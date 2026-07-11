// @struct/framework - 事件系统类型

import type { Id } from "../types/base.js";

/** 基础事件接口 */
export interface BaseEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly data?: unknown;
}

/** framework 基础设施事件类型映射 */
export interface FrameworkEvents {
  "state:changed": { from: string; to: string; reason?: string };
  "plugin:registered": { pluginId: string; priority: number };
  "plugin:unregistered": { pluginId: string };
  "plugin:error": { pluginId: string; hook: string; error: unknown };
  "pipeline:error": { middleware: string; error: unknown };
  "tool:blocked": { tool: string; reason: string };
  abort: { reason: string };
}

/** 事件处理器返回 void，异常由 EventBus 收集 */
export type EventHandler<E extends BaseEvent = BaseEvent> = (event: E) => void | Promise<void>;

/** 事件总线接口 */
export interface IEventBus<E extends Record<string, unknown> = Record<string, unknown>> {
  on<K extends keyof E & string>(type: K, handler: EventHandler): () => void;
  once<K extends keyof E & string>(type: K, handler: EventHandler): () => void;
  off<K extends keyof E & string>(type: K, handler: EventHandler): void;
  emit<K extends keyof E & string>(type: K, data: E[K]): Error[];
  emitAsync<K extends keyof E & string>(type: K, data: E[K], signal?: AbortSignal): Promise<Error[]>;
  listenerCount<K extends keyof E & string>(type: K): number;
  clear(): void;
}
