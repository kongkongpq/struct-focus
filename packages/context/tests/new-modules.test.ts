// @struct/context - 新模块单测 (2026-07-17，v3)
// 覆盖: ContentStore / CapsuleStore / runInquiry / packSubtask / compressEntries / 可逆操作

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { ContextManager } from "../src/manager.js";
import { ContentStore, type StoredContent } from "../src/content-store.js";
import { CapsuleStore } from "../src/capsule.js";
import { BudgetManager } from "../src/budget.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "structagent-new-tests-" + Date.now());

const TASK_CTX = {
  currentSubtasks: [] as string[],
  failingTests: [] as string[],
  focusedSymbols: [] as string[],
  recentErrors: [] as { message: string; file?: string }[],
};

// ─── ContentStore ─────────────────────────────────────────

describe("ContentStore", () => {
  let store: ContentStore;
  const sroot = path.join(TEST_ROOT, "st");

  beforeEach(() => { store = new ContentStore(sroot); });
  afterEach(async () => { try { await fs.rm(sroot, { recursive: true, force: true }); } catch {} });

  it("save + load 往返", async () => {
    const entry: StoredContent = { entryId: "e_abc", originalContent: "hello world", originalTokenCount: 10, savedAt: Date.now(), reason: "evict", source: "test.ts" };
    await store.save(entry);
    const loaded = await store.load("e_abc");
    expect(loaded).not.toBeNull();
    expect(loaded!.originalContent).toBe("hello world");
    expect(loaded!.entryId).toBe("e_abc");
  });

  it("load 不存在的 id 返回 null", async () => {
    expect(await store.load("nonexistent")).toBeNull();
  });

  it("loadByFile 按 source 字段筛选", async () => {
    await store.save({ entryId: "e1", originalContent: "A", originalTokenCount: 5, savedAt: 1, reason: "evict", source: "foo.ts" });
    await store.save({ entryId: "e2", originalContent: "B", originalTokenCount: 3, savedAt: 2, reason: "forget", source: "bar.ts" });
    await store.save({ entryId: "e3", originalContent: "C", originalTokenCount: 7, savedAt: 3, reason: "evict", source: "foo.ts" });
    const found = await store.loadByFile("foo.ts");
    expect(found).toHaveLength(2);
    expect(found.map(e => e.originalContent).sort()).toEqual(["A", "C"]);
  });

  it("generateCapsuleSummary 生成摘要", () => {
    const entries: StoredContent[] = [
      { entryId: "ea", originalContent: "x", originalTokenCount: 10, savedAt: 1, reason: "evict", source: "a.ts" },
      { entryId: "eb", originalContent: "y", originalTokenCount: 20, savedAt: 2, reason: "evict", source: "b.ts" },
    ];
    const s = ContentStore.generateCapsuleSummary(entries);
    expect(s).toContain("2 个文件");
    expect(s).toContain("30 tokens");
  });
});

// ─── CapsuleStore ─────────────────────────────────────────

describe("CapsuleStore", () => {
  let caps: CapsuleStore;
  const croot = path.join(TEST_ROOT, "caps");

  beforeEach(() => { caps = new CapsuleStore(croot); });
  afterEach(async () => { try { await fs.rm(croot, { recursive: true, force: true }); } catch {} });

  it("buildCapsule 构建正确结构", () => {
    const cap = CapsuleStore.buildCapsule("task_1", [
      { content: "决策：使用 Redis 作为缓存层", source: "meeting.md", entryId: "e1", timestamp: 1 },
      { content: "错误：OOM at line 42", source: "log.txt", entryId: "e2", timestamp: 2 },
    ], { summary: "修复 Redis OOM", files: ["redis.ts"], symbols: ["connect", "disconnect"] });
    expect(cap.id).toMatch(/^capsule_/);
    expect(cap.taskId).toBe("task_1");
    expect(cap.summary).toBe("修复 Redis OOM");
    expect(cap.files).toContain("redis.ts");
    expect(cap.symbols).toContain("connect");
    expect(cap.entryIds).toHaveLength(2);
    expect(cap.originalTokens).toBeGreaterThan(0);
  });

  it("save + load 往返", async () => {
    const cap = CapsuleStore.buildCapsule("task_r", [{ content: "往返测试数据", source: "test.ts", entryId: "e_r", timestamp: 3 }]);
    await caps.save(cap);
    const loaded = await caps.load(cap.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe("task_r");
  });

  it("load 不存在返回 null", async () => {
    expect(await caps.load("capsule_ghost")).toBeNull();
  });

  it("list 返回摘要列表", async () => {
    await caps.save(CapsuleStore.buildCapsule("a", [{ content: "A", entryId: "ea", timestamp: 1 }], { files: ["a.ts"] }));
    await caps.save(CapsuleStore.buildCapsule("b", [{ content: "B", entryId: "eb", timestamp: 2 }], { files: ["b.ts"] }));
    expect((await caps.list())).toHaveLength(2);
  });

  it("findByFile 按文件关联查询", async () => {
    await caps.save(CapsuleStore.buildCapsule("f1", [{ content: "x", entryId: "ex", timestamp: 1 }], { files: ["src/auth.ts"] }));
    const found = await caps.findByFile("src/auth.ts");
    expect(found).toHaveLength(1);
    expect(found[0]!.taskId).toBe("f1");
  });

  it("summaryText 包含胶囊 id 和文件", () => {
    const cap = CapsuleStore.buildCapsule("task_s", [{ content: "决策：使用 Redis", source: "design.md", entryId: "e_s", timestamp: 4 }],
      { summary: "Redis 引入决策", files: ["redis.ts", "cache.ts"], symbols: ["RedisClient"] });
    const text = CapsuleStore.summaryText(cap);
    expect(text).toContain(cap.id);
    expect(text).toContain("redis.ts");
    expect(text).toContain("RedisClient");
    expect(text).toContain("recall:context");
  });
});

// ─── compressEntries ──────────────────────────────────────

describe("compressEntries", () => {
  let mgr: ContextManager;

  beforeEach(() => { mgr = new ContextManager(); });

  it("按 ID 谓词压缩指定条目", () => {
    mgr.appendObservation("keep me", { source: "f1.ts" });
    mgr.appendObservation("compress this please", { source: "f2.ts" });
    const all = mgr.getAllEntries();
    const count = mgr.compressEntries((e: any) => e.id === all[1]!.id);
    expect(count).toBe(1);
    const updated = mgr.getAllEntries();
    expect(updated[1]!.compressed).toBe(true);
    expect(updated[0]!.compressed).toBeFalsy();
  });

  it("压缩后条目有 compressedContent", () => {
    mgr.appendObservation("long content " + "x".repeat(3000), { source: "big.ts" });
    const all = mgr.getAllEntries();
    mgr.compressEntries((e: any) => e.id === all[0]!.id);
    const entries = mgr.getAllEntries();
    expect(entries[0]!.compressed).toBe(true);
    expect(entries[0]!.compressedContent).toBeTruthy();
  });

  it("type=system 条目不被压缩", () => {
    mgr.appendObservation("normal");
    const all = mgr.getAllEntries();
    // 手动插入一个 system 类型条目（通过内部数组）
    (mgr as any).entries.unshift({ id: "e_sys", type: "system", content: "system prompt", tokenCount: 50, timestamp: 1, taskRelevance: 0, evicted: false, compressed: false });
    const count = mgr.compressEntries((_e: any, idx: number) => idx === 0);
    expect(count).toBe(0);
  });
});

// ─── runInquiry 质询引擎 ──────────────────────────────────

describe("runInquiry", () => {
  let mgr: ContextManager;
  const croot = path.join(TEST_ROOT, "inq");

  beforeEach(() => { mgr = new ContextManager({ capsuleRoot: croot }); });
  afterEach(async () => { try { await fs.rm(croot, { recursive: true, force: true }); } catch {} });

  it("无编辑文件时返回空报告", async () => {
    const result = await mgr.runInquiry();
    expect(result.hasReport).toBe(false);
    expect(result.injectedCount).toBe(0);
  });

  it("编辑文件关联历史胶囊时注入缺口 observation", async () => {
    const capsule = CapsuleStore.buildCapsule("fix_login", [
      { content: "修复了登录超时问题", source: "auth.ts", entryId: "e_auth", timestamp: 5 },
    ], { files: ["auth.ts"] });
    await (mgr as any).capsules.save(capsule);
    mgr.setTaskContext({ editingFiles: ["auth.ts"], ...TASK_CTX });
    const result = await mgr.runInquiry();
    expect(result.hasReport).toBe(true);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.injectedCount).toBeGreaterThan(0);
  });

  it("冲突检测 — LLM 提议触及已放弃方案时注入冲突", async () => {
    const capsule = CapsuleStore.buildCapsule("fix_cache", [
      { content: "确定使用多级缓存", source: "cache.ts", entryId: "e_c1", timestamp: 6 },
    ]);
    capsule.discardedAlternatives = [{ approach: "全局锁 分布式锁 方案", reason: "耦合太强" }];
    await (mgr as any).capsules.save(capsule);
    // LLM assistant 回复中触发冲突关键词
    mgr.appendAssistant("我打算用全局锁和分布式锁方案解决缓存一致性");
    mgr.setTaskContext({ editingFiles: ["cache.ts"], ...TASK_CTX });
    await new Promise(r => setTimeout(r, 100));
    const result = await mgr.runInquiry();
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]).toContain("全局锁");
  });
});

// ─── packSubtask ──────────────────────────────────────────

describe("packSubtask", () => {
  let mgr: ContextManager;
  const croot = path.join(TEST_ROOT, "pack");

  beforeEach(() => { mgr = new ContextManager({ capsuleRoot: croot }); });
  afterEach(async () => { try { await fs.rm(croot, { recursive: true, force: true }); } catch {} });

  it("打包子任务并压缩原始条目", async () => {
    mgr.setTaskContext({ editingFiles: ["src/app.ts"], ...TASK_CTX });
    mgr.appendObservation("API 返回 429", { source: "api.ts", taskRelevance: 0.8 });
    mgr.appendObservation("修复方案：指数退避", { source: "api.ts" });
    const result = await mgr.packSubtask("fix_rate_limit", { summary: "修复速率限制" });
    expect(result.ok).toBe(true);
    expect(result.capsuleId).toMatch(/^capsule_/);
    expect(mgr.getAllEntries().filter((e: any) => e.compressed).length).toBeGreaterThan(0);
  });

  it("expandCapsule 展开已打包的胶囊", async () => {
    mgr.appendObservation("测试内容", { source: "test.ts" });
    const pack = await mgr.packSubtask("test_pack");
    expect(pack.ok).toBe(true);
    const expand = await mgr.expandCapsule(pack.capsuleId!);
    expect(expand.ok).toBe(true);
    expect(expand.capsule).toBeTruthy();
  });

  it("listCapsules 列出所有打包的胶囊", async () => {
    mgr.appendObservation("d1", { source: "a.ts" });
    await mgr.packSubtask("ta");
    mgr.appendObservation("d2", { source: "b.ts" });
    await mgr.packSubtask("tb");
    expect((await mgr.listCapsules())).toHaveLength(2);
  });
});

// ─── 可逆操作 ─────────────────────────────────────────────

describe("可逆操作", () => {
  let mgr: ContextManager;

  beforeEach(() => { mgr = new ContextManager(); });

  it("expandEntry 恢复压缩条目", () => {
    mgr.appendObservation("original text here", { source: "f.ts" });
    const all = mgr.getAllEntries();
    mgr.compressEntries((e: any) => e.id === all[0]!.id);
    expect(mgr.getAllEntries()[0]!.compressed).toBe(true);
    const ok = mgr.expandEntry(all[0]!.id);
    expect(ok).toBe(true);
    expect(mgr.getAllEntries()[0]!.compressed).toBe(false);
  });

  it("truncateLongEntries 产生可逆截断", () => {
    // 生成超长内容（tokenCount > 2000）、多行（确保 truncateEntryContent 生效）
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) lines.push(`line_${i.toString().padStart(4, "0")}: ${"data ".repeat(10)}`);
    const long = lines.join("\n");
    (mgr as any).entries.push({
      id: "e_long", type: "tool", content: long,
      tokenCount: 2500, timestamp: Date.now(), taskRelevance: 0.5,
      source: "big.ts", evicted: false, compressed: false,
    });
    const count = mgr.truncateLongEntries();
    expect(count).toBeGreaterThanOrEqual(1);
    const e = (mgr as any).entries.find((x: any) => x.id === "e_long");
    expect(e.originalContent).toBeTruthy();
    expect(e.content.length).toBeLessThan(long.length);
  });

  it("recallFromStore 使用 entry id（非 externalRef）还原驱逐条目", async () => {
    const sroot = path.join(TEST_ROOT, "rs");
    const mgr2 = new ContextManager({ storeRoot: sroot });
    try {
      mgr2.appendObservation("restorable content here", { source: "restore.ts" });
      const entriesBefore = mgr2.getEntries();
      const targetId = entriesBefore[0]!.id;
      mgr2.forgetFile("restore.ts");
      await new Promise(r => setTimeout(r, 100));
      // forgetFile 存到 ContentStore 用的是 e.id（非 externalRef），load 也要用 e.id
      const ok = await mgr2.recallFromStore(targetId);
      expect(ok).toBe(true);
    } finally {
      await fs.rm(sroot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("recallByFile 按文件路径还原关联条目", async () => {
    const sroot = path.join(TEST_ROOT, "rb");
    const mgr3 = new ContextManager({ storeRoot: sroot });
    try {
      mgr3.appendObservation("data1 here", { source: "foo.ts" });
      mgr3.appendObservation("data2 more", { source: "foo.ts" });
      mgr3.appendObservation("data3 bar", { source: "bar.ts" });
      mgr3.forgetFile("foo.ts");
      await new Promise(r => setTimeout(r, 100));
      const count = await mgr3.recallByFile("foo.ts");
      expect(count).toBeGreaterThan(0);
    } finally {
      await fs.rm(sroot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ─── 性能防护 ─────────────────────────────────────────────

describe("性能防护", () => {
  it("runInquiry 在空胶囊状态下快速返回", async () => {
    const mgr = new ContextManager({ capsuleRoot: path.join(TEST_ROOT, "perf") });
    mgr.setTaskContext({ editingFiles: ["test.ts"], ...TASK_CTX });
    const start = Date.now();
    const result = await mgr.runInquiry();
    expect(Date.now() - start).toBeLessThan(500);
    expect(result.hasReport).toBe(false);
  });
});

afterAll(async () => {
  try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
});
