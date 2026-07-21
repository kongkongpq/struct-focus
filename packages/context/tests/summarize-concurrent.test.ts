import { describe, it, expect } from "vitest";
import { summarizeToCapsule } from "../src/summarize.js";

function makeEntries(n: number) {
  return Array.from({ length: n }, (_, k) => ({
    content: (
      `用户在做 StructFocus 项目第 ${k} 部分。\n\n` +
      `这里讨论上下文压缩管线的实现细节与边界情况。\n\n` +
      `需要验证长对话下召回率是否稳定保持高位。\n`
    ).repeat(20),
    source: `file${k}.ts`,
  }));
}

describe("压缩 LLM 并发化（Promise.all + 10s 超时回退）", () => {
  it("多块 LLM 调用按块映射、顺序保持，单块失败回退确定性摘要", async () => {
    const input = { entries: makeEntries(6), metadata: { category: "conversation", taskId: "t-concurrent" } };
    const calls: string[] = [];
    const llmCall = async (p: string): Promise<string> => {
      const m = p.match(/块 (\d+)\/(\d+)/);
      const idx = m ? parseInt(m[1]!, 10) - 1 : -1;
      calls.push(p);
      // 第 2 块（index 1）模拟失败 → 应回退确定性摘要
      if (idx === 1) throw new Error("boom");
      return `CHUNK${idx}`;
    };
    const out = await summarizeToCapsule(input, llmCall);
    expect(out.capsule.chunkSummaries.length).toBeGreaterThan(1);
    // 顺序保持：成功块返回 CHUNK{i}，失败块（index 1）回退为确定性摘要（不以 CHUNK 开头）
    out.capsule.chunkSummaries.forEach((s, i) => {
      if (i === 1) expect(s.startsWith("CHUNK")).toBe(false);
      else expect(s).toBe(`CHUNK${i}`);
    });
    // 每块的 LLM 都被调用过（并发路径覆盖所有块）
    expect(calls.length).toBe(out.capsule.chunkSummaries.length);
  });

  it("无 LLM 时全部走确定性回退且不抛错", async () => {
    const input = { entries: makeEntries(4), metadata: { taskId: "t-fallback" } };
    const out = await summarizeToCapsule(input);
    expect(out.capsule).toBeTruthy();
    expect(out.capsule.chunkSummaries.length).toBeGreaterThan(0);
  });
});
