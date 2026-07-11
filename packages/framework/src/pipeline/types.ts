// @struct/framework - Pipeline 类型与实现

import type { Result } from "../types/base.js";

/** 中间件：接收上下文 T 和 next，可前置/后置处理 */
export type NamedMiddleware<T> = {
  readonly name: string;
  (ctx: T, next: () => Promise<void>): Promise<void>;
};

/** 管道接口 */
export interface IPipeline<T> {
  use(middleware: NamedMiddleware<T>): void;
  remove(name: string): void;
  middlewares(): readonly NamedMiddleware<T>[];
  run(ctx: T, signal?: AbortSignal): Promise<Result<T, Error>>;
}

/**
 * 洋葱模型管道：按注册顺序执行，每层可前/后置处理。
 * - 支持 AbortSignal 中止
 * - 单层异常不传播，收集为 Result
 * - 遍历时使用快照副本
 */
export class Pipeline<T> implements IPipeline<T> {
  private list: NamedMiddleware<T>[] = [];

  use(middleware: NamedMiddleware<T>): void {
    this.list.push(middleware);
  }

  remove(name: string): void {
    this.list = this.list.filter((m) => m.name !== name);
  }

  middlewares(): readonly NamedMiddleware<T>[] {
    return [...this.list];
  }

  async run(ctx: T, signal?: AbortSignal): Promise<Result<T, Error>> {
    if (signal?.aborted) {
      return { ok: false, error: new Error("Aborted before pipeline") };
    }

    const snapshot = [...this.list];
    let aborted = false;

    const dispatch = async (index: number): Promise<void> => {
      if (aborted || signal?.aborted) {
        aborted = true;
        return;
      }
      if (index >= snapshot.length) return;

      const mw = snapshot[index]!;
      if (!mw) return;

      await mw(ctx, async () => {
        await dispatch(index + 1);
      });
    };

    try {
      await dispatch(0);
      if (aborted) {
        return { ok: false, error: new Error("Pipeline aborted") };
      }
      return { ok: true, value: ctx };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e : new Error(String(e)),
      };
    }
  }
}
