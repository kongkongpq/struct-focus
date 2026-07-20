// @structfocus/context — 报告生成（Markdown / JSON / CSV）
//
// 严格对齐 benchmark-guide.md 第 5 节的报告模板。

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Aggregate } from "./metrics.js";
import type { TrialRecord, BenchmarkConfig } from "./types.js";

export interface ReportMeta {
  date: string;
  model: string;
  mode: string; // "smoke" | "full" | "custom"
  windowTokens: number;
  configs: BenchmarkConfig[];
  sweep: boolean;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatMarkdown(
  meta: ReportMeta,
  agg: Aggregate,
  trials: TrialRecord[],
): string {
  const { A, B, C } = agg.lines;
  const cVsB = (C.avgRecall - B.avgRecall) * 100;

  const lines: string[] = [];
  lines.push("# StructFocus Benchmark Report");
  lines.push("");
  lines.push(`**日期**: ${meta.date}`);
  lines.push(`**LLM**: ${meta.model}`);
  lines.push(`**模式**: ${meta.mode} ｜ **FIFO 窗口**: ${meta.windowTokens} tokens`);
  lines.push(
    `**配置矩阵**: ${meta.configs
      .map((c) => `轮${c.rounds}×话题${c.topics}×重复${c.repeat}`)
      .join("， ")}`,
  );
  lines.push("");
  lines.push("> 对照逻辑：A 裸跑(上界) → B FIFO 截断(业界基线) → C StructFocus(被测)。");
  lines.push("> 召回率（上下文留存率）= 注入给 LLM 的上下文中命中 ground-truth 关键词的比例（零 LLM-judge，对 mock 与真实 LLM 同样有效）。");
  lines.push("");

  // ─── 5.1 总体对比 ───────────────────────────────
  lines.push("## 5.1 总体对比");
  lines.push("");
  lines.push("| 指标 | A 裸跑 (UB) | B FIFO | C StructFocus | C vs B |");
  lines.push("|------|:----------:|:------:|:-------------:|:------:|");
  lines.push(
    `| 平均召回率 | ${pct(A.avgRecall)} | ${pct(B.avgRecall)} | **${pct(C.avgRecall)}** | **${cVsB >= 0 ? "+" : ""}${cVsB.toFixed(1)}pp** ${cVsB > 0 ? "✅" : ""} |`,
  );
  lines.push(
    `| 平均 TTFT | ${fmtMs(A.avgTTFT)} | ${fmtMs(B.avgTTFT)} | **${fmtMs(C.avgTTFT)}** | — |`,
  );
  lines.push(
    `| 平均 token/prompt | ${A.avgTokens.toFixed(0)} | ${B.avgTokens.toFixed(0)} | **${C.avgTokens.toFixed(0)}** | — |`,
  );
  const compPct = agg.avgCompression > 0 ? (1 - agg.avgCompression) * 100 : 0;
  lines.push(`| 压缩比 (C only) | — | — | ${compPct.toFixed(0)}% | — |`);
  lines.push("");

  // ─── 5.2 按对话长度 ─────────────────────────────
  lines.push("## 5.2 按对话长度");
  lines.push("");
  if (agg.byLength.length > 0) {
    lines.push("| 对话轮数 | A 召回率 | B 召回率 | C 召回率 | C-B 提升 |");
    lines.push("|---------|:-------:|:-------:|:-------:|:-------:|");
    for (const row of agg.byLength) {
      const diff = (row.C - row.B) * 100;
      lines.push(
        `| ${row.rounds} | ${pct(row.A)} | ${pct(row.B)} | ${pct(row.C)} | ${diff >= 0 ? "+" : ""}${diff.toFixed(0)}pp |`,
      );
    }
    // 找到 B 线开始明显落后于 C 线的临界轮数（用于结论措辞）
    let thresholdRounds: number | null = null;
    for (const row of agg.byLength) {
      if (row.B < C.avgRecall - 0.1) {
        thresholdRounds = row.rounds;
        break;
      }
    }
    if (thresholdRounds !== null) {
      lines.push("");
      lines.push(
        `> 结论：对话轮数 ≥ ${thresholdRounds} 时，C 线 StructFocus 召回率显著优于 B 线 FIFO 截断（B 因 FIFO 尾部截断已丢失最前端的目标话题）。`,
      );
    }
  } else {
    lines.push("_无数据_");
  }
  lines.push("");

  // ─── 5.3 话题召回率分布 ──────────────────────────
  lines.push("## 5.3 话题召回率分布");
  lines.push("");
  if (agg.byTopic.length > 1) {
    lines.push("| 话题（最终提问目标） | A | B | C | 说明 |");
    lines.push("|------|:-:|:-:|:-:|------|");
    // 按话题在对话中的「距离」排序：index 0 = 最远端，index 大 = 近端
    const ordered = [...agg.byTopic].sort((a, b) => topicIndex(a.topic) - topicIndex(b.topic));
    for (const row of ordered) {
      const dist = topicIndex(row.topic);
      const note = dist === 0 ? "最远端话题，B 易遗忘" : dist >= ordered.length - 1 ? "近端话题，B 也保留" : "中断话题";
      lines.push(`| ${row.topic} | ${pct(row.A)} | ${pct(row.B)} | ${pct(row.C)} | ${note} |`);
    }
  } else {
    const only = agg.byTopic[0];
    lines.push(
      only
        ? `仅运行了针对话题「${only.topic}」的遗忘曲线实验。运行 \`--sweep\` 可获得按话题位置（近端/中断/远端）的完整分布。`
        : "_无数据_",
    );
  }
  lines.push("");

  // ─── 5.4 Token 效率 ─────────────────────────────
  lines.push("## 5.4 Token 效率");
  lines.push("");
  lines.push("| | A 裸跑 | B FIFO | C StructFocus |");
  lines.push("|--|:-----:|:------:|:------------:|");
  lines.push(
    `| 总 prompt tokens | ${agg.totalTokens.A.toLocaleString()} | ${agg.totalTokens.B.toLocaleString()} | **${agg.totalTokens.C.toLocaleString()}** |`,
  );
  const saveVsA = agg.totalTokens.A > 0 ? (1 - agg.totalTokens.C / agg.totalTokens.A) * 100 : 0;
  lines.push(`| 相对 A 节省 | — | — | **${saveVsA.toFixed(0)}%** |`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`生成于 ${meta.date} ｜ 共 ${trials.length} 条 trial（A/B/C 各 ${trials.length} 次调用）`);
  lines.push("");

  return lines.join("\n");
}

// 简易话题顺序索引（按 TOPICS 数组顺序），用于 5.3 排序
import { TOPICS } from "./dataset/topics.js";
function topicIndex(name: string): number {
  const i = TOPICS.findIndex((t) => t.name === name);
  return i < 0 ? 999 : i;
}

/** 写出 Markdown / JSON / CSV 三份报告 */
export function writeReports(
  outDir: string,
  baseName: string,
  meta: ReportMeta,
  agg: Aggregate,
  trials: TrialRecord[],
): { md: string; json: string; csv: string } {
  mkdirSync(outDir, { recursive: true });
  const md = formatMarkdown(meta, agg, trials);

  const json = JSON.stringify({ meta, aggregate: agg, trials }, null, 2);

  // CSV：每行一个 line 的评分
  const csvHeader = [
    "config_rounds",
    "config_topics",
    "target_topic",
    "line",
    "recall",
    "hits",
    "total",
    "ttft_ms",
    "prompt_tokens",
    "capsule_tokens",
    "original_tokens",
  ].join(",");
  const csvRows: string[] = [csvHeader];
  for (const t of trials) {
    for (const line of [t.A, t.B, t.C]) {
      csvRows.push(
        [
          t.config.rounds,
          t.config.topics,
          t.targetTopic,
          line.line,
          line.recall.toFixed(3),
          line.hits,
          line.total,
          Math.round(line.ttft),
          line.promptTokens,
          line.capsuleTokens,
          line.originalTokens,
        ].join(","),
      );
    }
  }
  const csv = csvRows.join("\n");

  const mdPath = resolve(outDir, `${baseName}.md`);
  const jsonPath = resolve(outDir, `${baseName}.json`);
  const csvPath = resolve(outDir, `${baseName}.csv`);
  writeFileSync(mdPath, md, "utf-8");
  writeFileSync(jsonPath, json, "utf-8");
  writeFileSync(csvPath, csv, "utf-8");

  return { md: mdPath, json: jsonPath, csv: csvPath };
}

// 仅用于类型导入路径解析（避免未使用告警）
void dirname;
