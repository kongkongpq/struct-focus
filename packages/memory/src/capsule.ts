// @struct/memory - 知识胶囊管理

import type { KnowledgeCapsule, CapsuleStatus } from "@struct/framework";
import { createId, now } from "@struct/framework";
import { JsonlEngine } from "./engine.js";

export interface CapsuleInput {
  requirement: string;
  modifications: { file: string; change: string }[];
  keyDecisions: string[];
  testResults: { testName: string; passed: boolean; output?: string }[];
  knownLimitations: string[];
  linkedPointers: string[];
  tags: string[];
  trigger: KnowledgeCapsule["trigger"];
  parent?: string;
  dependsOn?: string[];
  confidence?: number;
}

/**
 * 胶囊管理器：
 * - recordCapsule: 封装并写入 JSONL
 * - getCapsule: 按 ID 查找
 * - searchCapsules: 字符串匹配搜索
 * - 版本链（parent / dependsOn）
 * - 过时验证（status: active|deprecated|needs-verify|raw）
 * - 生成失败 → 重试队列 3 次 → 标 raw
 */
export class CapsuleManager {
  private readonly engine: JsonlEngine<KnowledgeCapsule>;
  private retryQueue: { input: CapsuleInput; attempts: number }[] = [];

  constructor(engine: JsonlEngine<KnowledgeCapsule>) {
    this.engine = engine;
  }

  async recordCapsule(input: CapsuleInput): Promise<KnowledgeCapsule> {
    const capsule: KnowledgeCapsule = {
      id: createId<"capsule">("cap"),
      requirement: input.requirement,
      modifications: input.modifications,
      keyDecisions: input.keyDecisions,
      testResults: input.testResults,
      knownLimitations: input.knownLimitations,
      linkedPointers: input.linkedPointers,
      tags: input.tags,
      timestamp: now(),
      status: "active",
      parent: input.parent,
      dependsOn: input.dependsOn,
      confidence: input.confidence,
      trigger: input.trigger,
    };

    try {
      await this.engine.append(capsule);
      return capsule;
    } catch {
      // 生成失败 → 入重试队列
      this.retryQueue.push({ input, attempts: 1 });
      return { ...capsule, status: "raw" };
    }
  }

  getCapsule(id: string): KnowledgeCapsule | undefined {
    return this.engine.getById(id);
  }

  searchCapsules(query: string, opts?: { limit?: number }): KnowledgeCapsule[] {
    return this.engine.search(query, {
      ...opts,
      filter: (r) => r.status !== "deprecated",
    });
  }

  /** 标记胶囊过时，联动标关联胶囊 needs-verify */
  async deprecate(id: string, reason?: string): Promise<void> {
    const capsule = this.engine.getById(id);
    if (!capsule) return;

    const updated: KnowledgeCapsule = {
      ...capsule,
      status: "deprecated",
      knownLimitations: [...capsule.knownLimitations, reason ?? "Deprecated"],
    };
    await this.engine.append(updated);

    // 联动：依赖此胶囊的其他胶囊标 needs-verify
    const dependents = this.engine
      .getAll()
      .filter((c) => c.dependsOn?.includes(id) && c.status === "active");
    for (const dep of dependents) {
      const depUpdated: KnowledgeCapsule = {
        ...dep,
        status: "needs-verify",
      };
      await this.engine.append(depUpdated);
    }
  }

  /** 获取版本链 */
  getVersionChain(id: string): KnowledgeCapsule[] {
    const chain: KnowledgeCapsule[] = [];
    let current = this.engine.getById(id);
    while (current) {
      chain.unshift(current);
      current = current.parent ? this.engine.getById(current.parent) : undefined;
    }
    return chain;
  }

  /** 获取活跃胶囊列表 */
  getActiveCapsules(): KnowledgeCapsule[] {
    return this.engine.getAll().filter((c) => c.status === "active");
  }

  /** 重试队列处理（T3 异步） */
  async processRetryQueue(): Promise<void> {
    const queue = this.retryQueue;
    this.retryQueue = [];

    for (const item of queue) {
      if (item.attempts >= 3) {
        // 超过 3 次重试 → 标 raw
        const capsule: KnowledgeCapsule = {
          id: createId<"capsule">("cap"),
          requirement: item.input.requirement,
          modifications: item.input.modifications,
          keyDecisions: item.input.keyDecisions,
          testResults: item.input.testResults,
          knownLimitations: [...item.input.knownLimitations, "Auto-generation failed 3 times"],
          linkedPointers: item.input.linkedPointers,
          tags: item.input.tags,
          timestamp: now(),
          status: "raw",
          trigger: item.input.trigger,
        };
        await this.engine.append(capsule).catch(() => {});
        continue;
      }

      try {
        await this.recordCapsule(item.input);
      } catch {
        this.retryQueue.push({ ...item, attempts: item.attempts + 1 });
      }
    }
  }

  hasRetryItems(): boolean {
    return this.retryQueue.length > 0;
  }
}
