// @structfocus/framework - 统一错误模型



export type ErrorCode =
  | "UNKNOWN"
  | "PERMISSION_DENIED"
  | "FILE_NOT_FOUND"
  | "SYNTAX_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "VALIDATION_ERROR"
  | "PLUGIN_ERROR"
  | "PIPELINE_ERROR"
  | "STATE_ERROR"
  | "BUDGET_EXCEEDED"
  | "LOOP_DETECTED"
  | "ABORTED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface StructError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly timestamp: string;
  readonly context?: Record<string, unknown>;
}

export function createError(
  code: ErrorCode,
  message: string,
  opts?: { cause?: unknown; context?: Record<string, unknown> },
): StructError {
  return {
    code,
    message,
    cause: opts?.cause,
    timestamp: new Date().toISOString(),
    context: opts?.context,
  };
}

/** 将任意异常规范化为 StructError */
export function toStructError(e: unknown): StructError {
  if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
    return e as StructError;
  }
  const message = e instanceof Error ? e.message : String(e);
  const code: ErrorCode = e instanceof Error && e.name === "AbortError" ? "ABORTED" : "UNKNOWN";
  return createError(code, message, { cause: e });
}

/** 判断错误是否可重试（用于 harness 错误恢复策略） */
export function isRetryable(error: StructError): boolean {
  return (
    error.code === "TIMEOUT" ||
    error.code === "NETWORK_ERROR" ||
    error.code === "RATE_LIMITED"
  );
}

export const Errors = {
  create: createError,
  toStruct: toStructError,
  isRetryable,
};
