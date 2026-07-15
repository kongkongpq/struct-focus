// @struct/context — CapsuleStore：知识胶囊系统
//
// 管理磁盘上的上下文胶囊。每个胶囊包含一个子任务完整的上下文记录：
//   文件列表、决策链路、已知限制、MANDATORY 规则、原始内容汇总。
//
// 存储格式 (JSON):
//   .structagent/capsules/<capsuleId>.json
//
// 与 ContentStore 的关系：
//   ContentStore 存单条被截断/驱逐的条目
//   CapsuleStore 存子任务级别的完整上下文打包
//   两者互不依赖，但胶囊构建时会引用 ContentStore 中的原始条目

import { promises as fs } from "node:fs";
import path from "node:path";

export interface CapsuleConstraint {
  type: "KNOWN_BUG" | "MANDATORY_RULE" | "DISCARDED_APPROACH";
  description: string;
  location: string; // e.g. "auth.ts:L87-L95"
  source: string;   // e.g. "测试失败后确认"
  createdAt: number;
}

export interface CapsuleDecision {
  summary: string;       // 决策一句话
  alternatives: string[]; // 已放弃的替代方案
  rationale: string;     // 为什么选这个
  files: string[];       // 涉及的改动的文件
}

export interface Capsule {
  id: string;
  /** 关联的子任务/阶段名 */
  taskId: string;
  /** 描述 */
  summary: string;
  /** 涉及文件（用于缺口检测：LLM 编辑这些文件时自动推入） */
  files: string[];
  /** 涉及的符号（函数名/类名） */
  symbols: string[];
  /** 决策清单 */
  decisions: CapsuleDecision[];
  /** 已知限制和规则 */
  constraints: CapsuleConstraint[];
  /** 已放弃的替代方案简述 */
  discardedAlternatives: { approach: string; reason: string }[];
  /** LLM 概括原始输出（每块一个字符串），用于 l1Summary——召回时不依赖原始对话 */
  chunkSummaries: string[];
  /** 关联的原始条目 ID（ContentStore 或 ContextManager 中的） */
  entryIds: string[];
  /** 构建时间 */
  createdAt: number;
  /** 原始内容总 token 估算 */
  originalTokens: number;
  /** 胶囊自身 token 估算 */
  capsuleTokens: number;
  /** 自动推送规则：编辑这些文件时框架自动推胶囊摘要到 L1 */
  autoPushOnFiles: string[];
}

const ESTIMATE_CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * 磁盘胶囊存储。
 * 一个胶囊 = 一个子任务的完整上下文。
 * 与 ContentStore 独立但可互引用。
 */
export class CapsuleStore {
  private readonly root: string;
  private ready = false;

  constructor(root: string) {
    this.root = root;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await fs.mkdir(this.root, { recursive: true });
    this.ready = true;
  }

  private capsulePath(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  async save(capsule: Capsule): Promise<void> {
    await this.ensureReady();
    await fs.writeFile(this.capsulePath(capsule.id), JSON.stringify(capsule, null, 2), "utf-8");
  }

  async load(id: string): Promise<Capsule | null> {
    try {
      const raw = await fs.readFile(this.capsulePath(id), "utf-8");
      return JSON.parse(raw) as Capsule;
    } catch {
      return null;
    }
  }

  /** 按文件路径查找关联胶囊 */
  async findByFile(filePath: string): Promise<Capsule[]> {
    await this.ensureReady();
    const results: Capsule[] = [];
    try {
      const files = await fs.readdir(this.root);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(this.root, f), "utf-8");
        const c = JSON.parse(raw) as Capsule;
        if (c.files.some((f2) => f2 === filePath || filePath.endsWith(f2) || f2.endsWith(filePath))) {
          results.push(c);
        }
      }
    } catch {
      // 目录尚未创建
    }
    return results;
  }

  /** 列出全部胶囊摘要 */
  async list(): Promise<{ id: string; taskId: string; summary: string; files: string[]; createdAt: number }[]> {
    await this.ensureReady();
    const results: { id: string; taskId: string; summary: string; files: string[]; createdAt: number }[] = [];
    try {
      const files = await fs.readdir(this.root);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(this.root, f), "utf-8");
        const c = JSON.parse(raw) as Capsule;
        results.push({ id: c.id, taskId: c.taskId, summary: c.summary, files: c.files, createdAt: c.createdAt });
      }
    } catch {
      // 目录尚未创建
    }
    return results;
  }

  /** 生成胶囊摘要文本（用于注入 observation） */
  static summaryText(c: Capsule): string {
    const decisionText = c.decisions.length
      ? `\n决策: ${c.decisions.map(d => d.summary).join("; ")}`
      : "";
    const constraintText = c.constraints.length
      ? `\n约束: ${c.constraints.map(cn => `[${cn.type}] ${cn.description}`).join("; ")}`
      : "";
    const discardedText = c.discardedAlternatives.length
      ? `\n已放弃方案: ${c.discardedAlternatives.map(a => `${a.approach}(原因:${a.reason})`).join("; ")}`
      : "";
    return `📦 capsule:${c.id}\n文件: ${c.files.join(", ")} | 符号: ${c.symbols.slice(0, 5).join(", ")}` +
      `${decisionText}${constraintText}${discardedText}` +
      `\n原始 ${c.originalTokens} tokens → 胶囊 ${c.capsuleTokens} tokens` +
      `\n调用 recall:context("${c.id}") 展开完整记录`;
  }

  /**
   * 生成胶囊 L1 概览（~500 tokens）：结构化大纲——文件列表 + 符号列表 + 决策摘要 + 约束摘要。
   * 位于 L0（summaryText ~100 tokens）和 L2（完整 JSON）之间。
   * LLM 看完 L0 后先 expand 到 L1，再决定是否要 L2 全文。
   */
  static summaryTextL1(c: Capsule): string {
    const lines: string[] = [];
    lines.push(`📦 胶囊 ${c.id} — 任务: ${c.taskId}`);
    lines.push("");

    // LLM 概括本体（召回的真正价值所在）
    if (c.chunkSummaries && c.chunkSummaries.length > 0) {
      lines.push(`概括 (${c.chunkSummaries.length} 块):`);
      for (const s of c.chunkSummaries) {
        const cleaned = s.replace(/\n{2,}/g, "\n").trim();
        lines.push(cleaned);
        lines.push("");
      }
    }

    // 文件概览
    if (c.files.length) {
      lines.push(`涉及文件: ${c.files.slice(0, 10).join(", ")}`);
      lines.push("");
    }
    // 符号概览
    if (c.symbols.length) {
      lines.push(`关键符号: ${c.symbols.slice(0, 20).join(", ")}${c.symbols.length > 20 ? " …" : ""}`);
      lines.push("");
    }
    // 决策链路
    if (c.decisions.length) {
      lines.push(`决策 (${c.decisions.length}):`);
      for (const d of c.decisions) lines.push(`  • ${d.summary}`);
      lines.push("");
    }
    // 约束（仅 MANDATORY_RULE）
    const mandatory = c.constraints.filter(cn => cn.type === "MANDATORY_RULE");
    if (mandatory.length) {
      lines.push(`强约束 (${mandatory.length}):`);
      for (const m of mandatory) lines.push(`  • [${m.type}] ${m.description}`);
      lines.push("");
    }
    // 已放弃方案
    if (c.discardedAlternatives.length) {
      lines.push(`已放弃方案 (${c.discardedAlternatives.length}):`);
      for (const a of c.discardedAlternatives) lines.push(`  • ${a.approach}（原因：${a.reason}）`);
      lines.push("");
    }
    lines.push(`原始 ${c.originalTokens} tokens → 胶囊 ${c.capsuleTokens} tokens`);
    lines.push(`调用 recall:context("${c.id}", level="L2") 加载完整 JSON`);
    return lines.join("\n");
  }

  /**
   * 构建胶囊：从条目列表生成结构化胶囊。
   * 自动提取决策信号、错误模式、文件引用。
   *
   * @param taskId 子任务标识
   * @param entries 该子任务所有上下文的文本内容拼接
   * @param options 附加信息
   */
  static buildCapsule(
    taskId: string,
    entries: { content: string; source?: string; entryId?: string; timestamp?: number }[],
    options?: {
      summary?: string;
      files?: string[];
      symbols?: string[];
    },
  ): Capsule {
    const files = options?.files ?? [
      ...new Set(entries.map(e => e.source).filter(Boolean) as string[]),
    ];
    const symbols = options?.symbols ?? [];
    const entryIds = entries.map(e => e.entryId).filter(Boolean) as string[];

    // 提取决策信号
    const decisionPatterns = [
      /决定采用\s*(.+)/, /最终方案[：:]\s*(.+)/, /约定[：:]\s*(.+)/,
      /确认使用\s*(.+)/, /架构决策[：:]\s*(.+)/,
    ];
    const decisions: CapsuleDecision[] = [];
    for (const e of entries) {
      for (const pat of decisionPatterns) {
        const m = e.content.match(pat);
        if (m) {
          decisions.push({
            summary: m[1]!.slice(0, 200),
            alternatives: [],
            rationale: "",
            files: files,
          });
          break;
        }
      }
    }

    // 提取约束：已知限制 + 强制规则 + 已放弃方案
    const constraints: CapsuleConstraint[] = [];
    const discardedAlternatives: { approach: string; reason: string }[] = [];
    const bugPatterns = [
      /(?:已知限制|KNOWN_BUG|已知问题|竞态条件|边界情况)[：:]\s*(.+)/gi,
      /(?:MANDATORY|强制|不可违背|必须遵守)[：:]\s*(.+)/gi,
      /(?:放弃|不再采用|否决).{0,10}(?:方案|方法|方式)[：:]\s*(.+)[，,]\s*(?:原因|因为|理由是)[：:]\s*(.+)/gi,
    ];

    for (const e of entries) {
      for (const pat of bugPatterns) {
        let m: RegExpExecArray | null;
        pat.lastIndex = 0;
        while ((m = pat.exec(e.content)) !== null) {
          const text = m[1]?.slice(0, 200) ?? "";
          if (pat.source.includes("放弃")) {
            discardedAlternatives.push({ approach: text, reason: m[2]?.slice(0, 100) ?? "" });
          } else if (pat.source.includes("MANDATORY")) {
            constraints.push({
              type: "MANDATORY_RULE",
              description: text,
              location: e.source ?? "",
              source: "auto-extracted",
              createdAt: Date.now(),
            });
          } else {
            constraints.push({
              type: "KNOWN_BUG",
              description: text,
              location: e.source ?? "",
              source: "auto-extracted",
              createdAt: Date.now(),
            });
          }
        }
      }
    }

    // 合并文本内容
    const fullText = entries.map(e => e.content).join("\n");
    const originalTokens = estimateTokens(fullText);

    const capsule: Capsule = {
      id: `capsule_${taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}`,
      taskId,
      summary: options?.summary ?? `子任务 ${taskId} 的上下文胶囊`,
      files,
      symbols,
      decisions,
      constraints,
      discardedAlternatives,
      chunkSummaries: [],
      entryIds,
      createdAt: Date.now(),
      originalTokens,
      capsuleTokens: 0, // 计算完 summaryText 后填充
      autoPushOnFiles: files,
    };

    capsule.capsuleTokens = estimateTokens(CapsuleStore.summaryText(capsule));
    return capsule;
  }
}
