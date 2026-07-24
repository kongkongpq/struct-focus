// @structfocus/context - 共享基础类型与常量（2026-07-15 新设计 / 2026-07-19 LongContextRecall 扩展）
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

// ─── 四层冷热架构：分重要性/活跃度两个维度 ────────────

/**
 * 四层放置目标（2026-07-20 重构）。
 *
 * 语义：
 *   L1_permanent — 永远不该丢的知识（用户习惯、项目方向、胶囊指针、检索工具描述）
 *   L2_working   — 当前工作内容（LLM 实际可见的 L1 指针 + 最近 N 轮对话）
 *   L3_compressed — 压缩后的旧对话（LLM 摘要过的胶囊正文）
 *   L4_raw       — 原始旧对话（ContentStore 磁盘深存，只在精确召回时访问）
 *
 * 流动：
 *   L2_working → L3_compressed（触发管理时概括归档）
 *   L3_compressed → L4_raw（胶囊原文 >7 天或超过 30 个后原文深存）
 *   L1_permanent → L3_compressed（永久知识旧了也会压缩归档，L1 仅留指针）
 */
export type PlacementLevel = "L1_permanent" | "L2_working" | "L3_compressed" | "L4_raw";

/** 放置来源：谁做的这个决定 */
export type PlacementSource = "system" | "ai" | "user";

/**
 * 管理策略（用户可调，2026-07-20）。
 *
 * 阈值语义改为「非活跃内容占比」而非「总窗口占比」。
 * 非活跃 = 距离当前话题 > topicDistance 轮 或 超过 ageThresholdMs 未更新。
 */
export interface ManagementPolicy {
  /** 非活跃内容占窗口比例超过此值 → 开始标记/分组/预压缩评估 */
  softThreshold: number; // 默认 0.20
  /** 非活跃内容超过此值 → 执行概括归档 L2→L3 */
  hardThreshold: number; // 默认 0.50
  /** 总 token 超过此值 → 强制将最冷 L3 条目迁移到 L4 */
  emergencyThreshold: number; // 默认 0.85
  /** 保守模式：紧急 L3→L4 深存仅在接近满窗口(>=0.97)时触发，避免正常对话里仍可召回的内容过早落盘（召回延迟/失败率上升） */
  conservative?: boolean;
  /** 距离当前话题多少轮才算"非活跃" */
  topicDistance: number; // 默认 3
  /** 单条消息超过此 token 直接评估是否该压缩归档 */
  maxChunkBeforeManage: number; // 默认 4000
  /**
   * 用户 override 模式。
   * 目前为声明式元数据（记录用户意图，不直接改变归档逻辑；实际强弱由
   * conservative / *Threshold 字段控制）。取值与 MCP context_set_policy 暴露的枚举保持一致。
   */
  userOverride: "auto" | "aggressive" | "conservative";
}

export const DEFAULT_MANAGEMENT_POLICY: ManagementPolicy = {
  softThreshold: 0.20,
  hardThreshold: 0.50,
  emergencyThreshold: 0.85,
  conservative: false,
  topicDistance: 3,
  maxChunkBeforeManage: 4000,
  userOverride: "auto",
};

/**
 * 计算实际生效的紧急阈值（L3→L4 深存触发点）。
 *
 * - 普通模式：直接用 `emergencyThreshold`（默认 0.85），窗口用到 85% 就把最冷 L3 内容压到磁盘 L4。
 * - 保守模式（`conservative: true`）：抬到 `max(emergencyThreshold, 0.97)`，即只有接近满窗口时才落盘，
 *   避免正常对话里仍可召回的内容被过早迁移到磁盘（召回延迟/失败率上升）。
 *
 * 若用户在保守模式下显式设了更高的 emergencyThreshold（如 0.99），以较大值为准。
 */
export function effectiveEmergencyThreshold(policy: ManagementPolicy): number {
  return policy.conservative ? Math.max(policy.emergencyThreshold, 0.97) : policy.emergencyThreshold;
}

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
  /** L3_compressed 专属：胶囊摘要文本（~100 tokens） */
  capsuleSummary?: string;
  /** L3_compressed 专属：关联的胶囊 id */
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
  compressedAt?: number;

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

  // 所属对话 id（roadmap 一.1 Per-Conversation 隔离）。
  // 由 ContextManager.currentConversationId 在 appendEntry 时打标，
  // 用于 toMessages 仅渲染当前对话条目、ContentStore.search 按对话过滤召回。
  conversationId?: string;

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
  /** 非活跃内容占窗口的比例 */
  inactivePercent: number;
  triggerLevel: 0 | 1 | 2 | -1; // -1 = 未触发（非活跃占比未达 soft）
  /** 降级条目数（L2→L3 + L3→L4 + 持续清理） */
  downgradedCount: number;
  /** 降级节省的 token 数 */
  downgradedTokens: number;
  /** @deprecated 用 downgradedCount 替代 */
  evictedCount: number;
  /** @deprecated 用 downgradedTokens 替代 */
  evictedTokens: number;
  compressedCount: number;
  truncatedCount: number;
  /** L3→L4 深存条目数 */
  l4MigratedCount: number;
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

// ─── 四层冷热管理常量 ──────────────────────────────────

/**
 * 管理触发规则（非活跃 = 距当前话题 ≥ topicDistance 轮 或 超过 ageThresholdMs）。
 *   - 非活跃内容 > softThreshold → 开始标记、分组、预压缩评估
 *   - 非活跃内容 > hardThreshold → 执行概括归档 L2→L3
 *   - 总 token > emergencyThreshold → 强制迁移最冷 L3 条目到 L4
 * 阈值在 ManagementPolicy 中定义，此处为常量引用。
 */

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
