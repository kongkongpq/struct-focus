// DocQA suite (roadmap 三.1 / 1.4) — key-gated
//
// 依赖 roadmap 1.4 的系统化长文档 QA 报告（750K chars）与 LLM_API_KEY。
// 现有 DocQA 结果在 harness 中但未写成可复现 BenchResult，且 key 未就绪，诚实跳过。

import { makeSkippedResult } from "./bench-result.mjs";

export async function run() {
  return makeSkippedResult(
    "docqa",
    "SKIPPED: 依赖 roadmap 1.4 系统化长文档 QA（750K chars，需 LLM_API_KEY）及 bench/harness.ts 编译。" +
      " 数据就绪后，在 bench/suites/docqa.mjs 中实现 BL vs CM 逐题对比（含幻觉分析），映射为 BenchResult。",
  );
}
