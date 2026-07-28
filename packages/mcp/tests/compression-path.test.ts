// MCP 压缩路径集成测试（mock LLM，无需真实 key）
//
// 通过 MCP 协议面（handle + engine 单例）验证：
//   context_inject 触发 autoManage → 窗口溢出 → 原文落盘 ContentStore（压缩/驱逐）
//   → recall / search 仍能找回目标；并显式触发 summarize 验证胶囊路径。
// 关键：用极小 maxWindow + 临时 storeRoot 触发压缩，LLM 用确定性桩（不调真实 API）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "os";
import { handle, engine } from "../src/index.js";

const TARGET = "TARGET-MARKER-ZX9 支付网关高峰期返回 503，根因是连接池耗尽。";
const FILLER = (i: number) =>
  `背景观测 ${i}：CI 流水线新增类型检查阶段；监控接入企业微信；缓存换 Redis 集群；日志改 OpenTelemetry；灰度按用户分桶。`;

describe("MCP 压缩路径（mock LLM 集成回归）", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "struct-mcp-cp-"));
    // 确定性 mock 压缩（先设，确保 reset 后新 CM 继承）
    engine.setLlmCall(async () => "[目标] 压缩测试\n[关键发现] mock-summary");
    // 极小窗口触发压缩；临时 storeRoot/capsuleRoot 隔离磁盘写入（胶囊库默认在 cwd，必须显式重定向）
    engine.options.maxWindow = 500;
    engine.options.storeRoot = tmpDir;
    engine.options.capsuleRoot = tmpDir;
    engine.options.autoSummarize = true;
    engine.options.minEntriesForSummarize = 1; // 显式胶囊路径即使剩余条目少也要能触发
    await engine.reset();
  });

  afterEach(async () => {
    // 还原默认引擎配置，避免影响其他测试文件
    engine.options.maxWindow = 200_000;
    engine.options.storeRoot = undefined;
    engine.options.capsuleRoot = undefined;
    engine.options.autoSummarize = true;
    await engine.reset().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("context_inject 触发压缩/驱逐并落盘，原文仍可经 recall 召回", async () => {
    // 注入目标 + 大量填充，溢出小窗口 → autoManage 压缩/驱逐，原文落盘 ContentStore
    await handle({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "context_inject", arguments: { content: TARGET, type: "observation" } },
    });
    for (let i = 0; i < 48; i++) {
      await handle({
        jsonrpc: "2.0", id: 2 + i, method: "tools/call",
        params: { name: "context_inject", arguments: { content: FILLER(i), type: "observation" } },
      });
    }

    // 1) 窗口未被撑爆（压缩/驱逐后释放）
    const cmStats: any = engine.getContextManager().getStats();
    expect(cmStats.usePercent).toBeLessThanOrEqual(100);
    expect(cmStats.activeEntries).toBeGreaterThan(0);

    // 2) 压缩确实发生：目标原文被落盘到 ContentStore（压缩/驱逐路径）
    const stored: any[] = await engine.getStore().search("TARGET-MARKER-ZX9", { mode: "bm25", topK: 5 });
    expect(stored.some((h) => (h.entry?.originalContent ?? "").includes("TARGET-MARKER-ZX9"))).toBe(true);

    // 3) 胶囊路径：显式触发概括（summarizeInactive 底层方法），验证胶囊生成
    await engine.summarize({ topic: "支付网关 503" });
    const capsules: any[] = await engine.listCapsules();
    expect(capsules.length).toBeGreaterThanOrEqual(1);

    // 4) recall 仍能找回被压缩/驱逐的目标原文（核心回归点）
    const recall: any = await handle({
      jsonrpc: "2.0", id: 91, method: "tools/call",
      params: { name: "context_recall", arguments: { query: "TARGET-MARKER-ZX9 503" } },
    });
    expect(recall.result.content[0].text).toContain("TARGET-MARKER-ZX9");

    // 5) search 也能命中落盘原文
    const search: any = await handle({
      jsonrpc: "2.0", id: 92, method: "tools/call",
      params: { name: "context_search", arguments: { query: "TARGET-MARKER-ZX9 连接池" } },
    });
    expect(search.result.content[0].text).toContain("TARGET-MARKER-ZX9");
  });
});
