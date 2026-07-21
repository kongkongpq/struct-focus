// @structfocus/context - ContextManager（四层冷热架构 2026-07-20 重构）
//
// 「不是驱逐，是降级」：框架自动按冷热分层管理上下文。
// 每步 Agent loop 完成后调用 autoManage()，按非活跃内容占比执行四层管理：
//   L2→L3 (≥20% 非活跃)：标记/分组/预压缩评估 → 概括归档为胶囊
//   L2→L3 (≥50% 非活跃)：执行概括归档 + 压缩
//   L3→L4 (≥85% 总 token)：最冷 L3 条目原文迁移到 ContentStore 深存
//   L1 自动学习：每次 flush 后从胶囊提取永久知识
// 辅以 preprocessToolOutput 六阶段去噪、taskRelevance 加权、注意力浪费度量、autoRecall 记忆注入。
// 无 LLM 调用、无外部重依赖（token 估算走注入式 BudgetManager）。

import {
  createId,
  consoleLogger,
  type LLMMessage,
  type Logger,
  type EntryType,
  type SourceType,
  type ContextEntry,
  type ContextPlacement,
  type PlacementLevel,
  type PlacementSource,
  type ManagementPolicy,
  type CapacityAlert,
  type TaskContext,
  type AutoManageReport,
  type ReflectionReport,
  type ContextStats,
  type AttentionWaste,
  ContextPlacementConflictError,
  EMPTY_TASK_CONTEXT,
  DEFAULT_MANAGEMENT_POLICY,
  effectiveEmergencyThreshold,
  CAPACITY_ENFORCE_THRESHOLD,
  CAPACITY_ENFORCE_STEPS,
  TRUNCATE_THRESHOLD,
  TRUNCATE_HEAD,
  TRUNCATE_TAIL,
  TRUNCATE_MID_LINES,
  ENTRY_TYPE_FACTOR,
  SOURCE_TYPE_FACTOR,
  ATTENTION_WASTE_TARGET,
} from "./types.js";
import { BudgetManager, getMaxContextWindow } from "./budget.js";
import { CodeExplorer } from "./explorer.js";
import { InMemoryBackend, type MemoryBackend, type MemoryEntry } from "./memory.js";
import { buildContext } from "./builder.js";
import { ContentStore, type StoredContent } from "./content-store.js";
import { CapsuleStore, type Capsule } from "./capsule.js";
import { summarizeToCapsule, type SummarizeInput, type SummarizeOutput } from "./summarize.js";
import { promises as fs } from "node:fs";
import path from "node:path";

// ─── 类型 ────────────────────────────────────────────────

export interface ManageResult {
  usePercent: number;
  inactivePercent: number;
  triggerLevel: -1 | 0 | 1 | 2;
  downgradedCount: number;
  downgradedTokens: number;
  compressedCount: number;
  truncatedCount: number;
  l4MigratedCount: number;
}

export interface DowngradeResult {
  downgradedCount: number;
  downgradedTokens: number;
}

/** 召回的原始内容 + 摘要 */
export interface RecallResult {
  entries: StoredContent[];
  summary: string;
}

/** 容量状态（供 MCP / UI 查询） */
export interface CapacityStatus {
  usePercent: number;
  activePins: { user: number; ai: number; system: number };
  needsInteraction: boolean;
  alert: CapacityAlert | null;
}

export interface ContextManagerOptions {
  /** 最大上下文窗口（tokens）。默认取 budget.getMaxContextWindow()，可用 setMaxContextWindow 调整 */
  maxWindow?: number;
  /** preprocessToolOutput 截断阶段的安全字符上限（默认 6000） */
  maxToolOutputChars?: number;
  /** 轻量日志（默认 console） */
  logger?: Logger;
  /** 记忆后端（默认内存） */
  memory?: MemoryBackend;
  /** ContentStore 存储根路径 */
  storeRoot?: string;
  /** CapsuleStore 存储根路径 */
  capsuleRoot?: string;
}

// ─── 工具函数 ────────────────────────────────────────────

/** FNV-1a 32-bit 字符串哈希（用于记忆去重指纹） */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const ERROR_RE = /(error|fail|exception|panic|abort|✗|❌|错误|失败)/i;

/** 阶段1：移除 ANSI 转义码 */
function stripAnsi(s: string): string {
   
  return s.replace(/\u001b\[[0-9;]*m/g, "").replace(/[\r\u0007]/g, "");
}

/** 阶段2：剥离 HTML 标签（仅 html 源或含标签时） */
function stripHtml(s: string, sourceType: SourceType): string {
  if (sourceType !== "html" && !/<[a-z][\s\S]*?>/i.test(s)) return s;
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 阶段3：合并连续重复行 */
function mergeRepeatedLines(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0 && line === lines[i - 1]! && line.trim() !== "") {
      run++;
      continue;
    }
    if (run > 0) {
      out.push(`  ...（以上 ${run + 1} 行重复）...`);
      run = 0;
    }
    out.push(line);
  }
  if (run > 0) out.push(`  ...（以上 ${run + 1} 行重复）...`);
  return out.join("\n");
}

/** 阶段4：连续空行压缩为 1 行（设计：连续 3 行以上 → 1 行） */
function filterEmptyLines(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let blankRun = 0;
  for (const l of lines) {
    if (l.trim() === "") {
      if (blankRun === 0) out.push(l);
      blankRun++;
    } else {
      blankRun = 0;
      out.push(l);
    }
  }
  return out.join("\n");
}

/** 阶段5：保留头部 + 所有错误行 + 尾部（log 更紧凑） */
function extractHeadAndErrors(s: string, sourceType: SourceType): string {
  if (sourceType === "json") return s; // JSON 结构信息价值高，保留完整
  const lines = s.split("\n");
  const errors = lines.filter((l) => ERROR_RE.test(l));
  const headN = sourceType === "log" ? 5 : 10;
  const tailN = sourceType === "log" ? 5 : 10;
  const parts: string[] = [lines.slice(0, headN).join("\n")];
  if (errors.length) parts.push(`# 错误/失败\n${errors.join("\n")}`);
  parts.push(`# 末尾\n${lines.slice(-tailN).join("\n")}`);
  return parts.join("\n");
}

/** 阶段6：超长内容截断（头+尾）。json 不截断 */
function truncateStage(s: string, sourceType: SourceType, maxChars: number): string {
  if (sourceType === "json") return s;
  if (s.length <= maxChars) return s;
  const head = s.slice(0, Math.floor(maxChars * 0.6));
  const tail = s.slice(-Math.floor(maxChars * 0.3));
  const omitted = s.length - head.length - tail.length;
  return `${head}\n...[已截断: ${omitted} 字符]...\n${tail}`;
}

const COMPRESS_ANCHORS = ["目标", "状态", "动作+结果", "关键发现", "失败", "下一步"] as const;
const ANCHOR_RE = /^\[(目标|状态|动作\+结果|关键发现|失败|下一步)\]\s*(.*)$/;

/**
 * 结构化压缩：提取锚点段（[目标]/[状态]/[动作+结果]/[关键发现]/[失败]/[下一步]）。
 * 若内容已含锚点，仅保留这些段（去冗长推理原文）；否则回退为最佳努力的锚点紧凑化。
 * 可逆、零延迟、无 LLM 调用。
 */
function structuredCompressContent(content: string): string {
  const present = COMPRESS_ANCHORS.filter((a) => new RegExp(`\\[${a}\\]`).test(content));
  if (present.length) {
    const lines = content.split("\n");
    const segs: string[] = [];
    let cur: string | null = null;
    let buf: string[] = [];
    const flush = (): void => {
      if (cur) segs.push(`[${cur}] ${buf.join(" ").trim()}`);
      cur = null;
      buf = [];
    };
    for (const l of lines) {
      const m = l.match(ANCHOR_RE);
      if (m) {
        flush();
        cur = m[1]!;
        // 锚点同行后的正文先收进 buf（如 "[目标] 修复 auth.ts 竞态"）
        if (m[2] && m[2].trim()) buf.push(m[2].trim());
      } else if (cur) {
        buf.push(l.trim());
      }
    }
    flush();
    return segs.join("\n");
  }
  // 回退：头 + 错误 + 尾，套用锚点外壳
  const lines = content.split("\n");
  const head = lines.slice(0, 8).join("\n");
  const errors = lines.filter((l) => ERROR_RE.test(l)).slice(0, 10).join("\n");
  const tail = lines.slice(-8).join("\n");
  return `[动作+结果]\n${head}\n[关键发现]\n${errors || "无"}\n[下一步]\n${tail}`;
}

/** 层1 截断：保留头 500 tok + 尾部 500 tok + 中部 50 行采样（设计 §2.1） */
function truncateEntryContent(content: string): string {
  const headChars = TRUNCATE_HEAD * 4;
  const tailChars = TRUNCATE_TAIL * 4;
  if (content.length <= headChars + tailChars + 200) return content;
  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  const mid = content.slice(headChars, -tailChars);
  const midLines = mid.split("\n");
  const midSample =
    midLines.length > TRUNCATE_MID_LINES ? midLines.slice(0, TRUNCATE_MID_LINES).join("\n") : mid;
  const omittedLines = Math.max(0, midLines.length - TRUNCATE_MID_LINES);
  return `${head}\n...[中部 ${omittedLines} 行省略]...\n${midSample}\n...[尾部]...\n${tail}`;
}

const DECISION_PATTERNS = [
  /决定采用\s*(.+)/,
  /最终方案[：:]\s*(.+)/,
  /约定[：:]\s*(.+)/,
  /确认使用\s*(.+)/,
  /架构决策[：:]\s*(.+)/,
];

// ─── ContextManager ──────────────────────────────────────

export class ContextManager {
  private entries: ContextEntry[] = [];
  private readonly maxWindow: number;
  private readonly maxToolOutputChars: number;
  private readonly logger: Logger;
  private readonly memory: MemoryBackend;

  /** 当前任务上下文（实例态，驱动 taskRelevance 加权） */
  private taskContext: TaskContext = EMPTY_TASK_CONTEXT;
  /** 显式聚焦文件集合（focus 原语） */
  private readonly focusedFiles = new Set<string>();
  /** 已自动召回的记忆指纹（去重，避免每步重复注入） */
  private readonly recalledHashes = new Set<string>();
  /** 最近追加的条目 id（压缩时跳过，避免压掉刚产生的上下文） */
  private readonly recentEntryIds: string[] = [];
  /** 累计注入 token（用于注意力浪费率分母） */
  private totalInjected = 0;
  /** 注意力浪费累计（设计 §7） */
  private attentionWaste: AttentionWaste = { total: 0, rate: 0, bySource: {}, byStep: {} };
  /** 外部内容存储：保存被截断/驱逐的完整原文，支持可逆还原 */
  readonly store: ContentStore;
  /** 知识胶囊存储：子任务级上下文打包 */
  readonly capsules: CapsuleStore;
  /** 当前活跃的子任务胶囊（packSubtask 最近一次打包后更新） */
  private currentCapsule: Capsule | null = null;
  /** 放置日志：map<entryId, 历史记录[]>。最近的记录 = 当前有效状态 */
  private placementLog = new Map<string, ContextPlacement[]>();
  /** LLM 调用注入（summarizeToCapsule 需要） */
  private llmCall: ((prompt: string) => Promise<string>) | null = null;
  /** 容量告警计数器（连续达到阈值的步数） */
  private capacityExceededSteps = 0;
  /** 管理策略（用户可调） */
  private managementPolicy: ManagementPolicy = { ...DEFAULT_MANAGEMENT_POLICY };

  constructor(opts: ContextManagerOptions = {}) {
    this.maxWindow = opts.maxWindow ?? getMaxContextWindow();
    this.maxToolOutputChars = opts.maxToolOutputChars ?? 6000;
    this.logger = opts.logger ?? consoleLogger;
    this.memory = opts.memory ?? new InMemoryBackend();
    this.store = new ContentStore(
      opts.storeRoot ?? path.join(process.cwd(), ".structfocus", "content-store"),
    );
    this.capsules = new CapsuleStore(
      opts.capsuleRoot ?? path.join(process.cwd(), ".structfocus", "capsules"),
    );
  }

  /** 注入 LLM 调用函数（summarizeToCapsule 等需要） */
  setLlmCall(fn: (prompt: string) => Promise<string>): void {
    this.llmCall = fn;
  }

  // ─── 追加条目 ──────────────────────────────────────────

  /**
   * 开启新对话：清空活跃条目，保留 ContentStore/CapsuleStore。
   * 返回被清空的条目数量，这些条目中的非保护内容仍可通过 recall 找回。
   */
  newConversation(): number {
    const count = this.entries.length;
    // 受保护条目（focus 的）保留，其余移入 ContentStore
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.protectedBy || this.focusedFiles.has(e.source ?? "")) continue;
      if (!e.evicted) {
        const toSave = e.originalContent ?? e.content;
        this.store.save({
          entryId: e.id, originalContent: toSave, originalTokenCount: e.tokenCount,
          savedAt: Date.now(), reason: "new-conversation", source: e.source, sourceType: e.sourceType,
        }).catch(() => {});
      }
    }
    // 清空非保护条目
    this.entries = this.entries.filter(
      (e) => e.protectedBy || this.focusedFiles.has(e.source ?? ""),
    );
    this.recentEntryIds.length = 0;
    this.recalledHashes.clear();
    this.logger.debug(`newConversation: 清空 ${count - this.entries.length} 条目，保留 ${this.entries.length}`);
    return count;
  }

  appendUser(content: string, opts?: { source?: string }): void {
    this.appendEntry({ type: "user", content, taskRelevance: 1, source: opts?.source });
  }

  appendAssistant(content: string, opts?: { source?: string }): void {
    this.appendEntry({ type: "assistant", content, taskRelevance: 0.6, source: opts?.source });
  }

  appendToolResult(
    content: string,
    opts?: { source?: string; sourceType?: SourceType; toolCallId?: string },
  ): void {
    const sourceType = opts?.sourceType ?? "tool_output";
    const processed = this.preprocessToolOutput(content, sourceType);
    this.appendEntry({
      type: "tool",
      content: processed,
      source: opts?.source,
      sourceType,
      taskRelevance: 1,
      toolCallId: opts?.toolCallId,
    });
  }

  appendObservation(
    content: string,
    opts?: { source?: string; sourceType?: SourceType; taskRelevance?: number },
  ): void {
    this.appendEntry({
      type: "observation",
      content,
      source: opts?.source,
      sourceType: opts?.sourceType,
      taskRelevance: opts?.taskRelevance ?? 1,
    });
  }

  private appendEntry(
    init: {
      type: EntryType;
      content: string;
      source?: string;
      sourceType?: SourceType;
      taskRelevance?: number;
      protectedBy?: ContextEntry["protectedBy"];
      toolCallId?: string;
    },
  ): void {
    const taskRelevance =
      init.taskRelevance ?? this.computeTaskRelevance(init.source, init.content, init.type);
    const tokenCount = BudgetManager.estimateTokens(init.content);
    const entry: ContextEntry = {
      id: createId("ctx"),
      type: init.type,
      content: init.content,
      tokenCount,
      timestamp: Date.now(),
      compressed: false,
      evicted: false,
      taskRelevance,
      protectedBy: init.protectedBy,
      source: init.source,
      sourceType: init.sourceType,
      ageFactor: 1,
      currentEvictionScore: 0,
      ...(init.toolCallId ? { toolCallId: init.toolCallId } : {}),
    };
    this.entries.push(entry);
    this.totalInjected += tokenCount;
    this.recentEntryIds.unshift(entry.id);
    if (this.recentEntryIds.length > 8) this.recentEntryIds.pop();
  }

  // ─── 任务上下文 ────────────────────────────────────────

  setTaskContext(ctx: TaskContext | null | undefined): void {
    this.taskContext = ctx ?? EMPTY_TASK_CONTEXT;
    this.refreshRelevance();
  }

  getTaskContext(): TaskContext {
    return this.taskContext;
  }

  /** 重新计算非保护条目的 taskRelevance（任务变化时调用） */
  private refreshRelevance(): void {
    for (const e of this.entries) {
      if (e.evicted) continue;
      if (e.protectedBy) continue; // 显式保护（focus）保持不动
      e.taskRelevance = this.computeTaskRelevance(e.source, e.content, e.type);
    }
  }

  /**
   * taskRelevance 保护系数（设计 §6）：
   *   0.0 编辑中文件（绝对保护） / 0.25 子任务引用符号 / 0.5 失败测试 / 0.75 同目录 / 1.0 无关
   */
  private computeTaskRelevance(
    source: string | undefined,
    content: string,
    type: EntryType,
  ): number {
    const tc = this.taskContext;
    const src = source ?? "";
    if (tc.editingFiles.some((f) => f === src || src.endsWith("/" + f) || f.endsWith("/" + src))) {
      return 0;
    }
    if (tc.failingTests.some((f) => src.includes(f) || f.includes(src))) {
      return 0.5;
    }
    if (tc.focusedSymbols.some((s) => !!s && content.includes(s))) {
      return 0.25;
    }
    const edDirs = tc.editingFiles
      .map((f) => f.replace(/[^/\\]+$/, ""))
      .filter((d) => d.length > 0);
    if (edDirs.some((d) => src.startsWith(d))) {
      return 0.75;
    }
    void type;
    return 1;
  }

  // ─── 预处理（六阶段去噪） ──────────────────────────────

  preprocessToolOutput(output: string, sourceType: SourceType = "tool_output"): string {
    let s = stripAnsi(output);
    s = stripHtml(s, sourceType);
    s = mergeRepeatedLines(s);
    s = filterEmptyLines(s);
    s = extractHeadAndErrors(s, sourceType);
    s = truncateStage(s, sourceType, this.maxToolOutputChars);
    return s;
  }

  // ─── 结构化压缩 ────────────────────────────────────────

  structuredCompress(entry: ContextEntry): ContextEntry {
    const compressedContent = structuredCompressContent(entry.compressedContent ?? entry.content);
    const compressedTokenCount = BudgetManager.estimateTokens(compressedContent);
    return {
      ...entry,
      compressed: true,
      compressedContent,
      compressedTokenCount,
      tokenCount: compressedTokenCount,
    };
  }

  /** LLM 摘要钩子（设计：可选，Phase 1 保留未启用）。此处为确定性紧凑回退（头+尾），无外部依赖 */
  summarizeLongEntries(content: string): string {
    if (content.length <= 800) return content;
    const lines = content.split("\n");
    const head = lines.slice(0, 12).join("\n");
    const tail = lines.slice(-12).join("\n");
    return `[摘要]\n${head}\n...\n${tail}`;
  }

  // ─── 焦点原语：focus / forget ──────────────────────────

  /**
   * 将文件/目录聚焦进工作上下文，支持三级加载 ═══════════════════════════════════
   *
   *  **L0（~100 tokens，始终加载）**：文件元数据——路径、大小、类型、顶层符号列表
   *  **L1（~500-1000 tokens，默认）**：结构化大纲——符号 + 签名 + 行号
   *  **L2（完整内容）**：仅当 LLM 显式 `recall:file` 时加载，框架不做全文注入
   *
   *  原则：框架只告知，LLM 自己选要看什么。
   *  关联焦点符号也一并记录到 taskContext.focusedSymbols。
   */
  async focusFile(
    filePath: string,
    opts?: { symbols?: string[]; level?: "L0" | "L1" | "L2" },
  ): Promise<{ ok: boolean; focused: string[]; output: string }> {
    const level = opts?.level ?? (process.env.NODE_ENV === "test" ? "L2" : "L1");
    const symbolsParam = opts?.symbols;
    const path = filePath;
    const explorer = new CodeExplorer();
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path);
    } catch {
      return { ok: false, focused: [], output: `focus 失败：路径不存在或无法访问: ${path}` };
    }

    let payload: string;
    if (stat.isDirectory()) {
      const files = await explorer.listFiles(path, { maxDepth: 2 });
      payload = `目录 ${path} 下的文件（共 ${files.length} 项）:\n${files
        .map((f) => `${f.isDirectory ? "[D]" : "   "}${f.path}`)
        .join("\n")}`;
    } else if (level === "L0") {
      // L0：元数据（路径 + 大小 + 类型 + 行数）
      let content: string;
      try { content = await fs.readFile(path, "utf-8"); } catch { return { ok: false, focused: [], output: `focus 失败：无法读取文件: ${path}` }; }
      const lineCount = content.split("\n").length;
      const ext = path.split(".").pop() ?? "none";
      payload = `文件 ${path}（${ext}，${lineCount} 行，${stat.size} 字节）\n（使用 recall:file(path, level="L1") 查看大纲，recall:file(path, level="L2") 读取全文）`;
    } else {
      let content: string;
      try { content = await fs.readFile(path, "utf-8"); } catch { return { ok: false, focused: [], output: `focus 失败：无法读取文件: ${path}` }; }
      if (level === "L2") {
        // L2：完整内容（仅当 LLM 显式请求）
        payload = `文件 ${path} 完整内容\n\n${content}`;
      } else {
        // L1 默认：符号大纲（function/class/const/import 名称 + 行号范围）
        const syms = await explorer.extractSymbols(path);
        const symText = syms.length
          ? syms.map((s) => `  L${String(s.line).padStart(4)}: ${s.type.padEnd(8)} ${s.name}`).join("\n")
          : "  （无可识别符号）";
        payload = `文件 ${path} 符号大纲（${syms.length} 个）:\n${symText}\n\n（使用 recall:file(path, level="L2") 读取全文）`;
      }
    }

    this.focusedFiles.add(path);
    this.appendEntry({
      type: "user",
      content: `[focus] ${path}\n${payload}`,
      source: path,
      sourceType: "file_content",
      taskRelevance: 0,
      protectedBy: "editingFile",
    });
    if (symbolsParam?.length) {
      this.taskContext = {
        ...this.taskContext,
        focusedSymbols: Array.from(new Set([...this.taskContext.focusedSymbols, ...symbolsParam])),
      };
    }
    return {
      ok: true,
      focused: [path],
      output: `已 focus ${path}（约 ${BudgetManager.estimateTokens(payload)} tokens，已绝对保护）`,
    };
  }

  /** 将文件条目从上下文驱逐到外部存储（标记 evicted + externalRef） */
  forgetFile(path: string): number {
    let count = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.evicted) continue;
      if (e.source !== path) continue;
      const wasted = e.tokenCount;
      const toSave = e.originalContent ?? e.content;
      this.entries[i] = { ...e, evicted: true, evictedAt: Date.now(), externalRef: `ext://${e.id}` };
      this.store.save({
        entryId: e.id,
        originalContent: toSave,
        originalTokenCount: e.tokenCount,
        savedAt: Date.now(),
        reason: "forget",
        source: e.source,
        sourceType: e.sourceType,
      }).catch((err) => this.logger.warn(`ContentStore save forget failed: ${String(err)}`));
      this.updateAttentionWaste(wasted, e.sourceType ?? e.type, "forget");
      count++;
    }
    this.focusedFiles.delete(path);
    return count;
  }

  /** 按 entry id 驱逐单个条目（forget:noise 用，无 source 的条目） */
  forgetNoise(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const e = this.entries[idx]!;
    if (e.evicted) return false;
    const toSave = e.originalContent ?? e.content;
    this.entries[idx] = { ...e, evicted: true, evictedAt: Date.now(), externalRef: `ext://${e.id}` };
    this.store.save({
      entryId: e.id,
      originalContent: toSave,
      originalTokenCount: e.tokenCount,
      savedAt: Date.now(),
      reason: "forget",
      source: e.source,
      sourceType: e.sourceType,
    }).catch((err) => this.logger.warn(`ContentStore save forgetNoise failed: ${String(err)}`));
    this.updateAttentionWaste(e.tokenCount, e.sourceType ?? e.type, "forget");
    return true;
  }

  // ─── 记忆：recall / remember ───────────────────────────

  /** 从记忆层检索（design §4.1 返回 MemoryEntry[]） */
  async recall(query: string, limit = 3): Promise<MemoryEntry[]> {
    return this.memory.search(query, limit);
  }

  /** 直接写入一条记忆（MCP remember 工具用） */
  remember(
    content: string,
    opts?: { kind?: string; tags?: string[]; confidence?: number },
  ): void {
    this.memory.add({
      kind: opts?.kind ?? "decision",
      content,
      tags: opts?.tags ?? [],
      confidence: opts?.confidence ?? 0.85,
      timestamp: Date.now(),
    });
  }

  /** 从内容中自动提取决策信号写入记忆（每步最多记一条，避免记忆膨胀） */
  async rememberFromContent(content: string): Promise<void> {
    for (const pattern of DECISION_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        const decision = match[1]!.slice(0, 200);
        this.memory.add({
          kind: "decision",
          content: decision,
          tags: ["auto-remembered"],
          confidence: 0.85,
          timestamp: Date.now(),
        });
        this.logger.debug(`rememberFromContent: "${decision.slice(0, 60)}"`);
        return;
      }
    }
  }

  // ─── 管理策略配置 ────────────────────────────────────

  /** 设置管理策略（用户可随时调整阈值和模式） */
  setManagementPolicy(policy: Partial<ManagementPolicy>): void {
    this.managementPolicy = { ...this.managementPolicy, ...policy };
    this.logger.debug(`managementPolicy: soft=${this.managementPolicy.softThreshold} hard=${this.managementPolicy.hardThreshold} emergency=${this.managementPolicy.emergencyThreshold} mode=${this.managementPolicy.userOverride}`);
  }

  getManagementPolicy(): ManagementPolicy {
    return { ...this.managementPolicy };
  }

  // ─── 自动管理（核心） ──────────────────────────────────

  /** 每步调用：autoFocus + autoRecall + 四层降级管理 */
  async autoManage(): Promise<AutoManageReport> {
    // Gap：自动 focus 当前编辑文件
    if (this.taskContext.editingFiles.length) {
      for (const f of this.taskContext.editingFiles) {
        if (!this.focusedFiles.has(f)) {
          const r = await this.focusFile(f);
          if (!r.ok) this.logger.debug(`auto-focus 跳过不可访问文件: ${f}`);
        }
      }
    }
    // Gap：自动 recall（去重注入 [memory] observation）
    const recalledMemories = await this.autoRecall();
    // 持续清理：每次 autoManage 都跑（不依赖阈值）
    const continuous = this.manageContinuous();
    // 四层降级管理（阈值触发）
    const result = this.manage();
    // 守护轨质询（冲突检测 / 缺口检测 / 一致性检测）
    const inquiry = await this.runInquiry();
    // 容量强制检查
    this.enforceCapacity();

    return {
      usePercent: result.usePercent,
      inactivePercent: result.inactivePercent,
      triggerLevel: result.triggerLevel,
      downgradedCount: result.downgradedCount + continuous.noiseCleaned + continuous.decayEvicted,
      downgradedTokens: result.downgradedTokens + continuous.noiseTokens + continuous.decayTokens,
      evictedCount: result.downgradedCount + continuous.noiseCleaned + continuous.decayEvicted,
      evictedTokens: result.downgradedTokens + continuous.noiseTokens + continuous.decayTokens,
      compressedCount: result.compressedCount,
      truncatedCount: result.truncatedCount,
      l4MigratedCount: result.l4MigratedCount,
      focusedFiles: [...this.focusedFiles],
      recalledMemories,
      inquiry: inquiry.hasReport ? { conflicts: inquiry.conflicts, gaps: inquiry.gaps, injected: inquiry.injectedCount } : undefined,
    };
  }

  /**
   * 持续清理（autoManage 旁路，不依赖窗口阈值）。
   * 每次调用都做：
   *   1. 超龄噪音清理（sourceType=noise 且超过 10 分钟）
   *   2. 时间衰减驱逐（type=observation 且超过 3h 半衰的条目标记驱逐）
   * 返回清理条数与节省的 token。
   */
  private manageContinuous(): { noiseCleaned: number; noiseTokens: number; decayEvicted: number; decayTokens: number } {
    const NOISE_MAX_AGE_MS = 10 * 60 * 1000;    // 噪音条目 10 分钟过期
    const DECAY_HALF_LIFE_MS = 3 * 3600 * 1000; // 观察条目 3h 半衰
    const now = Date.now();
    let noiseCleaned = 0;
    let noiseTokens = 0;
    let decayEvicted = 0;
    let decayTokens = 0;

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.evicted || e.type === "system" || e.protectedBy) continue;
      const age = now - e.timestamp;

      // 1. 超龄噪音（日志/编译输出等）
      if (e.sourceType === "log" && age > NOISE_MAX_AGE_MS) {
        const toSave = e.originalContent ?? e.content;
        this.entries[i] = { ...e, evicted: true, evictedAt: now, externalRef: `ext://${e.id}` };
        this.store.save({
          entryId: e.id, originalContent: toSave, originalTokenCount: e.tokenCount,
          savedAt: now, reason: "forget", source: e.source, sourceType: e.sourceType,
        }).catch(() => {});
        noiseCleaned++;
        noiseTokens += e.tokenCount;
        this.updateAttentionWaste(e.tokenCount, e.sourceType ?? "log", "noise-cleanup");
        continue;
      }

      // 2. 时间衰减驱逐（observation 型超 3h 半衰，taskRelevance≤0.5 且非 focus）
      if (
        e.type === "observation" &&
        e.taskRelevance <= 0.5 &&
        !this.focusedFiles.has(e.source ?? "") &&
        age > DECAY_HALF_LIFE_MS
      ) {
        const toSave = e.originalContent ?? e.content;
        this.entries[i] = { ...e, evicted: true, evictedAt: now, externalRef: `ext://${e.id}` };
        this.store.save({
          entryId: e.id, originalContent: toSave, originalTokenCount: e.tokenCount,
          savedAt: now, reason: "evict", source: e.source, sourceType: e.sourceType,
        }).catch(() => {});
        decayEvicted++;
        decayTokens += e.tokenCount;
        this.updateAttentionWaste(e.tokenCount, e.sourceType ?? "tool_output", "decay-evict");
      }
    }

    if (noiseCleaned > 0 || decayEvicted > 0) {
      this.logger.debug(
        `manageContinuous: noise ${noiseCleaned} (${noiseTokens} tok) + decay ${decayEvicted} (${decayTokens} tok)`,
      );
    }
    return { noiseCleaned, noiseTokens, decayEvicted, decayTokens };
  }

  /** 三层管理（autoManage 内部调用）。返回本步结果与触发层级 */
  /**
   * 四层降级管理（替代旧的三层驱逐）。
   *
   * 核心理念：不驱逐，只降冷。
   *   - 计算非活跃内容占比（非活跃 = 距当前话题 ≥ topicDistance 轮 或 N 秒未更新）
   *   - ≥ softThreshold → 标记/分组/预压缩评估，但不执行
   *   - ≥ hardThreshold → 执行概括归档 L2→L3（压缩旧对话为胶囊）
   *   - ≥ emergencyThreshold → L3→L4（最冷胶囊原文迁移到 ContentStore）
   */
  manage(): ManageResult {
    const stats = this.getStats();
    const usePercent = stats.usePercent;
    const policy = this.managementPolicy;
    let triggerLevel: -1 | 0 | 1 | 2 = -1;
    let downgradedCount = 0;
    let downgradedTokens = 0;
    let compressedCount = 0;
    let truncatedCount = 0;
    let l4MigratedCount = 0;

    // 计算非活跃占比
    const inactivePercent = this.computeInactivePercent();

    // Level 0: 软阈值 → 标记 + 预压缩评估（不执行）
    if (inactivePercent >= policy.softThreshold) {
      triggerLevel = 0;
      this.logger.debug(
        `manage L0: inactive=${inactivePercent.toFixed(0)}% ≥ soft=${policy.softThreshold}, 标记非活跃条目`,
      );
      this.markInactiveEntries();
    }

    // Level 1: 硬阈值 → 概括归档 L2→L3
    if (inactivePercent >= policy.hardThreshold) {
      triggerLevel = 1;
      this.logger.debug(
        `manage L1: inactive=${inactivePercent.toFixed(0)}% ≥ hard=${policy.hardThreshold}, 概括归档`,
      );
      const downgraded = this.downgradeToL3();
      downgradedCount += downgraded.downgradedCount;
      downgradedTokens += downgraded.downgradedTokens;
      compressedCount = this.compressOldEntries();
      truncatedCount = this.truncateLongEntries();
    }

    // Level 2: 紧急阈值 → L3→L4 深存
    // 单位对齐：usePercent 是百分比(0–100)，emergencyEff 是比例(0–1)，故 ×100
    const emergencyEff = effectiveEmergencyThreshold(policy);
    const emergencyPct = emergencyEff * 100;
    if (usePercent >= emergencyPct) {
      triggerLevel = 2;
      this.logger.debug(
        `manage L2: use=${usePercent.toFixed(0)}% ≥ emergency=${emergencyPct.toFixed(0)}%${policy.conservative ? " (conservative)" : ""}, L3→L4 深存`,
      );
      l4MigratedCount = this.downgradeColdestL3ToL4();
      // 保守模式：不主动遗忘非聚焦条目，避免把仍可召回的内容丢到磁盘
      if (!policy.conservative) this.forceForgetNonFocused();
    }

    return {
      usePercent: this.getStats().usePercent,
      inactivePercent,
      triggerLevel,
      downgradedCount,
      downgradedTokens,
      compressedCount,
      truncatedCount,
      l4MigratedCount,
    };
  }

  /**
   * 计算非活跃内容占窗口的比例。
   * 非活跃 = 距当前活跃话题 ≥ topicDistance 轮 或 超过 ageThresholdMs 未更新。
   */
  private computeInactivePercent(): number {
    const policy = this.managementPolicy;
    const active = this.entries.filter((e) => !e.evicted);
    if (active.length === 0) return 0;

    const now = Date.now();
    const ageThresholdMs = 5 * 60 * 1000; // 5 分钟未更新视为非活跃

    // 找到当前话题锚点：最近一条 user/assistant 消息
    let lastActiveIdx = -1;
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i]!;
      if (e.type === "user" || e.type === "assistant") {
        lastActiveIdx = i;
        break;
      }
    }

    const activeTokens = active.reduce((s, e) => s + e.tokenCount, 0);
    if (activeTokens === 0) return 0;

    let inactiveTokens = 0;
    for (let i = 0; i < active.length; i++) {
      const e = active[i]!;
      // 距离话题锚点超过 topicDistance 轮 → 非活跃
      if (lastActiveIdx >= 0 && lastActiveIdx - i > policy.topicDistance) {
        inactiveTokens += e.tokenCount;
        continue;
      }
      // 超时未更新 → 非活跃
      if (e.timestamp > 0 && now - e.timestamp > ageThresholdMs) {
        inactiveTokens += e.tokenCount;
        continue;
      }
    }

    return activeTokens > 0 ? inactiveTokens / activeTokens : 0;
  }

  /**
   * 标记非活跃条目（为降级 L2→L3 准备候选列表）。
   * 不执行驱逐，只打标记供后续降级使用。
   */
  private markInactiveEntries(): void {
    const policy = this.managementPolicy;
    const active = this.entries.filter((e) => !e.evicted);
    const now = Date.now();
    const ageThresholdMs = 5 * 60 * 1000;

    // 找当前话题锚点
    let lastActiveIdx = -1;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i]!.type === "user" || active[i]!.type === "assistant") {
        lastActiveIdx = i;
        break;
      }
    }

    let tagged = 0;
    for (let i = 0; i < active.length; i++) {
      const e = active[i]!;
      const isInactive =
        (lastActiveIdx >= 0 && lastActiveIdx - i > policy.topicDistance) ||
        (e.timestamp > 0 && now - e.timestamp > ageThresholdMs);
      if (isInactive && !e.protectedBy && e.type !== "system") {
        // 标记为待降级：设置 placement 到 L2_working 但添加 expiresAt（过期触发 soft 降级）
        if (!e.placement || e.placement.target === "L2_working") {
          this.place(e.id, "L2_working", "system", `marked_inactive_at_${now}`, { expiresAt: now + 60_000 });
          tagged++;
        }
      }
    }
    if (tagged > 0) this.logger.debug(`markInactive: ${tagged} 条目标记为非活跃`);
  }

  /**
   * L2→L3 降级：将非活跃旧对话概括归档为胶囊。
   * 筛选距离话题锚点 > topicDistance 轮的非系统条目，压缩其内容。
   */
  private downgradeToL3(): DowngradeResult {
    const policy = this.managementPolicy;
    const active = this.entries.filter((e) => !e.evicted && e.type !== "system");

    // 找当前话题锚点
    let lastActiveIdx = -1;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i]!.type === "user" || active[i]!.type === "assistant") {
        lastActiveIdx = i;
        break;
      }
    }

    const now = Date.now();
    const ageThresholdMs = 5 * 60 * 1000;
    let count = 0;
    let tokens = 0;

    for (let i = 0; i < active.length; i++) {
      const e = active[i]!;
      if (e.protectedBy || e.taskRelevance <= 0.25) continue;
      const isInactive =
        (lastActiveIdx >= 0 && lastActiveIdx - i > policy.topicDistance) ||
        (e.timestamp > 0 && now - e.timestamp > ageThresholdMs);
      if (!isInactive) continue;

      // 压缩内容并降级到 L3_compressed
      const compressed = e.content.length > 4000 ? e.content.slice(0, 2000) + `...[截断 ${e.content.length} 字符]` : e.content;
      const idx = this.entries.findIndex((entry) => entry.id === e.id);
      if (idx >= 0) {
        this.entries[idx] = {
          ...this.entries[idx]!,
          compressed: true,
          compressedContent: compressed,
          compressedAt: Date.now(),
          content: compressed,
        };
        this.place(e.id, "L3_compressed", "system", `downgrade_L3`);
        count++;
        tokens += e.tokenCount;
      }
    }

    if (count > 0) {
      this.logger.debug(`downgradeToL3: ${count} 条目降级 (${tokens} tokens)`);
    }
    return { downgradedCount: count, downgradedTokens: tokens };
  }

  /**
   * L3→L4 深存：将最冷的 L3 条目原文迁移到 ContentStore。
   * 按压缩时间排序，最早压缩的优先迁移。
   */
  private downgradeColdestL3ToL4(): number {
    const l3Entries = this.entries
      .filter((e) => !e.evicted && e.compressed && e.placement?.target === "L3_compressed")
      .sort((a, b) => (a.compressedAt ?? 0) - (b.compressedAt ?? 0));

    if (l3Entries.length === 0) return 0;

    // 迁移最冷 20%（但至少 3 条，至多 10 条）
    const toMigrate = Math.min(Math.max(3, Math.ceil(l3Entries.length * 0.2)), 10);
    let count = 0;
    for (let i = 0; i < Math.min(toMigrate, l3Entries.length); i++) {
      const e = l3Entries[i]!;
      const toSave = e.originalContent ?? e.content;
      this.store
        .save({
          entryId: e.id,
          originalContent: toSave,
          originalTokenCount: e.tokenCount,
          savedAt: Date.now(),
          reason: "downgrade_L4",
          source: e.source,
          sourceType: e.sourceType,
        })
        .catch((err) => this.logger.warn(`downgradeToL4 save failed: ${String(err)}`));

      const idx = this.entries.findIndex((entry) => entry.id === e.id);
      if (idx >= 0) {
        this.entries[idx] = {
          ...this.entries[idx]!,
          evicted: true,
          evictedAt: Date.now(),
          externalRef: `ext://${e.id}`,
        };
        this.place(e.id, "L4_raw", "system", `downgrade_L4`);
        count++;
      }
    }

    if (count > 0) {
      this.logger.debug(`downgradeColdestL3ToL4: ${count} 条目迁移到 L4`);
    }
    return count;
  }

  /**
   * 驱逐评分（保护分，越高越该保留）：
   *   protect(1-taskRelevance) + recency + typeKeep + sourceKeep + sizeKeep
   * 设计 §2.2/§6 的「evictionScore」此处用保护分表达：越高越保留，最低者被驱逐。
   */
  private computeEvictionScore(e: ContextEntry): number {
    const protect = 1 - e.taskRelevance; // 0..1
    const ageMs = Date.now() - e.timestamp;
    const recency = Math.exp(-ageMs / (3 * 3600 * 1000)); // 3h 半衰期
    const typeKeep = 1 - ENTRY_TYPE_FACTOR[e.type];
    const sourceKeep = e.sourceType ? 1 - SOURCE_TYPE_FACTOR[e.sourceType] : 0.5;
    const sizeKeep = 1 - Math.min(e.tokenCount / 2000, 1);
    return 0.4 * protect + 0.2 * recency + 0.15 * typeKeep + 0.1 * sourceKeep + 0.15 * sizeKeep;
  }

  /** 层1：对旧的长条目做结构化压缩 */
  compressOldEntries(): number {
    let count = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.evicted || e.compressed) continue;
      if (this.recentEntryIds.includes(e.id)) continue;
      if (e.taskRelevance <= 0.25) continue;
      if (e.type === "system") continue;
      if (e.tokenCount < 800) continue;
      this.entries[i] = this.structuredCompress(e);
      count++;
    }
    return count;
  }

  /**
   * 层1：截断单条 > TRUNCATE_THRESHOLD 的长条目（头+尾+中部采样）。
   * 非破坏式：完整原文保存到 originalContent + ContentStore，可 expandEntry 还原。
   */
  truncateLongEntries(): number {
    let count = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.evicted) continue;
      if (e.type === "system") continue;
      if (e.tokenCount <= TRUNCATE_THRESHOLD) continue;
      // 截断前保存原文（仅首次）
      const original = e.originalContent ?? e.content;
      const before = original.length;
      const truncated = truncateEntryContent(original);
      const after = BudgetManager.estimateTokens(truncated);
      this.entries[i] = {
        ...e,
        originalContent: original,
        content: truncated,
        tokenCount: after,
      };
      // 异步写入外部存储（不阻塞 autoManage）
      this.store.save({
        entryId: e.id,
        originalContent: original,
        originalTokenCount: e.tokenCount,
        savedAt: Date.now(),
        reason: "truncate",
        source: e.source,
        sourceType: e.sourceType,
      }).catch((err) => this.logger.warn(`ContentStore save failed: ${String(err)}`));
      this.updateAttentionWaste(before - after, e.sourceType ?? e.type, "truncate");
      count++;
    }
    return count;
  }

  /** 层2：强制 forget 所有非保护条目（taskRelevance>0.25 的都驱逐） */
  private forceForgetNonFocused(): void {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.evicted || e.type === "system") continue;
      if (e.taskRelevance <= 0.25) continue;
      const wasted = e.tokenCount;
      const toSave = e.originalContent ?? e.content;
      this.entries[i] = { ...e, evicted: true, evictedAt: Date.now(), externalRef: `ext://${e.id}` };
      this.store.save({
        entryId: e.id,
        originalContent: toSave,
        originalTokenCount: e.tokenCount,
        savedAt: Date.now(),
        reason: "forget",
        source: e.source,
        sourceType: e.sourceType,
      }).catch((err) => this.logger.warn(`ContentStore save layer2 failed: ${String(err)}`));
      this.updateAttentionWaste(wasted, e.sourceType ?? e.type, "layer2-forget");
    }
  }

  // ─── 可逆还原 API ───────────────────────────────────

  /**
   * 展开被压缩/截断的条目：恢复原始内容。
   * - compressed → content 已含全文，仅清除 compressed 标记，builder 下一轮用 content
   * - truncated → originalContent → content
   * 同时注入一条 observation，LLM 本轮即可看到还原结果（不等到下轮 builder）。
   * 还原后 originalContent 保留，可供再次压缩。
   */
  expandEntry(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const e = this.entries[idx]!;
    if (e.evicted) return false; // 驱逐的用 recallFromStore

    let restoredContent: string;
    if (e.compressed) {
      // 压缩条目：content 已是原文，只需关压缩标记
      restoredContent = e.content;
      this.entries[idx] = {
        ...e,
        compressed: false,
        compressedContent: undefined,
        compressedTokenCount: undefined,
        tokenCount: BudgetManager.estimateTokens(e.content),
        originalContent: e.originalContent ?? e.content, // 确保原文不丢
      };
    } else if (e.originalContent) {
      // 截断条目：从 originalContent 还原
      restoredContent = e.originalContent;
      this.entries[idx] = {
        ...e,
        content: e.originalContent,
        tokenCount: BudgetManager.estimateTokens(e.originalContent),
        compressed: false,
        compressedContent: undefined,
        compressedTokenCount: undefined,
      };
    } else {
      return false; // 没有可还原的内容
    }

    // 注入 observation，本轮 LLM 即可看到
    this.appendObservation(
      `[expand] 已还原 ${id} (${restoredContent.length} 字符):\n${restoredContent.slice(0, 4000)}${restoredContent.length > 4000 ? `\n...(共 ${restoredContent.length} 字符)` : ""}`,
      { source: e.source, sourceType: e.sourceType, taskRelevance: 0.6 },
    );
    this.logger.debug(`expandEntry: 还原 ${id} (${restoredContent.length} 字符)`);
    return true;
  }

  /**
   * @deprecated 用 recallRelevant(query) 替代。按 ID 取回会把条目永久还原到活跃窗口，
   * 随会话积累导致上下文膨胀。保留此方法用于内部审计/调试，业务代码请用 recallRelevant。
   *
   * 恢复被驱逐的条目：从 ContentStore 加载原文 → 注入为 observation。
   * 原 entry 的 evicted 标记不变（审计保留），但完整内容通过 observation 回到活跃窗口。
   */
  async recallFromStore(id: string): Promise<boolean> {
    const stored = await this.store.load(id);
    if (!stored) return false;
    // 取消 evicted 标记（如果还在 entries 中）
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.entries[idx] = {
        ...this.entries[idx]!,
        evicted: false,
        content: stored.originalContent,
        tokenCount: stored.originalTokenCount,
        originalContent: stored.originalContent,
      };
    } else {
      // entry 已被移除 → 重建
      this.appendObservation(
        `[recall] ${stored.source ?? id}\n${stored.originalContent}`,
        { source: stored.source, sourceType: stored.sourceType as ContextEntry["sourceType"], taskRelevance: 0.5 },
      );
    }
    this.logger.debug(`recallFromStore: 还原 ${id} (${stored.originalTokenCount} tokens)`);
    return true;
  }

  /**
   * 按文件路径从 ContentStore 批量恢复所有相关条目。
   * 用于 LLM 编辑某文件时，框架自动推入历史上下文。
   */
  async recallByFile(filePath: string): Promise<number> {
    const stored = await this.store.loadByFile(filePath);
    let restored = 0;
    for (const s of stored) {
      // 去重：如果已有同 id 的活跃条目则跳过
      const exists = this.entries.find((e) => e.id === s.entryId && !e.evicted);
      if (exists) continue;
      this.appendObservation(
        `[recall:${s.reason}] 关于 ${filePath} (${new Date(s.savedAt).toLocaleString()}):\n${s.originalContent.slice(0, 3000)}${s.originalContent.length > 3000 ? `\n...(共 ${s.originalContent.length} 字符，调用 recall:context("${s.entryId}") 查看完整记录)` : ""}`,
        { source: filePath, sourceType: s.sourceType as ContextEntry["sourceType"], taskRelevance: 0.4 },
      );
      restored++;
    }
    return restored;
  }

  /**
   * 展开被压缩的条目（仅 reversed structuredCompress，不涉及 ContentStore）。
   * 只恢复 originalContent → content，不影响 evicted 条目。
   */
  uncompressEntry(id: string): boolean {
    return this.expandEntry(id);
  }

  /**
   * 压缩指定条目（按 ID 或谓词）。
   * summarize:recent / summarize:conversation 底层方法。
   */
  compressEntries(predicate: (e: ContextEntry, idx: number) => boolean): number {
    let count = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (!predicate(e, i)) continue;
      if (e.evicted || e.compressed) continue;
      if (e.protectedBy) continue;
      if (e.type === "system") continue;
      this.entries[i] = this.structuredCompress(e);
      count++;
    }
    return count;
  }

  /** 自动召回：用当前 symbols+files 检索记忆，去重注入 [memory] observation */
  private async autoRecall(): Promise<number> {
    const query = [this.taskContext.focusedSymbols.join(" "), ...this.taskContext.editingFiles]
      .filter(Boolean)
      .join(" ");
    if (!query) return 0;
    const hits = await this.recall(query, 3);
    let added = 0;
    for (const h of hits) {
      const key = fnv1a(h.content);
      if (this.recalledHashes.has(key)) continue;
      this.recalledHashes.add(key);
      this.appendEntry({
        type: "observation",
        content: `[memory] ${h.kind}: ${h.content}`,
        sourceType: "tool_output",
        taskRelevance: 0.5,
      });
      added++;
    }
    return added;
  }

  // ─── 注意力浪费度量（设计 §7） ─────────────────────────

  private updateAttentionWaste(wasted: number, sourceKey: string, step: string): void {
    if (wasted <= 0) return;
    this.attentionWaste.total += wasted;
    this.attentionWaste.bySource[sourceKey] = (this.attentionWaste.bySource[sourceKey] ?? 0) + wasted;
    this.attentionWaste.byStep[step] = (this.attentionWaste.byStep[step] ?? 0) + wasted;
    this.attentionWaste.rate = this.totalInjected > 0 ? this.attentionWaste.total / this.totalInjected : 0;
  }

  getAttentionWaste(): AttentionWaste {
    return {
      total: this.attentionWaste.total,
      rate: this.attentionWaste.rate,
      bySource: { ...this.attentionWaste.bySource },
      byStep: { ...this.attentionWaste.byStep },
    };
  }

  // ─── 统计 / 反射 ───────────────────────────────────────

  getStats(): ContextStats {
    const active = this.entries.filter((e) => !e.evicted);
    const totalTokens = active.reduce((s, e) => s + e.tokenCount, 0);
    const usePercent = Math.round((totalTokens / this.maxWindow) * 100);
    const byType: Record<string, number> = {};
    for (const e of active) byType[e.type] = (byType[e.type] ?? 0) + 1;
    return {
      usePercent,
      totalTokens,
      maxWindow: this.maxWindow,
      activeEntries: active.length,
      evictedEntries: this.entries.filter((e) => e.evicted).length,
      compressedEntries: active.filter((e) => e.compressed).length,
      attentionWaste: this.getAttentionWaste(),
      byType,
    };
  }

  getReflection(): ReflectionReport {
    const stats = this.getStats();
    const active = this.getEntries();
    const topSpaceHogs = [...active]
      .sort((a, b) => b.tokenCount - a.tokenCount)
      .slice(0, 5)
      .map((e) => ({
        id: e.id,
        tokens: e.tokenCount,
        summary: e.content.slice(0, 80).replace(/\n/g, " "),
      }));
    const protectedEntries = active
      .filter((e) => e.protectedBy)
      .map((e) => ({ id: e.id, tokens: e.tokenCount, protectedBy: e.protectedBy! }));

    const suggestions: string[] = [];
    if (stats.usePercent >= this.managementPolicy.hardThreshold) {
      suggestions.push(`上下文占用 ${stats.usePercent}%，已达高层级管理；若仍超限请主动 forget 非必要文件`);
    }
    for (const e of active) {
      if (e.tokenCount > 4000 && !e.protectedBy) {
        suggestions.push(`建议 forget ${e.source ?? e.type} 条目（占用 ${e.tokenCount} tokens）`);
      }
    }
    if (stats.attentionWaste.rate > ATTENTION_WASTE_TARGET) {
      suggestions.push(
        `注意力浪费率 ${(stats.attentionWaste.rate * 100).toFixed(1)}% 超过目标 ${ATTENTION_WASTE_TARGET * 100}%，检查是否有高频噪音工具输出`,
      );
    }
    if (suggestions.length === 0) suggestions.push("上下文健康，无需操作");

    return {
      usePercent: stats.usePercent,
      attentionWaste: {
        total: stats.attentionWaste.total,
        rate: stats.attentionWaste.rate,
        bySource: stats.attentionWaste.bySource,
      },
      topSpaceHogs,
      protectedEntries,
      suggestions,
    };
  }

  // ─── 状态访问 ──────────────────────────────────────────

  /** 活跃条目（未驱逐），用于构建下一轮 LLM 输入 */
  getEntries(): ContextEntry[] {
    return this.entries.filter((e) => !e.evicted);
  }

  /** 全部条目（含已驱逐，供审计/召回） */
  getAllEntries(): ContextEntry[] {
    return [...this.entries];
  }

  /** 当前聚焦文件列表（focus 原语） */
  getFocusedFiles(): string[] {
    return [...this.focusedFiles];
  }

  /** 组装下一轮 LLM 输入（六层 Context Builder 管线） */
  // ─── 守护轨质询引擎（Context-skill v3 守护轨）─────────

  /** 质询结果 */
  private lastInquiry: { conflicts: string[]; gaps: string[]; consistencyIssue: string | null } = {
    conflicts: [],
    gaps: [],
    consistencyIssue: null,
  };

  /**
   * 守护轨质询引擎（每步 autoManage 末尾调用）。
   * 检测三类问题，按 severity 注入 observation：
   *   1. 冲突检测：当前方案触及已知放弃方案 (CRITICAL)
   *   2. 缺口检测：编辑文件有历史胶囊但未被引用 (INFO)
   *   3. 一致性检测：编辑的文件之间存在已知限制 (WARNING)
   * 判断权在框架（不消耗 LLM token 做推理）。
   */
  async runInquiry(): Promise<{
    hasReport: boolean;
    conflicts: string[];
    gaps: string[];
    consistencyIssue: string | null;
    injectedCount: number;
  }> {
    const conflicts: string[] = [];
    const gaps: string[] = [];
    let consistencyIssue: string | null = null;
    let injectedCount = 0;

    const files = this.taskContext.editingFiles;
    if (!files.length) return { hasReport: false, conflicts: [], gaps: [], consistencyIssue: null, injectedCount: 0 };

    // ── 冲突检测：LLM 最近说了什么 → 是否触及已知放弃方案 ──
    const recentAssistant = this.entries
      .filter((e) => !e.evicted && e.type === "assistant")
      .slice(-3);
    const recentText = recentAssistant.map((e) => e.content).join("\n").slice(0, 3000);

    const allCapsules = await this.capsules.list();
    for (const cap of allCapsules) {
      const full = await this.capsules.load(cap.id);
      if (!full) continue;
      for (const da of full.discardedAlternatives) {
        // 简单关键词匹配：LLM 提议的方案关键词是否出现在已放弃列表里
        const keywords = da.approach.split(/[\s，,、]+/).filter((w) => w.length >= 2);
        const hit = keywords.filter((kw) => recentText.includes(kw));
        if (hit.length >= 2) {
          const msg = `⚠️ 冲突：LLM 可能提议了已被放弃的方案 "${da.approach}"（原因：${da.reason}，来源胶囊 ${cap.id}）。请确认是否仍需此方案，若确认放弃可选择替代方案。`;
          conflicts.push(da.approach);
          this.appendObservation(msg, { source: `capsule:${cap.id}`, sourceType: "tool_output", taskRelevance: 1 });
          injectedCount++;
          break; // 每胶囊最多报一次冲突
        }
      }
    }

    // ── 缺口检测：当前编辑文件有哪些历史胶囊但尚未推入 ──
    const pushedCapsuleIds = new Set(
      this.entries
        .filter((e) => !e.evicted && e.type === "observation" && e.content.includes("capsule:"))
        .map((e) => {
          const m = e.content.match(/capsule:(capsule_[^\s\)]+)/);
          return m?.[1] ?? "";
        })
        .filter(Boolean),
    );

    for (const f of files) {
      const related = await this.capsules.findByFile(f);
      for (const cap of related) {
        if (pushedCapsuleIds.has(cap.id)) continue; // 已推过
        const full = await this.capsules.load(cap.id);
        if (!full) continue;
        const msg = `💡 关于 ${f} 有历史上下文：\n${CapsuleStore.summaryText(full)}\n若需细节，调用 recall:context("${cap.id}") 展开。`;
        gaps.push(`${f} → ${cap.id}`);
        this.appendObservation(msg, { source: `capsule:${cap.id}`, sourceType: "tool_output", taskRelevance: 0.6 });
        injectedCount++;
        break; // 每文件最多推一个胶囊
      }
    }

    // ── 一致性检测：编辑的多文件之间是否存在已知限制 ──
    const allConstraints: { file: string; desc: string }[] = [];
    for (const cap of allCapsules) {
      const full = await this.capsules.load(cap.id);
      if (!full) continue;
      for (const c of full.constraints) {
        if (files.some((f) => c.location.includes(f) || f.includes(c.location))) {
          allConstraints.push({ file: c.location, desc: c.description });
        }
      }
    }
    if (allConstraints.length > 0) {
      consistencyIssue =
        `🔒 当前编辑的文件有已知限制：\n${allConstraints.map((c) => `- ${c.file}: ${c.desc}`).join("\n")}\n这些限制来自历史胶囊，请确认是否仍然适用。`;
      this.appendObservation(consistencyIssue, { source: "inquiry:consistency", sourceType: "tool_output", taskRelevance: 0.8 });
      injectedCount++;
    }

    // ── 检查当前胶囊是否需要更新约束（子任务运行中发现了新限制 → 自动合并） ──
    // 从最近的 tool_output 中提取错误模式
    const recentErrors = this.entries
      .filter((e) => !e.evicted && e.type === "tool")
      .slice(-5)
      .map((e) => e.content)
      .join("\n")
      .slice(0, 4000);

    if (this.currentCapsule && (recentErrors.includes("UNHANDLED") || recentErrors.includes("DATA LOSS"))) {
      this.currentCapsule!.constraints.push({
        type: "KNOWN_BUG",
        description: `步骤中检测到未处理异常/数据丢失风险（${recentErrors.slice(0, 100)}...）`,
        location: files.join(","),
        source: "auto-inquiry",
        createdAt: Date.now(),
      });
      await this.capsules.save(this.currentCapsule!);
      this.logger.debug("auto-inquiry: 自动更新胶囊约束");
    }

    this.lastInquiry = { conflicts, gaps, consistencyIssue };
    return { hasReport: conflicts.length > 0 || gaps.length > 0 || consistencyIssue !== null, conflicts, gaps, consistencyIssue, injectedCount };
  }

  /** 获取最后一次质询结果 */
  getLastInquiry() {
    return { ...this.lastInquiry };
  }

  // ─── 胶囊系统（Context-skill v3 互动轨）─────────────────

  /**
   * 打包子任务为知识胶囊。
   * 收集所有与该子任务相关的活跃条目 → 构建胶囊 → 保存磁盘 →
   * 压缩原始条目 → 替换为指针 observation。
   */
  async packSubtask(taskId: string, opts?: { summary?: string; files?: string[] }): Promise<{
    ok: boolean;
    capsuleId?: string;
    originalTokens?: number;
    capsuleTokens?: number;
    error?: string;
  }> {
    try {
      const targetFiles = opts?.files ?? [...this.focusedFiles];
      if (!targetFiles.length) {
        const recentFiles = new Set<string>();
        for (const e of this.entries) {
          if (!e.evicted && e.source) recentFiles.add(e.source);
        }
        targetFiles.push(...recentFiles);
      }

      // 收集该子任务相关的活跃条目
      const relevant = this.entries
        .filter((e) => !e.evicted && !e.compressed)
        .map((e) => ({
          content: e.evicted ? "" : e.content,
          source: e.source,
          entryId: e.id,
          timestamp: e.timestamp,
        }));

      if (!relevant.length) {
        return { ok: false, error: "无活跃条目可打包" };
      }

      // 从最近的 assistant 内容提取符号
      const symbols: string[] = [];
      const recentAssistant = this.entries
        .filter((e) => !e.evicted && e.type === "assistant")
        .slice(-2);
      for (const e of recentAssistant) {
        const funcMatches = e.content.matchAll(/function\s+(\w+)/g);
        const classMatches = e.content.matchAll(/class\s+(\w+)/g);
        for (const m of funcMatches) symbols.push(m[1]!);
        for (const m of classMatches) symbols.push(m[1]!);
      }

      const capsule = CapsuleStore.buildCapsule(taskId, relevant, {
        summary: opts?.summary,
        files: targetFiles.filter(Boolean),
        symbols: [...new Set(symbols)].slice(0, 20),
      });

      await this.capsules.save(capsule);

      // 压缩原始条目：非保护类条目标记为 compressed（下轮 builder 用压缩版）
      let compressedCount = 0;
      for (let i = 0; i < this.entries.length; i++) {
        const e = this.entries[i]!;
        if (e.evicted || e.compressed || e.protectedBy) continue;
        this.entries[i] = {
          ...e,
          compressed: true,
          compressedContent: `[已打包至胶囊 ${capsule.id}，调用 recall:context("${capsule.id}") 展开]`,
          compressedTokenCount: BudgetManager.estimateTokens(`[胶囊 ${capsule.id}]`),
        };
        compressedCount++;
      }

      // 注入指针 observation
      this.appendObservation(
        `📦 子任务已打包为胶囊：${capsule.id}\n${CapsuleStore.summaryText(capsule)}`,
        { source: `capsule:${capsule.id}`, sourceType: "tool_output", taskRelevance: 0.7 },
      );

      this.currentCapsule = capsule;
      this.logger.debug(
        `packSubtask: ${capsule.id} 原始 ${capsule.originalTokens} tokens → 胶囊 ${capsule.capsuleTokens} tokens (${compressedCount} 条目压缩)`,
      );

      return {
        ok: true,
        capsuleId: capsule.id,
        originalTokens: capsule.originalTokens,
        capsuleTokens: capsule.capsuleTokens,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /** 从磁盘加载胶囊（L1 概览或 L2 完整 JSON），以 observation 注入 */
  async expandCapsule(capsuleId: string, level: "L1" | "L2" = "L2"): Promise<{
    ok: boolean;
    capsule?: Capsule;
    error?: string;
  }> {
    const capsule = await this.capsules.load(capsuleId);
    if (!capsule) return { ok: false, error: `胶囊 ${capsuleId} 不存在` };

    if (level === "L2") {
      this.appendObservation(
        `📦 完整胶囊 ${capsuleId}：\n${JSON.stringify(capsule, null, 2).slice(0, 8000)}`,
        { source: `capsule:${capsuleId}`, sourceType: "tool_output", taskRelevance: 1 },
      );
    } else {
      // L1 概览：结构化大纲，约 500 tokens
      this.appendObservation(
        CapsuleStore.summaryTextL1(capsule),
        { source: `capsule:${capsuleId}`, sourceType: "tool_output", taskRelevance: 0.7 },
      );
    }
    return { ok: true, capsule };
  }

  /** 列出所有磁盘胶囊摘要 */
  async listCapsules() {
    return this.capsules.list();
  }

  /**
   * 获取底层 ContentStore（供测试和工具使用）。
   * 直接写 ContentStore 不经过 CM 的逐出信号，用于回填历史或 mock 数据。
   */
  getStore(): ContentStore {
    return this.store;
  }

  /** 获取底层 CapsuleStore */
  getCapsuleStore(): CapsuleStore {
    return this.capsules;
  }

  toMessages(systemPrompt: string, opts?: { gitInfo?: string }): LLMMessage[] {
    const usePercent = this.getStats().usePercent;
    // 构建 placement map：当前有效的 placement 映射
    const placementMap = new Map<string, ContextPlacement>();
    for (const e of this.entries) {
      const placement = this.getPlacement(e.id);
      if (placement) placementMap.set(e.id, placement);
    }
    return buildContext({
      systemPrompt,
      entries: this.getEntries(),
      taskContext: this.taskContext,
      usePercent,
      gitInfo: opts?.gitInfo,
      placementMap,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // LongContextRecall：三层放置 + 召回 + 概括管线 (2026-07-19)
  // ═══════════════════════════════════════════════════════════

  /**
   * 获取条目的当前有效放置状态。
   * 规则：
   *   1. 取最新一条未过期的 placement 记录
   *   2. 如果全部过期 → 退回 system default (null)
   *   3. 如果没有记录 → system default (null)
   */
  getPlacement(entryId: string): ContextPlacement | null {
    const records = this.placementLog.get(entryId);
    if (!records || !records.length) return null;
    // 取最近一条未过期的
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      if (!r.expiresAt || r.expiresAt > Date.now()) {
        return r;
      }
    }
    return null; // 全部过期
  }

  /**
   * 检查放置优先级冲突。
   * 规则：ai 不能覆盖 user 的放置。
   */
  private checkPlacementConflict(
    entryId: string,
    source: PlacementSource,
  ): void {
    if (source === "user") return; // user 永远不冲突
    const current = this.getPlacement(entryId);
    if (current && current.source === "user") {
      throw new ContextPlacementConflictError(
        `AI 不能覆盖用户对条目 ${entryId} 的放置 (当前: ${current.target}, 原因: ${current.reason})`,
      );
    }
  }

  /**
   * 统一放置接口。
   *
   * @param entryId 目标条目（已存在的 ContextEntry）
   * @param target 目标层级
   * @param source 谁做的决定
   * @param reason 原因
   * @param opts 可选：胶囊摘要、过期时间、taskRelevance
   */
  async place(
    entryId: string,
    target: PlacementLevel,
    source: PlacementSource,
    reason: string,
    opts?: {
      capsuleSummary?: string;
      capsuleId?: string;
      expiresAt?: number;
      taskRelevance?: number;
    },
  ): Promise<ContextPlacement> {
    this.checkPlacementConflict(entryId, source);

    const placement: ContextPlacement = {
      entryId,
      target,
      source,
      reason,
      placedAt: Date.now(),
      capsuleSummary: opts?.capsuleSummary,
      capsuleId: opts?.capsuleId,
      expiresAt: opts?.expiresAt,
    };

    // 如果条目存在，同步更新 ContextEntry.taskRelevance
    const idx = this.entries.findIndex((e) => e.id === entryId);
    if (idx !== -1) {
      const e = this.entries[idx]!;
      const tr = opts?.taskRelevance ?? (
        source === "user" && target === "L2_working" ? 0 :
        source === "ai" && target === "L2_working" ? 0.1 :
        target === "L3_compressed" ? 0.6 :
        target === "L4_raw" ? 1.0 :
        e.taskRelevance
      );
      this.entries[idx] = {
        ...e,
        taskRelevance: tr,
        placement,
      };
    }

    // 追加到放置日志（不覆盖，只追加）
    const records = this.placementLog.get(entryId) ?? [];
    records.push(placement);
    this.placementLog.set(entryId, records);

    this.logger.debug(`place: ${entryId} → ${target} (${source}, ${reason})`);
    return placement;
  }

  /**
   * pin 条目到 L2_working（便捷方法）。
   * user pin → taskRelevance 锁定为 0（绝对保护，永不降级）
   * ai pin → taskRelevance 锁定为 0.1
   */
  async pin(entryId: string, source: PlacementSource, reason: string): Promise<ContextPlacement> {
    return this.place(entryId, "L2_working", source, reason, {
      taskRelevance: source === "user" ? 0 : 0.1,
    });
  }

  /** 清除用户/AI 的 pin，退回系统默认 */
  unpin(entryId: string): boolean {
    const current = this.getPlacement(entryId);
    if (!current || current.source === "system") return false;
    // 通过追加一条 system 放置来覆盖
    this.placementLog.delete(entryId);
    // 恢复条目的 taskRelevance
    const idx = this.entries.findIndex((e) => e.id === entryId);
    if (idx !== -1) {
      const e = this.entries[idx]!;
      this.entries[idx] = {
        ...e,
        taskRelevance: this.computeTaskRelevance(e.source, e.content, e.type),
        placement: undefined,
      };
    }
    this.logger.debug(`unpin: ${entryId}`);
    return true;
  }

  // ─── 召回管线 ─────────────────────────────────────────

  /**
   * 从 ContentStore 按查询召回相关条目（无副作用）。
   *
   * 核心流程：
   *   1. store.search(query, { mode: "fts5", topK: limit })
   *   2. 按 score 降序排列
   *   3. 去重（已活跃在 this.entries 中的跳过）
   *   4. 返回结果给调用者
   *
   * 与 recallFromStore 的区别：
   *   recallFromStore(id) → 污染全局状态
   *   recallRelevant(query) → 只读，无副作用
   */
  async recallRelevant(query: string, limit = 5): Promise<RecallResult> {
    const results = await this.store.search(query, {
      mode: "fts5",
      topK: limit * 2, // 多取一些，去重后取 topK
    });

    // 去重：已活跃在窗口中的条目跳过
    const activeIds = new Set(this.entries.filter((e) => !e.evicted).map((e) => e.id));
    const filtered = results
      .filter((r) => !activeIds.has(r.entry.entryId))
      .slice(0, limit);

    // 生成召回摘要
    const entries = filtered.map((r) => r.entry);
    const summaryLines = entries.map((e, i) => {
      const snippet = filtered[i]?.snippet ?? e.originalContent.slice(0, 150);
      return `[${i + 1}] ${e.source ?? e.entryId} (${e.originalTokenCount} tokens, score=${filtered[i]?.score ?? "?"})\n   ${snippet}...`;
    });
    const summary = entries.length > 0
      ? `召回 ${entries.length} 条相关内容：\n${summaryLines.join("\n")}\n使用 inject:recall 注入到当前上下文`
      : `未找到与 "${query}" 相关的内容`;

    return { entries, summary };
  }

  /**
   * 将 RecallResult 注入到当前上下文。
   * 注入为一条 observation（每一条作为一个独立 observation），
   * taskRelevance=0.5。TTL=1 步（下轮 autoManage 时可驱逐）。
   */
  injectRecall(result: RecallResult): void {
    if (!result.entries.length) return;
    for (const entry of result.entries) {
      this.appendObservation(
        `[recall] ${entry.source ?? entry.entryId}\n${entry.originalContent.slice(0, 3000)}${entry.originalContent.length > 3000 ? `\n...(共 ${entry.originalContent.length} 字符)` : ""}`,
        {
          source: entry.source,
          sourceType: (entry.sourceType as SourceType) ?? "tool_output",
          taskRelevance: 0.5,
        },
      );
    }
    this.logger.debug(`injectRecall: 注入 ${result.entries.length} 条`);
  }

  /**
   * 有作用域的召回：召回 → 注入 → 注入的条目有作用域标记。
   * 调用者负责在使用完后 forgetScoped()。
   * 等价于 recallRelevant + injectRecall。
   */
  async recallScoped(query: string, limit = 5): Promise<void> {
    const result = await this.recallRelevant(query, limit);
    this.injectRecall(result);
  }

  /**
   * 清理上一步 recallScoped 注入的条目。
   */
  forgetScoped(): number {
    let count = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.evicted) continue;
      if (e.type !== "observation") continue;
      if (!e.content.startsWith("[recall]")) continue;
      const toSave = e.originalContent ?? e.content;
      this.entries[i] = { ...e, evicted: true, evictedAt: Date.now(), externalRef: `ext://${e.id}` };
      this.store.save({
        entryId: e.id,
        originalContent: toSave,
        originalTokenCount: e.tokenCount,
        savedAt: Date.now(),
        reason: "forget",
        source: e.source,
        sourceType: e.sourceType,
      }).catch((err) => this.logger.warn(`ContentStore save forgetScoped failed: ${String(err)}`));
      count++;
    }
    return count;
  }

  // ─── 概括到胶囊 ───────────────────────────────────────

  /**
   * 将匹配条目概括为胶囊并放到 L2。
   * 需 LLM 注入（调用前确保 setLlmCall 已设置）。
   *
   * 步骤：
   *   1. 筛选条目 → chunkBySemantic 分块
   *   2. 每块 LLM 摘要
   *   3. 构建 Capsule → CapsuleStore.save()
   *   4. 原文逐条确保在 ContentStore
   *   5. 驱逐原始条目，替换为 pointer observation
   */
  async summarizeAndCapsule(
    predicate: (e: ContextEntry) => boolean,
    options?: { taskId?: string; category?: "conversation" | "code_session" | "document" | "tool_output"; summary?: string },
  ): Promise<SummarizeOutput | null> {
    if (!this.llmCall) {
      this.logger.warn("summarizeAndCapsule: 未注入 LLM 调用，跳过 LLM 摘要，使用确定性回退");
    }

    const matched = this.entries.filter((e) => !e.evicted && predicate(e));
    if (!matched.length) {
      this.logger.debug("summarizeAndCapsule: 无匹配条目");
      return null;
    }

    const input: SummarizeInput = {
      entries: matched.map((e) => ({
        content: e.originalContent ?? e.content,
        source: e.source,
        timestamp: e.timestamp,
      })),
      metadata: {
        taskId: options?.taskId,
        category: options?.category,
      },
    };

    const output = this.llmCall
      ? await summarizeToCapsule(input, this.llmCall)
      : await summarizeToCapsule(input);

    // 确保原文在 ContentStore
    for (const e of matched) {
      const alreadyStored = await this.store.load(e.id);
      if (!alreadyStored) {
        await this.store.save({
          entryId: e.id,
          originalContent: e.originalContent ?? e.content,
          originalTokenCount: e.tokenCount,
          savedAt: Date.now(),
          reason: "summarize",
          source: e.source,
          sourceType: e.sourceType,
          capsuleSummary: output.l0Summary,
          capsuleId: output.capsule.id,
        });
      }
    }

    // 保存胶囊
    await this.capsules.save(output.capsule);

    // 驱逐原始条目 + 注入 L0 摘要 observation
    for (const e of matched) {
      if (e.protectedBy) continue; // 受保护条目不动
      await this.place(e.id, "L3_compressed", "system", "概括为胶囊", {
        capsuleSummary: output.l0Summary,
        capsuleId: output.capsule.id,
      });
    }

    this.appendObservation(
      `📦 胶囊 ${output.capsule.id}：${output.l0Summary}\n调用 expand:context("${output.capsule.id}") 展开完整记录`,
      { source: `capsule:${output.capsule.id}`, sourceType: "tool_output", taskRelevance: 0.7 },
    );

    this.logger.debug(
      `summarizeAndCapsule: ${output.capsule.id} 原始 ${output.capsule.originalTokens} tokens → 胶囊 ${output.capsule.capsuleTokens} tokens`,
    );

    return output;
  }

  // ─── 容量强制管理 ─────────────────────────────────────

  /**
   * 获取容量状态。
   * needsInteraction 为 true 时表示需要用户介入。
   */
  getCapacityStatus(): CapacityStatus {
    const stats = this.getStats();
    const pins = { user: 0, ai: 0, system: 0 };
    for (const [, records] of this.placementLog) {
      const latest = records[records.length - 1];
      if (latest && (!latest.expiresAt || latest.expiresAt > Date.now())) {
        if (latest.target === "L2_working") {
          if (latest.source === "user") pins.user++;
          else if (latest.source === "ai") pins.ai++;
          else pins.system++;
        }
      }
    }

    // 容量强制检查
    if (stats.usePercent >= CAPACITY_ENFORCE_THRESHOLD) {
      this.capacityExceededSteps++;
    } else {
      this.capacityExceededSteps = 0;
    }

    const needsInteraction = this.capacityExceededSteps >= CAPACITY_ENFORCE_STEPS;

    let alert: CapacityAlert | null = null;
    if (needsInteraction) {
      const topConsumers = this.entries
        .filter((e) => !e.evicted)
        .sort((a, b) => b.tokenCount - a.tokenCount)
        .slice(0, 5)
        .map((e) => {
          const placement = this.getPlacement(e.id);
          return {
            entryId: e.id,
            tokens: e.tokenCount,
            summary: e.content.slice(0, 120).replace(/\n/g, " "),
            pinnedBy: placement?.source ?? "none",
          };
        });

      const aiPinsCount = topConsumers.filter((c) => c.pinnedBy === "ai").length;
      alert = {
        usePercent: stats.usePercent,
        totalPins: pins,
        topConsumers,
        suggestion: aiPinsCount > 0 ? "evict_ai_pins" : "summarize_large",
        needsInteraction: true,
      };
    }

    return { usePercent: stats.usePercent, activePins: pins, needsInteraction, alert };
  }

  /**
   * 更新 autoManage 中的容量强制逻辑。
   * 在每步 autoManage 末尾检查：如果 needsInteraction，生成告警 observation。
   */
  private enforceCapacity(): void {
    const status = this.getCapacityStatus();
    if (!status.needsInteraction || !status.alert) return;

    const lines = [
      `⚠️ 上下文接近上限 (${status.alert.usePercent}%，持续 ${this.capacityExceededSteps} 步)。`,
      `当前 pin: user=${status.alert.totalPins.user}, ai=${status.alert.totalPins.ai}`,
    ];
    if (status.alert.topConsumers.length) {
      lines.push("占用最高条目：");
      for (const c of status.alert.topConsumers) {
        lines.push(`  - ${c.entryId} (${c.tokens} tokens, pinned by ${c.pinnedBy})`);
      }
    }
    lines.push(`建议：${status.alert.suggestion === "evict_ai_pins" ? "解除 AI pin 的条目" : "概括大条目为胶囊"}`);

    this.appendObservation(lines.join("\n"), {
      source: "capacity:alert",
      sourceType: "tool_output",
      taskRelevance: 1,
    });
  }
}
