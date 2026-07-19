// @struct/context — QA 测试集
//
// 每个话题 1 道题 + 关键词列表，直接由 TOPICS 派生（单一事实来源）。

import type { Topic } from "../types.js";
import { TOPICS } from "./topics.js";

export interface QADef {
  topic: string;
  title: string;
  question: string;
  keywords: string[];
}

/** 完整 QA 集合（每个话题一道） */
export const QA_SET: QADef[] = TOPICS.map((t: Topic) => ({
  topic: t.name,
  title: t.title,
  question: t.qa.question,
  keywords: t.qa.keywords,
}));

/** 按话题名取 QA */
export function getQA(topicName: string): QADef | undefined {
  return QA_SET.find((q) => q.topic === topicName);
}
