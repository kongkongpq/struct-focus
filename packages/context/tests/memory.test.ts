import { describe, it, expect } from "vitest";
import { InMemoryBackend, tokenizeQuery } from "@struct/context";

describe("InMemoryBackend", () => {
  it("add 后 search 命中相关记忆", () => {
    const b = new InMemoryBackend();
    b.add({ kind: "decision", content: "采用 autoManage 自动接管注意力", tags: ["ctx"], confidence: 0.9, timestamp: 1 });
    b.add({ kind: "note", content: "无关的另一条记忆", tags: [], confidence: 0.5, timestamp: 2 });
    const hits = b.search("autoManage 注意力", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("autoManage");
  });

  it("中文长词拆 2-gram 提升召回", () => {
    const b = new InMemoryBackend();
    b.add({ kind: "decision", content: "上下文窗口管理策略", tags: [], confidence: 0.9, timestamp: 1 });
    const hits = b.search("上下文", 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("tokenizeQuery 过滤标点与短词", () => {
    const toks = tokenizeQuery("修复, 竞态！ token refresh.");
    expect(toks).toContain("修复");
    expect(toks).toContain("竞态");
    expect(toks).toContain("token");
    expect(toks).not.toContain(" ");
  });
});
