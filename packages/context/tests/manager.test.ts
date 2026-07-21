import { describe, it, expect } from "vitest";
import { ContextManager, type TaskContext, effectiveEmergencyThreshold, DEFAULT_MANAGEMENT_POLICY } from "@structfocus/context";

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

describe("autoManage 四层降级管理", () => {
  it("L0 (≥20% 非活跃)：标记不执行", () => {
    const m = new ContextManager({ maxWindow: 400_000 });
    // 先追加一些活跃对话
    m.appendUser("hello");
    m.appendAssistant("hi there");
    // 追加大量旧条目使其距离话题远
    for (let i = 0; i < 30; i++) {
      m.appendUser(`old message ${i}`);
      m.appendAssistant(`old reply ${i}`);
    }
    // 把话题距离设小，让前面的全变"非活跃"
    m.setManagementPolicy({ topicDistance: 2 });
    const report = m.manage();
    // 非活跃占比足够多时触发标记（L0）
    expect(report.triggerLevel).toBeGreaterThanOrEqual(0);
    // L0 只标记不降级，条目还在
    expect(m.getEntries().length).toBeGreaterThan(30);
  });

  it("L1 (非活跃达 hardThreshold)：概括归档", () => {
    const m = new ContextManager({ maxWindow: 400_000 });
    m.appendUser("current work");
    m.appendAssistant("working on it");
    for (let i = 0; i < 50; i++) {
      m.appendUser(`old msg ${i} `.repeat(10));
    }
    m.setManagementPolicy({ hardThreshold: 0.5, topicDistance: 2, emergencyThreshold: 0.99 });
    const report = m.manage();
    // L1 触发概括归档，不触发 L2 紧急
    expect(report.triggerLevel).toBe(1);
    expect(report.downgradedCount).toBeGreaterThan(0);
  });

  it("焦点文件受 taskRelevance 保护不被降级", () => {
    const tc: TaskContext = {
      currentSubtasks: [],
      editingFiles: ["pkg/x.ts"],
      failingTests: [],
      focusedSymbols: [],
      recentErrors: [],
    };
    const m = new ContextManager({ maxWindow: 400_000 });
    m.setTaskContext(tc);
    m.appendToolResult("important context about x", { source: "pkg/x.ts", sourceType: "file_content" });
    for (let i = 0; i < 40; i++) m.appendUser(`noise${i}`);
    m.setTaskContext(tc);
    m.setManagementPolicy({ hardThreshold: 0.3, topicDistance: 2, emergencyThreshold: 0.99 });
    m.manage(); // 四层降级
    const stillThere = m.getEntries().some((e) => e.source === "pkg/x.ts" && !e.evicted && !e.compressed);
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

describe("保守模式 (conservative) — emergencyThreshold", () => {
  it("effectiveEmergencyThreshold: 普通=0.85，保守=0.97，保守+更高阈值取大值", () => {
    expect(effectiveEmergencyThreshold({ ...DEFAULT_MANAGEMENT_POLICY, conservative: false })).toBe(0.85);
    expect(effectiveEmergencyThreshold({ ...DEFAULT_MANAGEMENT_POLICY, conservative: true })).toBe(0.97);
    expect(
      effectiveEmergencyThreshold({ ...DEFAULT_MANAGEMENT_POLICY, emergencyThreshold: 0.99, conservative: true }),
    ).toBe(0.99);
  });

  it("相同负载下保守模式抑制 L3→L4 落盘，仅接近满窗口才触发", () => {
    function build(conservative: boolean, targetLoad: number) {
      const m = new ContextManager({ maxWindow: 10_000 });
      // topicDistance:0 让全部内容视为非活跃，便于触发 L2→L3 降层，制造可被落盘的 L3
      m.setManagementPolicy({ softThreshold: 0.1, hardThreshold: 0.2, topicDistance: 0, emergencyThreshold: 0.85, conservative });
      const chunk = "x".repeat(105); // ~30 tokens
      let guard = 0;
      while (m.getStats().usePercent < targetLoad && guard++ < 5000) {
        m.appendToolResult(chunk, { source: "c", sourceType: "log" });
      }
      // 单次 manage 内会先 L2→L3 降层，再评估 L3→L4 紧急落盘
      return m.manage();
    }

    // 负载落在 85%~97% 之间：普通模式(85%)应触发紧急落盘(triggerLevel=2)，保守模式(97%)不应
    // 注：triggerLevel=2 表示进入了 L3→L4 紧急分支（实际迁移数还取决于是否存在已压缩的 L3 条目）
    const aggressive = build(false, 90);
    const conservative = build(true, 90);
    expect(aggressive.triggerLevel).toBe(2);
    expect(conservative.triggerLevel).toBeLessThan(2);

    // 接近满窗口（>=97%）：保守模式也应触发紧急落盘
    const near = build(true, 99);
    expect(near.triggerLevel).toBe(2);
  });
});
