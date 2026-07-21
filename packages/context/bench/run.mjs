// StructFocus 统一基准入口 (roadmap 三.1)
//
// 纯 Node ESM，无需 tsx / 无需 API key 即可运行 BM25 suite。
// NIAH / multihop / DocQA 在缺少 LLM_API_KEY 或未编译 harness 时优雅跳过（不伪造结果）。
//
// 用法：
//   node packages/context/bench/run.mjs --suite bm25
//   node packages/context/bench/run.mjs --suite all
//   node packages/context/bench/run.mjs --list
//   node packages/context/bench/run.mjs            # 默认 all
//
// 输出：控制台摘要 + 统一 Markdown 报告（docs/benchmarks/_last-run.md）+ JSON（docs/benchmarks/_last-run.json）

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { SUITE_META, ALL_SUITES, formatReportMarkdown } from "./suites/bench-result.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// suite 模块映射（懒加载，避免未就绪模块在 import 阶段报错）
const SUITE_RUNNERS = {
  bm25: () => import("./suites/bm25.mjs").then((m) => m.run()),
  niah: () => import("./suites/niah.mjs").then((m) => m.run()),
  multihop: () => import("./suites/multihop.mjs").then((m) => m.run()),
  docqa: () => import("./suites/docqa.mjs").then((m) => m.run()),
};

function parseArgs(argv) {
  const args = { suite: "all", list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list" || a === "-l") args.list = true;
    else if (a === "--suite" || a === "-s") args.suite = argv[++i] || "all";
    else if (a === "--help" || a === "-h") args.list = true; // 展示可用 suite 即视为帮助
  }
  return args;
}

function printList() {
  console.log("可用 suite：");
  for (const name of ALL_SUITES) {
    const m = SUITE_META[name];
    console.log(`  ${name.padEnd(10)} ${m.needsLLM ? "(需 LLM_API_KEY)" : "(无需 key)"}  ${m.description}`);
  }
  console.log("");
  console.log("用法: node packages/context/bench/run.mjs --suite <bm25|niah|multihop|docqa|all>");
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    printList();
    return;
  }

  let selected;
  if (args.suite === "all") {
    selected = ALL_SUITES;
  } else if (SUITE_META[args.suite]) {
    selected = [args.suite];
  } else {
    console.error(`未知 suite: ${args.suite}`);
    printList();
    process.exitCode = 1;
    return;
  }

  console.log("=".repeat(64));
  console.log("  StructFocus 基准运行器 (bench/run.mjs)");
  console.log("=".repeat(64));
  console.log(`  suite: ${selected.join(", ")}`);
  console.log("");

  const results = [];
  for (const name of selected) {
    const meta = SUITE_META[name];
    console.log(`▶ ${name} — ${meta.needsLLM ? "需 LLM key" : "无需 key"}`);
    try {
      const r = await SUITE_RUNNERS[name]();
      results.push(r);
      if (r.status === "skipped") {
        console.log(`  ⏭️  SKIPPED: ${r.note}`);
      } else {
        const bl = r.results?.BL?.score;
        const cm = r.results?.CM?.score;
        console.log(`  ✅ OK  (BL=${JSON.stringify(bl)} | CM=${JSON.stringify(cm)})`);
      }
    } catch (err) {
      console.error(`  ❌ ERROR in ${name}:`, err?.message || err);
      results.push({
        suite: name,
        model: null,
        date: new Date().toISOString().slice(0, 10),
        status: "error",
        results: null,
        note: String(err?.stack || err),
      });
    }
    console.log("");
  }

  // 写统一报告（__dir = packages/context/bench → ../../.. 即仓库根）
  const md = formatReportMarkdown(results, "bench/run.mjs");
  const json = JSON.stringify(results, null, 2);
  const outDir = join(__dir, "..", "..", "..", "docs", "benchmarks");
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, "_last-run.md");
  const jsonPath = join(outDir, "_last-run.json");
  writeFileSync(mdPath, md, "utf-8");
  writeFileSync(jsonPath, json, "utf-8");
  console.log("=".repeat(64));
  console.log(`  报告: ${mdPath}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log("=".repeat(64));

  const okCount = results.filter((r) => r.status === "ok").length;
  const skipCount = results.filter((r) => r.status === "skipped").length;
  const errCount = results.filter((r) => r.status === "error").length;
  console.log(`  汇总: OK=${okCount}  SKIPPED=${skipCount}  ERROR=${errCount}`);
}

await main();
