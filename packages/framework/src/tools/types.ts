// @struct/framework - 工具类型定义

export type ToolCategory =
  | "fs"
  | "shell"
  | "git"
  | "analysis"
  | "project"
  | "status"
  | "verify";

export type ToolParamType = "string" | "number" | "boolean" | "array" | "object";

export interface ToolParam {
  readonly name: string;
  readonly type: ToolParamType;
  readonly description: string;
  readonly required: boolean;
  readonly default?: unknown;
  readonly enum?: readonly string[];
}

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly params: readonly ToolParam[];
  readonly risk: RiskLevel;
  readonly disableable: boolean;
  readonly enabledByDefault: boolean;
}

/** 工具调用请求 */
export interface ToolCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** 工具执行结果 */
export interface ToolResult {
  readonly success: boolean;
  readonly output: string;
  readonly error?: string;
  readonly exitCode?: number;
  readonly durationMs: number;
  /** 被安全策略拦截时为 true */
  readonly blocked?: boolean;
  readonly blockedReason?: string;
  /** 死循环检测依赖：本次修改的文件列表 */
  readonly filesChanged?: string[];
  /** 死循环检测依赖：测试是否通过（仅 test 类工具） */
  readonly testPassed?: boolean;
  /** 错误恢复策略：标记是否可重试 */
  readonly retryable?: boolean;
  /** 结构化元数据（供隐式信号、审计用） */
  readonly meta?: Record<string, unknown>;
}
