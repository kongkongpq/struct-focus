import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContentStore } from "../src/content-store.js";

function tmpDir(): string {
  return path.join(tmpdir(), `struct-cs-lru-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

describe("ContentStore 磁盘 LRU（防无限增长）", () => {
  it("超过上限后按时间淘汰最旧条目，保留最新", async () => {
    const dir = tmpDir();
    // 上限 ~10KB（单条约 1.3KB，可容纳数个）；关闭节流以便每次 save 立即清理
    const limitBytes = Math.floor(0.01 * 1024 * 1024);
    const store = new ContentStore(dir, { maxStorageMB: 0.01, cleanupThrottleMs: 0 });
    try {
      for (let i = 0; i < 20; i++) {
        await store.save({
          entryId: `e${i}`,
          originalContent: "x".repeat(600),
          originalTokenCount: 150,
          savedAt: Date.now() + i,
          reason: "truncate",
        });
      }
      // save() 异步触发清理（不阻塞）；显式收尾确保最终状态稳定
      await store.enforceStorageLimit();
      const stats = await store.getStorageStats();
      // 回到上限 90% 以内
      expect(stats.usedBytes).toBeLessThanOrEqual(limitBytes);
      expect(stats.entryCount).toBeLessThan(20);
      // 最旧 e0 应被物理淘汰
      expect(await store.load("e0")).toBeNull();
      // 最新 e19 应保留
      expect(await store.load("e19")).not.toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("maxStorageMB=0 表示不限制，不会淘汰", async () => {
    const dir = tmpDir();
    const store = new ContentStore(dir, { maxStorageMB: 0, cleanupThrottleMs: 0 });
    try {
      for (let i = 0; i < 10; i++) {
        await store.save({
          entryId: `u${i}`,
          originalContent: "y".repeat(400),
          originalTokenCount: 100,
          savedAt: Date.now() + i,
          reason: "evict",
        });
      }
      const stats = await store.getStorageStats();
      expect(stats.maxBytes).toBe(0);
      expect(stats.entryCount).toBe(10);
      expect(await store.load("u0")).not.toBeNull();
    } finally {
      await cleanup(dir);
    }
  });

  it("enforceStorageLimit 手动触发清理并返回释放字节数", async () => {
    const dir = tmpDir();
    const limitBytes = Math.floor(0.01 * 1024 * 1024);
    const store = new ContentStore(dir, { maxStorageMB: 0.01, cleanupThrottleMs: 60_000 });
    try {
      for (let i = 0; i < 20; i++) {
        await store.save({
          entryId: `m${i}`,
          originalContent: "z".repeat(600),
          originalTokenCount: 150,
          savedAt: Date.now() + i,
          reason: "truncate",
        });
      }
      const before = await store.getStorageStats();
      const freed = await store.enforceStorageLimit();
      const after = await store.getStorageStats();
      expect(freed).toBeGreaterThan(0);
      expect(after.usedBytes).toBeLessThan(before.usedBytes);
      expect(after.usedBytes).toBeLessThanOrEqual(limitBytes);
    } finally {
      await cleanup(dir);
    }
  });
});
