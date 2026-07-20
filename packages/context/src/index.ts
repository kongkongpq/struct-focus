// @struct/context - 统一导出

// 共享类型（含 LLMMessage / ContextEntry / TaskContext / ContextPlacement 等）
export * from "./types.js";

// 长上下文引擎（独立，不绑定任何 Agent 框架）
export {
  LongContextEngine,
  type LongContextEngineOptions,
  type RecallResult as LongContextRecallResult,
  type EngineStats,
} from "./longcontext-engine.js";

// 上下文管理器（核心运行时）
export {
  ContextManager,
  type ManageResult,
  type DowngradeResult,
  type RecallResult,
  type CapacityStatus,
  type ContextManagerOptions,
} from "./manager.js";

// 记忆后端
export {
  InMemoryBackend,
  tokenizeQuery,
  type MemoryEntry,
  type MemoryBackend,
} from "./memory.js";

// 构建器 / 指针 / 预算 / 探索器
export { ContextBuilder, buildContext, type BuildContextInput } from "./builder.js";
export { PointerRegistry } from "./pointer.js";
export {
  BudgetManager,
  DEFAULT_BUDGET_BUCKETS,
  TOTAL_BUDGET,
  FIXED_OVERHEAD,
  EVICTION_ORDER,
  MAX_CONTEXT_WINDOW,
  setTokenEstimator,
  hasTokenEstimator,
  setMaxContextWindow,
  getMaxContextWindow,
  type TokenEstimator,
  type BudgetBucket,
  type EvictionPriority,
} from "./budget.js";
export { CodeExplorer, type FileInfo, type SymbolInfo } from "./explorer.js";

// 集成契约（框架无关，StructAgent 自身暴露）
export { createContextMiddleware } from "./middleware.js";
export type { ContextMiddleware, ContextMiddlewareOptions } from "./middleware.js";
