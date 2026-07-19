// @struct/mcp - StructAgent 上下文引擎的 MCP Server（stdio 传输，零依赖实现 MCP 协议）
//
// 暴露上下文原语为 MCP Tools：focus / forget / reflect / autoManage /
// appendTool / appendMessage / getEntries / getLog / reset / remember / recall。
// 不依赖 @modelcontextprotocol/sdk，直接实现 MCP 的 JSON-RPC over stdio 协议，
// 以便作为「上下文中间层」被任意支持 MCP 的 Agent 宿主接入。
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  ContextManager,
  TOTAL_BUDGET,
  type TaskContext,
} from "@struct/context";

const SYSTEM_PROMPT = "StructAgent 上下文引擎（MCP）";

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: McpTool[] = [
  { name: "focus", description: "将文件/目录聚焦进工作上下文（L0 元数据/L1 大纲/L2 全文）", inputSchema: { type: "object", properties: { path: { type: "string" }, symbols: { type: "array", items: { type: "string" } }, level: { type: "string", enum: ["L0", "L1", "L2"] } }, required: ["path"] } },
  { name: "forget", description: "从工作上下文卸载指定文件", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "reflect", description: "查看上下文健康度（token/预算/聚焦文件/注意力浪费/建议）", inputSchema: { type: "object", properties: {} } },
  { name: "autoManage", description: "引擎主动接管注意力管理（按预算阈值驱逐/压缩/告警）", inputSchema: { type: "object", properties: { taskContext: { type: "object" } } } },
  { name: "appendTool", description: "追加一条工具结果", inputSchema: { type: "object", properties: { content: { type: "string" }, file: { type: "string" }, sourceType: { type: "string" } }, required: ["content"] } },
  { name: "appendMessage", description: "追加一条消息（assistant 会自动 remember 决策）", inputSchema: { type: "object", properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } }, required: ["role", "content"] } },
  { name: "getEntries", description: "列出当前上下文条目（含 token 估算）", inputSchema: { type: "object", properties: {} } },
  { name: "getLog", description: "列出全部上下文条目（含已驱逐）", inputSchema: { type: "object", properties: {} } },
  { name: "reset", description: "重置上下文引擎", inputSchema: { type: "object", properties: {} } },
  { name: "remember", description: "记录一条记忆", inputSchema: { type: "object", properties: { content: { type: "string" }, kind: { type: "string" }, tags: { type: "string" } }, required: ["content"] } },
  { name: "recall", description: "检索相关记忆（分词逐词匹配）", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  // context-skill v3 互动轨工具
  { name: "forget:noise", description: "正则清理噪音条目（日志/报告类输出）", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "recall:context", description: "从磁盘加载历史胶囊（L1 概览或 L2 完整）", inputSchema: { type: "object", properties: { capsuleId: { type: "string" }, level: { type: "string", enum: ["L1", "L2"] } }, required: ["capsuleId"] } },
  { name: "recall:file", description: "按需加载文件 L1 大纲或 L2 完整内容", inputSchema: { type: "object", properties: { path: { type: "string" }, level: { type: "string", enum: ["L1", "L2"] } }, required: ["path"] } },
  { name: "pack:subtask", description: "将当前子任务上下文打包为知识胶囊", inputSchema: { type: "object", properties: { taskId: { type: "string" }, summary: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["taskId"] } },
  { name: "summarize:recent", description: "压缩最近 N 步为摘要", inputSchema: { type: "object", properties: { steps: { type: "number" } }, required: ["steps"] } },
  { name: "summarize:conversation", description: "压缩指定步骤之后的对话历史", inputSchema: { type: "object", properties: { sinceStep: { type: "number" } }, required: ["sinceStep"] } },
  { name: "stats", description: "统计：条目数、token 分布、各层占比", inputSchema: { type: "object", properties: {} } },
  { name: "budget", description: "预算分配详情", inputSchema: { type: "object", properties: {} } },
];

// 引擎单例（一个 MCP 会话对应一个 ContextManager）
let manager = new ContextManager({ maxWindow: TOTAL_BUDGET });

type TextContent = { type: "text"; text: string };

function textResult(text: string): { content: TextContent[] } {
  return { content: [{ type: "text", text }] };
}

function entriesSummary() {
  return manager.toMessages(SYSTEM_PROMPT).map((m, i) => ({
    index: i,
    role: m.role,
    tokens: Math.ceil((m.content ?? "").length / 4),
    preview: (m.content ?? "").slice(0, 200),
  }));
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: TextContent[] }> {
  switch (name) {
    case "focus": {
      const r = await manager.focusFile(String(args.path), {
        symbols: Array.isArray(args.symbols) ? (args.symbols as string[]) : undefined,
        level: args.level as "L0" | "L1" | "L2" | undefined,
      });
      return textResult(JSON.stringify(r, null, 2));
    }
    case "forget":
      return textResult(JSON.stringify({ removed: manager.forgetFile(String(args.target)) }));
    case "reflect":
      return textResult(JSON.stringify(manager.getReflection(), null, 2));
    case "autoManage": {
      const tc = args.taskContext as TaskContext | undefined;
      if (tc) manager.setTaskContext(tc);
      const report = await manager.autoManage();
      return textResult(JSON.stringify({ report, reflect: manager.getReflection() }, null, 2));
    }
    case "appendTool":
      manager.appendToolResult(String(args.content), {
        source: args.file ? String(args.file) : undefined,
        sourceType: (args.sourceType as "tool_output" | "file_content" | "log" | "html" | "json") ?? "tool_output",
      });
      return textResult(JSON.stringify(manager.getReflection()));
    case "appendMessage": {
      const role = String(args.role);
      const text = String(args.content);
      if (role === "assistant") {
        manager.appendAssistant(text);
        await manager.rememberFromContent(text);
      } else {
        manager.appendUser(text);
      }
      return textResult(JSON.stringify(manager.getReflection()));
    }
    case "getEntries":
      return textResult(JSON.stringify(entriesSummary(), null, 2));
    case "getLog":
      return textResult(JSON.stringify(manager.getAllEntries().map((e) => ({ id: e.id, type: e.type, source: e.source, evicted: e.evicted, tokens: e.tokenCount })), null, 2));
    case "reset":
      manager = new ContextManager({ maxWindow: TOTAL_BUDGET });
      return textResult(JSON.stringify(manager.getReflection()));
    case "remember":
      manager.remember(String(args.content), {
        kind: args.kind ? String(args.kind) : undefined,
        tags: args.tags ? String(args.tags).split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      return textResult("remembered");
    case "recall":
      return textResult(JSON.stringify(await manager.recall(String(args.query), typeof args.limit === "number" ? args.limit : 3), null, 2));
    // context-skill v3 互动轨
    case "forget:noise": {
      const pattern = String(args.pattern);
      const re = new RegExp(pattern, "i");
      let count = 0;
      const all = manager.getAllEntries();
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (!e || e.evicted) continue;
        if (re.test(e.content) || (e.source && re.test(e.source))) {
          // 有 source 的按文件驱逐，无 source 的直接逐条标记 evicted + 写 ContentStore
          if (e.source) {
            manager.forgetFile(e.source);
          } else {
            manager.forgetNoise(e.id);
          }
          count++;
        }
      }
      return textResult(JSON.stringify({ cleaned: count, pattern }, null, 2));
    }
    case "recall:context": {
      const level = (args.level === "L1" ? "L1" : "L2") as "L1" | "L2";
      const result = await manager.expandCapsule(String(args.capsuleId), level);
      return textResult(JSON.stringify(result, null, 2));
    }
    case "recall:file": {
      const level = (args.level === "L2" ? "L2" : "L1") as "L1" | "L2";
      const r = await manager.focusFile(String(args.path), { level });
      return textResult(JSON.stringify(r, null, 2));
    }
    case "pack:subtask": {
      const files = Array.isArray(args.files) ? (args.files as string[]) : undefined;
      const result = await manager.packSubtask(String(args.taskId), {
        summary: args.summary as string | undefined,
        files,
      });
      return textResult(JSON.stringify(result, null, 2));
    }
    case "summarize:recent": {
      const N = typeof args.steps === "number" ? args.steps : 5;
      // 按 assistant 回合计数：一个 assistant 消息后紧跟若干 tool 回复作为一个"步"
      const all = manager.getAllEntries();
      const stepBoundaries: number[] = [];
      for (let i = 0; i < all.length; i++) {
        if (all[i]!.type === "assistant") stepBoundaries.push(i);
      }
      // 取最后 N 个 assistant 回合作为起始索引
      const startIdx = stepBoundaries.length > N ? stepBoundaries[stepBoundaries.length - N]! : 0;
      const c1 = manager.compressEntries(
        (_e, idx) => idx >= startIdx && !all[idx]!.evicted && !all[idx]!.protectedBy,
      );
      return textResult(JSON.stringify({ compressed: c1, steps: N, sinceIdx: startIdx }, null, 2));
    }
    case "summarize:conversation": {
      const since = typeof args.sinceStep === "number" ? args.sinceStep : 0;
      // sinceStep 语义：从第 since 个 assistant 回合之后开始压缩
      const all = manager.getAllEntries();
      let stepCount = 0;
      let sinceIdx = 0;
      for (let i = 0; i < all.length; i++) {
        if (all[i]!.type === "assistant") {
          if (stepCount >= since) { sinceIdx = i; break; }
          stepCount++;
        }
      }
      const c2 = manager.compressEntries(
        (_e, idx) => idx >= sinceIdx && !all[idx]!.evicted && !all[idx]!.protectedBy,
      );
      return textResult(JSON.stringify({ compressed: c2, sinceStep: since, sinceIdx }, null, 2));
    }
    case "stats":
      return textResult(JSON.stringify(manager.getStats(), null, 2));
    case "budget":
      return textResult(JSON.stringify({
        usePercent: manager.getStats().usePercent,
        totalEntries: manager.getEntries().length,
        reflection: manager.getReflection(),
      }, null, 2));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── JSON-RPC over stdio（MCP 协议最小实现） ──

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<void> {
  const id = msg.id;
  // 通知（无 id）不回复
  if (id === undefined) return;

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "struct-context-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === "tools/call") {
    try {
      const result = await callTool(String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>);
      send({ jsonrpc: "2.0", id, result });
    } catch (e) {
      const err = e as { message?: string };
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? e) } });
    }
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${msg.method}` } });
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
    void handle(msg);
  });
}

// 作为入口直接运行时启动
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startMcpServer();
}
