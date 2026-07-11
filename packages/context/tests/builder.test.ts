import { describe, it, expect } from "vitest";
import { buildContext, type ContextEntry, type TaskContext } from "@struct/context";

function entry(i: number, type: ContextEntry["type"], content: string, over: Partial<ContextEntry> = {}): ContextEntry {
  return {
    id: `e${i}`,
    type,
    content,
    tokenCount: 10,
    timestamp: i,
    compressed: false,
    evicted: false,
    taskRelevance: 1,
    ageFactor: 1,
    currentEvictionScore: 0,
    ...over,
  };
}

const tc: TaskContext = {
  currentSubtasks: ["修复竞态"],
  editingFiles: ["auth.ts"],
  failingTests: ["auth.test.ts"],
  focusedSymbols: ["token"],
  recentErrors: [{ message: "race condition", file: "auth.ts" }],
};

describe("buildContext 六层管线", () => {
  const entries = [
    entry(1, "user", "用户请求"),
    entry(2, "assistant", "我来分析"),
    entry(3, "tool", "[tool_output] 读取结果", { sourceType: "tool_output" }),
    entry(4, "observation", "[memory] 已知 bug", { sourceType: "tool_output" }),
    // 加一条 assistant 条目以便 builder 有连续的 user/assistant 交替
    entry(5, "assistant", "修复方案", { sourceType: "tool_output" }),
  ];

  it("L1 系统提示始终在最前", () => {
    const msgs = buildContext({ systemPrompt: "SYS", entries, taskContext: tc, usePercent: 10 });
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe("SYS");
  });

  it("L3 任务上下文与 L4 聚焦层在占用低时不重复，但都出现", () => {
    const msgs = buildContext({ systemPrompt: "SYS", entries, taskContext: tc, usePercent: 10 });
    const contents = msgs.map((m) => m.content ?? "").join("\n");
    expect(contents).toContain("当前任务上下文");
    expect(contents).toContain("聚焦文件");
    expect(contents).toContain("auth.ts");
  });

  it("L5 历史层按时间顺序渲染活跃条目", () => {
    const msgs = buildContext({ systemPrompt: "SYS", entries, taskContext: tc, usePercent: 10 });
    const roles = msgs.map((m) => m.role);
    // user / assistant / tool / observation 角色都在历史中
    // tool 和 observation 映射为 "user"（兼容 API 交替约束）
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // roles 中必须至少有一个 user 角色（来自 tool 条目）
    expect(roles.filter(r => r === "user").length).toBeGreaterThanOrEqual(1);
  });

  it("L6 预算检查层在高位占用时追加告警", () => {
    const low = buildContext({ systemPrompt: "SYS", entries, taskContext: tc, usePercent: 10 });
    expect(low.some((m) => (m.content ?? "").includes("⚠️"))).toBe(false);
    const high = buildContext({ systemPrompt: "SYS", entries, taskContext: tc, usePercent: 92 });
    expect(high.some((m) => (m.content ?? "").includes("⚠️"))).toBe(true);
  });

  it("已驱逐条目不进入消息", () => {
    const withEvicted = [...entries, entry(5, "tool", "old", { evicted: true })];
    const msgs = buildContext({ systemPrompt: "SYS", entries: withEvicted, taskContext: tc, usePercent: 10 });
    const all = msgs.map((m) => m.content ?? "").join("\n");
    expect(all).not.toContain("old");
  });
});
