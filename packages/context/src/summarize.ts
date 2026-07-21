// @structfocus/context — 概括到胶囊管线 (2026-07-19)
//
// summarizeToCapsule：将上下文内容概括为三层胶囊
//   L0: ~100 tokens（始终注入活跃窗口，作为指针）
//   L1: ~500 tokens（结构化大纲，LLM 决定是否 expand）
//   L2: 完整 JSON（ContentStore + CapsuleStore）
//
// chunkBySemantic：按语义边界分块（不固定长度）
//   规则：最大 2000 chars、在 \n\n 处切分、禁止句子中间切开、
//         同说话者连续消息保持在一起、时间跳跃>1天→强制新块

import { CapsuleStore, type Capsule } from "./capsule.js";

// ─── 类型 ───────────────────────────────────────────────

export interface SummarizeInput {
  entries: { content: string; source?: string; timestamp?: number }[];
  prompt?: string;
  metadata?: {
    taskId?: string;
    category?: "conversation" | "code_session" | "document" | "tool_output";
    participants?: string[];
    tags?: string[];
  };
}

export interface SummarizeOutput {
  capsule: Capsule;
  l1Summary: string;
  l0Summary: string;
  /** 每个语义块的摘要文本（LLM 输出或确定性回退） */
  chunkSummaries: string[];
  extractedEntities: { name: string; type: "person" | "date" | "file" | "decision" | "event"; mentions: number }[];
  pointers: string[];
}

// ─── 语义分块 ───────────────────────────────────────────

/**
 * 按语义边界将条目分块。
 * 不固定长度，而是按自然边界切分。
 *
 * 规则：
 *   1. maxChars 默认 2000
 *   2. 在换段符 (\n\n) 处切分
 *   3. 禁止在句子中间切开（退回到上一个句子边界）
 *   4. 同一说话者 (source 相同) 的连续消息保持在同块
 *   5. 时间跳跃 > 1 天 → 强制开始新块
 */
export function chunkBySemantic(
  entries: { content: string; source?: string; timestamp?: number }[],
  maxChars = 2000,
): { content: string; source?: string; timestamp?: number }[][] {
  if (!entries.length) return [];

  const chunks: { content: string; source?: string; timestamp?: number }[][] = [];
  let currentChunk: { content: string; source?: string; timestamp?: number }[] = [];
  let currentChars = 0;

  function flushChunk(): void {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const entryLen = entry.content.length;

    // 规则5: 时间跳跃 > 1 天
    if (i > 0 && entry.timestamp && entries[i - 1]?.timestamp) {
      const gap = entry.timestamp - entries[i - 1]!.timestamp!;
      if (gap > 24 * 3600 * 1000) {
        flushChunk();
      }
    }

    // 规则3: 如果当前块接近上限，找上一个句子边界切分
    if (currentChars > 0 && currentChars + entryLen > maxChars) {
      // 在上一块的 \n\n 处切
      const lastEntry = currentChunk[currentChunk.length - 1];
      if (lastEntry) {
        const paraBreak = lastEntry.content.lastIndexOf("\n\n");
        if (paraBreak > maxChars * 0.3) {
          // 后半部分移到新块
          const firstPart = lastEntry.content.slice(0, paraBreak);
          const secondPart = lastEntry.content.slice(paraBreak + 2);
          currentChunk[currentChunk.length - 1] = {
            ...lastEntry,
            content: firstPart,
          };
          currentChars -= secondPart.length;
          flushChunk();
          currentChunk.push({ ...lastEntry, content: secondPart });
          currentChars += secondPart.length;
          // 当前 entry 放入新块
          currentChunk.push(entry);
          currentChars += entryLen;
          continue;
        }
      }
      flushChunk();
    }

    // 规则4: 同一 source 的连续条目保持在同一块；source 切换且当前块已较大时，另起一块
    // （避免把同一说话者的连续消息拆到两块，也避免不同说话者挤在一块导致召回串味）
    if (
      i > 0 &&
      entry.source &&
      entry.source !== entries[i - 1]?.source &&
      currentChars > maxChars * 0.5
    ) {
      flushChunk();
    }

    currentChunk.push(entry);
    currentChars += entryLen;

    // 规则2: 在 \n\n 自然段处切分
    if (currentChars >= maxChars * 0.7 && entry.content.includes("\n\n")) {
      const lastPara = entry.content.lastIndexOf("\n\n");
      if (lastPara > 50) {
        const firstPart = entry.content.slice(0, lastPara);
        const secondPart = entry.content.slice(lastPara + 2);
        currentChunk[currentChunk.length - 1] = { ...entry, content: firstPart };
        currentChars -= secondPart.length;
        flushChunk();
        currentChunk.push({ ...entry, content: secondPart });
        currentChars += secondPart.length;
      }
    }
  }

  flushChunk();
  return chunks;
}

// ─── 实体提取（确定性，不依赖 LLM） ─────────────────────

function extractEntities(text: string): { name: string; type: "person" | "date" | "file" | "decision" | "event"; mentions: number }[] {
  const entities: Map<string, { type: string; mentions: number }> = new Map();

  // 文件名
  const filePatterns = [
    /([\w\-.]+\.(?:ts|tsx|js|jsx|py|rs|go|java|cpp|h|json|yaml|yml|md|toml|css|html|vue|svelte))/g,
    /(['"])([\w\-.\\/]+\.[\w]+)\1/g,
  ];
  for (const pat of filePatterns) {
    for (const m of text.matchAll(pat)) {
      const name = m[2] ?? m[1]!;
      const existing = entities.get(name);
      if (existing) existing.mentions++;
      else entities.set(name, { type: "file", mentions: 1 });
    }
  }

  // 日期
  const datePat = /\b(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\b/g;
  for (const m of text.matchAll(datePat)) {
    const name = m[1]!;
    const existing = entities.get(name);
    if (existing) existing.mentions++;
    else entities.set(name, { type: "date", mentions: 1 });
  }

  // 决策信号
  const decisionPat = /(?:决定|确认|约定|采纳|采用|选择|最终方案)[：:]\s*(.{10,80}?)(?:[。\.\n]|$)/g;
  for (const m of text.matchAll(decisionPat)) {
    const name = m[1]!.trim();
    if (name.length < 5) continue;
    const existing = entities.get(name);
    if (existing) existing.mentions++;
    else entities.set(name, { type: "decision", mentions: 1 });
  }

  // 人名（简单启发式：大写开头 + 英文名）
  const personPat = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/g;
  const commonNames = new Set(["Error", "Type", "String", "Number", "Boolean", "Array", "Object",
    "True", "False", "None", "Null", "Module", "Class", "Function", "Interface", "Export", "Import",
    "The", "This", "That", "When", "Where", "What", "Which", "There", "These", "Those"]);
  for (const m of text.matchAll(personPat)) {
    const name = m[1]!;
    if (commonNames.has(name)) continue;
    if (name.length < 3 || name.length > 30) continue;
    const existing = entities.get(name);
    if (existing) existing.mentions++;
    else entities.set(name, { type: "person", mentions: 1 });
  }

  return [...entities.entries()]
    .filter(([, v]) => v.mentions >= 2)
    .sort((a, b) => b[1].mentions - a[1].mentions)
    .slice(0, 30)
    .map(([name, v]) => ({ name, type: v.type as "person" | "date" | "file" | "decision" | "event", mentions: v.mentions }));
}

// ─── LLM 摘要模板 ───────────────────────────────────────

function buildSummarizePrompt(
  chunk: string,
  category: string,
  chunkIndex: number,
  totalChunks: number,
): string {
  return `你是一个上下文摘要引擎。请将以下内容概括为结构化记录。

类别: ${category}
块 ${chunkIndex + 1}/${totalChunks}

请按以下格式输出（不要输出额外内容）：

[目标]: 这一段的主题是什么？一句话。
[关键发现]: 最重要的发现或决策（最多 3 条）。
[决策]: 如果有任何明确决策，列出。无则写"无"。
[下一步]: 如果需要后续动作，列出。无则写"无"。
[相关实体]: 关键人物、文件、日期、术语。

内容:
${chunk.slice(0, 6000)}`;
}

// ─── 确定性回退摘要（无 LLM 时用） ──────────────────────

function deterministicSummary(text: string): string {
  // 分句
  const sentences = text.split(/(?<=[。！？.!?])\s*/).filter(s => s.trim().length > 5);
  if (sentences.length === 0) return "[目标]: (无内容)\n[关键发现]: 无\n[决策]: 无\n[下一步]: 无";

  // 开篇句=目标（用户第一条消息）
  const firstUser = sentences.find(s => /^用户[：:]/.test(s) || /^Human[：:]/.test(s) || s.includes("在做") || s.includes("项目") || s.includes("的问题") || s.includes("想")) ?? sentences[0]!;

  // 提取错误/失败/问题句
  const errorLines = sentences.filter(s => /(error|fail|错误|失败|异常|慢|高|飙升|退化|暴跌|死锁|碎片|bug)/i.test(s)).slice(0, 3);

  // 提取建议/方案句
  const solutionLines = sentences.filter(s => /(建议|方案|解法|标准|实现|换成|加入|采用|改成|配置|设置|优化|用)/.test(s)).slice(0, 3);

  // 提取决策/确认句（"好了"、"写好了"、"实现了"、"解决"）
  const decisionLines = sentences.filter(s => /(好了|写好了|实现了|解决|完成|搞定|OK|done|采纳|采用|就用|选了|决定)/.test(s)).slice(0, 2);

  // 提取下一步/待办信号
  const nextLines = sentences.filter(s => /(现在想|最后的问题|还需要|下一步|接下来|想要一个|想加)/.test(s)).slice(0, 2);

  return [
    `[目标]: ${firstUser!.slice(0, 200)}`,
    `[关键发现]: ${errorLines.length ? errorLines.map(s => s.slice(0, 120)).join("; ") : "无明确错误"}`,
    `[决策]: ${decisionLines.length ? decisionLines.map(s => s.slice(0, 120)).join("; ") : "无"}`,
    `[下一步]: ${nextLines.length ? nextLines.map(s => s.slice(0, 120)).join("; ") : (solutionLines.length ? solutionLines.map(s => s.slice(0, 120)).join("; ") : "无")}`,
  ].join("\n");
}

// ─── 超时保护 ───────────────────────────────────────────

/** 给 Promise 加超时；超时后 reject（调用方应回退到确定性摘要） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ─── 主概括函数 ─────────────────────────────────────────

/**
 * 将内容概括为三层胶囊。
 *
 * @param input 待概括的内容
 * @param llmCall 可选 LLM 调用（不提供则使用确定性回退）
 */
export async function summarizeToCapsule(
  input: SummarizeInput,
  llmCall?: (prompt: string) => Promise<string>,
): Promise<SummarizeOutput> {
  const category = input.metadata?.category ?? "conversation";
  const taskId = input.metadata?.taskId ?? `task_${Date.now()}`;

  // Step 1: 语义分块
  const chunks = chunkBySemantic(input.entries);

  // Step 2: 每块并发生成摘要（LLM 调用 Promise.all，单块 10s 超时后回退确定性摘要）
  const summarizeChunk = async (chunkIdx: number): Promise<string> => {
    const chunkText = chunks[chunkIdx]!.map((e) => e.content).join("\n\n");
    if (!llmCall) return deterministicSummary(chunkText);
    const prompt = buildSummarizePrompt(chunkText, category, chunkIdx, chunks.length);
    try {
      return await withTimeout(llmCall(prompt), 10_000, `chunk ${chunkIdx} LLM`);
    } catch {
      // 失败/超时：回退到确定性摘要，不影响主流程
      return deterministicSummary(chunkText);
    }
  };
  const chunkSummaries = await Promise.all(chunks.map((_, i) => summarizeChunk(i)));

  // Step 3: 全量文本（用于实体提取 + CapsuleStore.buildCapsule）
  const fullText = input.entries.map((e) => e.content).join("\n");
  const entities = extractEntities(fullText);

  // Step 4: 构建胶囊
  const capsule = CapsuleStore.buildCapsule(taskId, input.entries, {
    summary: input.metadata?.taskId
      ? `子任务 ${input.metadata.taskId} 的上下文胶囊（${chunks.length} 块）`
      : `上下文胶囊（${chunks.length} 块，${input.entries.length} 条目）`,
    files: [...new Set(entities.filter((e) => e.type === "file").map((e) => e.name))],
    symbols: entities.filter((e) => e.type === "file").map((e) => e.name.replace(/\.[^.]+$/, "")),
  });

  // Step 4.5: 把 LLM 摘要存入胶囊 + 提取 decisions
  capsule.chunkSummaries = chunkSummaries;
  for (const summary of chunkSummaries) {
    const decisionMatch = summary.match(/\[决策\]:\s*(.+)/);
    if (decisionMatch && decisionMatch[1] && decisionMatch[1].trim() !== "无") {
      capsule.decisions.push({
        summary: decisionMatch[1].trim().slice(0, 200),
        alternatives: [],
        rationale: summary.slice(0, 300),
        files: capsule.files,
      });
    }
  }

  // Step 5: 生成 l0/l1 分层摘要
  const fileNames = capsule.files.slice(0, 5).join(", ");
  const decisionSummaries = capsule.decisions.map((d) => d.summary).join("; ");
  const _entityNames = entities.slice(0, 10).map((e) => e.name).join(", ");

  const l0Summary = `📦 ${capsule.id}: ${fileNames || `${input.entries.length} 条上下文`}${decisionSummaries ? ` | 决策: ${decisionSummaries}` : ""}`.slice(0, 150);

  const l1Summary = CapsuleStore.summaryTextL1(capsule);

  // Step 6: 指针列表（指向 entryIds）
  const pointers = input.entries.map((e, i) => `pointer_${i}`);

  return {
    capsule,
    l1Summary,
    l0Summary,
    chunkSummaries,
    extractedEntities: entities,
    pointers,
  };
}
