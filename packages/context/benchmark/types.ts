// @structfocus/context — Benchmark 共享类型
//
// A/B/C 三线对照实验的共享数据结构。
// 与 packages/context/src 解耦：这里只描述 benchmark 自身的契约。

/** 一条对话消息（用户 / 助手） */
export interface Message {
  role: "user" | "assistant";
  content: string;
}

/** 单个话题的一轮预写对话 */
export interface TopicRound {
  user: string;
  assistant: string;
}

/** 预写话题库中的单个话题 */
export interface Topic {
  /** 英文标识，用于排序与日志 */
  name: string;
  /** 中文标题 */
  title: string;
  /** 背景描述（生成器可选向 LLM 透传） */
  context: string;
  /** 最终提问 + 命中关键词 */
  qa: {
    question: string;
    keywords: string[];
  };
  /** 预写轮次（≥ 6 轮） */
  rounds: TopicRound[];
}

/** 一次 Runner 执行的结果（A/B 线共用） */
export interface RunResult {
  /** LLM 回答文本（仅作参考留存，不直接用于召回评分） */
  answer: string;
  /**
   * 注入给 LLM 的上下文文本（召回评分的对象）。
   * 评分口径：ground-truth 关键词是否出现在本字段中，即「信息是否进上下文」。
   * 这是指南 §2/§5 的设计：零 LLM-judge、确定、可复现，对 mock 与真实 LLM 同样有效。
   */
  injectText: string;
  /** 首 token 延迟（ms，近似：请求发出 → 回答返回） */
  ttft: number;
  /** 输入 prompt 估算 token 数 */
  promptTokens: number;
  /** 本次回答指向的话题名（最终提问目标） */
  targetTopic: string;
}

/** C 线结果（在 RunResult 基础上增加胶囊相关指标） */
export interface RunResultC extends RunResult {
  /** 胶囊 token（压缩后） */
  capsuleTokens: number;
  /** 原始 token（压缩前） */
  originalTokens: number;
  /** 召回到的胶囊数 */
  recallCapsules: number;
  /** 召回到的原文片段数 */
  recallEntries: number;
}

/** 单个 QA 的评分结果 */
export interface QAResult {
  line: "A" | "B" | "C";
  question: string;
  keywords: string[];
  answer: string;
  hits: number;
  total: number;
  recall: number;
  ttft: number;
  promptTokens: number;
  /** 本次回答指向的话题名（最终提问目标） */
  targetTopic: string;
  // C 线独有（A/B 为 0）
  capsuleTokens: number;
  originalTokens: number;
}

/** 一个 benchmark 配置（行数 × 话题数 × 重复次数） */
export interface BenchmarkConfig {
  rounds: number;
  topics: number;
  repeat: number;
}

/** 一次完整运行（三线）归并到一条对话上的结果 */
export interface TrialRecord {
  config: BenchmarkConfig;
  topicOrder: string[];
  /** 最终提问指向的话题（下标） */
  targetTopicIndex: number;
  /** 最终提问指向的话题名 */
  targetTopic: string;
  finalQuestion: string;
  keywords: string[];
  A: QAResult;
  B: QAResult;
  C: QAResult;
}
