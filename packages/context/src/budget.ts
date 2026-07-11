// @struct/context - 预算桶模型

import type { TokenSlice, TokenUsage } from "@struct/framework";

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

  /** 估算 tokens（粗略：4 字符 ≈ 1 token） */
  static estimateTokens(text: string): number {
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
