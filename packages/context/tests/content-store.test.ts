// ContentStore 搜索精度 + LRU 清理单测（路线图 2.2.1）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ContentStore } from "../src/content-store.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "struct-cs-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

async function seed(
  store: ContentStore,
  id: string,
  content: string,
  source: string,
): Promise<void> {
  await store.save({
    entryId: id,
    originalContent: content,
    originalTokenCount: Math.ceil(content.length / 4),
    savedAt: Date.now(),
    reason: "forget",
    source,
  });
}

describe("ContentStore 搜索精度（BM25）", () => {
  it("search exact keyword returns correct entry", async () => {
    const store = new ContentStore(root);
    await seed(store, "e1", "Caroline is a software engineer", "c1");
    const r = await store.search("Caroline", { mode: "bm25", topK: 5 });
    expect(r.length).toBe(1);
    expect(r[0]!.entry.entryId).toBe("e1");
  });

  it("search case insensitive", async () => {
    const store = new ContentStore(root);
    await seed(store, "e1", "Caroline is a software engineer", "c1");
    const r = await store.search("caroline", { mode: "bm25", topK: 5 });
    expect(r.length).toBe(1);
    expect(r[0]!.entry.entryId).toBe("e1");
  });

  it("search with sourcePattern filter", async () => {
    const store = new ContentStore(root);
    await seed(store, "a", "discuss budget allocation", "convo_c3");
    await seed(store, "b", "discuss roadmap items", "convo_c5");
    await seed(store, "c", "discuss risk register", "convo_c3");
    const r = await store.search("discuss", {
      mode: "bm25",
      topK: 10,
      sourcePattern: "convo_c3",
    });
    expect(r.length).toBe(2);
    expect(r.map((x) => x.entry.entryId).sort()).toEqual(["a", "c"]);
  });

  it("search respects topK", async () => {
    const store = new ContentStore(root);
    for (let i = 0; i < 10; i++) {
      await seed(store, `e${i}`, `error message number ${i}`, `s${i}`);
    }
    const r = await store.search("error", { mode: "bm25", topK: 3 });
    expect(r.length).toBe(3);
  });

  it("search empty query returns empty", async () => {
    const store = new ContentStore(root);
    await seed(store, "e1", "something relevant", "s");
    const r = await store.search("", { mode: "bm25", topK: 5 });
    expect(r).toEqual([]);
  });

  it("rebuildIndex restores searchability from disk", async () => {
    const store = new ContentStore(root);
    await seed(store, "e1", "Caroline is a software engineer", "c1");
    // 全新实例从磁盘惰性重建内存索引
    const store2 = new ContentStore(root);
    const r = await store2.search("Caroline", { mode: "bm25", topK: 5 });
    expect(r.length).toBe(1);
    expect(r[0]!.entry.entryId).toBe("e1");
  });
});

describe("ContentStore 磁盘 LRU 清理", () => {
  it("store LRU eviction removes oldest when over limit", async () => {
    const store = new ContentStore(root, { maxStorageMB: 1 }); // 上限 1MB
    for (let i = 0; i < 40; i++) {
      await store.save({
        entryId: `big${i}`,
        originalContent: "x".repeat(40_000), // ~40KB/条
        originalTokenCount: 10_000,
        savedAt: Date.now() + i,
        reason: "forget",
        source: `f${i}`,
      });
    }
    const freed = await store.enforceStorageLimit();
    expect(freed).toBeGreaterThan(0);
    const stats = await store.getStorageStats();
    expect(stats.atCapacity).toBe(false);
  });
});
