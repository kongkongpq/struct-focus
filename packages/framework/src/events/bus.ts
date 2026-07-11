// @struct/framework - EventBus 实现

import type { BaseEvent, EventHandler, IEventBus } from "./types.js";

/**
 * 泛型事件总线。
 * - emit 同步执行所有 handler，收集异常返回 Error[]（不吞异常）
 * - emitAsync 异步执行，支持 AbortSignal 中止
 * - on 返回 unsubscribe 函数
 * - 遍历时使用快照副本，遍历中卸载不崩
 */
export class EventBus<E extends Record<string, unknown> = Record<string, unknown>>
  implements IEventBus<E>
{
  private handlers = new Map<string, Set<EventHandler>>();

  on<K extends keyof E & string>(type: K, handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  once<K extends keyof E & string>(type: K, handler: EventHandler): () => void {
    const wrapper: EventHandler = (event) => {
      this.off(type, wrapper);
      return handler(event);
    };
    return this.on(type, wrapper);
  }

  off<K extends keyof E & string>(type: K, handler: EventHandler): void {
    const set = this.handlers.get(type);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(type);
      }
    }
  }

  emit<K extends keyof E & string>(type: K, data: E[K]): Error[] {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return [];

    const event: BaseEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    const errors: Error[] = [];
    // 快照遍历，遍历中卸载安全
    const snapshot = Array.from(set);
    for (const handler of snapshot) {
      try {
        const result = handler(event);
        // 同步 emit 中若返回 Promise，不等待但捕获 reject
        if (result instanceof Promise) {
          result.catch((e) => {
            errors.push(e instanceof Error ? e : new Error(String(e)));
          });
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return errors;
  }

  async emitAsync<K extends keyof E & string>(
    type: K,
    data: E[K],
    signal?: AbortSignal,
  ): Promise<Error[]> {
    if (signal?.aborted) {
      return [new Error("Aborted before emit")];
    }

    const set = this.handlers.get(type);
    if (!set || set.size === 0) return [];

    const event: BaseEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    const errors: Error[] = [];
    const snapshot = Array.from(set);
    for (const handler of snapshot) {
      if (signal?.aborted) {
        errors.push(new Error("Aborted during emit"));
        break;
      }
      try {
        await handler(event);
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return errors;
  }

  listenerCount<K extends keyof E & string>(type: K): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
