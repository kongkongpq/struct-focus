// MCP Server 测试 — 直接驱动 JSON-RPC 协议处理器，验证 8 个工具的握手与调用
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { handle, engine } from "../src/index.js";

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
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo.name).toBe("struct-context-mcp");
  });

  it("ping 回显空结果", async () => {
    const res: any = await handle({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(res.result).toEqual({});
    expect(res.id).toBe(2);
  });

  it("tools/list 暴露恰好 8 个工具", async () => {
    const res: any = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "context_inject",
      "context_recall",
      "context_status",
      "context_forget",
      "context_focus",
      "context_set_policy",
      "context_stats",
      "context_search",
    ]);
    expect(names.length).toBe(8);

    // 每个工具都应带 2025-06-18 引入的 Tool Annotations（语义标注）
    const byName = Object.fromEntries(res.result.tools.map((t: any) => [t.name, t]));
    expect(byName.context_inject.annotations).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    });
    expect(byName.context_recall.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(byName.context_forget.annotations.destructiveHint).toBe(true);
    expect(byName.context_focus.annotations.openWorldHint).toBe(true);
    for (const n of ["context_status", "context_stats", "context_search", "context_set_policy"]) {
      expect(byName[n].annotations).toBeDefined();
    }
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

describe("MCP 工具调用（8 个工具）", () => {
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

  it("context_set_policy 热更新策略并可被 status 反映", async () => {
    const set: any = await handle({
      jsonrpc: "2.0", id: 20, method: "tools/call",
      params: { name: "context_set_policy", arguments: { conservative: true, emergencyThreshold: 0.99 } },
    });
    expect(set.result.content[0].text).toContain("策略已更新");
    expect(set.result.content[0].text).toContain("conservative=true");

    const status: any = await handle({
      jsonrpc: "2.0", id: 21, method: "tools/call",
      params: { name: "context_status", arguments: {} },
    });
    const report = JSON.parse(status.result.content[0].text);
    expect(report.policy.conservative).toBe(true);
    expect(report.policy.effectiveEmergencyThreshold).toBe(0.99);

    // 还原，避免影响其他用例
    await handle({
      jsonrpc: "2.0", id: 22, method: "tools/call",
      params: { name: "context_set_policy", arguments: { conservative: false, emergencyThreshold: 0.85 } },
    });
  });

  it("context_stats 返回精简状态（含磁盘/LLM/emergency）", async () => {
    await handle({
      jsonrpc: "2.0", id: 30, method: "tools/call",
      params: { name: "context_inject", arguments: { content: "用户：调研 LLM 上下文压缩方案", type: "user" } },
    });
    const res: any = await handle({
      jsonrpc: "2.0", id: 31, method: "tools/call",
      params: { name: "context_stats", arguments: {} },
    });
    const report = JSON.parse(res.result.content[0].text);
    expect(typeof report.totalFed).toBe("number");
    expect(typeof report.capsuleCount).toBe("number");
    expect(typeof report.activeEntries).toBe("number");
    expect(typeof report.diskMB).toBe("number");
    expect(typeof report.diskMaxMB).toBe("number");
    expect(typeof report.llmStatus).toBe("string");
    expect(typeof report.emergencyThreshold).toBe("number");
  });

  it("context_search 无匹配返回友好提示", async () => {
    const res: any = await handle({
      jsonrpc: "2.0", id: 32, method: "tools/call",
      params: { name: "context_search", arguments: { query: "完全不存在的罕见词条xyz" } },
    });
    expect(res.result.content[0].text).toContain("未找到");
  });

  it("context_search 命中 ContentStore 历史原文", async () => {
    // 直接灌入一条被落盘的历史原文（模拟 evict/truncate 后的 ContentStore 条目）
    await engine.getStore().save({
      entryId: "search-demo-1",
      originalContent: "Redis OOM 排查：maxmemory 配得太小，且没设淘汰策略，导致写满后拒绝写入。",
      originalTokenCount: 30,
      savedAt: Date.now(),
      reason: "truncate",
      source: "redis-ops.md",
    });
    const res: any = await handle({
      jsonrpc: "2.0", id: 34, method: "tools/call",
      params: { name: "context_search", arguments: { query: "Redis OOM maxmemory" } },
    });
    expect(res.result.content[0].text).toContain("Redis OOM");
    expect(res.result.content[0].text).toContain("redis-ops.md");
  });

  it("context_search query 为空返回错误", async () => {
    const res: any = await handle({
      jsonrpc: "2.0", id: 33, method: "tools/call",
      params: { name: "context_search", arguments: { query: "" } },
    });
    expect(res.result.content[0].text).toContain("error");
  });

  it("未知工具返回 -32603 错误", async () => {
    const res: any = await handle({
      jsonrpc: "2.0", id: 17, method: "tools/call",
      params: { name: "ghost_tool", arguments: {} },
    });
    expect(res.error.code).toBe(-32603);
  });
});
