// MCP Server 测试 — 直接驱动 JSON-RPC 协议处理器，验证 5 个工具的握手与调用
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { handle } from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "struct-mcp-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("MCP JSON-RPC handshake", () => {
  it("initialize 返回协议版本与能力", async () => {
    const res: any = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo.name).toBe("struct-context-mcp");
  });

  it("ping 回显空结果", async () => {
    const res: any = await handle({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(res.result).toEqual({});
    expect(res.id).toBe(2);
  });

  it("tools/list 暴露恰好 5 个工具", async () => {
    const res: any = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "context_inject",
      "context_recall",
      "context_status",
      "context_forget",
      "context_focus",
    ]);
    expect(names.length).toBe(5);
  });

  it("未知方法返回 method not found", async () => {
    const res: any = await handle({ jsonrpc: "2.0", id: 4, method: "bogus/method" });
    expect(res.error.code).toBe(-32601);
  });

  it("通知（无 id）不返回响应", async () => {
    const res = await handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeUndefined();
  });
});

describe("MCP 工具调用（5 个工具）", () => {
  it("context_inject + context_status 注入并可查状态", async () => {
    const inject: any = await handle({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "context_inject", arguments: { content: "用户：Redis OOM 怎么修？", type: "user" } },
    });
    expect(inject.result.content[0].text).toContain("已注入");

    const status: any = await handle({
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "context_status", arguments: {} },
    });
    const report = JSON.parse(status.result.content[0].text);
    expect(report.activeEntries).toBeGreaterThanOrEqual(1);
    expect(typeof report.totalFed).toBe("number");
  });

  it("context_focus 聚焦一个真实文件", async () => {
    const file = path.join(tmpDir, "demo.ts");
    await fs.writeFile(file, "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    const res: any = await handle({
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { name: "context_focus", arguments: { path: file, level: "L2" } },
    });
    expect(res.result.content[0].text).toContain("已 focus");
    expect(res.result.content[0].text).toContain("demo.ts");
  });

  it("context_focus 聚焦不存在路径返回错误", async () => {
    const res: any = await handle({
      jsonrpc: "2.0", id: 13, method: "tools/call",
      params: { name: "context_focus", arguments: { path: path.join(tmpDir, "nope.ts") } },
    });
    expect(res.result.content[0].text).toContain("✗");
  });

  it("context_forget 卸载已聚焦文件", async () => {
    const file = path.join(tmpDir, "keep.ts");
    await fs.writeFile(file, "export const x = 1;\n");
    await handle({
      jsonrpc: "2.0", id: 14, method: "tools/call",
      params: { name: "context_focus", arguments: { path: file } },
    });
    const forget: any = await handle({
      jsonrpc: "2.0", id: 15, method: "tools/call",
      params: { name: "context_forget", arguments: { target: file } },
    });
    expect(forget.result.content[0].text).toContain("已忘记");
    expect(forget.result.content[0].text).toContain("1 条");
  });

  it("context_recall 未命中返回友好提示", async () => {
    const res: any = await handle({
      jsonrpc: "2.0", id: 16, method: "tools/call",
      params: { name: "context_recall", arguments: { query: "不存在的奇怪查询xyz" } },
    });
    expect(res.result.content[0].text).toBeTruthy();
  });

  it("未知工具返回 -32603 错误", async () => {
    const res: any = await handle({
      jsonrpc: "2.0", id: 17, method: "tools/call",
      params: { name: "ghost_tool", arguments: {} },
    });
    expect(res.error.code).toBe(-32603);
  });
});
