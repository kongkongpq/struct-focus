// @structfocus/mcp — StructFocus 上下文引擎的 MCP Server（stdio 传输，零依赖实现 MCP 协议）
//
// 暴露「上下文管理」原语为 5 个 MCP Tools（由任意 MCP 客户端接入）：
//   - context_inject  注入一条上下文（喂给引擎）
//   - context_recall  语义召回历史上下文
//   - context_status  查看引擎状态（统计/胶囊数/占用）
//   - context_forget  忘记（卸载）指定上下文
//   - context_focus   聚焦指定文件/目录
//
// 不依赖 @modelcontextprotocol/sdk，直接实现 MCP 的 JSON-RPC over stdio 协议，
// 以便作为「上下文中间层」被 Claude Code / Cursor / Cline / 任意支持 MCP 的 Agent 宿主接入。
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  LongContextEngine,
  type LongContextEngineOptions,
} from "@structfocus/context";

const SERVER_NAME = "struct-context-mcp";
const SERVER_VERSION = "0.2.0";

// ── MCP 工具定义 ────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: McpTool[] = [
  {
    name: "context_inject",
    description: "注入一条上下文（对话、工具输出、日志等）。type 可选 user/tool/observation。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "文本内容" },
        source: { type: "string", description: "来源（文件名、说话者等）" },
        type: { type: "string", enum: ["user", "tool", "observation"], description: "条目类型" },
      },
      required: ["content"],
    },
  },
  {
    name: "context_recall",
    description: "按自然语言语义召回历史上下文（胶囊摘要 + 相关原文片段）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言查询" },
        topK: { type: "number", description: "最多返回条数（默认 5）" },
      },
      required: ["query"],
    },
  },
  {
    name: "context_status",
    description: "查看引擎状态：累计注入/概括 token、胶囊数、活跃/归档条目数、最后概括时间。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "context_forget",
    description: "忘记（卸载）指定上下文。target 为文件路径或条目 ID。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "文件路径或条目 ID" },
      },
      required: ["target"],
    },
  },
  {
    name: "context_focus",
    description: "聚焦指定文件/目录到工作上下文（L1 符号大纲，可选 L0/L2）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件或目录路径" },
        symbols: { type: "array", items: { type: "string" }, description: "关联焦点符号" },
        level: { type: "string", enum: ["L0", "L1", "L2"], description: "加载级别" },
      },
      required: ["path"],
    },
  },
];

// ── 引擎单例 ───────────────────────────────────────────────

const engineOptions: LongContextEngineOptions = {
  logger: undefined,
};
const engine = new LongContextEngine(engineOptions);

// ── 工具调用 ───────────────────────────────────────────────

type TextContent = { type: "text"; text: string };

function textResult(text: string): { content: TextContent[] } {
  return { content: [{ type: "text", text }] };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: TextContent[] }> {
  switch (name) {
    case "context_inject": {
      const content = String(args.content ?? "");
      if (!content) return textResult("error: content 不能为空");
      engine.feed(content, {
        source: args.source ? String(args.source) : undefined,
        type: (args.type as "user" | "tool" | "observation") ?? "observation",
      });
      const stats = engine.getStats();
      return textResult(`✓ 已注入。活跃条目 ${stats.activeEntries}，累计注入 ${stats.totalFed} 字符。`);
    }
    case "context_recall": {
      const query = String(args.query ?? "");
      if (!query) return textResult("error: query 不能为空");
      const topK = typeof args.topK === "number" ? args.topK : undefined;
      const result = await engine.recall(query, topK ? { topK } : undefined);
      if (result.injectText.includes("未找到")) {
        return textResult(result.injectText);
      }
      return textResult(result.injectText);
    }
    case "context_status": {
      const stats = engine.getStats();
      const report = {
        totalFed: stats.totalFed,
        totalSummarized: stats.totalSummarized,
        capsuleCount: stats.capsuleCount,
        activeEntries: stats.activeEntries,
        storedEntries: stats.storedEntries,
        lastSummarizeAt: stats.lastSummarizeAt,
      };
      return textResult(JSON.stringify(report, null, 2));
    }
    case "context_forget": {
      const target = String(args.target ?? "");
      if (!target) return textResult("error: target 不能为空");
      const removed = engine.forget(target);
      return textResult(`✓ 已忘记 ${removed} 条（target: ${target}）`);
    }
    case "context_focus": {
      const path = String(args.path ?? "");
      if (!path) return textResult("error: path 不能为空");
      const result = await engine.focus(path, {
        symbols: Array.isArray(args.symbols) ? (args.symbols as string[]) : undefined,
        level: args.level as "L0" | "L1" | "L2" | undefined,
      });
      if (!result.ok) return textResult(`✗ ${result.output}`);
      return textResult(result.output);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── JSON-RPC over stdio（MCP 协议最小实现） ──

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * 处理一条 JSON-RPC 消息。
 * @returns 需要回复的响应对象；通知（无 id）或无需回复时返回 undefined。
 */
export async function handle(
  msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> },
): Promise<unknown | undefined> {
  const id = msg.id;
  // 通知（无 id）不回复
  if (id === undefined) return undefined;

  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (msg.method === "notifications/initialized") return undefined;
  if (msg.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (msg.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (msg.method === "tools/call") {
    try {
      const result = await callTool(String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      const err = e as { message?: string };
      return { jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? e) } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${msg.method}` } };
}

export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(t);
    } catch {
      return; // 忽略非法行
    }
    void handle(msg).then((res) => {
      if (res !== undefined) send(res);
    });
  });
}

// 作为入口直接运行时启动
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startMcpServer();
}
