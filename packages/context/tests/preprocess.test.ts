import { describe, it, expect } from "vitest";
import { ContextManager } from "@struct/context";

function mk(): ContextManager {
  return new ContextManager({ maxWindow: 200_000 });
}

describe("preprocessToolOutput (六阶段去噪)", () => {
  it("移除 ANSI 转义码", () => {
    const out = mk().preprocessToolOutput("\u001b[31mred\u001b[0m text");
    expect(out).not.toContain("\u001b[");
    expect(out).toContain("red text");
  });

  it("剥离 HTML 标签保留文本", () => {
    const html = "<div><p>hello</p><span>world</span></div>";
    const out = mk().preprocessToolOutput(html, "html");
    expect(out).not.toContain("<");
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("合并连续重复行", () => {
    const out = mk().preprocessToolOutput("a\nb\nb\nb\nc");
    expect(out).toContain("（以上");
    expect(out).not.toMatch(/b\nb\nb/);
  });

  it("日志保留头 + 错误 + 尾", () => {
    const lines = [
      "line1",
      "line2",
      "fatal ERROR something broke",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
    ];
    const out = mk().preprocessToolOutput(lines.join("\n"), "log");
    expect(out).toContain("line1"); // 头部
    expect(out).toContain("ERROR something broke"); // 错误行
    expect(out).toContain("line8"); // 尾部
  });

  it("JSON 源保留完整内容不截断", () => {
    const json = JSON.stringify({ a: 1, b: [1, 2, 3], c: "x".repeat(5000) });
    const out = mk().preprocessToolOutput(json, "json");
    expect(out).toBe(json);
  });

  it("超长输出被截断到安全上限", () => {
    const big = "x".repeat(50000);
    const out = mk().preprocessToolOutput(big, "tool_output");
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("已截断");
  });
});
