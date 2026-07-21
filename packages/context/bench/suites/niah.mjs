// NIAH suite (roadmap 三.1) — key-gated
//
// 需要 LLM_API_KEY，且当前 harness（bench/harness.ts）未被编译进 dist，
// run.ts/harness.ts 依赖未存在的 ./harness.js。在 key 可用 + harness 编译后接入。
// 当前仅诚实跳过，不伪造分数。

import { makeSkippedResult } from "./bench-result.mjs";

export async function run() {
  return makeSkippedResult(
    "niah",
    "SKIPPED: 需要 LLM_API_KEY 且 bench/harness.ts 需编译（当前 harness.js 不存在 / tsx 未安装）。" +
      " 接入步骤：① pnpm add -D tsx 或将 harness 纳入 tsconfig include；② 配置 LLM_API_KEY/LLM_BASE_URL/LLM_MODEL；" +
      " ③ 在 run.ts 中调用 runNIAHSingle 等并映射为 BenchResult。",
  );
}
