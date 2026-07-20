// @structfocus/context — ContextMiddleware：把 StructFocus 接入任意 Agent 框架的契约
//
// 这是「模式二：中间件注入」的标准接口（将 StructFocus 作为 pre/post LLM hook 注入任意框架）。
// 框架只需在 hook 点调用这三个方法，无需改框架源码、也无需引入任何框架依赖。
//
// 重要边界：这不是某个具体框架的适配层。HTTP Sidecar / Python wrapper 等「针对特定
// 框架或语言」的适配留给社区实现（不属于 StructFocus 核心范围）。ContextMiddleware 是
// StructFocus 自身暴露的、与框架无关的集成契约——任何支持 pre/post LLM hook 的
// 框架（OpenClaw、CodeX 等）都能直接实现它。

import type { LongContextEngine } from "./longcontext-engine.js";

/** 通用消息形状（与 LLMMessage 兼容，content 必为 string） */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

/**
 * StructFocus 暴露给 Agent 框架的中间件契约。
 * 三个方法对应一次 LLM 调用的生命周期。
 */
export interface ContextMiddleware {
  /** LLM 调用前：喂入本轮新消息 + 语义召回相关历史，返回增强后的消息数组 */
  preLlmCall(messages: Message[]): Promise<Message[]>;
  /** LLM 返回后：把 assistant 回复喂回 StructFocus（本轮 user 已在 preLlmCall 喂入） */
  postLlmCall(userMsg: string, assistantMsg: string): void;
  /** Agent 主动语义召回，返回可直接注入的上下文文本（无命中返回空串） */
  recall(query: string): Promise<string>;
}

export interface ContextMiddlewareOptions {
  /** 兜底 system prompt（messages 里没有 system 消息时使用） */
  systemPrompt?: string;
  /** 召回 topK（默认 5） */
  recallTopK?: number;
}

/**
 * 用 LongContextEngine 构造一个 ContextMiddleware。
 *
 * 行为约定（避免重复喂入）：
 *   - preLlmCall：只喂入本轮「最后一条 user 消息」；其余历史由 prior 轮次的
 *     preLlmCall / postLlmCall 已逐步喂入引擎。然后用最后一条 user 消息做语义
 *     召回，把胶囊 + ContentStore 命中拼成一条 system 消息前置注入。
 *   - postLlmCall：只喂入 assistant 回复（user 已在 pre 阶段喂过）。
 */
export function createContextMiddleware(
  engine: LongContextEngine,
  opts: ContextMiddlewareOptions = {},
): ContextMiddleware {
  const topK = opts.recallTopK ?? 5;

  async function preLlmCall(messages: Message[]): Promise<Message[]> {
    const systemMsg = messages.find((m) => m.role === "system");
    const systemPrompt = systemMsg?.content ?? opts.systemPrompt ?? "";

    // 1. 喂入本轮最新的 user 消息（线性对话中即「新 query」）
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      engine.feed(lastUser.content, { type: "user", source: "middleware" });
    }

    // 2. 语义召回：找回被概括/驱逐的历史（胶囊 chunkSummaries + ContentStore 全文）
    let recallText = "";
    if (lastUser) {
      const r = await engine.recall(lastUser.content, { topK });
      if (r.injectText && !r.injectText.includes("未找到")) recallText = r.injectText;
    }

    // 3. 组装增强消息：system(+兜底) → [召回上下文] → 原始消息（去重首条 system）
    const out: Message[] = [];
    if (systemPrompt) out.push({ role: "system", content: systemPrompt });
    if (recallText) {
      out.push({
        role: "system",
        content: `以下是与本次请求相关的历史上下文（由 StructFocus 召回）：\n\n${recallText}`,
      });
    }
    for (const m of messages) {
      if (m.role === "system" && m === systemMsg) continue; // 已在前面注入
      out.push(m);
    }
    return out;
  }

  function postLlmCall(_userMsg: string, assistantMsg: string): void {
    engine.feed(assistantMsg, { type: "observation", source: "middleware" });
  }

  async function recall(query: string): Promise<string> {
    const r = await engine.recall(query, { topK });
    return r.injectText && !r.injectText.includes("未找到") ? r.injectText : "";
  }

  return { preLlmCall, postLlmCall, recall };
}
