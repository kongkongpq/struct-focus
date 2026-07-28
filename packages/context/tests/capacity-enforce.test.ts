import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LongContextEngine } from "../src/longcontext-engine.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 回归测试：容量兜底强制驱逐（forceEvictToCapacity）。
 *
 * 设计层观察（此前留作待办）：enforceCapacity() 只发"接近上限"告警 observation，
 * 不强制驱逐。若窗口超限且 autoManage 各压缩/降级路径都因"活跃+高相关度"未触发收缩，
 * 会一直告警而不落盘。本测试验证：持续超限 ≥3 步后，兜底逻辑强制驱逐最冷/低相关度
 * 条目，把占用压回安全水位（maxWindow * 0.9），且原文经 ContentStore 可召回恢复。
 */
describe("容量兜底强制驱逐", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sf-cap-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("窗口持续超限时强制驱逐最冷条目，占用回到安全水位且原文可恢复", async () => {
    const maxWindow = 3000;
    const engine = new LongContextEngine({
      storeRoot: path.join(dir, "store"),
      capsuleRoot: path.join(dir, "caps"),
      maxWindow,
      autoSummarize: false,
      minEntriesForSummarize: 999, // 关闭 summarizeInactive 干扰，专测容量兜底
    });
    const cm = engine.getContextManager();

    // 每条约 315 tokens（≈1260 字符），共 14 条 => 约 4410 tokens > 3000 窗口
    for (let i = 0; i < 14; i++) {
      const content = `（Redis 连接池 OOM 排查编号 ${i}）`.repeat(70);
      cm.appendUser(content, { source: `redis_${i}.ts` });
    }

    const pre = cm.getStats();
    expect(pre.usePercent).toBeGreaterThanOrEqual(95); // 确认确实超限

    // 连续调用 autoManage：第 3 步起 needsInteraction 触发强制驱逐
    for (let step = 0; step < 6; step++) {
      await engine.autoManage();
    }

    const post = cm.getStats();
    // 核心断言：窗口被压回安全水位（≤90%），且有条目被驱逐
    expect(post.usePercent).toBeLessThanOrEqual(90);
    expect(post.evictedEntries).toBeGreaterThan(0);
    expect(post.totalTokens).toBeLessThanOrEqual(Math.floor(maxWindow * 0.9) + 1);

    // 被驱逐条目的原文仍经召回可恢复（ContentStore 已落盘）
    const rec = await engine.recall("Redis 连接池 OOM 排查", { topK: 3 });
    expect(rec.injectText.length).toBeGreaterThan(0);
  });

  it("未超限时不驱逐任何条目（兜底幂等）", async () => {
    const engine = new LongContextEngine({
      storeRoot: path.join(dir, "store2"),
      capsuleRoot: path.join(dir, "caps2"),
      maxWindow: 3000,
      autoSummarize: false,
      minEntriesForSummarize: 999,
    });
    const cm = engine.getContextManager();
    for (let i = 0; i < 3; i++) {
      cm.appendUser(`（小条目 ${i}）`.repeat(3), { source: `s_${i}.ts` });
    }
    for (let step = 0; step < 4; step++) await engine.autoManage();
    const post = cm.getStats();
    expect(post.evictedEntries).toBe(0);
    expect(post.usePercent).toBeLessThan(95);
  });
});
