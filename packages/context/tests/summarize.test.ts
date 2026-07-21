// summarize 管线单测（路线图 2.2.3，不需要真实 LLM）
import { describe, it, expect } from "vitest";
import { chunkBySemantic, summarizeToCapsule } from "../src/summarize.js";

describe("summarize: chunkBySemantic", () => {
  it("respects maxChars（单块不远超上限）", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      content: `段落${i} `.repeat(45).slice(0, 500), // 每块约 500 字
      source: "user",
    }));
    const chunks = chunkBySemantic(entries, 800);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      const total = chunk.reduce((s, e) => s + e.content.length, 0);
      // 允许单条 > maxChars 的条目独占一块（不切半条），但多条目块不应远超上限
      expect(total).toBeLessThanOrEqual(800 + 500);
    }
  });

  it("splits at paragraph boundary（不在句子中间切断）", () => {
    const big = Array.from(
      { length: 10 },
      (_, i) => `第${i}段关于主题${i}的详细描述与结论。`,
    ).join("\n\n");
    const chunks = chunkBySemantic([{ content: big, source: "doc" }], 200);
    expect(chunks.length).toBeGreaterThan(1);
    // 拼接还原应大致覆盖原文（在 \n\n 处切分，重连后近似等于原文）
    const rebuilt = chunks.map((c) => c.map((e) => e.content).join("\n\n")).join("\n\n");
    expect(rebuilt.length).toBeGreaterThan(big.length * 0.5);
  });

  it("groups same source（同 source 连续条目保持在同一块）", () => {
    const entries = [
      { content: "a".repeat(100), source: "alice" },
      { content: "b".repeat(100), source: "alice" },
      { content: "c".repeat(100), source: "alice" },
      { content: "d".repeat(100), source: "bob" },
    ];
    const chunks = chunkBySemantic(entries, 500); // 3 条 alice 累计 300 > 0.5*500，source 切换时触发 flush
    const aliceChunk = chunks.find((c) => c.length === 3);
    expect(aliceChunk).toBeTruthy();
    expect(aliceChunk!.every((e) => e.source === "alice")).toBe(true);
  });

  it("time gap > 1 day forces new chunk", () => {
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
});

describe("summarize: summarizeToCapsule", () => {
  it("returns valid structure with mock llmCall", async () => {
    const mockLlm = async (_p: string) =>
      "[目标]: 测试任务\n[关键发现]: 无\n[决策]: 无\n[下一步]: 无";
    const result = await summarizeToCapsule(
      {
        entries: [
          { content: "用户决定采用方案X。", source: "user", timestamp: 1 },
          { content: "代码已实现完成。", source: "assistant", timestamp: 2 },
        ],
        metadata: { taskId: "t1", category: "conversation" },
      },
      mockLlm,
    );
    expect(result.capsule).toBeTruthy();
    expect(result.capsule.id).toContain("t1");
    expect(result.l0Summary.length).toBeGreaterThan(0);
    expect(result.l1Summary.length).toBeGreaterThan(0);
    expect(result.chunkSummaries.length).toBeGreaterThanOrEqual(1);
    expect(result.pointers.length).toBe(2);
  });

  it("handles llmCall failure gracefully（回退确定性摘要）", async () => {
    const failing = async (_p: string): Promise<string> => {
      throw new Error("LLM down");
    };
    const result = await summarizeToCapsule(
      { entries: [{ content: "测试回退内容用于验证健壮性。", source: "user" }] },
      failing,
    );
    expect(result.capsule).toBeTruthy();
    expect(result.l0Summary.length).toBeGreaterThan(0);
  });
});
