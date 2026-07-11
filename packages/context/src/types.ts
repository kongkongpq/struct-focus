// @struct/context - 共享基础类型与常量（2026-07-15 新设计 / 2026-07-19 LongContextRecall 扩展）
//
// 集中存放 Context Engine 用到的最小类型/函数与阈值常量，无外部依赖。
// 本文件是设计文档的「权威类型契约」：ContextManager、ContextBuilder、
// 消费方（app/mcp/bench）均以这里的类型为准。

// ─── Branded ID / Utils ────────────────────────────────────

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type Id<B extends string> = Brand<string, B>;

/** 生成带前缀的唯一 ID（零 Node 依赖：用 globalThis.crypto） */
export function createId<B extends string>(prefix: string): Id<B> {
  const uuid = globalThis.crypto.randomUUID();
  return `${prefix}_${uuid}` as Id<B>;
}

export function now(): number {
  return Date.now();
}

// ─── 轻量日志 ──────────────────────────────────────────────

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export const consoleLogger: Logger = {
  debug: (m) => console.debug(`[context] ${m}`),
  info: (m) => console.info(`[context] ${m}`),
  warn: (m) => console.warn(`[context] ${m}`),
};

// ─── LLM 消息（序列化目标） ────────────────────────────────

export type CacheControlBreakpoint = { readonly type: "ephemeral" };

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly unknown[];
  /** prompt caching 断点（打在稳定的 I-Context system 消息上） */
  readonly cacheControl?: CacheControlBreakpoint;
}

// ─── 条目类型与来源 ────────────────────────────────────────

export type EntryType = "user" | "assistant" | "tool" | "system" | "memory" | "observation";

export type SourceType = "tool_output" | "file_content" | "log" | "html" | "json";

/** 条目受保护的原因（taskRelevance=0 时出现） */
export type ProtectionReason = "editingFile" | "failingTest" | "cwd" | "llm";

// ─── LongContextRecall：三层放置模型 ─────────────────────

/** L1/L2/L3 放置目标 */
export type PlacementLevel = "L1_active" | "L2_capsule" | "L3_cold";

/** 放置来源：谁做的这个决定 */
export type PlacementSource = "system" | "ai" | "user";

/**
 * 上下文放置记录。
 * 每次 place / recall / pin / unpin 操作追加一条。
 * 某条目的当前有效状态 = 最近一条未过期的 placement 记录。
 */
export interface ContextPlacement {
  /** 目标条目 id */
  entryId: string;
  /** 目标层级 */
  target: PlacementLevel;
  /** 谁放置的 */
  source: PlacementSource;
  /** 原因（human-readable，审计用） */
  reason: string;
  /** 放置时间 */
  placedAt: number;
  /** L2_capsule 专属：胶囊摘要文本（~100 tokens） */
  capsuleSummary?: string;
  /** L2_capsule 专属：关联的胶囊 id */
  capsuleId?: string;
  /** 过期时间（ms timestamp），过期后自动降级回系统默认 */
  expiresAt?: number;
  /** 是否已被后续操作覆盖 */
  supersededBy?: string;
}

/** 放置优先级冲突错误 */
export class ContextPlacementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextPlacementConflictError";
  }
}

/** 容量告警 */
export interface CapacityAlert {
  usePercent: number;
  totalPins: { user: number; ai: number };
  topConsumers: { entryId: string; tokens: number; summary: string; pinnedBy: string }[];
  suggestion: "evict_ai_pins" | "summarize_large" | "manual_review";
  needsInteraction: boolean;
}

/** 容量强制交互的阈值（百分比） */
export const CAPACITY_ENFORCE_THRESHOLD = 95;
/** 阈值持续的步数阈值 */
export const CAPACITY_ENFORCE_STEPS = 3;

// ─── 上下文条目（核心状态单元） ────────────────────────────

export interface ContextEntry {
  id: string;
  type: EntryType;
  content: string;
  tokenCount: number;
  timestamp: number;

  // 可逆压缩：originalContent 始终保存完整原文（永不销毁）
  //   structuredCompress → content 不变, compressedContent=精华, compressed=true
  //   truncate → content 被截断, originalContent=完整原文
  //   任何时候 expandEntry() 可恢复 originalContent → content
  originalContent?: string;

  // 压缩（structuredCompress 可逆，零延迟、无 LLM 调用）
  compressed: boolean;
  compressedContent?: string;
  compressedTokenCount?: number;

  // 驱逐到外部存储（保留审计，物理移出窗口但完整原文在 ContentStore）
  evicted: boolean;
  evictedAt?: number;
  externalRef?: string;

  // 任务相关性：0 = 绝对保护（绝不驱逐），1 = 可驱逐
  taskRelevance: number;
  protectedBy?: ProtectionReason;

  // 来源（用于 preprocessToolOutput 差异化去噪 & 注意力浪费按 source 归类）
  source?: string;
  sourceType?: SourceType;

  // 运行时评分字段
  ageFactor: number; // 越旧越高（0~1+）
  currentEvictionScore: number; // 当前综合驱逐分

  /** LongContextRecall：当前放置状态（运行时字段，不从 JSON 反序列化） */
  placement?: ContextPlacement;
}

// ─── 任务上下文（驱动 taskRelevance 加权） ─────────────────

export interface TaskContext {
  /** 当前子任务描述（用于关键词相关性） */
  currentSubtasks: string[];
  /** 正在编辑的文件（taskRelevance = 0，绝对保护） */
  editingFiles: string[];
  /** 失败的测试文件（taskRelevance = 0.5 保护） */
  failingTests: string[];
  /** 当前聚焦的符号（函数/类，用于 autoRecall 检索） */
  focusedSymbols: string[];
  /** 最近错误（影响相关性 & 反射建议） */
  recentErrors: { message: string; file?: string }[];
}

export const EMPTY_TASK_CONTEXT: TaskContext = {
  currentSubtasks: [],
  editingFiles: [],
  failingTests: [],
  focusedSymbols: [],
  recentErrors: [],
};

// ─── 自动管理报告 ──────────────────────────────────────────

export interface AutoManageReport {
  usePercent: number;
  triggerLevel: 0 | 1 | 2 | -1; // -1 = 未触发（usePercent 未达层0）
  evictedCount: number;
  evictedTokens: number;
  compressedCount: number;
  truncatedCount: number;
  focusedFiles: string[];
  recalledMemories: number;
  /** 守护轨质询结果（autoManage 每步自动运行 runInquiry） */
  inquiry?: { conflicts: string[]; gaps: string[]; injected: number };
  /** 放置变更多少（新增条目被放置的数量） */
  autoPlacedCount?: number;
}

// ─── 注意力浪费度量 ────────────────────────────────────────

export interface AttentionWaste {
  /** 累计被驱逐/丢弃的 token（设计目标 < 总量的 15%） */
  total: number;
  /** 浪费率 = total / 累计注入总量 */
  rate: number;
  /** 按来源(sourceType)归类的浪费 token */
  bySource: Record<string, number>;
  /** 按触发步骤归类的浪费 token（层0/层1/层2） */
  byStep: Record<string, number>;
}

// ─── 反射报告（getReflection） ─────────────────────────────

export interface ReflectionReport {
  usePercent: number;
  attentionWaste: { total: number; rate: number; bySource: Record<string, number> };
  topSpaceHogs: { id: string; tokens: number; summary: string }[];
  protectedEntries: { id: string; tokens: number; protectedBy: string }[];
  suggestions: string[];
}

// ─── 统计快照（getStats） ──────────────────────────────────

export interface ContextStats {
  usePercent: number;
  totalTokens: number;
  maxWindow: number;
  activeEntries: number;
  evictedEntries: number;
  compressedEntries: number;
  attentionWaste: AttentionWaste;
  byType: Record<string, number>;
}

// ─── 阈值 / 比例常量（集中便于基准调参） ──────────────────

/** 三层阈值：窗口使用率 */
export const EVICT_THRESHOLD_0 = 70; // 层0：轻量驱逐
export const EVICT_THRESHOLD_1 = 85; // 层1：驱逐 + 压缩 + 截断
export const EVICT_THRESHOLD_2 = 90; // 层2：强制 forget 非聚焦文件

/** 驱逐比例（占总条数） */
export const EVICT_RATIO_0 = 0.15;
export const EVICT_RATIO_1 = 0.25;

/** 长条目截断阈值与切片 */
export const TRUNCATE_THRESHOLD = 2000; // token
export const TRUNCATE_HEAD = 500; // 头 token
export const TRUNCATE_TAIL = 500; // 尾 token
export const TRUNCATE_MID_LINES = 50; // 中段保留行数

/** 老化：每过此毫秒，ageFactor 提升一个单位步长 */
export const AGE_FACTOR_STEP_MS = 5 * 60 * 1000; // 5 分钟

/**
 * taskRelevance 保护系数：
 * 值越接近 0 越该保护（驱逐分越低）；越接近 1 越可驱逐。
 */
export const TASK_RELEVANCE_FACTORS: Record<string, number> = {
  editingFile: 0.0, // 编辑中文件：绝对保护
  subtask: 0.25, // 子任务明确引用
  failingTest: 0.5, // 失败测试（cwd 同类）
  cwd: 0.5, // 当前工作目录相关
  sameDir: 0.75, // 同目录但非编辑
  unrelated: 1.0, // 无关：最先驱逐
};

/** 来源类型对驱逐分的影响（数值越大越易驱逐） */
export const SOURCE_TYPE_FACTOR: Record<SourceType, number> = {
  tool_output: 1.0, // 工具输出噪音最多
  log: 0.9,
  file_content: 0.4, // 文件内容通常更有价值
  html: 1.0,
  json: 0.6,
};

/** 条目类型对驱逐分的影响 */
export const ENTRY_TYPE_FACTOR: Record<EntryType, number> = {
  tool: 1.0,
  observation: 0.9,
  user: 0.7,
  assistant: 0.6,
  system: 0.1, // system 几乎不驱逐
  memory: 0.5,
};

/** 注意力浪费目标上限（设计 §7） */
export const ATTENTION_WASTE_TARGET = 0.15;
