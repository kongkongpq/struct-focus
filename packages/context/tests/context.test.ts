// context 测试 - PointerRegistry + BudgetManager + CodeExplorer + ContextBuilder
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PointerRegistry, BudgetManager, CodeExplorer, ContextBuilder, TOTAL_BUDGET } from "@structfocus/context";
import { type ContextPointer, type IMemoryProvider, type RetrievedMemory, now } from "@structfocus/framework";

// ── PointerRegistry ───────────────────────────────────────

describe("PointerRegistry", () => {
  let reg: PointerRegistry;

  beforeEach(() => { reg = new PointerRegistry(); });

  it("register + get", () => {
    const p: ContextPointer = makePointer("ptr_1", "high");
    reg.register(p);
    expect(reg.get("ptr_1")).toBe(p);
  });

  it("expand 通过 memory provider 获取内容", () => {
    const p: ContextPointer = makePointer("ptr_1", "high");
    reg.register(p);
    const mockMemory: IMemoryProvider = {
      searchSync: vi.fn(),
      findPointersByFile: vi.fn(),
      expandPointer: vi.fn().mockReturnValue("full content"),
      getProjectContext: vi.fn(),
    };
    reg.setMemoryProvider(mockMemory);
    reg.markExpanded("ptr_1");
    const content = reg.expand("ptr_1");
    expect(content).toBeTruthy();
  });

  it("high 指针强制展开", () => {
    const p: ContextPointer = makePointer("ptr_1", "high");
    reg.register(p);
    reg.expand("ptr_1"); // 自动标记展开
    expect(reg.getExpanded()).toHaveLength(1);
  });

  it("compress 非 high 指针", () => {
    const p: ContextPointer = makePointer("ptr_1", "low");
    reg.register(p);
    reg.markExpanded("ptr_1");
    reg.compress("ptr_1");
    expect(reg.getExpanded()).toHaveLength(0);
  });

  it("compress high 指针不可压缩", () => {
    const p: ContextPointer = makePointer("ptr_1", "high");
    reg.register(p);
    reg.markExpanded("ptr_1");
    reg.compress("ptr_1");
    expect(reg.getExpanded()).toHaveLength(1);
  });

  it("findByFile 自动关联", () => {
    reg.register(makePointer("ptr_1", "medium", ["src/index.ts", "src/types.ts"]));
    reg.register(makePointer("ptr_2", "low", ["src/other.ts"]));
    const results = reg.findByFile("src/index.ts");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("ptr_1");
  });

  it("deduplicate 合并共享>50%文件的指针", () => {
    reg.register(makePointer("ptr_1", "medium", ["a.ts", "b.ts", "c.ts"]));
    reg.register(makePointer("ptr_2", "medium", ["a.ts", "b.ts", "d.ts"]));
    reg.register(makePointer("ptr_3", "low", ["x.ts"]));
    const deduped = reg.deduplicate();
    // ptr_1 和 ptr_2 共享 2/3 > 50%，合并为 1 个
    expect(deduped.length).toBe(2);
  });

  it("getByImportance 过滤", () => {
    reg.register(makePointer("ptr_1", "high"));
    reg.register(makePointer("ptr_2", "low"));
    reg.register(makePointer("ptr_3", "high"));
    expect(reg.getByImportance("high")).toHaveLength(2);
    expect(reg.getByImportance("low")).toHaveLength(1);
  });

  it("clear 清空", () => {
    reg.register(makePointer("ptr_1", "high"));
    reg.clear();
    expect(reg.getAll()).toHaveLength(0);
  });
});

// ── BudgetManager ─────────────────────────────────────────

describe("BudgetManager", () => {
  it("默认 5 桶 Push 模型", () => {
    const bm = new BudgetManager();
    expect(bm.totalBudget).toBe(TOTAL_BUDGET);
  });

  it("consume 记录消耗", () => {
    const bm = new BudgetManager();
    bm.consume("fixed", 1000);
    expect(bm.remaining("fixed")).toBe(1000);
  });

  it("totalUsed + totalRemaining", () => {
    const bm = new BudgetManager();
    bm.consume("fixed", 2000);
    bm.consume("session", 3000);
    expect(bm.totalUsed()).toBe(5000);
    expect(bm.totalRemaining()).toBe(TOTAL_BUDGET - 5000);
  });

  it("isOverBudget 超预算检测", () => {
    const bm = new BudgetManager();
    bm.consume("dynamic", TOTAL_BUDGET + 1);
    expect(bm.isOverBudget()).toBe(true);
  });

  it("estimateTokens 4字符≈1token", () => {
    expect(BudgetManager.estimateTokens("hello world!")).toBe(3);
    expect(BudgetManager.estimateTokens("")).toBe(0);
  });

  it("toTokenUsage 生成报告", () => {
    const bm = new BudgetManager();
    bm.consume("fixed", 500);
    const usage = bm.toTokenUsage();
    expect(usage.total).toBe(500);
    expect(usage.budget).toBe(TOTAL_BUDGET);
    expect(usage.slices.length).toBe(5);
    expect(usage.remaining).toBe(TOTAL_BUDGET - 500);
  });

  it("getEvictionOrder 6级驱逐优先级", () => {
    const bm = new BudgetManager();
    const order = bm.getEvictionOrder();
    expect(order.length).toBe(6);
    expect(order[0]!.name).toBe("old-tool-output");
    expect(order[5]!.name).toBe("system-prompt");
  });

  it("reset 重置", () => {
    const bm = new BudgetManager();
    bm.consume("fixed", 1000);
    bm.reset();
    expect(bm.totalUsed()).toBe(0);
  });
});

// ── CodeExplorer ──────────────────────────────────────────

describe("CodeExplorer", () => {
  let tmpDir: string;
  let explorer: CodeExplorer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "struct-ctx-"));
    explorer = new CodeExplorer();
    // 创建测试文件
    await fs.writeFile(path.join(tmpDir, "index.ts"), "export function main() {}\nconst x = 1;");
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "utils.ts"), "export class Utils {}");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("listFiles 列出文件树", async () => {
    const files = await explorer.listFiles(tmpDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.name === "index.ts")).toBe(true);
    expect(files.some((f) => f.name === "utils.ts")).toBe(true);
  });

  it("findRelevant 按关键词查找", async () => {
    const results = await explorer.findRelevant(tmpDir, ["index"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe("index.ts");
  });

  it("extractSymbols 提取符号", async () => {
    const symbols = await explorer.extractSymbols(path.join(tmpDir, "index.ts"));
    expect(symbols.some((s) => s.name === "main" && s.type === "function")).toBe(true);
    expect(symbols.some((s) => s.name === "x" && s.type === "const")).toBe(true);
  });

  it("searchSymbol 按名称搜索", async () => {
    const results = await explorer.searchSymbol(tmpDir, "Utils");
    expect(results.some((s) => s.name === "Utils")).toBe(true);
  });

  it("排除 node_modules/dist/.git", async () => {
    await fs.mkdir(path.join(tmpDir, "node_modules"));
    await fs.writeFile(path.join(tmpDir, "node_modules", "hidden.ts"), "hidden");
    const files = await explorer.listFiles(tmpDir);
    expect(files.some((f) => f.name === "hidden.ts")).toBe(false);
  });
});

// ── ContextBuilder ────────────────────────────────────────

describe("ContextBuilder", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "struct-cb-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("build 生成 AssembledContext", async () => {
    await fs.writeFile(path.join(tmpDir, "index.ts"), "export function main() {}");
    const builder = new ContextBuilder();
    const ctx = await builder.build({
      cwd: tmpDir,
      userMessage: "hello world",
      sessionId: "test",
    });
    expect(ctx.systemPrompt).toContain("StructFocus");
    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(ctx.messages[ctx.messages.length - 1]!.content).toBe("hello world");
    expect(ctx.tokenUsage.budget).toBe(TOTAL_BUDGET);
  });

  it("build 带 memory provider 注入记忆", async () => {
    const builder = new ContextBuilder();
    const mockMemory: IMemoryProvider = {
      searchSync: vi.fn().mockReturnValue([
        { kind: "decision", summary: "选择了 vitest", relevance: 0.9 },
      ] as RetrievedMemory[]),
      findPointersByFile: vi.fn().mockReturnValue([]),
      expandPointer: vi.fn().mockReturnValue(null),
      getProjectContext: vi.fn().mockReturnValue("# Project\nTest project"),
    };
    const ctx = await builder.build({
      cwd: tmpDir,
      userMessage: "test",
      sessionId: "s1",
    }, mockMemory);
    expect(ctx.systemPrompt).toContain("Project");
    expect(ctx.retrievedMemories).toBeDefined();
  });

  it("build 包含预算切片", async () => {
    const builder = new ContextBuilder();
    const ctx = await builder.build({
      cwd: tmpDir,
      userMessage: "test",
      sessionId: "s1",
    });
    expect(ctx.tokenUsage.slices.length).toBe(5);
    expect(ctx.tokenUsage.slices.some((s) => s.layer === "fixed")).toBe(true);
  });

  it("build activeFiles 触发指针关联", async () => {
    const builder = new ContextBuilder();
    const mockMemory: IMemoryProvider = {
      searchSync: vi.fn().mockReturnValue([]),
      findPointersByFile: vi.fn().mockReturnValue([
        makePointer("ptr_1", "high", ["src/index.ts"]),
      ]),
      expandPointer: vi.fn().mockReturnValue(null),
      getProjectContext: vi.fn().mockReturnValue(null),
    };
    const ctx = await builder.build({
      cwd: tmpDir,
      userMessage: "edit index.ts",
      sessionId: "s1",
      activeFiles: ["src/index.ts"],
    }, mockMemory);
    expect(ctx.pointers.length).toBeGreaterThan(0);
    expect(ctx.pointers[0]!.id).toBe("ptr_1");
  });

  it("build knowledge_query 传递给检索", async () => {
    const builder = new ContextBuilder();
    const mockMemory: IMemoryProvider = {
      searchSync: vi.fn().mockReturnValue([]),
      findPointersByFile: vi.fn().mockReturnValue([]),
      expandPointer: vi.fn().mockReturnValue(null),
      getProjectContext: vi.fn().mockReturnValue(null),
    };
    await builder.build({
      cwd: tmpDir,
      userMessage: "do something",
      sessionId: "s1",
      knowledgeQuery: "how to use EventBus",
    }, mockMemory);
    expect(mockMemory.searchSync).toHaveBeenCalledWith(
      "how to use EventBus",
      expect.any(Object),
    );
  });
});

// ── 辅助 ──────────────────────────────────────────────────

function makePointer(id: string, importance: "high" | "medium" | "low", files: string[] = []): ContextPointer {
  return {
    id: id as any,
    type: "decision",
    topic: `topic_${id}`,
    files,
    keywords: [],
    timestamp: now(),
    importance,
    contentRef: `ref_${id}`,
    estimatedTokens: 50,
  };
}
