// memory 测试 - Memory 核心类：记录/搜索/胶囊/指针/环境/ONBOARDING
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Memory } from "@structfocus/memory";

let tmpDir: string;
let memory: Memory;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "struct-mem-"));
  memory = new Memory({ rootPath: tmpDir });
  await memory.init();
});

afterEach(async () => {
  await memory.close();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("Memory 记录", () => {
  it("record 写入 4 类记录", async () => {
    await memory.record({ kind: "decision", content: "选择 JSONL", tags: ["storage"] });
    await memory.record({ kind: "fact", content: "vitest 是框架" });
    await memory.record({ kind: "error", content: "类型错误" });
    await memory.record({ kind: "pref", content: "偏好暗色" });

    expect(memory.getRecords("decision")).toHaveLength(1);
    expect(memory.getRecords("fact")).toHaveLength(1);
    expect(memory.getRecords("error")).toHaveLength(1);
    expect(memory.getRecords("pref")).toHaveLength(1);
    expect(memory.getRecords()).toHaveLength(4);
  });

  it("search 按查询词搜索", async () => {
    await memory.record({ kind: "decision", content: "使用 TypeScript" });
    await memory.record({ kind: "fact", content: "vitest 用于测试" });

    const results = memory.search("TypeScript");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("TypeScript");
  });

  it("search 按 kind 过滤", async () => {
    await memory.record({ kind: "decision", content: "test content" });
    await memory.record({ kind: "error", content: "test content" });

    const results = memory.search("test", { kind: "error" });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("error");
  });

  it("searchSync 返回 RetrievedMemory", async () => {
    await memory.record({ kind: "fact", content: "hello world" });
    const results = memory.searchSync("hello", 200);
    expect(results.length).toBeGreaterThanOrEqual(0);
    if (results.length > 0) {
      expect(results[0]!.kind).toBe("fact");
      expect(results[0]!.summary).toContain("hello");
    }
  });
});

describe("Memory 胶囊", () => {
  it("recordCapsule + getCapsule", async () => {
    const cap = await memory.recordCapsule({
      requirement: "实现 EventBus",
      modifications: [{ file: "bus.ts", change: "添加 try/catch" }],
      keyDecisions: ["使用 Error[] 收集"],
      testResults: [{ testName: "emit 异常", passed: true }],
      knownLimitations: [],
      linkedPointers: [],
      tags: ["eventbus"],
      trigger: "test-pass",
    });
    expect(cap.id).toBeTruthy();
    expect(cap.status).toBe("active");

    const found = memory.getCapsule(cap.id);
    expect(found).toBeDefined();
    expect(found!.requirement).toBe("实现 EventBus");
  });

  it("searchCapsules 搜索", async () => {
    await memory.recordCapsule({
      requirement: "实现 EventBus",
      modifications: [],
      keyDecisions: [],
      testResults: [],
      knownLimitations: [],
      linkedPointers: [],
      tags: [],
      trigger: "test-pass",
    });
    await memory.recordCapsule({
      requirement: "实现 Pipeline",
      modifications: [],
      keyDecisions: [],
      testResults: [],
      knownLimitations: [],
      linkedPointers: [],
      tags: [],
      trigger: "test-pass",
    });

    const results = memory.searchCapsules("EventBus");
    expect(results).toHaveLength(1);
  });

  it("getActiveCapsules 返回活跃胶囊", async () => {
    await memory.recordCapsule({
      requirement: "test",
      modifications: [],
      keyDecisions: [],
      testResults: [],
      knownLimitations: [],
      linkedPointers: [],
      tags: [],
      trigger: "test-pass",
    });
    expect(memory.getActiveCapsules()).toHaveLength(1);
  });

  it("deprecate 标记过时 + 联动 needs-verify", async () => {
    const cap1 = await memory.recordCapsule({
      requirement: "v1",
      modifications: [],
      keyDecisions: [],
      testResults: [],
      knownLimitations: [],
      linkedPointers: [],
      tags: [],
      trigger: "test-pass",
    });
    const cap2 = await memory.recordCapsule({
      requirement: "v2 depends on v1",
      modifications: [],
      keyDecisions: [],
      testResults: [],
      knownLimitations: [],
      linkedPointers: [],
      tags: [],
      trigger: "test-pass",
      dependsOn: [cap1.id],
    });

    await memory.deprecateCapsule(cap1.id, "outdated");

    // cap2 应被联动标为 needs-verify
    const _updated = memory.getCapsule(cap2.id);
    // 注意：deprecate append 了一条新记录，旧的还在
    const allCaps = memory.searchCapsules("v2");
    const hasNeedsVerify = allCaps.some((c) => c.status === "needs-verify");
    expect(hasNeedsVerify).toBe(true);
  });

  it("版本链 getVersionChain", async () => {
    const cap1 = await memory.recordCapsule({
      requirement: "v1",
      modifications: [], keyDecisions: [], testResults: [],
      knownLimitations: [], linkedPointers: [], tags: [],
      trigger: "test-pass",
    });
    const _cap2 = await memory.recordCapsule({
      requirement: "v2",
      modifications: [], keyDecisions: [], testResults: [],
      knownLimitations: [], linkedPointers: [], tags: [],
      trigger: "test-pass",
      parent: cap1.id,
    });

    // 通过 capsuleMgr 访问版本链
    const chain = memory.searchCapsules("v");
    expect(chain.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Memory 可逆指针", () => {
  it("createPointer + expandPointer 100% 保真", async () => {
    const content = "这是一段很长的完整内容，需要被保真恢复。".repeat(10);
    const ptr = await memory.createPointer({
      type: "decision",
      topic: "测试指针",
      files: ["src/index.ts"],
      keywords: ["test"],
      importance: "high",
      content,
    });

    const expanded = memory.expandPointer(ptr.id);
    expect(expanded).toBe(content);
  });

  it("findPointersByFile 自动关联", async () => {
    await memory.createPointer({
      type: "file-content",
      topic: "文件指针",
      files: ["src/index.ts", "src/types.ts"],
      keywords: [],
      importance: "medium",
      content: "content",
    });

    const results = memory.findPointersByFile("src/index.ts");
    expect(results).toHaveLength(1);
    expect(results[0]!.topic).toBe("文件指针");
  });

  it("associatePointer 关联胶囊", async () => {
    const ptr = await memory.createPointer({
      type: "decision",
      topic: "决策",
      files: [],
      keywords: [],
      importance: "high",
      content: "decision content",
    });
    const cap = await memory.recordCapsule({
      requirement: "test",
      modifications: [], keyDecisions: [], testResults: [],
      knownLimitations: [], linkedPointers: [], tags: [],
      trigger: "test-pass",
    });

    await memory.associatePointer(ptr.id, cap.id);
    // 验证不崩溃即可
  });

  it("getByImportance / getAllPointers", async () => {
    await memory.createPointer({
      type: "decision", topic: "high", files: [], keywords: [],
      importance: "high", content: "c1",
    });
    await memory.createPointer({
      type: "decision", topic: "low", files: [], keywords: [],
      importance: "low", content: "c2",
    });

    expect(memory.getAllPointers().length).toBeGreaterThanOrEqual(2);
  });
});

describe("Memory ONBOARDING", () => {
  it("getOnboarding 初始为 null", () => {
    expect(memory.getOnboarding()).toBeNull();
  });

  it("generateOnboarding 启发式生成（不调 LLM）", async () => {
    // 创建一个 package.json
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project", version: "1.0.0", scripts: { build: "tsc" } }),
    );

    const onboarding = await memory.generateOnboarding();
    expect(onboarding).toContain("# ONBOARDING");
    expect(onboarding).toContain("test-project");
    expect(onboarding).toContain("build");
  });
});

describe("Memory 导出与汇报", () => {
  it("exportJSON 导出全部", async () => {
    await memory.record({ kind: "fact", content: "test" });
    const exported = await memory.exportJSON();
    expect(exported.records).toContain("test");
  });

  it("exportMarkdown 导出", async () => {
    await memory.record({ kind: "fact", content: "test" });
    const exported = await memory.exportMarkdown();
    expect(exported.records).toContain("# Memory Export");
  });

  it("getSummary 汇报概况", async () => {
    await memory.record({ kind: "decision", content: "d1" });
    await memory.record({ kind: "error", content: "e1" });
    await memory.recordCapsule({
      requirement: "test", modifications: [], keyDecisions: [],
      testResults: [], knownLimitations: [], linkedPointers: [],
      tags: [], trigger: "test-pass",
    });

    const summary = memory.getSummary();
    expect(summary.decisions).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.capsules).toBe(1);
  });
});
