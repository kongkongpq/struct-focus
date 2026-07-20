import { describe, it, expect } from "vitest";
import { ContextManager, type ContextEntry } from "@structfocus/context";

function entry(content: string, over: Partial<ContextEntry> = {}): ContextEntry {
  return {
    id: "e1",
    type: "assistant",
    content,
    tokenCount: 100,
    timestamp: Date.now(),
    compressed: false,
    evicted: false,
    taskRelevance: 1,
    ageFactor: 1,
    currentEvictionScore: 0,
    ...over,
  };
}

describe("structuredCompress (锚点压缩)", () => {
  it("保留已有锚点段并丢弃冗长推理", () => {
    const content = [
      "嗯，让我看看这个文件到底怎么了……（冗长推理原文共 500 字）",
      "[目标] 修复 auth.ts 的 token 刷新竞态",
      "[状态] 进行中",
      "[动作+结果] read_file(auth.ts) → 已读取 145 行",
      "[关键发现] 第 87 行缺少 mutex 锁",
      "[失败] 无",
      "[下一步] 在第 87 行添加互斥锁",
    ].join("\n");
    const m = new ContextManager({ maxWindow: 200_000 });
    const c = m.structuredCompress(entry(content));
    expect(c.compressed).toBe(true);
    expect(c.compressedContent).toContain("[目标] 修复 auth.ts");
    expect(c.compressedContent).toContain("[下一步]");
    expect(c.compressedContent).not.toContain("冗长推理原文");
  });

  it("无锚点时回退为头+错误+尾紧凑化", () => {
    const content = ["first line of reasoning", "ERROR boom", "middle stuff", "last line"].join("\n");
    const m = new ContextManager({ maxWindow: 200_000 });
    const c = m.structuredCompress(entry(content));
    expect(c.compressed).toBe(true);
    expect(c.compressedContent).toContain("[动作+结果]");
    expect(c.compressedContent).toContain("ERROR boom");
  });
});
