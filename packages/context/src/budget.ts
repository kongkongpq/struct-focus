// @structfocus/context - 预算桶模型

import type { TokenSlice, TokenUsage } from "@structfocus/framework";

export interface BudgetBucket {
  readonly name: string;
  readonly limit: number;
  used: number;
}

export const DEFAULT_BUDGET_BUCKETS: readonly BudgetBucket[] = [
  { name: "fixed", limit: 2000, used: 0 },
  { name: "session", limit: 5000, used: 0 },
  { name: "retrieval", limit: 5000, used: 0 },
  { name: "tools", limit: 3000, used: 0 },
  { name: "dynamic", limit: 110000, used: 0 },
];

export const TOTAL_BUDGET = 125000;
export const FIXED_OVERHEAD = 15000;

/** 注入式真实 tokenizer 的类型 */
export type TokenEstimator = (text: string) => number;

/** 注入式真实 tokenizer 的最大上下文窗口（不同模型可覆盖） */
export const MAX_CONTEXT_WINDOW = 200_000;

let tokenEstimator: TokenEstimator | null = null;
let maxContextWindow = MAX_CONTEXT_WINDOW;

/** 注入/清除真实 tokenizer（传 null 恢复字符启发式） */
export function setTokenEstimator(fn: TokenEstimator | null): void {
  tokenEstimator = fn;
}

/** 当前是否已注入真实 tokenizer */
export function hasTokenEstimator(): boolean {
  return tokenEstimator !== null;
}

/** 设置/读取最大上下文窗口（按模型能力调整） */
export function setMaxContextWindow(value: number): void {
  if (value > 0) maxContextWindow = value;
}

/** 读取最大上下文窗口（默认 MAX_CONTEXT_WINDOW，可被 setMaxContextWindow 覆盖） */
export function getMaxContextWindow(): number {
  return maxContextWindow;
}

export type EvictionPriority = 1 | 2 | 3 | 4 | 5 | 6;

export const EVICTION_ORDER: readonly { priority: EvictionPriority; name: string; description: string }[] = [
  { priority: 1, name: "old-tool-output", description: "旧工具输出→[已省略]" },
  { priority: 2, name: "expanded-pointers", description: "已展开指针包→重新压缩" },
  { priority: 3, name: "low-relevance-memory", description: "低相关记忆" },
  { priority: 4, name: "project-memory", description: "项目记忆(可重读)" },
  { priority: 5, name: "active-code", description: "活跃代码(绝不扔)" },
  { priority: 6, name: "system-prompt", description: "System Prompt(绝不扔)" },
];

export class BudgetManager {
  private buckets: Map<string, BudgetBucket>;
  readonly totalBudget: number;

  constructor(buckets: readonly BudgetBucket[] = DEFAULT_BUDGET_BUCKETS) {
    this.buckets = new Map(buckets.map((b) => [b.name, { ...b }]));
    this.totalBudget = buckets.reduce((sum, b) => sum + b.limit, 0);
  }

  /** 记录某层消耗 */
  consume(bucket: string, tokens: number): void {
    const b = this.buckets.get(bucket);
    if (b) b.used += tokens;
  }

  /** 获取某桶剩余 */
  remaining(bucket: string): number {
    const b = this.buckets.get(bucket);
    return b ? Math.max(0, b.limit - b.used) : 0;
  }

  /** 总已用 */
  totalUsed(): number {
    let sum = 0;
    for (const b of this.buckets.values()) sum += b.used;
    return sum;
  }

  /** 总剩余 */
  totalRemaining(): number {
    return this.totalBudget - this.totalUsed();
  }

  /** 是否超预算 */
  isOverBudget(): boolean {
    return this.totalUsed() > this.totalBudget;
  }

  /**
   * 预算估算器：优先用注入的真实 tokenizer；未注入时退回字符启发式（4 字符≈1 token）。
   * 即便有真实估计，也保留字符启发式下限（每 6 字符至少 1 token），防止极端低估导致预算失控。
   */
  static estimateTokens(text: string): number {
    if (tokenEstimator) {
      const est = tokenEstimator(text);
      return Math.max(est, Math.ceil(text.length / 6));
    }
    return Math.ceil(text.length / 4);
  }

  /** 生成 TokenUsage 报告 */
  toTokenUsage(): TokenUsage {
    const slices: TokenSlice[] = Array.from(this.buckets.values()).map((b) => ({
      layer: b.name,
      tokens: b.used,
    }));
    return {
      total: this.totalUsed(),
      slices,
      budget: this.totalBudget,
      remaining: this.totalRemaining(),
    };
  }

  /** 按驱逐优先级获取驱逐顺序 */
  getEvictionOrder(): readonly typeof EVICTION_ORDER[number][] {
    return EVICTION_ORDER;
  }

  /** 重置 */
  reset(): void {
    for (const b of this.buckets.values()) b.used = 0;
  }
}
