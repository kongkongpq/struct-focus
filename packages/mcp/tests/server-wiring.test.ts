// MCP Server 接线测试：验证 8 个工具里真正驱动「AI 管理上下文」的
// context_inject 是否触发 autoManage（压缩/驱逐/窗口管理），
// 而不是只 feed 不管理（那样长对话会无限膨胀，产品核心价值失效）。
//
// 修复前：context_inject 只调 engine.feed() + getStats()，从不 autoManage
//         → 以下 autoManage 断言应失败（证明断点）。
// 修复后：context_inject 在 feed 后 await engine.autoManage() → 断言通过。
import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// 导入 MCP Server 模块（含导出的 engine 单例与 handle）
import { handle, engine } from "../src/index.js";

afterAll(() => {
  // 清理单例 engine 默认 storeRoot（.longcontext / .structfocus）产生的目录
  for (const d of [".longcontext", ".structfocus"]) {
    const p = join(process.cwd(), d);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe("MCP context_inject 必须触发 autoManage（核心管理接线）", () => {
  it("每次 context_inject 后引擎真正跑了 autoManage（压缩/驱逐/窗口管理）", async () => {
    const spy = vi.spyOn(engine, "autoManage");

    const res = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_inject", arguments: { content: "用户：Redis 连接池未设上限导致 OOM", type: "user" } },
    });

    expect(res).toBeDefined();
    expect((res as any).result).toBeDefined();
    // 关键断言：接入路径真的调用了 autoManage
    expect(spy).toHaveBeenCalled();
  });

  it("连续多次 context_inject 后仍能持续管理（非一次性）", async () => {
    const spy = vi.spyOn(engine, "autoManage");
    spy.mockClear();

    for (let i = 0; i < 5; i++) {
      await handle({
        jsonrpc: "2.0",
        id: 100 + i,
        method: "tools/call",
        params: { name: "context_inject", arguments: { content: `工具输出 #${i}：编译日志较长内容 x${i}`, type: "tool" } },
      });
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("context_recall 仍可用（召回路径不被接线改动破坏）", async () => {
    const res = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "context_recall", arguments: { query: "Redis OOM" } },
    });
    expect((res as any).result).toBeDefined();
    expect((res as any).result.content[0].text).toBeTypeOf("string");
  });
});
