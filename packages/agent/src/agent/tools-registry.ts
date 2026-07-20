// structfocus-agent - 工具注册（33 工具注册到 Harness，生成 LLM function-calling schema）

import type { ToolDef } from "@structfocus/framework";
import { type Harness, ALL_TOOLS } from "@structfocus/harness";

// ─── LLM function-calling 格式转换 ────────────────────────

export interface ToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: Record<string, { type: string; description: string }>;
      readonly required: readonly string[];
    };
  };
}

/** 将 ToolDef 转换为 OpenAI/DeepSeek/智谱 function-calling schema */
export function toToolSchema(def: ToolDef): ToolSchema {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const p of def.params) {
    properties[p.name] = { type: p.type, description: p.description };
    if (p.required) required.push(p.name);
  }
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: { type: "object", properties, required },
    },
  };
}

/** 获取所有已启用工具的 LLM schema */
export function getToolSchemas(harness: Harness): readonly ToolSchema[] {
  return harness.listTools().map(toToolSchema);
}

// ─── 工具分类注册 ──────────────────────────────────────────

export interface ToolRegistryOptions {
  /** 禁用的工具名列表 */
  readonly disable?: readonly string[];
  /** 额外注册的自定义工具 */
  readonly extras?: readonly ToolDef[];
}

/**
 * 将全部 33 个内置工具注册到 Harness。
 * 支持选择性禁用和注册自定义工具。
 * Harness 构造函数已预注册 ALL_TOOLS，此函数主要用于：
 *   1. 注册额外自定义工具
 *   2. 按配置禁用特定工具
 */
export function setupTools(harness: Harness, opts: ToolRegistryOptions = {}): void {
  // 禁用指定工具
  for (const name of opts.disable ?? []) {
    harness.disableTool(name);
  }

  // 注册自定义工具
  if (opts.extras && opts.extras.length > 0) {
    harness.registerTools(opts.extras);
  }
}

// ─── 工具统计 ──────────────────────────────────────────────

export function toolStats(harness: Harness) {
  const all = harness.listTools();
  const categories = new Map<string, number>();
  for (const t of all) {
    const cat = t.category ?? "other";
    categories.set(cat, (categories.get(cat) ?? 0) + 1);
  }
  return {
    total: all.length,
    categories: Object.fromEntries(categories),
    enabled: all.length,
    disabled: ALL_TOOLS.length - all.length,
  };
}
