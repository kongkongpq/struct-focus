// @structfocus/context — LongContextRecall 新功能单测 (2026-07-19)
// 覆盖：放置系统 / 召回管线 / 概括管线 / 容量管理 / ContentStore 搜索 / toMessages L1/L2/L3 渲染

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextManager } from "../src/manager.js";
import { ContentStore, type StoredContent } from "../src/content-store.js";

import { summarizeToCapsule, chunkBySemantic } from "../src/summarize.js";
import { buildContext } from "../src/builder.js";
import { ContextPlacementConflictError, type ContextPlacement, type ContextEntry } from "../src/types.js";

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── 辅助函数 ──────────────────────────────────────────

function tmpDir(): string {
  return path.join(os.tmpdir(), `sctest_lcr_${Date.now()}_${Math.random().toString(36).slice(2)}`);
}

function makeCm(opts?: { maxWindow?: number; storeRoot?: string; capsuleRoot?: string }) {
  return new ContextManager({
    maxWindow: opts?.maxWindow ?? 128000,
    storeRoot: opts?.storeRoot ?? tmpDir(),
    capsuleRoot: opts?.capsuleRoot ?? tmpDir(),
  });
}

function _setTask(cm: ContextManager, editingFiles: string[]) {
  cm.setTaskContext({ currentSubtasks: ["task1"], editingFiles, failingTests: [], focusedSymbols: ["testFn"], recentErrors: [] });
}

// ─── 测试 1: 放置系统 ──────────────────────────────────

describe("Placement System", () => {
  let cm: ContextManager;
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    cm = new ContextManager({ maxWindow: 128000, storeRoot: dir, capsuleRoot: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("place → getPlacement 往返", async () => {
    cm.appendUser("test content");
    const entry = cm.getEntries()[0]!;
    const p = await cm.place(entry.id, "L3_compressed", "system", "测试放置");
    expect(p.target).toBe("L3_compressed");
    expect(p.source).toBe("system");
    const retrieved = cm.getPlacement(entry.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.target).toBe("L3_compressed");
  });

  it("pin (user) → 绝对保护", async () => {
    cm.appendUser("important");
    const entry = cm.getEntries()[0]!;
    await cm.pin(entry.id, "user", "必须保留");
    const e = cm.getEntries()[0]!;
    expect(e.taskRelevance).toBe(0);
    expect(e.placement).toBeTruthy();
    expect(e.placement!.source).toBe("user");
  });

  it("pin (ai) → 半保护", async () => {
    cm.appendUser("data");
    const entry = cm.getEntries()[0]!;
    await cm.pin(entry.id, "ai", "AI 关注");
    const e = cm.getEntries()[0]!;
    expect(e.taskRelevance).toBe(0.1);
  });

  it("AI 不能覆盖 user 的 pin", async () => {
    cm.appendUser("locked");
    const entry = cm.getEntries()[0]!;
    await cm.pin(entry.id, "user", "用户保护");
    await expect(
      cm.place(entry.id, "L4_raw", "ai", "试图覆盖")
    ).rejects.toThrow(ContextPlacementConflictError);
  });

  it("user 可以覆盖 AI", async () => {
    cm.appendUser("data");
    const entry = cm.getEntries()[0]!;
    await cm.pin(entry.id, "ai", "AI attention");
    const p2 = await cm.place(entry.id, "L4_raw", "user", "强制冷存");
    expect(p2.target).toBe("L4_raw");
  });

  it("unpin 清除 user pin", async () => {
    cm.appendUser("temp pinned");
    const entry = cm.getEntries()[0]!;
    await cm.pin(entry.id, "user", "临时保护");
    expect(cm.getPlacement(entry.id)).toBeTruthy();
    const ok = cm.unpin(entry.id);
    expect(ok).toBe(true);
    expect(cm.getPlacement(entry.id)).toBeNull();
  });

  it("unpin 清除 AI pin", async () => {
    cm.appendUser("ai pinned");
    const entry = cm.getEntries()[0]!;
    await cm.pin(entry.id, "ai", "AI attention");
    expect(cm.getPlacement(entry.id)).toBeTruthy();
    cm.unpin(entry.id);
    expect(cm.getPlacement(entry.id)).toBeNull();
  });

  it("expired placement 退回 null", async () => {
    cm.appendUser("expires soon");
    const entry = cm.getEntries()[0]!;
    await cm.place(entry.id, "L3_compressed", "ai", "for 1ms", { expiresAt: Date.now() + 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(cm.getPlacement(entry.id)).toBeNull();
  });

  it("placement 最多追加记录不覆盖", async () => {
    cm.appendUser("multi-place");
    const entry = cm.getEntries()[0]!;
    await cm.place(entry.id, "L2_working", "system", "first");
    await cm.place(entry.id, "L3_compressed", "ai", "second");
    await cm.place(entry.id, "L4_raw", "ai", "third");
    // 有效状态 = 最近一条
    const p = cm.getPlacement(entry.id);
    expect(p!.target).toBe("L4_raw");
    expect(p!.source).toBe("ai");
  });
});

// ─── 测试 2: ContentStore 搜索 ─────────────────────────

describe("ContentStore Search", () => {
  let store: ContentStore;
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    store = new ContentStore(dir);
    // 写入测试数据
    await store.save({
      entryId: "e1", originalContent: "Caroline joined the project in 2024", originalTokenCount: 10, savedAt: Date.now(), reason: "evict", source: "chat_1",
    });
    await store.save({
      entryId: "e2", originalContent: "数据库迁移到 PostgreSQL 完成", originalTokenCount: 8, savedAt: Date.now(), reason: "evict", source: "chat_2",
    });
    await store.save({
      entryId: "e3", originalContent: "Caroline discussed adoption with Evan last week", originalTokenCount: 12, savedAt: Date.now(), reason: "evict", source: "chat_3",
    });
    await store.save({
      entryId: "e4", originalContent: "PostgreSQL connection pool config updated", originalTokenCount: 10, savedAt: Date.now() - 100000, reason: "evict", source: "chat_1",
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("BM25 search: Caroline → 返回相关条目", async () => {
    const results = await store.search("Caroline adoption", { mode: "bm25", topK: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // e3 应该最高（包含 Caroline + Evan + adoption）
    const top = results[0]!;
    expect(top.entry.originalContent).toContain("Caroline");
  });

  it("BM25 search: PostgreSQL → 匹配英文词（中文需分词器，见已知局限）", async () => {
    const results = await store.search("PostgreSQL", { mode: "bm25", topK: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.entry.originalContent.includes("PostgreSQL"))).toBe(true);
  });

  it("BM25 search: 无匹配返回空", async () => {
    const results = await store.search("xyzzy_nonexistent_term", { mode: "bm25", topK: 5 });
    expect(results).toHaveLength(0);
  });

  it("search with minScore", async () => {
    const results = await store.search("Caroline", { mode: "bm25", topK: 5, minScore: 0.3 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("search with savedAfter filter", async () => {
    const now = Date.now();
    const results = await store.search("PostgreSQL", { mode: "bm25", topK: 5, savedAfter: now - 50000 });
    // e4 is 100s ago, e2 is recent
    const ids = results.map((r) => r.entry.entryId);
    expect(ids).toContain("e2");
    expect(ids).not.toContain("e4");
  });

  it("search with sourcePattern", async () => {
    const results = await store.search("Caroline", { mode: "bm25", topK: 5, sourcePattern: "chat_1" });
    const sources = results.map((r) => r.entry.source);
    expect(sources.every((s) => s === "chat_1")).toBe(true);
  });

  it("searchMulti 合并去重", async () => {
    const results = await store.searchMulti(["Caroline", "PostgreSQL"], { mode: "bm25", topK: 5 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // 不应有重复
    const ids = results.map((r) => r.entry.entryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rebuildIndex", async () => {
    const r = await store.rebuildIndex();
    expect(r.total).toBe(4);
    expect(r.indexed).toBe(4);
    expect(r.errors).toBe(0);
  });

  it("文件按哈希分片存储", async () => {
    const loaded = await store.load("e1");
    expect(loaded).toBeTruthy();
    expect(loaded!.originalContent).toContain("Caroline");
  });
});

// ─── 测试 3: 召回管线 ──────────────────────────────────

describe("Recall Pipeline", () => {
  let cm: ContextManager;
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    cm = new ContextManager({ maxWindow: 128000, storeRoot: dir, capsuleRoot: dir });
    // 写入一些内容到 ContentStore
    await cm.getStore().save({
      entryId: "r1", originalContent: "决定采用 Deno 替代 Node.js", originalTokenCount: 10, savedAt: Date.now(), reason: "evict",
    });
    await cm.getStore().save({
      entryId: "r2", originalContent: "决定采用 pnpm 替代 npm", originalTokenCount: 8, savedAt: Date.now(), reason: "evict",
    });
    await cm.getStore().save({
      entryId: "r3", originalContent: "Caroline的领养申请已通过", originalTokenCount: 8, savedAt: Date.now(), reason: "evict",
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recallRelevant → 返回相关条目", async () => {
    const result = await cm.recallRelevant("Deno 方案", 3);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.summary).toContain("Deno");
  });

  it("recallRelevant → 不返回已活跃在窗口中的条目（按 entryId 去重）", async () => {
    // 将一个条目先 append 进 CM，再 evict 到 ContentStore。
    // recallRelevant 按 entryId 去重，同一 ID 的已活跃条目不会重复出现在召回结果中。
    cm.appendUser("决定采用 Deno 替代 Node.js");
    const entry = cm.getEntries()[0]!;
    const entryId = entry.id;
    // 手动保存同样的 entryId 到 ContentStore
    await cm.getStore().save({
      entryId, originalContent: "决定采用 Deno 替代 Node.js",
      originalTokenCount: 10, savedAt: Date.now(), reason: "evict",
    });
    const result = await cm.recallRelevant("Deno", 5);
    // 同一 entryId 的应被去重
    expect(result.entries.every((e) => e.entryId !== entryId)).toBe(true);
  });

  it("recallRelevant → 无副作用", async () => {
    const before = cm.getEntries().length;
    await cm.recallRelevant("Caroline", 3);
    const after = cm.getEntries().length;
    expect(after).toBe(before); // 不应改变 entries
  });

  it("injectRecall → 注入 entries", async () => {
    const result = await cm.recallRelevant("Deno", 3);
    cm.injectRecall(result);
    const entries = cm.getEntries();
    const recalled = entries.filter((e) => e.content.startsWith("[recall]"));
    expect(recalled.length).toBe(result.entries.length);
  });

  it("recallScoped → 注入后 forgetScoped 清理", async () => {
    await cm.recallScoped("Deno", 3);
    const afterInject = cm.getEntries().filter((e: ContextEntry) => e.content.startsWith("[recall]"));
    expect(afterInject.length).toBeGreaterThan(0);
    // forget
    const count = cm.forgetScoped();
    expect(count).toBe(afterInject.length);
    const afterForget = cm.getEntries().filter((e: ContextEntry) => !e.evicted && e.content.startsWith("[recall]"));
    expect(afterForget.length).toBe(0);
  });

  it("recallRelevant → 无匹配时返回空 summary", async () => {
    const result = await cm.recallRelevant("nonexistent_xyz_abc", 3);
    expect(result.entries.length).toBe(0);
    expect(result.summary).toContain("未找到");
  });
});

// ─── 测试 4: 概括到胶囊 ────────────────────────────────

describe("Summarize to Capsule", () => {
  it("deterministic fallback 生成有效输出", async () => {
    const result = await summarizeToCapsule({
      entries: [
        { content: "决定采用 Rust 重写核心模块。经过评估 Go 和 Rust 后，确认 Rust 性能更优。约定所有新模块使用 Rust。" },
        { content: "已知局限：Rust 编译时间较长（约 45 秒全量构建）。"},
      ],
      metadata: { taskId: "rewrite-core", category: "code_session" },
    });
    expect(result.capsule).toBeTruthy();
    expect(result.capsule.id).toContain("rewrite-core");
    expect(result.l0Summary.length).toBeGreaterThan(0);
    expect(result.l1Summary.length).toBeGreaterThan(0);
    expect(result.pointers.length).toBe(2);
  });

  it("chunkBySemantic 正确分块", () => {
    const entries = [
      { content: "A".repeat(100), source: "user1" },
      { content: "B".repeat(100), source: "user1" }, // same source
      { content: "C".repeat(100), source: "user2" }, // different source
      { content: "\n\nD".repeat(50) + "\n\n" + "E".repeat(50), source: "user1" },
    ];
    const chunks = chunkBySemantic(entries, 150);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Each chunk should have content
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("chunkBySemantic 空输入返回空", () => {
    expect(chunkBySemantic([])).toHaveLength(0);
  });

  it("chunkBySemantic 时间跳跃 > 1 天强制分块", () => {
    const now = Date.now();
    const entries = [
      { content: "Day 1 message", timestamp: now },
      { content: "Day 3 message", timestamp: now + 2.5 * 24 * 3600 * 1000 },
    ];
    const chunks = chunkBySemantic(entries, 10000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]![0]!.content).toBe("Day 1 message");
    expect(chunks[1]![0]!.content).toBe("Day 3 message");
  });

  it("LLM 失败时回退到 deterministic", async () => {
    const failingLlm = async (_prompt: string): Promise<string> => {
      throw new Error("LLM unavailable");
    };
    const result = await summarizeToCapsule({
      entries: [{ content: "测试内容" }],
    }, failingLlm);
    expect(result.capsule).toBeTruthy();
    expect(result.l0Summary.length).toBeGreaterThan(0);
  });
});

// ─── 测试 5: toMessages + placement-aware 渲染 ──────────

describe("Placement-aware toMessages", () => {
  let cm: ContextManager;
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    cm = new ContextManager({ maxWindow: 128000, storeRoot: dir, capsuleRoot: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("L2_working 条目完整渲染", () => {
    cm.appendUser("important message");
    const msgs = cm.toMessages("system prompt");
    const userMessages = msgs.filter((m: { role: string; content: string | null }) => m.role === "user");
    expect(userMessages.some((m: { content: string | null }) => m.content && m.content.includes("important message"))).toBe(true);
  });

  it("L3_compressed 条目渲染为胶囊摘要", async () => {
    cm.appendUser("this will be condensed");
    const entry = cm.getEntries()[0]!;
    await cm.place(entry.id, "L3_compressed", "ai", "summarize", { capsuleSummary: "📦 测试胶囊摘要" });
    const msgs = cm.toMessages("system prompt");
    const capsuleMessages = msgs.filter((m: { content: string | null }) =>
      m.content && m.content.includes("胶囊"));
    expect(capsuleMessages.length).toBeGreaterThanOrEqual(1);
    expect(capsuleMessages[0]!.content).toContain("📦 测试胶囊摘要");
    expect(capsuleMessages[0]!.content).toContain("expand:context");
  });

  it("L4_raw 条目不渲染", async () => {
    cm.appendUser("cold storage data");
    const entry = cm.getEntries()[0]!;
    await cm.place(entry.id, "L4_raw", "user", "冷存");
    const msgs = cm.toMessages("system prompt");
    const coldMessages = msgs.filter((m: { content: string | null }) =>
      m.content && m.content.includes("cold storage"));
    expect(coldMessages.length).toBe(0);
  });

  it("无 placement 时等同于 L1（向后兼容）", () => {
    cm.appendUser("plain content");
    const msgs = cm.toMessages("system prompt");
    const userMessages = msgs.filter((m: { role: string }) => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 测试 6: 容量管理 ──────────────────────────────────

describe("Capacity Management", () => {
  it("小占用时不触发交互", () => {
    const cm = makeCm({ maxWindow: 128000 });
    cm.appendUser("small entry");
    const status = cm.getCapacityStatus();
    expect(status.usePercent).toBeLessThan(95);
    expect(status.needsInteraction).toBe(false);
    expect(status.alert).toBeNull();
  });

  it("容量强制阈值超过后触发告警", async () => {
    // 使用极小窗口 + 全部 pin 住条目，使驱逐无效，强制触发容量告警
    const cm = makeCm({ maxWindow: 200 });
    // 填充大量内容（每一个约 75+ tokens → 4 个就超窗口）
    for (let i = 0; i < 4; i++) {
      cm.appendUser(`X${String(i)}`.padEnd(300, "X")); // ~75 tokens each
    }
    // pin 住所有条目防止 autoManage 驱逐它们
    for (const e of cm.getEntries()) {
      await cm.pin(e.id, "user", "test pin");
    }

    // 多次 autoManage — 条目受保护无法驱逐，容量持续超限
    for (let i = 0; i < 4; i++) {
      await cm.autoManage();
    }
    const status = cm.getCapacityStatus();
    // 小窗口 + 4 条已超 100%
    expect(status.usePercent).toBeGreaterThanOrEqual(95);
    // 连续3步后应该触发
    expect(status.needsInteraction).toBe(true);
    if (status.alert) {
      expect(status.alert.topConsumers.length).toBeGreaterThan(0);
    }
  });

  it("统计 pin 数量正确", async () => {
    const cm = makeCm();
    cm.appendUser("e1");
    cm.appendUser("e2");
    cm.appendUser("e3");
    const entries = cm.getEntries();
    await cm.pin(entries[0]!.id, "user", "user pin");
    await cm.pin(entries[1]!.id, "ai", "ai pin");
    // entry[2] 没有pin
    const status = cm.getCapacityStatus();
    expect(status.activePins.user).toBe(1);
    expect(status.activePins.ai).toBe(1);
    expect(status.activePins.system).toBe(0);
  });
});

// ─── 测试 7: ContentStore.searchByCapsule ───────────────

describe("ContentStore Capsule Filtering", () => {
  let store: ContentStore;
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    store = new ContentStore(dir);
    await store.save({ entryId: "c1", originalContent: "part of capsule A", originalTokenCount: 5, savedAt: Date.now(), reason: "summarize", capsuleId: "capsule_a" });
    await store.save({ entryId: "c2", originalContent: "also capsule A", originalTokenCount: 5, savedAt: Date.now(), reason: "summarize", capsuleId: "capsule_a" });
    await store.save({ entryId: "c3", originalContent: "capsule B only", originalTokenCount: 5, savedAt: Date.now(), reason: "summarize", capsuleId: "capsule_b" });
    await store.save({ entryId: "c4", originalContent: "no capsule", originalTokenCount: 5, savedAt: Date.now(), reason: "evict" });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("searchByCapsule 按 capsuleId 过滤", async () => {
    const results = await store.searchByCapsule("capsule_a");
    expect(results.length).toBe(2);
    expect(results.map((r) => r.entryId).sort()).toEqual(["c1", "c2"]);
  });

  it("searchByCapsule 不存在的 capsule 返回空", async () => {
    const results = await store.searchByCapsule("nonexistent");
    expect(results.length).toBe(0);
  });

  it("无 capsuleId 的条目不在任何胶囊结果中", async () => {
    const results = await store.searchByCapsule("");
    expect(results.length).toBe(0);
  });
});

// ─── 测试 8: ContentStore.generateCapsuleSummary ────────

describe("ContentStore.generateCapsuleSummary", () => {
  it("generates summary with files", () => {
    const entries: StoredContent[] = [
      { entryId: "a", originalContent: "file1 content", originalTokenCount: 10, savedAt: Date.now(), reason: "evict", source: "src/a.ts" },
      { entryId: "b", originalContent: "file2 content", originalTokenCount: 20, savedAt: Date.now(), reason: "evict", source: "src/b.ts" },
    ];
    const summary = ContentStore.generateCapsuleSummary(entries);
    expect(summary).toContain("2 个文件");
    expect(summary).toContain("30 tokens");
  });

  it("generates summary without files", () => {
    const entries: StoredContent[] = [
      { entryId: "a", originalContent: "no source", originalTokenCount: 5, savedAt: Date.now(), reason: "evict" },
    ];
    const summary = ContentStore.generateCapsuleSummary(entries);
    expect(summary).toContain("1 条上下文");
  });
});

// ─── 测试 9: getStore() helper ─────────────────────────

describe("ContextManager.getStore()", () => {
  it("getStore 返回 ContentStore 实例", () => {
    const cm = makeCm();
    const store = (cm as any).store as ContentStore; // 直接访问 readonly
    expect(store).toBeInstanceOf(ContentStore);
  });
});

// ─── 测试 10: toMessages with placementMap 参数 ────────

describe("buildContext placementMap", () => {
  it("placementMap L4_raw 条目不渲染", () => {
    const entries: ContextEntry[] = [
      {
        id: "e1", type: "user", content: "visible", tokenCount: 10, timestamp: Date.now(),
        compressed: false, evicted: false, taskRelevance: 1, ageFactor: 1, currentEvictionScore: 0,
      },
      {
        id: "e2", type: "user", content: "hidden", tokenCount: 10, timestamp: Date.now() + 1,
        compressed: false, evicted: false, taskRelevance: 1, ageFactor: 1, currentEvictionScore: 0,
      },
    ];
    const placementMap = new Map<string, ContextPlacement>();
    placementMap.set("e2", { entryId: "e2", target: "L4_raw", source: "user", reason: "cold", placedAt: Date.now() });

    const msgs = buildContext({
      systemPrompt: "test",
      entries,
      taskContext: { currentSubtasks: [], editingFiles: [], failingTests: [], focusedSymbols: [], recentErrors: [] },
      usePercent: 10,
      placementMap,
    });

    const userMsgs = msgs.filter((m: { role: string }) => m.role === "user");
    expect(userMsgs.some((m: { content: string | null }) => m.content && m.content.includes("visible"))).toBe(true);
    expect(userMsgs.some((m: { content: string | null }) => m.content && m.content.includes("hidden"))).toBe(false);
  });

  it("placementMap L3_compressed 渲染为摘要", () => {
    const entries: ContextEntry[] = [
      {
        id: "e1", type: "user", content: "big content here", tokenCount: 100, timestamp: Date.now(),
        compressed: false, evicted: false, taskRelevance: 0.6, ageFactor: 1, currentEvictionScore: 0,
      },
    ];
    const placementMap = new Map<string, ContextPlacement>();
    placementMap.set("e1", {
      entryId: "e1", target: "L3_compressed", source: "ai", reason: "summarized",
      placedAt: Date.now(), capsuleSummary: "📦 摘要: 包含重要决策",
    });

    const msgs = buildContext({
      systemPrompt: "test",
      entries,
      taskContext: { currentSubtasks: [], editingFiles: [], failingTests: [], focusedSymbols: [], recentErrors: [] },
      usePercent: 10,
      placementMap,
    });

    const userMsgs = msgs.filter((m: { role: string }) => m.role === "user");
    const capsuleMsg = userMsgs.find((m: { content: string | null }) => m.content && m.content.includes("expand:context"));
    expect(capsuleMsg).toBeTruthy();
    expect(capsuleMsg!.content).toContain("📦 摘要: 包含重要决策");
    expect(capsuleMsg!.content).toContain("expand:context");
  });

  it("无 placementMap 时全为 L1（向后兼容）", () => {
    const entries: ContextEntry[] = [
      {
        id: "e1", type: "user", content: "hello world", tokenCount: 10, timestamp: Date.now(),
        compressed: false, evicted: false, taskRelevance: 1, ageFactor: 1, currentEvictionScore: 0,
      },
    ];
    const msgs = buildContext({
      systemPrompt: "test",
      entries,
      taskContext: { currentSubtasks: [], editingFiles: [], failingTests: [], focusedSymbols: [], recentErrors: [] },
      usePercent: 10,
    });
    const userMsgs = msgs.filter((m: { role: string }) => m.role === "user");
    expect(userMsgs.some((m: { content: string | null }) => m.content && m.content.includes("hello world"))).toBe(true);
  });
});
