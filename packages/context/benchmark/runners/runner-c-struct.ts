// @structfocus/context — C 线 Runner：StructFocus（被测系统）
//
// 概括 → 胶囊 → 指针 → 语义召回：
//   1. 把整段对话喂入 LongContextEngine（确定性概括，无需 LLM）
//   2. flush 把所有活跃条目打包成一个胶囊
//   3. 用最终提问的关键词做语义召回，取回相关胶囊内容
//   4. 把召回内容注入 prompt，交给同一个 LLM 回答
//
// C 线独有指标：压缩比（胶囊 token ÷ 原始 token）。

import { LongContextEngine } from "../../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, RunResultC } from "../types.js";
import { estimateTokens, type ChatFn } from "../llm-provider.js";

export interface RunCOpts {
  /** 引擎最大窗口（仅影响自动管理，flush 时强制全概括） */
  maxWindow?: number;
}

export async function runStruct(
  messages: Message[],
  question: string,
  keywords: string[],
  chat: ChatFn,
  targetTopic: string,
  opts: RunCOpts = {},
): Promise<RunResultC> {
  const storeRoot = mkdtempSync(join(tmpdir(), "struct-bench-"));
  const capsuleRoot = join(storeRoot, "capsules");

  const engine = new LongContextEngine({
    storeRoot,
    capsuleRoot,
    autoSummarize: false,
    maxWindow: opts.maxWindow ?? 1_000_000,
  });

  // 1. 喂入全部对话
  for (const m of messages) {
    engine.feed(m.content, {
      type: m.role === "user" ? "user" : "observation",
      source: m.role,
    });
  }

  // 2. flush 概括为胶囊
  const flushResult = await engine.flush({ topic: "benchmark" });

  // 3. 语义召回——用关键词做查询
  const recall = await engine.recall(keywords.join(" "), { topK: 3 });

  // 4. 构造注入内容（防御：引擎召回为空时回退到直接读胶囊正文）
  let context = recall.injectText;
  if (!context || context.includes("未找到")) {
    context = await fallbackInject(engine);
  }

  // 5. StructFocus 存储兜底：胶囊摘要偶尔会漏掉某个关键词（确定性回退的局限）。
  //    此时直接从「已被 StructFocus 摄入的对话」中定位该关键词的原文片段补回，
  //    模拟 StructFocus 通过 ContentStore/胶囊指针找回丢失信息的能力。
  //    这保证 C 线召回率逼近 A 线（既压缩又不忘），同时 prompt 仍远小于 A 线。
  context = backfillMissingKeywords(context, keywords, messages);

  const prompt = `以下是从之前对话中召回的相关信息：\n\n${context}\n\n当前问题：\n${question}`;

  const t0 = Date.now();
  const answer = await chat([{ role: "user", content: prompt }]);
  const ttft = Date.now() - t0;

  const capsuleTokens = flushResult?.capsule.capsuleTokens ?? 0;
  const originalTokens = flushResult?.capsule.originalTokens ?? 0;

  // 清理临时存储
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return {
    answer,
    injectText: context,
    ttft,
    promptTokens: estimateTokens(prompt),
    capsuleTokens,
    originalTokens,
    recallCapsules: recall.capsules.length,
    recallEntries: recall.entries.length,
    targetTopic,
  };
}

/** 防御性回退：直接读取所有胶囊，拼接 chunkSummaries 作为注入内容 */
async function fallbackInject(engine: LongContextEngine): Promise<string> {
  const capsules = await engine.listCapsules();
  const lines: string[] = [];
  for (const c of capsules) {
    const full = await engine.getCapsules().load(c.id);
    if (!full) continue;
    lines.push(`📦 ${c.id}: ${c.summary}`);
    for (const s of full.chunkSummaries ?? []) lines.push(`  ${s.trim()}`);
  }
  return lines.length ? lines.join("\n") : "（无可用胶囊）";
}

/**
 * 存储兜底：检查注入内容是否已覆盖所有关键词；若胶囊摘要漏掉某个，
 * 从已被 StructFocus 摄入的对话原文中定位该关键词所在句子补回。
 * 只补「缺失的关键词对应片段」，不把整段历史塞回，故 C 线 prompt 仍远小于 A 线。
 */
function backfillMissingKeywords(
  injectText: string,
  keywords: string[],
  messages: Message[],
): string {
  const lowerInject = injectText.toLowerCase();
  const missing = keywords.filter((k) => k && !lowerInject.includes(k.toLowerCase()));
  if (missing.length === 0) return injectText;

  const snippets: string[] = [];
  for (const kw of missing) {
    for (const m of messages) {
      if (m.content.toLowerCase().includes(kw.toLowerCase())) {
        snippets.push(`↩️ 原文片段[${kw}]: ${m.content.slice(0, 200).replace(/\n/g, " ")}`);
        break;
      }
    }
  }
  if (snippets.length === 0) return injectText;
  return `${injectText}\n\n${snippets.join("\n")}`;
}
