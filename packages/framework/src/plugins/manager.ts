// @struct/framework - PluginManager 实现

import type { IPlugin, PluginHooks, AgentContext, ToolContext, RunResult, InjectResult } from "./types.js";
import type { StructError } from "../errors/types.js";
import { createError, toStructError } from "../errors/types.js";

/**
 * 插件管理器：
 * - 按 priority 降序排序（数值大 = 优先级高）
 * - 遍历使用快照副本，遍历中卸载/注册安全
 * - 单插件异常隔离：try/catch 收集为 StructError，不中断管道
 */
export class PluginManager {
  private plugins = new Map<string, IPlugin>();
  private sortedCache: IPlugin[] | null = null;

  register(plugin: IPlugin): void {
    this.plugins.set(plugin.id, plugin);
    this.invalidateCache();
  }

  unregister(id: string): void {
    this.plugins.delete(id);
    this.invalidateCache();
  }

  get(id: string): IPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): readonly IPlugin[] {
    if (!this.sortedCache) {
      this.sortedCache = Array.from(this.plugins.values()).sort(
        (a, b) => b.priority - a.priority,
      );
    }
    return this.sortedCache;
  }

  count(): number {
    return this.plugins.size;
  }

  clear(): void {
    this.plugins.clear();
    this.invalidateCache();
  }

  private invalidateCache(): void {
    this.sortedCache = null;
  }

  /**
   * 依次调用所有插件的指定钩子，合并 InjectResult。
   * 单插件异常被收集为 StructError，不中断后续插件。
   */
  async invokeAgentHooks(
    hookName: "onBeforeAgent" | "onAfterAgent",
    ctx: AgentContext,
  ): Promise<{ results: InjectResult[]; errors: StructError[] }> {
    const results: InjectResult[] = [];
    const errors: StructError[] = [];
    const snapshot = this.list();

    for (const plugin of snapshot) {
      const hook = plugin.hooks[hookName];
      if (!hook) continue;
      try {
        const result = await hook(ctx);
        if (result) results.push(result);
      } catch (e) {
        errors.push(
          createError("PLUGIN_ERROR", `Plugin ${plugin.id} ${hookName} failed`, {
            cause: e,
            context: { pluginId: plugin.id, hook: hookName },
          }),
        );
      }
    }
    return { results, errors };
  }

  async invokeToolHooks(
    hookName: "onBeforeTool" | "onAfterTool",
    ctx: ToolContext,
  ): Promise<{ results: InjectResult[]; errors: StructError[]; blocked?: { reason: string } }> {
    const results: InjectResult[] = [];
    const errors: StructError[] = [];
    let blocked: { reason: string } | undefined;
    const snapshot = this.list();

    for (const plugin of snapshot) {
      if (blocked) break;
      const hook = plugin.hooks[hookName];
      if (!hook) continue;
      try {
        const result = await hook(ctx);
        if (result) {
          results.push(result);
          if (result.blockTool) {
            blocked = { reason: result.blockReason ?? "Blocked by plugin" };
          }
        }
      } catch (e) {
        errors.push(
          createError("PLUGIN_ERROR", `Plugin ${plugin.id} ${hookName} failed`, {
            cause: e,
            context: { pluginId: plugin.id, hook: hookName },
          }),
        );
      }
    }
    return { results, errors, blocked };
  }

  async invokeRunCompleted(result: RunResult): Promise<StructError[]> {
    const errors: StructError[] = [];
    const snapshot = this.list();

    for (const plugin of snapshot) {
      const hook = plugin.hooks.onRunCompleted;
      if (!hook) continue;
      try {
        await hook(result);
      } catch (e) {
        errors.push(
          createError("PLUGIN_ERROR", `Plugin onRunCompleted failed`, {
            cause: e,
            context: { pluginId: plugin.id, hook: "onRunCompleted" },
          }),
        );
      }
    }
    return errors;
  }

  async invokeError(
    error: unknown,
    ctx?: Parameters<NonNullable<PluginHooks["onError"]>>[1],
  ): Promise<StructError[]> {
    const errors: StructError[] = [];
    const snapshot = this.list();

    for (const plugin of snapshot) {
      const hook = plugin.hooks.onError;
      if (!hook) continue;
      try {
        await hook(error, ctx);
      } catch (e) {
        errors.push(
          createError("PLUGIN_ERROR", `Plugin ${plugin.id} onError failed`, {
            cause: e,
            context: { pluginId: plugin.id, hook: "onError" },
          }),
        );
      }
    }
    return errors;
  }
}
