// @structfocus/framework - 重试工具

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  /** 判断错误是否应重试；默认全部重试 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitter: true,
};

/**
 * 指数退避 + jitter 重试。
 * - 第 n 次重试延迟 = min(baseDelay * 2^(n-1), maxDelay) ± jitter
 * - 支持 AbortSignal 中止
 * - shouldRetry 判断是否继续
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> = {},
  signal?: AbortSignal,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= opts.maxAttempts) break;
      if (opts.shouldRetry && !opts.shouldRetry(e, attempt)) break;

      const expDelay = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
      const delay = opts.jitter
        ? expDelay * (0.5 + Math.random() * 0.5)
        : expDelay;

      await sleep(delay, signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
