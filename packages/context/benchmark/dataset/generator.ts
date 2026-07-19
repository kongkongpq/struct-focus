// @struct/context — 对话生成器（确定性，无随机）
//
// 把「话题顺序 × 每话题轮数」组合成一条完整测试对话：
//   [话题A 轮1..k] [话题B 轮1..k] ... [话题Z 轮1..k] [最终提问]
//
// 设计意图：最终提问永远指向第一个话题（遗忘曲线）；
// 中间的 B..Z 是干扰噪声。A 裸跑全保留 → B FIFO 截断后首个话题
// 可能被推出窗口 → C 用胶囊+召回把首个话题找回来。

import type { Message } from "../types.js";
import { TOPICS } from "./topics.js";

export interface GeneratedConversation {
  /** 拼装后的完整对话（不含最终提问） */
  messages: Message[];
  /** 最终提问（永远指向 order[0] 话题） */
  finalQuestion: string;
  /** 实际使用的话题 name 顺序 */
  topicsUsed: string[];
  /** 最终提问对应的关键词（用于召回/评分） */
  finalKeywords: string[];
}

/**
 * 生成一条测试对话。
 *
 * @param order        话题在 TOPICS 中的下标顺序（如 [0,1,2,3]）
 * @param roundsPerTopic 每个话题取多少轮。超过预写轮数时循环复用
 *                       （确定性），以保证「对话轮数 N」能真正拉长对话、
 *                       触发 B 线 FIFO 截断的遗忘效应。
 */
export function generateConversation(
  order: number[],
  roundsPerTopic: number,
): GeneratedConversation {
  const messages: Message[] = [];
  const topicsUsed: string[] = [];

  const n = Math.max(1, roundsPerTopic);
  for (const idx of order) {
    const topic = TOPICS[idx];
    if (!topic) continue;
    topicsUsed.push(topic.name);
    const cycle = topic.rounds.length;
    for (let r = 0; r < n; r++) {
      const round = topic.rounds[r % cycle]!;
      messages.push({ role: "user", content: round.user });
      messages.push({ role: "assistant", content: round.assistant });
    }
  }

  const first = TOPICS[order[0]!];
  const finalQuestion = first ? first.qa.question : "";
  const finalKeywords = first ? first.qa.keywords : [];

  return { messages, finalQuestion, topicsUsed, finalKeywords };
}

/**
 * 构造「前 N 个话题」的顺序（下标）。
 * benchmark 的默认顺序就是按 TOPICS 数组顺序取前 topics 个。
 */
export function buildOrder(topics: number): number[] {
  const n = Math.max(1, Math.min(topics, TOPICS.length));
  return Array.from({ length: n }, (_, i) => i);
}
