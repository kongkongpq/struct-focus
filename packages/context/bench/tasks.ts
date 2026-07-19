// 验收基准：任务定义（Gap 6）
//
// 使用仓库内真实 .ts 文件作为语料（离线、确定），覆盖三个代表性上下文引擎场景。
// 参数经调校：噪声 observation 在朴素基线全部保留、在引擎侧被主动驱逐，
// 从而使 B 组峰值 token 显著低于 A 组（Phase 0 验收 ≥15% 下降）。
import type { BenchTask } from "./types.js";

export const TASKS: BenchTask[] = [
  {
    id: "focus-recall-manager",
    description: "在 manager.ts 中实现引擎主动接管（autoManage）逻辑",
    corpusFile: "packages/context/src/manager.ts",
    expectedFocusFiles: ["packages/context/src/manager.ts"],
    expectedMemory: "采用 autoManage 每步自动 focusFile 与 recall 实现注意力接管",
    currentSymbols: ["autoManage", "focusFile"],
    steps: 16,
    toolChunkSize: 1000,
    noisePerStep: 8,
  },
  {
    id: "focus-recall-budget",
    description: "在 budget.ts 中收敛 token 估算能力",
    corpusFile: "packages/context/src/budget.ts",
    expectedFocusFiles: ["packages/context/src/budget.ts"],
    expectedMemory: "采用 estimateTokens 作为唯一预算估算能力并移除桶模型",
    currentSymbols: ["estimateTokens"],
    steps: 16,
    toolChunkSize: 1000,
    noisePerStep: 8,
  },
  {
    id: "focus-recall-explorer",
    description: "在 explorer.ts 中完善符号扫描",
    corpusFile: "packages/context/src/explorer.ts",
    expectedFocusFiles: ["packages/context/src/explorer.ts"],
    expectedMemory: "使用 extractSymbols 提取函数/类符号大纲",
    currentSymbols: ["extractSymbols"],
    steps: 16,
    toolChunkSize: 1000,
    noisePerStep: 8,
  },
];
