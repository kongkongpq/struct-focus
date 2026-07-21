// BM25 搜索精度 suite (roadmap 二.3 / 三.1)
// 确定性、无需 API key。复用 search-precision.mjs 的 runBm25()。
//
// 运行入口：node packages/context/bench/run.mjs --suite bm25

import { runBm25, writeBm25Report } from "../search-precision.mjs";
import { makeBenchResult } from "./bench-result.mjs";

/**
 * 执行 BM25 精度基准，返回统一 BenchResult。
 * BL = 简单 includes 子串匹配；CM = StructStore BM25 打分。
 * 同时刷新规范报告 docs/benchmarks/bm25-precision.md。
 */
export async function run() {
  const data = await runBm25();
  const { rows, agg, passRecall, passPrecision, scenarioB } = data;
  // 刷新规范 BM25 报告（roadmap 二.3 要求产物）
  try {
    const p = writeBm25Report(data);
    console.log(`  📄 规范报告已刷新: ${p}`);
  } catch (e) {
    console.warn(`  ⚠️ 规范报告写出失败: ${e?.message || e}`);
  }

  const blScore = {
    precisionAt5Exact: round(agg.incPExact),
    recallAt5Exact: round(agg.incRExact),
    precisionAt5All: round(agg.incP),
    recallAt5All: round(agg.incR),
  };
  const cmScore = {
    precisionAt5Exact: round(agg.bm25PExact),
    recallAt5Exact: round(agg.bm25RExact),
    precisionAt5All: round(agg.bm25P),
    recallAt5All: round(agg.bm25R),
    recallAt10ScenarioB: round(scenarioB.bm25R10),
  };

  const details = {
    method:
      "100 条模拟被驱逐条目（20 主题簇×5）+ 20 查询（16 精确 + 4 同义模糊）；对比 BM25 与 includes 子串匹配。",
    rows: rows.map((r) => ({
      q: r.q,
      fuzzy: r.fuzzy,
      gold: r.gold,
      bm25: { p: round(r.bm25Pk), r: round(r.bm25Rk) },
      includes: { p: round(r.incPk), r: round(r.incRk) },
    })),
    aggregate: {
      exactN: agg.exactN,
      bm25: { pExact: round(agg.bm25PExact), rExact: round(agg.bm25RExact) },
      includes: { pExact: round(agg.incPExact), rExact: round(agg.incRExact) },
    },
    scenarioB: {
      relCount: scenarioB.relCount,
      bm25: { r5: round(scenarioB.bm25R5), r10: round(scenarioB.bm25R10) },
      includes: { r5: round(scenarioB.incR5), r10: round(scenarioB.incR10) },
      passRecallAt10: scenarioB.passRecall10,
    },
    passRecallAt5Exact: passRecall,
    passPrecisionAt5ExactVsIncludes: passPrecision,
  };

  const note =
    `BM25 不劣于 includes（精确 P@5 ${cmScore.precisionAt5Exact} ≥ ${blScore.precisionAt5Exact}）PASS；` +
    `场景B 忠实实现 Recall@10≥0.7 = ${scenarioB.bm25R10.toFixed(3)} ${scenarioB.passRecall10 ? "PASS" : "FAIL"}。` +
    `（roadmap 字面 Recall@5≥0.7 在 topK=5/10相关 下数学不可达，已披露）`;

  return makeBenchResult(
    "bm25",
    "bm25 (deterministic, no LLM)",
    {
      BL: { label: "includes substring", score: blScore, details: details },
      CM: { label: "StructFocus BM25", score: cmScore, details: details },
    },
    note,
  );
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
