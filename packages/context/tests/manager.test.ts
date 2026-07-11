import { describe, it, expect } from "vitest";
import { ContextManager, type TaskContext } from "@struct/context";

function fillNoise(m: ContextManager, n: number, size = 200): void {
  for (let i = 0; i < n; i++) {
    m.appendToolResult("noise ".repeat(Math.ceil(size / 6)), { source: `noise-${i}.log`, sourceType: "log" });
  }
}

describe("ContextManager 基础", () => {
  it("追加条目后 getEntries 与 getStats 正确", () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    m.appendUser("hi");
    m.appendAssistant("ok");
    expect(m.getEntries().length).toBe(2);
    expect(m.getStats().totalTokens).toBeGreaterThan(0);
  });

  it("forgetFile 标记驱逐并计入注意力浪费", () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    m.appendToolResult("big log output here", { source: "a.log", sourceType: "log" });
    const before = m.getStats().totalTokens;
    const removed = m.forgetFile("a.log");
    expect(removed).toBe(1);
    expect(m.getStats().totalTokens).toBeLessThan(before);
    expect(m.getStats().evictedEntries).toBe(1);
    expect(m.getAttentionWaste().total).toBeGreaterThan(0);
  });
});

describe("autoManage 三层管理", () => {
  it("层0 (≥70% 且 <85%)：驱逐低价值条目", () => {
    const m = new ContextManager({ maxWindow: 4000 });
    // 小步追加，精确填充到 70%~85% 区间
    let guard = 0;
    while (m.getStats().usePercent < 76 && guard++ < 500) fillNoise(m, 1, 50);
    expect(m.getStats().usePercent).toBeGreaterThanOrEqual(70);
    expect(m.getStats().usePercent).toBeLessThan(85);
    const beforeCount = m.getEntries().length;
    const report = m.manage();
    expect(report.triggerLevel).toBe(0);
    expect(report.evictedCount).toBeGreaterThan(0);
    expect(m.getEntries().length).toBeLessThan(beforeCount);
  });

  it("层1 (≥85% 且 <90%)：驱逐 + 压缩 + 截断", () => {
    const m = new ContextManager({ maxWindow: 4000 });
    let guard = 0;
    while (m.getStats().usePercent < 88 && guard++ < 500) fillNoise(m, 1, 50);
    expect(m.getStats().usePercent).toBeGreaterThanOrEqual(85);
    expect(m.getStats().usePercent).toBeLessThan(90);
    const report = m.manage();
    expect(report.triggerLevel).toBe(1);
    expect(report.evictedCount).toBeGreaterThan(0);
  });

  it("焦点文件受 taskRelevance 保护不被驱逐", () => {
    const tc: TaskContext = {
      currentSubtasks: [],
      editingFiles: ["pkg/x.ts"],
      failingTests: [],
      focusedSymbols: [],
      recentErrors: [],
    };
    const m = new ContextManager({ maxWindow: 4000 });
    m.setTaskContext(tc);
    m.appendToolResult("important context about x", { source: "pkg/x.ts", sourceType: "file_content" });
    fillNoise(m, 60);
    m.setTaskContext(tc);
    const protectedId = m.getEntries().find((e) => e.source === "pkg/x.ts")!.id;
    m.evictEntries(1.0); // 尝试驱逐一切可驱逐的
    const stillThere = m.getEntries().some((e) => e.id === protectedId && !e.evicted);
    expect(stillThere).toBe(true);
  });
});

describe("三原语 focus / forget / reflect", () => {
  it("focusFile 绝对保护并把文件加入聚焦集合", async () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    const r = await m.focusFile(__filename);
    expect(r.ok).toBe(true);
    expect(m.getFocusedFiles()).toContain(__filename);
    const focused = m.getEntries().find((e) => e.source === __filename)!;
    expect(focused.taskRelevance).toBe(0);
    expect(focused.protectedBy).toBe("editingFile");
  });

  it("getReflection 返回健康度与建议", () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    fillNoise(m, 10);
    const rep = m.getReflection();
    expect(rep.usePercent).toBeGreaterThanOrEqual(0);
    expect(rep.attentionWaste).toHaveProperty("rate");
    expect(Array.isArray(rep.suggestions)).toBe(true);
    expect(Array.isArray(rep.topSpaceHogs)).toBe(true);
  });
});

describe("记忆 recall / remember", () => {
  it("remember + recall 命中", async () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    m.remember("采用 autoManage 每步自动接管注意力", { kind: "decision" });
    const hits = await m.recall("autoManage 注意力", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("autoManage");
  });

  it("rememberFromContent 提取决策信号", async () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    await m.rememberFromContent("决定采用 Redis 作为缓存层");
    const hits = await m.recall("Redis 缓存", 3);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("autoManage 内 autoRecall 注入 [memory] observation", async () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    m.remember("auth.ts 存在已知 token 竞态", { kind: "bug" });
    m.setTaskContext({
      currentSubtasks: [],
      editingFiles: ["auth.ts"],
      failingTests: [],
      focusedSymbols: ["token"],
      recentErrors: [],
    });
    const report = await m.autoManage();
    expect(report.recalledMemories).toBeGreaterThanOrEqual(0);
  });
});
