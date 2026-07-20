// @structfocus/context — B 线 Runner：FIFO 30K 截断（业界基线）
//
// 从对话尾部向前取，直到累计 token 超过窗口上限，旧消息直接丢弃。
// 代表「市面上 99% 的 Agent/Chat 产品做的事」。
//
// 说明：指南原文以 30K 作为业界基线窗口；但本基准的合成对话单轮较短，
// 30K 窗口在 160 轮内都不会淘汰首个话题。因此窗口做成可配置参数
// （--window，默认 6000），让 B 线在长对话下确实发生「遗忘」，
// 才能观察到 C 线相对 B 的优势。可用 --window 30000 复现指南原设定。

import type { Message, RunResult } from "../types.js";
import { estimateTokens, type ChatFn } from "../llm-provider.js";
import type { LLMMessage } from "../../src/index.js";

export async function runFIFO(
  messages: Message[],
  question: string,
  chat: ChatFn,
  targetTopic: string,
  maxTokens = 6000,
): Promise<RunResult> {
  // 从后往前取，直到 token 累计超上限
  const windowMsgs: Message[] = [];
  let accTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateTokens(messages[i]!.content);
    if (accTokens + t > maxTokens) break;
    windowMsgs.unshift(messages[i]!);
    accTokens += t;
  }

  const prompt: LLMMessage[] = [
    ...windowMsgs.map((m) => ({ role: m.role, content: m.content })),
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
