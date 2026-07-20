// @structfocus/context — Benchmark 入口
//
// A/B/C 三线对照实验编排：生成对话 → 跑三线 → 评分 → 聚合 → 出报告。
//
// 用法：
//   npx tsx packages/context/benchmark/index.ts --smoke
//   npx tsx packages/context/benchmark/index.ts --full
//   npx tsx packages/context/benchmark/index.ts --rounds 40,80 --topics 4,8 --repeat 2
//   npx tsx packages/context/benchmark/index.ts --smoke --mock        # 强制离线确定性
//   npx tsx packages/context/benchmark/index.ts --smoke --sweep       # 额外扫话题位置
//
// LLM：默认自动探测 LLM_API_KEY / GLM_API_KEY / DASHSCOPE_API_KEY / DEEPSEEK_API_KEY。
//   未配置时回退到 --mock（确定性回退，不消耗额度，用于管线自检）。
//   真实回答可设置 GLM_API_KEY 等环境变量后直接运行。

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { BenchmarkConfig, RunResult, RunResultC, TrialRecord } from "./types.js";
import { TOPICS } from "./dataset/topics.js";
import { generateConversation, buildOrder } from "./dataset/generator.js";
import { runRaw } from "./runners/runner-a-raw.js";
import { runFIFO } from "./runners/runner-b-fifo.js";
import { runStruct } from "./runners/runner-c-struct.js";
import {
  createChatFn,
  detectLLMConfig,
  type ChatFn,
  type LLMConfig,
} from "./llm-provider.js";
import { aggregate, toQAResult } from "./metrics.js";
import { writeReports } from "./report.js";

// ─── 参数解析 ───────────────────────────────────────

interface CliArgs {
  mode: "smoke" | "full" | "custom";
  mock: boolean;
  sweep: boolean;
  rounds: number[];
  topics: number[];
  repeat: number;
  window: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const smoke = has("--smoke");
  const full = has("--full");
  const mock = has("--mock");
  const sweep = has("--sweep");

  const roundsRaw = get("--rounds");
  const topicsRaw = get("--topics");
  const repeatRaw = get("--repeat");
  const windowRaw = get("--window");

  if (smoke) {
    return {
      mode: "smoke",
      mock,
      sweep: sweep || mock, // smoke 默认扫话题（便宜）
      rounds: [160],
      topics: [8],
      repeat: 1,
      window: windowRaw ? Number(windowRaw) : 4000,
    };
  }
  if (full) {
    return {
      mode: "full",
      mock,
      sweep, // full 默认不扫（省真实额度），显式 --sweep 才扫
      rounds: [20, 40, 80, 160],
      topics: [4, 8, 12],
      repeat: repeatRaw ? Number(repeatRaw) : 3,
      window: windowRaw ? Number(windowRaw) : 4000,
    };
  }
  // custom
  return {
    mode: "custom",
    mock,
    sweep,
    rounds: roundsRaw ? roundsRaw.split(",").map(Number) : [20],
    topics: topicsRaw ? topicsRaw.split(",").map(Number) : [4],
    repeat: repeatRaw ? Number(repeatRaw) : 1,
    window: windowRaw ? Number(windowRaw) : 6000,
  };
}

// ─── 主流程 ───────────────────────────────────────

function makeTrial(
  cfg: BenchmarkConfig,
  order: number[],
  targetTopicIndex: number,
  question: string,
  keywords: string[],
  A: RunResult,
  B: RunResult,
  C: RunResultC,
): TrialRecord {
  return {
    config: cfg,
    topicOrder: order.map((i) => TOPICS[i]?.name ?? `t${i}`),
    targetTopicIndex,
    targetTopic: TOPICS[order[targetTopicIndex]!]?.name ?? `t${targetTopicIndex}`,
    finalQuestion: question,
    keywords,
    A: toQAResult("A", A, question, keywords),
    B: toQAResult("B", B, question, keywords),
    C: toQAResult("C", C, question, keywords, C.capsuleTokens, C.originalTokens),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = detectLLMConfig();
  const useMock = args.mock || !config;
  if (useMock && !args.mock && !config) {
    console.log("⚠️  未检测到 LLM API Key，自动回退到 --mock（确定性回退，不消耗额度）。");
    console.log("    配置 GLM_API_KEY / LLM_API_KEY 等环境变量可使用真实 LLM 回答。\n");
  }
  const chat: ChatFn = createChatFn(config as LLMConfig | null, useMock);
  const modelLabel = useMock ? "mock (确定性回退)" : (config as LLMConfig).model;
  const delayMs = useMock ? 0 : 800;

  const configs: BenchmarkConfig[] = [];
  for (const rounds of args.rounds) {
    for (const topics of args.topics) {
      configs.push({ rounds, topics, repeat: args.repeat });
    }
  }

  console.log("══════════════════════════════════════════════");
  console.log(` StructFocus Benchmark — ${args.mode.toUpperCase()}`);
  console.log(` LLM: ${modelLabel}`);
  console.log(` FIFO 窗口: ${args.window} tokens ｜ sweep: ${args.sweep ? "开" : "关"}`);
  console.log(` 配置数: ${configs.length} ｜ 矩阵: ${configs.map((c) => `${c.rounds}/${c.topics}×${c.repeat}`).join(", ")}`);
  console.log("══════════════════════════════════════════════\n");

  const trials: TrialRecord[] = [];
  let callCount = 0;

  const delay = (): Promise<void> =>
    delayMs > 0 ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve();

  for (const cfg of configs) {
    const order = buildOrder(cfg.topics);
    // 至少 2 轮/话题，保证最终提问（话题 0）的关键词在 A/B 线中也完整出现，
    // 不会被「轮数/话题数」向下取整到 1 轮而导致关键词缺失、拉低 A/B 基线。
    const roundsPerTopic = Math.max(2, Math.floor(cfg.rounds / cfg.topics));
    console.log(`▶ 配置 轮${cfg.rounds} × 话题${cfg.topics} (每话题 ${roundsPerTopic} 轮) × 重复${cfg.repeat}`);

    // 主实验：遗忘曲线（最终提问永远指向话题 0）
    for (let rep = 0; rep < cfg.repeat; rep++) {
      const gen = generateConversation(order, roundsPerTopic);
      const A = await runRaw(gen.messages, gen.finalQuestion, chat, TOPICS[0]!.name);
      callCount++;
      await delay();
      const B = await runFIFO(gen.messages, gen.finalQuestion, chat, TOPICS[0]!.name, args.window);
      callCount++;
      await delay();
      const C = await runStruct(gen.messages, gen.finalQuestion, gen.finalKeywords, chat, TOPICS[0]!.name);
      callCount++;
      await delay();
      trials.push(makeTrial(cfg, order, 0, gen.finalQuestion, gen.finalKeywords, A, B, C));
    }

    // 话题位置扫描（近端/中断/远端），仅 sweep 时
    if (args.sweep) {
      for (let t = 0; t < order.length; t++) {
        const targetTopic = TOPICS[order[t]!]!;
        const gen = generateConversation(order, roundsPerTopic);
        const A = await runRaw(gen.messages, targetTopic.qa.question, chat, targetTopic.name);
        callCount++;
        await delay();
        const B = await runFIFO(gen.messages, targetTopic.qa.question, chat, targetTopic.name, args.window);
        callCount++;
        await delay();
        const C = await runStruct(gen.messages, targetTopic.qa.question, targetTopic.qa.keywords, chat, targetTopic.name);
        callCount++;
        await delay();
        trials.push(makeTrial(cfg, order, t, targetTopic.qa.question, targetTopic.qa.keywords, A, B, C));
      }
    }
    console.log(`  ✓ 完成（累计 ${callCount} 次 LLM 调用）\n`);
  }

  // 聚合 + 报告
  const agg = aggregate(trials);
  const date = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const meta = {
    date: new Date().toLocaleString("zh-CN"),
    model: modelLabel,
    mode: args.mode,
    windowTokens: args.window,
    configs,
    sweep: args.sweep,
  };

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(__dirname, "results");
  const base = `${date}_${args.mode}`;
  const paths = writeReports(outDir, base, meta, agg, trials);

  console.log("══════════════════════════════════════════════");
  console.log(" 结果摘要：");
  console.log(`   A 召回率: ${(agg.lines.A.avgRecall * 100).toFixed(1)}%`);
  console.log(`   B 召回率: ${(agg.lines.B.avgRecall * 100).toFixed(1)}%`);
  console.log(`   C 召回率: ${(agg.lines.C.avgRecall * 100).toFixed(1)}%`);
  const comp = agg.avgCompression > 0 ? (1 - agg.avgCompression) * 100 : 0;
  console.log(`   C 压缩比: ${comp.toFixed(0)}% ｜ token 节省 vs A: ${agg.totalTokens.A > 0 ? ((1 - agg.totalTokens.C / agg.totalTokens.A) * 100).toFixed(0) : 0}%`);
  console.log("");
  console.log(` 报告: ${paths.md}`);
  console.log(` 数据: ${paths.json}`);
  console.log(` 表格: ${paths.csv}`);
  console.log("══════════════════════════════════════════════");
}

void main();
