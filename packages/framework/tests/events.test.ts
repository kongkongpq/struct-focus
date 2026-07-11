// framework 测试 - EventBus
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "@struct/framework";

describe("EventBus", () => {
  it("on/emit 基本订阅与触发", () => {
    const bus = new EventBus<{ test: { value: number } }>();
    const handler = vi.fn();
    bus.on("test", handler);
    const errors = bus.emit("test", { value: 42 });
    expect(errors).toHaveLength(0);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "test", data: { value: 42 } }),
    );
  });

  it("off 取消订阅", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    const handler = vi.fn();
    bus.on("test", handler);
    bus.off("test", handler);
    bus.emit("test", { x: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("on 返回 unsubscribe 函数", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    const handler = vi.fn();
    const unsub = bus.on("test", handler);
    unsub();
    bus.emit("test", { x: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("once 只触发一次", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    const handler = vi.fn();
    bus.once("test", handler);
    bus.emit("test", { x: 1 });
    bus.emit("test", { x: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emit 收集 handler 异常但不中断", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    const handler1 = vi.fn(() => {
      throw new Error("handler1 error");
    });
    const handler2 = vi.fn();
    bus.on("test", handler1);
    bus.on("test", handler2);
    const errors = bus.emit("test", { x: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("handler1 error");
    expect(handler2).toHaveBeenCalled();
  });

  it("emitAsync 异步执行并收集异常", async () => {
    const bus = new EventBus<{ test: { x: number } }>();
    const handler1 = vi.fn(async () => {
      throw new Error("async error");
    });
    const handler2 = vi.fn(async () => {});
    bus.on("test", handler1);
    bus.on("test", handler2);
    const errors = await bus.emitAsync("test", { x: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("async error");
    expect(handler2).toHaveBeenCalled();
  });

  it("emitAsync 支持 AbortSignal 中止", async () => {
    const bus = new EventBus<{ test: { x: number } }>();
    bus.on("test", vi.fn());
    const controller = new AbortController();
    controller.abort();
    const errors = await bus.emitAsync("test", { x: 1 }, controller.signal);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Aborted");
  });

  it("listenerCount 返回正确数量", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    bus.on("test", vi.fn());
    bus.on("test", vi.fn());
    expect(bus.listenerCount("test")).toBe(2);
  });

  it("遍历时卸载不崩溃", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    const handler1 = vi.fn();
    const handler2 = vi.fn(() => {
      bus.off("test", handler1);
    });
    bus.on("test", handler1);
    bus.on("test", handler2);
    expect(() => bus.emit("test", { x: 1 })).not.toThrow();
    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it("clear 清空所有", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    bus.on("test", vi.fn());
    bus.clear();
    expect(bus.listenerCount("test")).toBe(0);
  });

  it("无 handler 时 emit 返回空数组", () => {
    const bus = new EventBus<{ test: { x: number } }>();
    const errors = bus.emit("test", { x: 1 });
    expect(errors).toHaveLength(0);
  });
});
