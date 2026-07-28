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

  it("无锚点时回退为语义锚点抽取（非头+尾截断）", () => {
    const content = [
      "first line of reasoning",
      "ERROR boom during deploy",
      "middle stuff",
      "last line",
    ].join("\n");
    const m = new ContextManager({ maxWindow: 200_000 });
    const c = m.structuredCompress(entry(content));
    expect(c.compressed).toBe(true);
    // 产物使用与主分支一致的完整锚点词表
    for (const a of ["[目标]", "[状态]", "[动作+结果]", "[关键发现]", "[失败]", "[下一步]"]) {
      expect(c.compressedContent).toContain(a);
    }
    // 错误句被抽到 [失败]，而非朴素地保留头尾
    expect(c.compressedContent).toContain("[失败] ERROR boom");
    // 不应出现头尾截断标记
    expect(c.compressedContent).not.toContain("已截断");
  });

  it("回退能从中英文混合文本抽取目标/关键发现/动作", () => {
    const content = [
      "用户在做 StructFocus 的上下文压缩模块。",
      "我们发现 GLM 首调延迟过高会触发静默降级。",
      "已采用 30s 超时修复该问题。",
      "下一步准备补齐多跳 QA 基准。",
    ].join("\n");
    const m = new ContextManager({ maxWindow: 200_000 });
    const c = m.structuredCompress(entry(content));
    expect(c.compressedContent).toContain("[目标]");
    expect(c.compressedContent).toContain("StructFocus");
    expect(c.compressedContent).toContain("[关键发现]");
    expect(c.compressedContent).toContain("静默降级");
    expect(c.compressedContent).toContain("[动作+结果]");
    expect(c.compressedContent).toContain("[下一步]");
    expect(c.compressedContent).toContain("多跳 QA 基准");
  });

  it("回退产物锚点词表与主分支一致（可检索性）", () => {
    const m = new ContextManager({ maxWindow: 200_000 });
    const noAnchor = m.structuredCompress(entry("随便一段没有锚点标记的长文本，包含部署失败和重试逻辑。"));
    const withAnchor = m.structuredCompress(
      entry(["[目标] x", "[状态] y", "[动作+结果] z", "[关键发现] w", "[失败] 无", "[下一步] q"].join("\n")),
    );
    const labels = (s: string) => (s.match(/\[[^\]]+\]/g) ?? []).sort().join(",");
    expect(labels(noAnchor.compressedContent)).toBe(labels(withAnchor.compressedContent));
  });
});
