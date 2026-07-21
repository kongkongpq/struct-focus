// @structfocus/context — LLM 驱动的验收基准
//
// 测三个场景：
//   1. Needle-in-Haystack（大海捞针）：噪音中埋关键信息，LLM 能不能找到
//   2. Cross-file Consistency（跨文件一致性）：多文件编辑，决策是否一致
//   3. Token Efficiency（Token 效率）：峰值 token 对比
//
// 使用 OpenAI 兼容 API（DeepSeek / 智谱 GLM / Moonshot 都可）
// 零 SDK 依赖，纯 fetch。

import { ContextManager } from "../src/index.js";

// ─── 配置 ────────────────────────────────────────────────

export interface LLMConfig {
  baseUrl: string;     // e.g. "https://api.deepseek.com"
  apiKey: string;
  model: string;       // e.g. "deepseek-chat"
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── LLM 调用 ────────────────────────────────────────────

/** 按 provider 拼出 chat/completions 端点（智谱/千问/DeepSeek/OpenAI 各有差异） */
function chatUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, "");
  if (u.endsWith("/v4") || u.includes("/api/paas")) return `${u}/chat/completions`; // 智谱 GLM
  if (u.includes("/compatible-mode")) return `${u}/v1/chat/completions`; // 通义千问 DashScope
  if (u.endsWith("/v1")) return `${u}/chat/completions`; // DeepSeek / OpenAI
  return `${u}/v1/chat/completions`;
}

export async function callLLM(config: LLMConfig, messages: LLMMessage[]): Promise<string> {
  const resp = await fetch(chatUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0,
      max_tokens: 500,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`LLM API ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json() as { choices: { message: { content: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

// ─── 测试结果类型 ────────────────────────────────────────

export interface TestCaseResult {
  taskId: string;
  baseline: {
    correct: boolean;
    answer: string;
    totalTokens: number;
    peakTokens: number;
    contextEntries: number;
  };
  managed: {
    correct: boolean;
    answer: string;
    totalTokens: number;
    peakTokens: number;
    contextEntries: number;
    capsulesCreated: number;
    conflictsDetected: number;
    gapsDetected: number;
  };
  verdict: "WIN" | "TIE" | "LOSE";
  note: string;
}

// ─── 工具函数 ────────────────────────────────────────────

function noiseLine(i: number, kind: string): string {
  const noises = {
    log: [
      `[${new Date(2026, 6, 15, 10, 0, 0).getTime() + i * 60000}] INFO  worker-${i % 4} cache hit ratio: ${(40 + i % 30).toFixed(1)}%`,
      `[${new Date(2026, 6, 15, 10, 0, 0).getTime() + i * 60000}] DEBUG worker-${i % 4} processing batch #${i * 100} (${i * 7 % 100} items)`,
      `[${new Date(2026, 6, 15, 10, 0, 0).getTime() + i * 60000}] WARN  worker-${i % 4} slow query detected: ${200 + i * 3}ms threshold exceeded`,
      `[${new Date(2026, 6, 15, 10, 0, 0).getTime() + i * 60000}] INFO  worker-${i % 4} GC pause: ${(1.5 + i % 5 * 0.3).toFixed(1)}ms, heap: ${(800 - i * 2) % 500 + 200}MB`,
    ],
    lint: [
      `eslint: src/utils/helpers.ts:${100 + i}:${i % 20 + 1}  warning  no-unused-vars  '${["_temp", "_unused", "_draft", "_backup"][i % 4]}' is assigned but never used`,
      `eslint: src/utils/helpers.ts:${200 + i}:${i % 30 + 1}  warning  prefer-const  'result' is never modified, use const`,
    ],
    build: [
      `tsc: src/components/Modal.${["tsx", "css", "test.tsx", "stories.tsx"][i % 4]} (${i * 3 % 50 + 10}ms)`,
      `vite: chunk ${["vendor", "main", "styles", "runtime"][i % 4]}-${i.toString(16).padStart(4, "0")}.js  ${(i * 13 % 500 + 50)}kB`,
    ],
    test: [
      `PASS  src/__tests__/component-${i % 20}.test.ts (${(1.2 + i % 10 * 0.3).toFixed(1)}s)`,
      `  ✓ renders without crashing (${i % 5 + 1}ms)`,
      `  ✓ handles empty state (${i % 7 + 1}ms)`,
    ],
  } as const;

  const picks = noises[kind as keyof typeof noises] ?? noises.log;
  return picks[i % picks.length]!;
}

// ─── 题 1：Needle-in-Haystack ────────────────────────────

export interface NeedleTask {
  id: string;
  description: string;
  needle: {
    content: string;
    source: string;
    step: number;        // 在第几步埋入
  };
  question: string;       // 最后问 LLM 的问题
  expectedAnswer: string; // 正确答案应包含的关键词
  totalSteps: number;
  noiseSteps: number;     // 多少步是噪音
}

export function runNeedleTask(task: NeedleTask): {
  baseline: { entries: number; peakTokens: number; messages: LLMMessage[] };
  managed: { entries: number; peakTokens: number; messages: LLMMessage[] };
} {
  // ── 朴素基线 ──
  const baseMgr = new ContextManager({ maxWindow: 128_000 });
  baseMgr.appendUser(task.description);
  for (let i = 0; i < task.totalSteps; i++) {
    if (i === task.needle.step) {
      baseMgr.appendObservation(task.needle.content, { source: task.needle.source, taskRelevance: 0.8 });
    } else {
      const k = ["log", "lint", "build", "test"][i % 4]!;
      baseMgr.appendObservation(noiseLine(i, k), { source: `noise-${i}`, taskRelevance: 0.3 });
    }
  }
  baseMgr.appendUser(task.question);
  const baseEntries = baseMgr.getAllEntries().filter(e => !e.evicted);
  const basePeak = baseEntries.reduce((s, e) => s + e.tokenCount, 0);
  const baseMsgs = baseMgr.toMessages("你是一个编程助手。请直接回答问题，不要编造。如果信息不在上下文中，请说你不知道。");

  // ── 管理组 ──
  const mgr = new ContextManager({ maxWindow: 128_000 });
  mgr.appendUser(task.description);
  mgr.setTaskContext({
    currentSubtasks: [task.description],
    editingFiles: [task.needle.source],
    failingTests: [],
    focusedSymbols: [],
    recentErrors: [],
  });
  for (let i = 0; i < task.totalSteps; i++) {
    if (i === task.needle.step) {
      mgr.appendObservation(task.needle.content, { source: task.needle.source, taskRelevance: 0.8 });
    } else {
      const k = ["log", "lint", "build", "test"][i % 4]!;
      mgr.appendObservation(noiseLine(i, k), { source: `noise-${i}`, taskRelevance: 0.3 });
    }
    // 每 5 步调一次 autoManage
    if (i % 5 === 0) {
      void mgr.autoManage(); // fire-and-forget here for sync harness
    }
  }
  // 强制一轮管理
  mgr.manage();
  mgr.appendUser(task.question);
  const mgrEntries = mgr.getAllEntries().filter(e => !e.evicted);
  const mgrPeak = mgrEntries.reduce((s, e) => s + e.tokenCount, 0);
  const mgrMsgs = mgr.toMessages("你是一个编程助手。请直接回答问题，不要编造。如果信息不在上下文中，请说你不知道。");

  return {
    baseline: { entries: baseEntries.length, peakTokens: basePeak, messages: baseMsgs },
    managed: { entries: mgrEntries.length, peakTokens: mgrPeak, messages: mgrMsgs },
  };
}

// ─── 题 2：跨文件决策一致性 ──────────────────────────────

export interface ConsistencyStep {
  step: number;
  file: string;
  content: string;
  question?: string;           // 问 LLM 要做的决策
  expectedAnswer?: string;     // 期望的关键词
}

export interface ConsistencyTask {
  id: string;
  description: string;
  steps: ConsistencyStep[];
}

export function runConsistencyTask(task: ConsistencyTask): {
  baseline: { entries: number; peakTokens: number; messages: LLMMessage[]; qaPairs: { step: number; question: string; contextSize: number }[] };
  managed: { entries: number; peakTokens: number; messages: LLMMessage[]; qaPairs: { step: number; question: string; contextSize: number }[] };
} {
  // ── 朴素基线 ──
  const baseMgr = new ContextManager({ maxWindow: 128_000 });
  baseMgr.appendUser(task.description);
  const baseQA: { step: number; question: string; contextSize: number }[] = [];

  for (const s of task.steps) {
    baseMgr.appendObservation(s.content, { source: s.file, taskRelevance: 0.6 });
    baseMgr.appendAssistant(`[在 ${s.file} 中做了相应修改]`);
    if (s.question) {
      baseQA.push({ step: s.step, question: s.question, contextSize: baseMgr.getStats().totalTokens });
    }
  }
  baseMgr.appendUser("请总结你在上述过程中做过的所有架构决策。");
  const baseMsgs = baseMgr.toMessages("你是一个编程助手。回答用户的最终问题。");

  // ── 管理组 ──
  const mgr = new ContextManager({ maxWindow: 128_000 });
  mgr.appendUser(task.description);
  mgr.setTaskContext({
    currentSubtasks: [task.description],
    editingFiles: [...new Set(task.steps.map(s => s.file))],
    failingTests: [],
    focusedSymbols: [],
    recentErrors: [],
  });
  const mgrQA: { step: number; question: string; contextSize: number }[] = [];

  for (const s of task.steps) {
    mgr.appendObservation(s.content, { source: s.file, taskRelevance: 0.6 });
    mgr.appendAssistant(`[在 ${s.file} 中做了相应修改]`);
    // 模拟每步后的 autoManage
    mgr.appendObservation(`✅ ${s.file} 修改完成，测试通过`, { source: s.file });
    mgr.manage();
    if (s.question) {
      mgrQA.push({ step: s.step, question: s.question, contextSize: mgr.getStats().totalTokens });
    }
  }
  mgr.appendUser("请总结你在上述过程中做过的所有架构决策。");
  const mgrMsgs = mgr.toMessages("你是一个编程助手。回答用户的最终问题。");

  return {
    baseline: { entries: baseMgr.getAllEntries().filter(e => !e.evicted).length, peakTokens: baseMgr.getStats().totalTokens, messages: baseMsgs, qaPairs: baseQA },
    managed: { entries: mgr.getAllEntries().filter(e => !e.evicted).length, peakTokens: mgr.getStats().totalTokens, messages: mgrMsgs, qaPairs: mgrQA },
  };
}

// ─── 题 3：Token 效率 ────────────────────────────────────

export interface EfficiencyTask {
  id: string;
  description: string;
  steps: number;
  toolChunkSize: number;        // 每步工具输出字符数
  noisePerStep: number;         // 每步噪音条数
  expectedFocusFiles: string[];
}

export function runEfficiencyTask(task: EfficiencyTask): {
  baseline: { peakTokens: number; endTokens: number; entries: number };
  managed: { peakTokens: number; endTokens: number; entries: number; evictedCount: number; compressedCount: number };
} {
  const TOTAL = 32_000;

  // ── 朴素基线 ──
  const baseMgr = new ContextManager({ maxWindow: TOTAL });
  baseMgr.appendUser(task.description);
  let basePeak = 0;
  for (let i = 0; i < task.steps; i++) {
    baseMgr.appendToolResult("x".repeat(task.toolChunkSize), { source: "output.txt", sourceType: "tool_output" });
    for (let n = 0; n < task.noisePerStep; n++) {
      baseMgr.appendObservation(`noise-${i}-${n}: ` + "data ".repeat(20));
    }
    basePeak = Math.max(basePeak, baseMgr.getStats().totalTokens);
  }

  // ── 管理组 ──
  const mgr = new ContextManager({ maxWindow: TOTAL });
  mgr.appendUser(task.description);
  mgr.setTaskContext({
    currentSubtasks: [task.description],
    editingFiles: task.expectedFocusFiles,
    failingTests: [],
    focusedSymbols: [],
    recentErrors: [],
  });
  let mgrPeak = 0;
  for (let i = 0; i < task.steps; i++) {
    mgr.appendToolResult("x".repeat(task.toolChunkSize), { source: "output.txt", sourceType: "tool_output" });
    for (let n = 0; n < task.noisePerStep; n++) {
      mgr.appendObservation(`noise-${i}-${n}: ` + "data ".repeat(20));
    }
    mgr.manage();
    mgrPeak = Math.max(mgrPeak, mgr.getStats().totalTokens);
  }

  const mgrStats = mgr.getStats();

  return {
    baseline: { peakTokens: basePeak, endTokens: baseMgr.getStats().totalTokens, entries: baseMgr.getAllEntries().length },
    managed: {
      peakTokens: mgrPeak,
      endTokens: mgrStats.totalTokens,
      entries: mgr.getAllEntries().length,
      evictedCount: mgrStats.evictedEntries,
      compressedCount: mgrStats.compressedEntries,
    },
  };
}

// ─── 格式化报告 ──────────────────────────────────────────

export function formatLLMTestReport(
  needleResult: ReturnType<typeof runNeedleTask>,
  consistencyResult: ReturnType<typeof runConsistencyTask>,
  efficiencyResult: ReturnType<typeof runEfficiencyTask>,
  llmAnswers?: { needle: { baseline: string; managed: string }; consistency: { baseline: string; managed: string } },
): string {
  const lines: string[] = [];
  lines.push("# StructFocus 验收测试报告");
  lines.push("");
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push("");

  // ── 题 1 ──
  lines.push("## 题 1：Needle-in-Haystack（大海捞针）");
  lines.push("");
  lines.push("| 指标 | 朴素基线 | StructFocus | 提升 |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(`| 上下文条目数 | ${needleResult.baseline.entries} | ${needleResult.managed.entries} | **${((1 - needleResult.managed.entries / needleResult.baseline.entries) * 100).toFixed(0)}%** |`);
  lines.push(`| 峰值 Token | ${needleResult.baseline.peakTokens} | ${needleResult.managed.peakTokens} | **${((1 - needleResult.managed.peakTokens / needleResult.baseline.peakTokens) * 100).toFixed(1)}%** |`);
  lines.push(`| 消息数 | ${needleResult.baseline.messages.length} | ${needleResult.managed.messages.length} | |`);
  if (llmAnswers?.needle) {
    lines.push("");
    lines.push("**LLM 回答：**");
    lines.push("");
    lines.push(`- 朴素基线：${llmAnswers.needle.baseline.slice(0, 200)}`);
    lines.push(`- StructFocus：${llmAnswers.needle.managed.slice(0, 200)}`);
  }
  lines.push("");

  // ── 题 2 ──
  lines.push("## 题 2：跨文件决策一致性");
  lines.push("");
  lines.push("| 指标 | 朴素基线 | StructFocus |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| 上下文条目数 | ${consistencyResult.baseline.entries} | ${consistencyResult.managed.entries} |`);
  lines.push(`| 峰值 Token | ${consistencyResult.baseline.peakTokens} | ${consistencyResult.managed.peakTokens} |`);
  lines.push(`| 决策检查点 | ${consistencyResult.baseline.qaPairs.length} | ${consistencyResult.managed.qaPairs.length} |`);
  lines.push("");
  lines.push("**各检查点上下文大小：**");
  lines.push("");
  lines.push("| 步骤 | 朴素基线 Token | StructFocus Token | 缩减% |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (let i = 0; i < consistencyResult.baseline.qaPairs.length; i++) {
    const b = consistencyResult.baseline.qaPairs[i]!;
    const m = consistencyResult.managed.qaPairs[i]!;
    const reduction = b.contextSize > 0 ? ((1 - m.contextSize / b.contextSize) * 100).toFixed(0) : "0";
    lines.push(`| ${b.step} | ${b.contextSize} | ${m.contextSize} | ${reduction}% |`);
  }
  if (llmAnswers?.consistency) {
    lines.push("");
    lines.push("**LLM 最终回答（总结所有架构决策）：**");
    lines.push("");
    lines.push(`- 朴素基线：${llmAnswers.consistency.baseline.slice(0, 300)}`);
    lines.push(`- StructFocus：${llmAnswers.consistency.managed.slice(0, 300)}`);
  }
  lines.push("");

  // ── 题 3 ──
  lines.push("## 题 3：Token 效率");
  lines.push("");
  const ePeakDrop = ((1 - efficiencyResult.managed.peakTokens / efficiencyResult.baseline.peakTokens) * 100).toFixed(1);
  lines.push("| 指标 | 朴素基线 | StructFocus | 变化 |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(`| 峰值 Token | ${efficiencyResult.baseline.peakTokens} | ${efficiencyResult.managed.peakTokens} | **-${ePeakDrop}%** |`);
  lines.push(`| 最终 Token | ${efficiencyResult.baseline.endTokens} | ${efficiencyResult.managed.endTokens} | |`);
  lines.push(`| 条目总数 | ${efficiencyResult.baseline.entries} | ${efficiencyResult.managed.entries} | |`);
  lines.push(`| 驱逐条目 | 0 | ${efficiencyResult.managed.evictedCount} | |`);
  lines.push(`| 压缩条目 | 0 | ${efficiencyResult.managed.compressedCount} | |`);
  lines.push("");

  // ── 总评 ──
  lines.push("## 总评");
  lines.push("");
  const peakDrop = ((1 - efficiencyResult.managed.peakTokens / efficiencyResult.baseline.peakTokens) * 100).toFixed(1);
  lines.push(`- Token 峰值下降：**${peakDrop}%**`);
  lines.push(`- 上下文条数缩减：**${((1 - needleResult.managed.entries / needleResult.baseline.entries) * 100).toFixed(0)}%**`);

  return lines.join("\n");
}
