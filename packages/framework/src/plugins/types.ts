// @struct/framework - 插件系统类型

import type { Id, JsonObject } from "../types/base.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

// ─── 沙箱级别 ─────────────────────────────────────────────

export type SandboxLevel = 0 | 1 | 2 | 3;

// ─── 消息 ─────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly name?: string;
}

// ─── 运行上下文 ───────────────────────────────────────────

export interface RunContext {
  readonly sessionId: string;
  readonly messages: Message[];
  readonly cwd: string;
  readonly abortSignal?: AbortSignal;
  readonly userConfig?: JsonObject;
  readonly env?: Record<string, string>;
}

/** 工具拦截上下文：插件可在工具执行前后注入逻辑 */
export interface ToolContext {
  readonly toolCall: ToolCall;
  readonly toolResult?: ToolResult;
  readonly runContext: RunContext;
  readonly phase: "before" | "after";
}

/** Agent 生命周期拦截上下文 */
export interface AgentContext {
  readonly runContext: RunContext;
  readonly phase: "before" | "after";
  readonly response?: AgentResponse;
}

export interface AgentResponse {
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: { promptTokens: number; completionTokens: number };
  readonly finishReason?: string;
}

// ─── 运行统计与结果 ───────────────────────────────────────

export interface RunStats {
  readonly steps: number;
  readonly toolCalls: number;
  readonly tokensUsed: number;
  readonly durationMs: number;
  readonly loopDetected?: boolean;
  readonly aborted?: boolean;
}

export interface RunResult {
  readonly success: boolean;
  readonly response: AgentResponse;
  readonly stats: RunStats;
  readonly error?: string;
}

// ─── 插件注入结果 ─────────────────────────────────────────

export interface InjectResult {
  /** 注入到上下文的额外消息/内容 */
  readonly messages?: Message[];
  /** 注入的系统提示 */
  readonly systemPrompt?: string;
  /** 工具结果修改（after 阶段） */
  readonly modifiedResult?: ToolResult;
  /** 是否阻止工具执行（before 阶段） */
  readonly blockTool?: boolean;
  readonly blockReason?: string;
}

// ─── 插件钩子 ─────────────────────────────────────────────

export interface PluginHooks {
  onBeforeAgent?(ctx: AgentContext): Promise<InjectResult | void>;
  onAfterAgent?(ctx: AgentContext): Promise<InjectResult | void>;
  onBeforeTool?(ctx: ToolContext): Promise<InjectResult | void>;
  onAfterTool?(ctx: ToolContext): Promise<InjectResult | void>;
  onRunCompleted?(result: RunResult): Promise<void>;
  onError?(error: unknown, ctx?: RunContext): Promise<void>;
}

// ─── 插件接口 ─────────────────────────────────────────────

export interface IPlugin {
  readonly id: string;
  readonly priority: number;
  readonly hooks: PluginHooks;
  readonly description?: string;
}
