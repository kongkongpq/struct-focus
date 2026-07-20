// @structfocus/context — A 线 Runner：裸跑（Upper Bound）
//
// 对话历史从头到尾全保留，不限窗口。代表「如果上下文无限长，LLM 能多好」。

import type { Message, RunResult } from "../types.js";
import { estimateTokens, type ChatFn } from "../llm-provider.js";
import type { LLMMessage } from "../../src/index.js";

export async function runRaw(
  messages: Message[],
  question: string,
  chat: ChatFn,
  targetTopic: string,
): Promise<RunResult> {
  const prompt: LLMMessage[] = [
    ...messages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ];
  const promptText = prompt.map((m) => m.content ?? "").join("\n");
  const t0 = Date.now();
  const answer = await chat(prompt);
  return {
    answer,
    injectText: promptText,
    ttft: Date.now() - t0,
    promptTokens: estimateTokens(promptText),
    targetTopic,
  };
}
