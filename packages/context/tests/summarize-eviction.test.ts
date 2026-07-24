import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LongContextEngine } from "../src/longcontext-engine.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 回归测试：summarizeAndCapsule 必须真正驱逐原始条目、释放活跃窗口。
 *
 * 历史 bug：概括生成胶囊后只对原条目调用 place() 打 L3 标记，从不置 evicted，
 * 于是 18 条原文仍完整留在活跃窗口，还额外注入 1 条胶囊指针 → activeEntries 反而变大，
 * 窗口 token 完全没释放（胶囊只是"额外内容"）。
 */
describe("summarizeAndCapsule 释放活跃窗口", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sf-evict-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("概括后 activeEntries 大幅下降（原条目被驱逐，仅留胶囊指针）", async () => {
    const engine = new LongContextEngine({
      storeRoot: path.join(dir, "store"),
      capsuleRoot: path.join(dir, "caps"),
      minEntriesForSummarize: 5,
      autoSummarize: false,
    });

    const N = 12;
    for (let i = 0; i < N; i++) {
      engine.feed(`条目 ${i}：一段关于 Redis 连接池 OOM 排查与修复的上下文记录 ${i}`, {
        source: `e_${i}.ts`,
        type: "observation",
      });
    }

    const pre = await engine.getStats();
    expect(pre.activeEntries).toBe(N);

    const out = await engine.flush({ topic: "redis-oom" });
    expect(out).not.toBeNull();

    const post = await engine.getStats();
    // 核心断言：窗口被释放 —— 活跃条目远小于概括前（不再是 N 或 N+1）
    expect(post.activeEntries).toBeLessThan(pre.activeEntries);
    expect(post.activeEntries).toBeLessThanOrEqual(2); // 仅剩胶囊指针 observation
    expect(post.capsuleCount).toBe(1);
  });

  it("原文经召回/胶囊仍可恢复（驱逐不等于丢失）", async () => {
    const engine = new LongContextEngine({
      storeRoot: path.join(dir, "store2"),
      capsuleRoot: path.join(dir, "caps2"),
      minEntriesForSummarize: 5,
      autoSummarize: false,
    });
    for (let i = 0; i < 8; i++) {
      engine.feed(`条目 ${i}：连接池统一封装 try-with-resources 确保释放，min-idle=10 max-idle=50`, {
        source: `r_${i}.ts`,
        type: "observation",
      });
    }
    await engine.flush({ topic: "pool-fix" });

    const rec = await engine.recall("Redis 连接池怎么修", { topK: 3 });
    // 原文经召回仍可恢复（无论走胶囊摘要还是 ContentStore 原文片段）
    const recovered =
      rec.injectText.includes("胶囊") ||
      rec.injectText.includes("相关片段") ||
      rec.injectText.includes("连接池");
    expect(recovered).toBe(true);
  });
});
