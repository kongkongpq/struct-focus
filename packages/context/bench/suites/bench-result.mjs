// 统一基准结果类型与格式化 (roadmap 三.1)
//
// 设计约束（来自项目现状核实）：
//   - bench/ 下的 .ts 脚本依赖未在 dist 编译的 harness.js，且本机未安装 tsx；
//     因此统一入口采用纯 Node ESM（.mjs），无需任何额外安装即可 `node` 运行。
//   - 仅 BM25 精度基准是确定性的、无需 API key（依赖 dist/index.js 的 ContentManager.getStore()）。
//   - NIAH / multihop / DocQA 需要 LLM_API_KEY，且当前 harness 未编译，标记为 key-gated，
//     运行时优雅跳过（不伪造结果，符合"诚实披露"要求）。

/**
 * @typedef {Object} SuiteMeta
 * @property {string} name
 * @property {string} description
 * @property {boolean} needsLLM
 */

/** 所有可用 suite 的元数据（run.mjs 据此解析 --suite）。 */
export const SUITE_META = {
  bm25: {
    name: "bm25",
    description: "BM25 vs includes 搜索精度（确定性，无需 API key）",
    needsLLM: false,
  },
  niah: {
    name: "niah",
    description: "Needle-in-Haystack 12 格热力图（需 LLM_API_KEY + 编译 harness）",
    needsLLM: true,
  },
  multihop: {
    name: "multihop",
    description: "多跳 QA 3文档×20题（需 LLM_API_KEY + 题库，见 roadmap 1.3）",
    needsLLM: true,
  },
  docqa: {
    name: "docqa",
    description: "超窗口长文档 QA（需 LLM_API_KEY，见 roadmap 1.4）",
    needsLLM: true,
  },
};

export const ALL_SUITES = Object.keys(SUITE_META);

/**
 * 统一结果结构（roadmap 三.1 合格标准要求的字段）：
 *   { suite, model, date, status, results: { BL: {score, details}, CM: {score, details} }, note }
 *
 * - status: "ok" | "skipped"
 * - BL: 基线（BM25 suite 中为 includes 子串匹配）
 * - CM: StructFocus（BM25 suite 中为 BM25 打分）
 * - score: 数值化指标对象（具体字段由 suite 定义）
 * - details: 人类可读的细节（数组/对象，可被 JSON 序列化）
 */
export function makeBenchResult(suite, model, results, note = "") {
  return {
    suite,
    model,
    date: new Date().toISOString().slice(0, 10),
    status: "ok",
    results,
    note,
  };
}

/** 生成一个"跳过"结果（key-gated / 未就绪）。不伪造分数。 */
export function makeSkippedResult(suite, reason) {
  return {
    suite,
    model: null,
    date: new Date().toISOString().slice(0, 10),
    status: "skipped",
    results: null,
    note: reason,
  };
}

/**
 * 将一组 BenchResult 渲染为统一 Markdown 报告。
 * @param {Array} results
 * @param {string} runner 运行入口标识
 */
export function formatReportMarkdown(results, runner = "bench/run.mjs") {
  const lines = [];
  lines.push(`# StructFocus 基准运行报告`);
  lines.push("");
  lines.push(`> 由 \`${runner}\` 生成。统一结果格式见 roadmap 三.1。`);
  lines.push("");
  lines.push(`| Suite | 状态 | Model | BL | CM | 备注 |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of results) {
    if (r.status === "skipped") {
      lines.push(`| ${r.suite} | ⏭️ SKIPPED | - | - | - | ${r.note} |`);
      continue;
    }
    const bl = r.results?.BL?.score;
    const cm = r.results?.CM?.score;
    const blStr = bl ? JSON.stringify(bl) : "-";
    const cmStr = cm ? JSON.stringify(cm) : "-";
    lines.push(`| ${r.suite} | ✅ OK | ${r.model} | ${blStr} | ${cmStr} | ${r.note || ""} |`);
  }
  lines.push("");

  // 逐 suite 详情
  for (const r of results) {
    if (r.status === "skipped") {
      lines.push(`## ${r.suite} — SKIPPED`);
      lines.push("");
      lines.push(`${r.note}`);
      lines.push("");
      continue;
    }
    lines.push(`## ${r.suite} — ${r.model}`);
    lines.push("");
    if (r.results?.BL?.details) {
      lines.push(`### Baseline (${r.results.BL.label || "BL"})`);
      lines.push("");
      lines.push(renderDetails(r.results.BL.details));
      lines.push("");
    }
    if (r.results?.CM?.details) {
      lines.push(`### StructFocus (${r.results.CM.label || "CM"})`);
      lines.push("");
      lines.push(renderDetails(r.results.CM.details));
      lines.push("");
    }
    if (r.note) {
      lines.push(`> ${r.note}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function renderDetails(details) {
  if (Array.isArray(details)) {
    return "```\n" + details.map((d) => (typeof d === "string" ? d : JSON.stringify(d))).join("\n") + "\n```";
  }
  if (typeof details === "object") {
    return "```json\n" + JSON.stringify(details, null, 2) + "\n```";
  }
  return String(details);
}
