// @structfocus/mcp — StructFocus 上下文引擎的 MCP Server（stdio 传输，零依赖实现 MCP 协议）
//
// 暴露「上下文管理」原语为 6 个 MCP Tools（由任意 MCP 客户端接入）：
//   - context_inject  注入一条上下文（喂给引擎）
//   - context_recall  语义召回历史上下文
//   - context_status  查看引擎状态（统计/胶囊数/占用/当前策略）
//   - context_forget  忘记（卸载）指定上下文
//   - context_focus   聚焦指定文件/目录
//   - context_set_policy  热更新管理策略（含 conservative 保守模式）
//
// 不依赖 @modelcontextprotocol/sdk，直接实现 MCP 的 JSON-RPC over stdio 协议，
// 以便作为「上下文中间层」被 Claude Code / Cursor / Cline / 任意支持 MCP 的 Agent 宿主接入。
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  LongContextEngine,
  type LongContextEngineOptions,
  type ManagementPolicy,
  effectiveEmergencyThreshold,
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
  {
    name: "context_set_policy",
    description: "热更新上下文管理策略（立即生效）。最常用：{ conservative: true } 开启保守模式（emergencyThreshold 抬到 0.97，窗口接近满才落盘 L4）。也可调 emergencyThreshold/hardThreshold/softThreshold/topicDistance/maxChunkBeforeManage/userOverride。",
    inputSchema: {
      type: "object",
      properties: {
        conservative: { type: "boolean", description: "保守模式：仅接近满窗口(≥0.97)才把最冷 L3 内容落盘到 L4" },
        softThreshold: { type: "number", description: "非活跃占比 ≥ 此值开始标记/预压缩（默认 0.20，比例）" },
        hardThreshold: { type: "number", description: "非活跃占比 ≥ 此值执行概括归档 L2→L3（默认 0.50，比例）" },
        emergencyThreshold: { type: "number", description: "总窗口占用 ≥ 此值触发 L3→L4 深存（默认 0.85，比例；保守模式抬到 0.97）" },
        topicDistance: { type: "number", description: "主题距离阈值（默认 3）" },
        maxChunkBeforeManage: { type: "number", description: "触发管理前最大 chunk（默认 4000）" },
        userOverride: { type: "string", enum: ["auto", "aggressive", "conservative"], description: "用户覆盖模式（默认 auto）" },
      },
    },
  },
];

// ── LLM 配置（压缩用，不配也能跑——走确定性回退） ─────────

function resolveLlmConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  // 一条环境变量搞定任何 OpenAI 兼容模型：
  //   STRUCT_LLM_API_KEY  — API Key（必填）
  //   STRUCT_LLM_BASE_URL — API 地址（选填，默认 https://api.openai.com/v1）
  //   STRUCT_LLM_MODEL    — 模型名（选填，默认 gpt-4o-mini）
  // 例：用 DeepSeek → STRUCT_LLM_API_KEY=sk-xxx STRUCT_LLM_BASE_URL=https://api.deepseek.com/v1 STRUCT_LLM_MODEL=deepseek-chat
  // 例：用智谱   → STRUCT_LLM_API_KEY=xxx STRUCT_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4 STRUCT_LLM_MODEL=glm-4-flash
  const apiKey = process.env.STRUCT_LLM_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: process.env.STRUCT_LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
    model: process.env.STRUCT_LLM_MODEL ?? "gpt-4o-mini",
  };
}

function createLlmCall(cfg: { baseUrl: string; apiKey: string; model: string }): (prompt: string) => Promise<string> {
  const url = `${cfg.baseUrl}/chat/completions`;
  return async (prompt: string): Promise<string> => {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.2,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`LLM ${resp.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  };
}

// ── 引擎单例 ───────────────────────────────────────────────

const llmCfg = resolveLlmConfig();
const engineOptions: LongContextEngineOptions = {
  llmCall: llmCfg ? createLlmCall(llmCfg) : undefined,
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
      const stats = await engine.getStats();
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
      const stats = await engine.getStats();
      const policy = engine.getManagementPolicy();
      const report = {
        totalFed: stats.totalFed,
        totalSummarized: stats.totalSummarized,
        capsuleCount: stats.capsuleCount,
        activeEntries: stats.activeEntries,
        storedEntries: stats.storedEntries,
        lastSummarizeAt: stats.lastSummarizeAt,
        storeStats: {
          usedMB: Math.round((stats.storeStats.usedBytes / 1024 / 1024) * 100) / 100,
          maxMB: stats.storeStats.maxBytes > 0
            ? Math.round((stats.storeStats.maxBytes / 1024 / 1024) * 100) / 100
            : 0,
          entryCount: stats.storeStats.entryCount,
          atCapacity: stats.storeStats.atCapacity,
        },
        policy: {
          conservative: policy.conservative,
          effectiveEmergencyThreshold: effectiveEmergencyThreshold(policy),
          emergencyThreshold: policy.emergencyThreshold,
          hardThreshold: policy.hardThreshold,
          softThreshold: policy.softThreshold,
          topicDistance: policy.topicDistance,
          maxChunkBeforeManage: policy.maxChunkBeforeManage,
          userOverride: policy.userOverride,
        },
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
    case "context_set_policy": {
      const policy: Partial<ManagementPolicy> = {};
      const bool = (k: keyof ManagementPolicy, v: unknown) => { if (typeof v === "boolean") (policy as Record<string, unknown>)[k] = v; };
      const num = (k: keyof ManagementPolicy, v: unknown) => { if (typeof v === "number") (policy as Record<string, unknown>)[k] = v; };
      const str = (k: keyof ManagementPolicy, v: unknown) => { if (typeof v === "string") (policy as Record<string, unknown>)[k] = v; };
      bool("conservative", args.conservative);
      num("softThreshold", args.softThreshold);
      num("hardThreshold", args.hardThreshold);
      num("emergencyThreshold", args.emergencyThreshold);
      num("topicDistance", args.topicDistance);
      num("maxChunkBeforeManage", args.maxChunkBeforeManage);
      str("userOverride", args.userOverride);
      if (Object.keys(policy).length === 0) return textResult("error: 至少提供一个策略字段（如 conservative / emergencyThreshold）");
      engine.setManagementPolicy(policy);
      const p = engine.getManagementPolicy();
      return textResult(
        `✓ 策略已更新。conservative=${p.conservative} effectiveEmergency=${effectiveEmergencyThreshold(p)} ` +
        `emergency=${p.emergencyThreshold} hard=${p.hardThreshold} soft=${p.softThreshold} userOverride=${p.userOverride}`,
      );
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
  // 启动日志（stderr，不干扰 MCP stdio 协议）
  if (!process.env.MCP_NO_BANNER) {
    if (llmCfg) {
      console.error(`[struct-context] LLM 压缩已启用：${llmCfg.model} @ ${llmCfg.baseUrl}`);
    } else {
      console.error("[struct-context] 未检测到 API Key，LLM 压缩走确定性回退（省钱但不准）。设 STRUCT_LLM_API_KEY（可选 STRUCT_LLM_BASE_URL / STRUCT_LLM_MODEL）启用 AI 摘要。");
    }
  }
  startMcpServer();
}
