// @struct/context — 度量指标与聚合
//
// 召回率（上下文留存率）：注入给 LLM 的上下文文本中命中 ground-truth 关键词的百分比
// （确定性，无需 LLM-as-judge）。这是指南 §2/§5 的设计口径——评「信息是否进上下文」，
// 对 mock 与真实 LLM 同样有效、可复现、零评判偏差。
// 其它指标：TTFT、token 消耗、压缩比。
//
// 说明：早期实现误把「LLM 回答文本」作为评分对象，导致真实 LLM 下 A 线（全量上下文）
// 因 GLM 不原样复述关键词而误判为 0%。评分已更正为注入上下文。

import type { QAResult, TrialRecord, RunResult } from "./types.js";
import { estimateTokens } from "./llm-provider.js";

/** 关键词命中评分 */
export function scoreRecall(
  answer: string,
  keywords: string[],
): { hits: number; total: number; recall: number } {
  const lower = answer.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (kw && lower.includes(kw.toLowerCase())) hits += 1;
  }
  const total = keywords.length;
  return { hits, total, recall: total === 0 ? 0 : hits / total };
}

/** 把一次 Runner 结果 + 关键词封装成可评分的 QAResult */
export function toQAResult(
  line: "A" | "B" | "C",
  run: RunResult,
  question: string,
  keywords: string[],
  capsuleTokens = 0,
  originalTokens = 0,
): QAResult {
  // 评分对象：注入给 LLM 的上下文文本（run.injectText），而非 LLM 的回答。
  // 这样测量的是「信息是否进上下文」，与指南 §2/§5 的零-judge 设计一致。
  const { hits, total, recall } = scoreRecall(run.injectText, keywords);
  return {
    line,
    question,
    keywords,
    answer: run.answer,
    hits,
    total,
    recall,
    ttft: run.ttft,
    promptTokens: run.promptTokens,
    targetTopic: run.targetTopic,
    capsuleTokens,
    originalTokens,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  const v = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

export interface LineAgg {
  avgRecall: number;
  stdRecall: number;
  avgTTFT: number;
  avgTokens: number;
  samples: number;
}

export interface LengthRow {
  rounds: number;
  A: number;
  B: number;
  C: number;
}

export interface TopicRow {
  topic: string;
  A: number;
  B: number;
  C: number;
}

export interface Aggregate {
  lines: { A: LineAgg; B: LineAgg; C: LineAgg };
  byLength: LengthRow[];
  byTopic: TopicRow[];
  /** C 线压缩比（capsuleTokens / originalTokens）均值 */
  avgCompression: number;
  totalTokens: { A: number; B: number; C: number };
}

function aggLine(results: QAResult[]): LineAgg {
  return {
    avgRecall: mean(results.map((r) => r.recall)),
    stdRecall: std(results.map((r) => r.recall)),
    avgTTFT: mean(results.map((r) => r.ttft)),
    avgTokens: mean(results.map((r) => r.promptTokens)),
    samples: results.length,
  };
}

/**
 * 聚合所有 trial。
 * @param trials 三次线对照的完整记录
 */
export function aggregate(trials: TrialRecord[]): Aggregate {
  const allA = trials.map((t) => t.A);
  const allB = trials.map((t) => t.B);
  const allC = trials.map((t) => t.C);

  // 按对话长度
  const lengthMap = new Map<number, { A: number[]; B: number[]; C: number[] }>();
  for (const t of trials) {
    const r = t.config.rounds;
    if (!lengthMap.has(r)) lengthMap.set(r, { A: [], B: [], C: [] });
    const bucket = lengthMap.get(r)!;
    bucket.A.push(t.A.recall);
    bucket.B.push(t.B.recall);
    bucket.C.push(t.C.recall);
  }
  const byLength: LengthRow[] = [...lengthMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rounds, b]) => ({
      rounds,
      A: mean(b.A),
      B: mean(b.B),
      C: mean(b.C),
    }));

  // 按话题（最终提问指向的话题）
  const topicMap = new Map<string, { A: number[]; B: number[]; C: number[] }>();
  for (const t of trials) {
    const name = t.targetTopic;
    if (!topicMap.has(name)) topicMap.set(name, { A: [], B: [], C: [] });
    const bucket = topicMap.get(name)!;
    bucket.A.push(t.A.recall);
    bucket.B.push(t.B.recall);
    bucket.C.push(t.C.recall);
  }
  const byTopic: TopicRow[] = [...topicMap.entries()].map(([topic, b]) => ({
    topic,
    A: mean(b.A),
    B: mean(b.B),
    C: mean(b.C),
  }));

  const compRatios = allC
    .filter((r) => r.originalTokens > 0)
    .map((r) => r.capsuleTokens / r.originalTokens);
  const avgCompression = compRatios.length ? mean(compRatios) : 0;

  return {
    lines: {
      A: aggLine(allA),
      B: aggLine(allB),
      C: aggLine(allC),
    },
    byLength,
    byTopic,
    avgCompression,
    totalTokens: {
      A: allA.reduce((s, r) => s + r.promptTokens, 0),
      B: allB.reduce((s, r) => s + r.promptTokens, 0),
      C: allC.reduce((s, r) => s + r.promptTokens, 0),
    },
  };
}

export { estimateTokens };
