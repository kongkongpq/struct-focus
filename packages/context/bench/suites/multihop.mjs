// Multi-hop QA suite (roadmap 三.1 / 1.3) — key-gated
//
// 依赖 roadmap 1.3 的多跳 QA 题库（3 文档 × 20 题）与 LLM_API_KEY。
// 当前题库与 key 均未就绪，诚实跳过。

import { makeSkippedResult } from "./bench-result.mjs";

export async function run() {
  return makeSkippedResult(
    "multihop",
    "SKIPPED: 依赖 roadmap 1.3 多跳 QA 题库（3 文档×20 题，需 GLM-4 key 生成与人工验证）及 LLM_API_KEY。" +
      " 题库就绪后，在 bench/suites/multihop.mjs 中实现 BL（直喂 3 文档）vs CM（recall top-5×3）对比，映射为 BenchResult。",
  );
}
