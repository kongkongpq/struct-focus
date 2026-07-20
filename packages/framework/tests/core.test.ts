// framework 测试 - Pipeline / StateMachine / retry / Errors
import { describe, it, expect, vi } from "vitest";
import { Pipeline, StateMachine, retry, createError, toStructError, isRetryable, type NamedMiddleware } from "@structfocus/framework";

// ── Pipeline ──────────────────────────────────────────────

describe("Pipeline", () => {
  it("按注册顺序执行中间件", async () => {
    const order: string[] = [];
    const mw1: NamedMiddleware<{ val: number }> = async (ctx, next) => {
      order.push("mw1-before");
      await next();
      order.push("mw1-after");
    };
    const mw2: NamedMiddleware<{ val: number }> = async (ctx, next) => {
      order.push("mw2-before");
      await next();
      order.push("mw2-after");
    };
    const pipe = new Pipeline<{ val: number }>();
    pipe.use(mw1);
    pipe.use(mw2);
    await pipe.run({ val: 0 });
    expect(order).toEqual([
      "mw1-before",
      "mw2-before",
      "mw2-after",
      "mw1-after",
    ]);
  });

  it("中间件可修改上下文", async () => {
    const mw1: NamedMiddleware<{ val: number }> = async (ctx, next) => {
      ctx.val += 10;
      await next();
    };
    const mw2: NamedMiddleware<{ val: number }> = async (ctx) => {
      ctx.val *= 2;
    };
    const pipe = new Pipeline<{ val: number }>();
    pipe.use(mw1);
    pipe.use(mw2);
    const result = await pipe.run({ val: 1 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.val).toBe(22);
  });

  it("单中间件异常收集为 Err", async () => {
    const mw: NamedMiddleware<{ val: number }> = async () => {
      throw new Error("mw crash");
    };
    const pipe = new Pipeline<{ val: number }>();
    pipe.use(mw);
    const result = await pipe.run({ val: 0 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe("mw crash");
  });

  it("remove 移除中间件", async () => {
    const mw = async (ctx: { val: number }, next: () => Promise<void>) => {
      ctx.val = 999;
      await next();
    };
    Object.defineProperty(mw, "name", { value: "test-mw", configurable: true });
    const pipe = new Pipeline<{ val: number }>();
    pipe.use(mw as any);
    pipe.remove("test-mw");
    const result = await pipe.run({ val: 0 });
    expect(result.ok && result.value.val).toBe(0);
  });

  it("AbortSignal 中止管道", async () => {
    const controller = new AbortController();
    controller.abort();
    const pipe = new Pipeline<{ val: number }>();
    pipe.use(async () => {});
    const result = await pipe.run({ val: 0 }, controller.signal);
    expect(result.ok).toBe(false);
  });

  it("空管道直接返回 Ok", async () => {
    const pipe = new Pipeline<{ val: number }>();
    const result = await pipe.run({ val: 42 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.val).toBe(42);
  });
});

// ── StateMachine ──────────────────────────────────────────

describe("StateMachine", () => {
  it("合法转移", () => {
    const sm = new StateMachine();
    expect(sm.current).toBe("idle");
    sm.transition("running");
    expect(sm.current).toBe("running");
    sm.transition("paused");
    expect(sm.current).toBe("paused");
    sm.transition("running");
    sm.transition("stopping");
    sm.transition("stopped");
    expect(sm.current).toBe("stopped");
  });

  it("非法转移抛错", () => {
    const sm = new StateMachine();
    expect(() => sm.transition("stopped")).toThrow("Invalid state transition");
  });

  it("canTransition 判断", () => {
    const sm = new StateMachine();
    expect(sm.canTransition("running")).toBe(true);
    expect(sm.canTransition("stopped")).toBe(false);
  });

  it("onChange 回调通知", () => {
    const sm = new StateMachine();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.transition("running", "start");
    expect(cb).toHaveBeenCalledWith("idle", "running", "start");
  });

  it("onChange 回调异常不影响状态机", () => {
    const sm = new StateMachine();
    sm.onChange(() => {
      throw new Error("listener crash");
    });
    expect(() => sm.transition("running")).not.toThrow();
    expect(sm.current).toBe("running");
  });

  it("reset 回到 idle", () => {
    const sm = new StateMachine();
    sm.transition("running");
    sm.transition("error");
    sm.reset();
    expect(sm.current).toBe("idle");
  });
});

// ── retry ────────────────────────────────────────────────

describe("retry", () => {
  it("首次成功不重试", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("失败后重试直到成功", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
      return "ok";
    };
    const result = await retry(fn, { maxAttempts: 3, baseDelayMs: 1, jitter: false });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("达到 maxAttempts 仍失败则抛出", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fail"));
    await expect(
      retry(fn, { maxAttempts: 2, baseDelayMs: 1, jitter: false }),
    ).rejects.toThrow("always fail");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("shouldRetry 返回 false 则不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(
      retry(fn, {
        maxAttempts: 5,
        baseDelayMs: 1,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("AbortSignal 中止重试", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error("fail");
    });
    await expect(
      retry(fn, { maxAttempts: 5, baseDelayMs: 1 }, controller.signal),
    ).rejects.toThrow();
  });
});

// ── Errors ────────────────────────────────────────────────

describe("Errors", () => {
  it("createError 创建结构化错误", () => {
    const e = createError("TIMEOUT", "operation timed out", { context: { tool: "shell" } });
    expect(e.code).toBe("TIMEOUT");
    expect(e.message).toBe("operation timed out");
    expect(e.context?.tool).toBe("shell");
    expect(e.timestamp).toBeTruthy();
  });

  it("toStructError 规范化 Error", () => {
    const e = toStructError(new Error("boom"));
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).toBe("boom");
  });

  it("toStructError 规范化 AbortError", () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const e = toStructError(abortErr);
    expect(e.code).toBe("ABORTED");
  });

  it("toStructError 规范化非 Error", () => {
    const e = toStructError("string error");
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).toBe("string error");
  });

  it("isRetryable 判断可重试错误", () => {
    expect(isRetryable(createError("TIMEOUT", "x"))).toBe(true);
    expect(isRetryable(createError("NETWORK_ERROR", "x"))).toBe(true);
    expect(isRetryable(createError("PERMISSION_DENIED", "x"))).toBe(false);
    expect(isRetryable(createError("SYNTAX_ERROR", "x"))).toBe(false);
  });
});
