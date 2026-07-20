// @structfocus/context — 社区标准对齐验收测试运行入口 (128K 级)
//
// 环境变量：
//   LLM_BASE_URL  LLM_API_KEY  LLM_MODEL
//
// 推荐：阿里百炼 qwen-plus (131K 上下文，最便宜的长上下文模型)
//   $env:LLM_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode"
//   $env:LLM_API_KEY="sk-xxx"
//   $env:LLM_MODEL="qwen-plus"
//
// 也支持 qwen-max/qwen-turbo/DeepSeek/智谱 等 OpenAI 兼容 API。

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callLLM, checkNIAH, runNIAHSingle, runLongMemSingle, runDocQA, generateLargeDoc, injectAnswerAt, formatNIAHReport, formatSummaryReport, estimateTokens, type LLMConfig, type NIAHPair, type NIAHResults, type LongMemSession } from "./harness.js";

// ═══════════════════════════════════════════════════════════
// 配置检测
// ═══════════════════════════════════════════════════════════

function detectConfig(): LLMConfig | null {
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL) {
    return { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
  }
  if (process.env.DASHSCOPE_API_KEY) {
    return { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode", apiKey: process.env.DASHSCOPE_API_KEY, model: "qwen-plus" };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return { baseUrl: "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY, model: "deepseek-chat" };
  }
  return null;
}

function costEstimate(config: LLMConfig, inputTokens: number, outputTokens: number): string {
  return `≈ ${((inputTokens + outputTokens) / 1_000_000 * 2).toFixed(4)} CNY (est)`;
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

async function main() {
  const cfg = detectConfig();
  if (!cfg) {
    console.log("=".repeat(60));
    console.log("  LLM_API_KEY / LLM_BASE_URL / LLM_MODEL not set.");
    console.log("");
    console.log("  Recommended (Alibaba Bailian qwen-plus 131K ctx):");
    console.log('  $env:LLM_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode"');
    console.log('  $env:LLM_API_KEY="sk-xxx"');
    console.log('  $env:LLM_MODEL="qwen-plus"');
    console.log("=".repeat(60));
    return;
  }

  console.log(`🚀 Model: ${cfg.model} @ ${cfg.baseUrl}`);
  console.log("");

  // Track token usage for cost
  let totalInput = 0;
  let totalOutput = 0;

  // ═══════════════════════════════════════════════════════
  // 题 1：NIAH — 12 格热力图 (4 lengths × 3 depths)
  // ═══════════════════════════════════════════════════════

  console.log("=".repeat(60));
  console.log("Test 1: Needle-in-Haystack (gkamradt NIAH) — 12-cell grid");
  console.log("=".repeat(60));

  // qwen3-max (non-thinking) = 65K context window
  const MAX_WINDOW = 65_000;

  const GRID: NIAHPair[] = [
    // 4K (50 steps)  × 3 depths
    { depth: 0.0, noiseSteps: 50, depthLabel: "Start (0%)", lengthLabel: "4K", approxTokens: 4 },
    { depth: 0.5, noiseSteps: 50, depthLabel: "Middle (50%)", lengthLabel: "4K", approxTokens: 4 },
    { depth: 1.0, noiseSteps: 50, depthLabel: "End (100%)", lengthLabel: "4K", approxTokens: 4 },
    // 16K (200 steps) × 3 depths
    { depth: 0.0, noiseSteps: 200, depthLabel: "Start (0%)", lengthLabel: "16K", approxTokens: 16 },
    { depth: 0.5, noiseSteps: 200, depthLabel: "Middle (50%)", lengthLabel: "16K", approxTokens: 16 },
    { depth: 1.0, noiseSteps: 200, depthLabel: "End (100%)", lengthLabel: "16K", approxTokens: 16 },
    // 32K (400 steps) × 3 depths
    { depth: 0.0, noiseSteps: 400, depthLabel: "Start (0%)", lengthLabel: "32K", approxTokens: 32 },
    { depth: 0.5, noiseSteps: 400, depthLabel: "Middle (50%)", lengthLabel: "32K", approxTokens: 32 },
    { depth: 1.0, noiseSteps: 400, depthLabel: "End (100%)", lengthLabel: "32K", approxTokens: 32 },
    // 64K (800 steps) × 3 depths — close to max window
    { depth: 0.0, noiseSteps: 800, depthLabel: "Start (0%)", lengthLabel: "64K", approxTokens: 64 },
    { depth: 0.5, noiseSteps: 800, depthLabel: "Middle (50%)", lengthLabel: "64K", approxTokens: 64 },
    { depth: 1.0, noiseSteps: 800, depthLabel: "End (100%)", lengthLabel: "64K", approxTokens: 64 },
  ];

  const niahResults: NIAHResults = { pairs: GRID, results: [] };

  for (const pair of GRID) {
    const needleSet = (GRID.indexOf(pair) % 3) + 1;
    const result = runNIAHSingle(pair.noiseSteps, pair.depth, needleSet, MAX_WINDOW);

    const tag = `${pair.lengthLabel} × ${pair.depthLabel}`;
    process.stdout.write(`  ${tag.padEnd(22)}`);

    const baseAnswer = await callLLM(cfg, result.baseline.messages, 200);
    totalInput += estimateTokens(result.baseline.messages.map((m) => m.content).join(" "));
    totalOutput += estimateTokens(baseAnswer);
    // GLM API 限流间隔
    await new Promise((r) => setTimeout(r, 1500));

    const managedAnswer = await callLLM(cfg, result.managed.messages, 200);
    totalInput += estimateTokens(
      result.managed.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" "),
    );
    totalOutput += estimateTokens(managedAnswer);

    const baseCorrect = checkNIAH(baseAnswer, result.groundTruth.answer);
    const managedCorrect = checkNIAH(managedAnswer, result.groundTruth.answer);

    let icon = "";
    if (!baseCorrect && managedCorrect) icon = "🏆 WIN";
    else if (baseCorrect && !managedCorrect) icon = "⚠️ REGRESSION";
    else if (baseCorrect && managedCorrect) icon = "✅";
    else icon = "❌ BOTH MISS";

    const gap = " ".repeat(Math.max(0, 8 - tag.length));
    console.log(
      `${icon}${gap} BL:${baseCorrect ? "✓" : "✗"} CM:${managedCorrect ? "✓" : "✗"} (downgraded:${result.managed.stats.downgraded} use:${result.managed.stats.usePercent}%)`,
    );

    niahResults.results.push({
      baseline: { answer: baseAnswer, correct: baseCorrect },
      managed: { answer: managedAnswer, correct: managedCorrect },
    });
  }

  const baseNiahOk = niahResults.results.filter((r) => r.baseline.correct).length;
  const mgrNiahOk = niahResults.results.filter((r) => r.managed.correct).length;
  console.log(`\n  NIAH Summary: Baseline ${baseNiahOk}/12 → CM ${mgrNiahOk}/12`);
  console.log("");

  // ═══════════════════════════════════════════════════════
  // 题 2：LongMemEval — 10 段会话 + 大量噪音
  // ═══════════════════════════════════════════════════════

  console.log("=".repeat(60));
  console.log("Test 2: LongMemEval (Cross-Session Memory) — 10 sessions");
  console.log("=".repeat(60));

  // 生成噪音对话
  function makeNoise(n: number): string[] {
    const qs = [
      "帮我看看我的订单状态。",
      "今天天气怎么样？",
      "能推荐一本编程书吗？",
      "Python 的 list comprehension 怎么用？",
      "帮我查一下快递单号 SF1234567890。",
      "这个月信用卡账单出来了吗？",
      "React 和 Vue 有什么区别？",
      "怎么配置 Nginx 反向代理？",
      "帮我把这段代码 review 一下。",
      "有没有好用的 JSON 格式化工具？",
    ];
    const as = [
      "订单 #1234 已发货，预计 7 月 20 日到达。",
      "今天多云，28°C，湿度 65%。",
      "推荐《设计数据密集型应用》(DDIA)，豆瓣 9.2 分。",
      "基本语法：[x for x in range(10) if x % 2 == 0]。",
      "快递当前在杭州中转站，预计明天派送。",
      "本月账单 ¥3,847.50，还款日 7 月 25 日。",
      "React 是 UI 库，Vue 是渐进式框架。React 用 JSX，Vue 用模板。",
      "在 nginx.conf 中配置 location /api { proxy_pass http://backend:3000; }。",
      "代码整体不错，建议把 fetchUser 拆成更小的函数，考虑加缓存层。",
      "推荐 jsonformatter.org 或者 VSCode 插件 Prettify JSON。",
    ];
    const result: string[] = [];
    for (let i = 0; i < n; i++) {
      result.push(qs[i % qs.length]!);
      result.push(as[i % as.length]!);
    }
    return result;
  }

  const longMemSessions: LongMemSession[] = [
    {
      sessionId: 1,
      facts: [
        { content: "项目 A 的生产数据库名为 'payroll_prod_v3'，运行在 PostgreSQL 14 上。", tags: ["project-A", "database"] },
        { content: "API key 必须存储在环境变量 SECRET_API_KEY 中，禁止硬编码。", tags: ["security", "policy"] },
      ],
      noise: makeNoise(8),
    },
    {
      sessionId: 2,
      facts: [
        { content: "项目 A 从 PostgreSQL 14 升级到 PostgreSQL 16，升级窗口为 7 月 20 日凌晨 2:00-4:00。", tags: ["project-A", "database", "upgrade"] },
      ],
      noise: makeNoise(6),
    },
    {
      sessionId: 3,
      facts: [
        { content: "CI/CD 流水线从 Jenkins 迁移到 GitHub Actions，新流水线配置文件在 .github/workflows/deploy.yml。", tags: ["project-A", "ci-cd"] },
      ],
      noise: makeNoise(10),
    },
    {
      sessionId: 4,
      facts: [
        { content: "安全审计发现 SQL 注入漏洞 3 处（高危），XSS 漏洞 5 处（中危），修复截止日期 2026-08-15。", tags: ["security", "audit"] },
      ],
      noise: makeNoise(4),
    },
    {
      sessionId: 5,
      facts: [
        { content: "项目 A 新增 Redis 缓存层，缓存策略为 Write-Through，Redis 版本 7.2。", tags: ["project-A", "cache"] },
      ],
      noise: makeNoise(8),
    },
    {
      sessionId: 6,
      facts: [
        { content: "安全策略更新 v2：所有 API key 需每 90 天轮换一次，轮换脚本位于 scripts/rotate_keys.sh。", tags: ["security", "policy"] },
      ],
      noise: makeNoise(6),
    },
    {
      sessionId: 7,
      facts: [
        { content: "项目 A 的 Redis 缓存命中率目标为 95%，当前生产环境命中率为 91.3%。", tags: ["project-A", "cache", "performance"] },
      ],
      noise: makeNoise(10),
    },
    {
      sessionId: 8,
      facts: [
        { content: "生产环境部署在阿里云杭州 Region，Kubernetes v1.28，3 个 AZ 部署。", tags: ["project-A", "infra"] },
      ],
      noise: makeNoise(4),
    },
    {
      sessionId: 9,
      facts: [
        { content: "安全审计复检：所有高危漏洞已修复，中危漏洞剩余 2 处 XSS 待修，新截止日期 2026-09-01。", tags: ["security", "audit"] },
      ],
      noise: makeNoise(8),
    },
    {
      sessionId: 10,
      facts: [
        { content: "项目 A Q3 目标：服务 SLA 从 99.5% 提升至 99.9%，缓存命中率从 91.3% 提升至 95%。", tags: ["project-A", "planning"] },
      ],
      noise: makeNoise(6),
    },
  ];

  const longMemQuestion =
    "请全面回答以下问题（如果不知道就说不知道）：\n" +
    "1. 项目 A 的生产数据库名称是什么？\n" +
    "2. 项目 A 的数据库从什么版本升级到什么版本？\n" +
    "3. 项目 A 的 CI/CD 平台是什么？\n" +
    "4. 安全审计发现了几处高危漏洞？\n" +
    "5. API key 轮换策略是什么？\n" +
    "6. 项目 A 的 Redis 缓存策略是什么？";

  process.stdout.write("  Running (10 sessions)... ");
  const longMem = await runLongMemSingle(longMemSessions, longMemQuestion, MAX_WINDOW);

  const baseLongMemAnswer = await callLLM(cfg, longMem.baseline.messages, 500);
  totalInput += estimateTokens(longMem.baseline.messages.map((m) => m.content).join(" "));
  totalOutput += estimateTokens(baseLongMemAnswer);

  const managedLongMemAnswer = await callLLM(cfg, longMem.managed.messages, 500);
  totalInput += estimateTokens(
    longMem.managed.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" "),
  );
  totalOutput += estimateTokens(managedLongMemAnswer);

  console.log("done");
  console.log(`  Recalled facts from memory: ${longMem.managed.recalledCount}`);
  console.log(`  Baseline:  ${baseLongMemAnswer.slice(0, 250)}...`);
  console.log(`  CM:        ${managedLongMemAnswer.slice(0, 250)}...`);
  console.log("");

  // ═══════════════════════════════════════════════════════
  // 题 3：MemGPT 超窗口文档 — 230K chars (~66K tokens, just over 65K window)
  // ═══════════════════════════════════════════════════════

  console.log("=".repeat(60));
  console.log("Test 3: MemGPT Document QA (230K chars over-window)");
  console.log("=".repeat(60));

  const answerText = `\n\n=== PRODUCT PRICING UPDATE — EFFECTIVE 2026-07-01 ===\n\nEnterprise Edition annual fee adjusted from ¥99,800 to ¥129,800.\nTeam Edition annual fee adjusted from ¥19,800 to ¥24,800.\nFree tier remains at 5 users.\nContact: sales@example.com for questions.\nKey verification code for this notice: PRC-2026-Q3-88421.\n\n=== END OF NOTICE ===\n\n`;

  // 230K chars ≈ 65K tokens, 答案在 70% 深度 (~160K chars ≈ 45K tokens 处)
  let largeDoc = generateLargeDoc(230_000);
  const answerPos = Math.floor(largeDoc.length * 0.7);
  largeDoc = injectAnswerAt(largeDoc, answerText, answerPos);

  const docQuestion = "Enterprise Edition 的年费调整后是多少？请直接给出金额。如果你不知道，请说你不知道。";
  const docQA = runDocQA(largeDoc, docQuestion, MAX_WINDOW);

  console.log(`  Document: ${(largeDoc.length / 1000).toFixed(0)}K chars (~${Math.round(largeDoc.length / 3.5 / 1000)}K tokens)`);
  console.log(`  Answer at: ${((answerPos / largeDoc.length) * 100).toFixed(0)}% depth (≈${Math.round(answerPos / 3.5 / 1000)}K tokens)`);
  console.log(`  Baseline window: ${(docQA.baseline.tokens / 1000).toFixed(1)}K tokens (last ${Math.round(docQA.baseline.tokens / estimateTokens(largeDoc) * 100)}% of doc)`);
  console.log(`  CM downgraded: ${docQA.managed.downgraded}, window: ${docQA.managed.usePercent}%`);
  process.stdout.write("  Requesting LLM... ");

  const baseDocAnswer = await callLLM(cfg, [{ role: "user", content: docQA.baseline.content + "\n\n" + docQuestion }], 200);
  totalInput += docQA.baseline.tokens;
  totalOutput += estimateTokens(baseDocAnswer);

  const managedDocAnswer = await callLLM(cfg, docQA.managed.messages, 200);
  totalInput += docQA.managed.tokens;
  totalOutput += estimateTokens(managedDocAnswer);

  console.log("done");
  console.log(`  Baseline:  ${baseDocAnswer.slice(0, 200)}`);
  console.log(`  CM:        ${managedDocAnswer.slice(0, 200)}`);
  console.log("");

  // ═══════════════════════════════════════════════════════
  // 报告
  // ═══════════════════════════════════════════════════════

  const cost = costEstimate(cfg, totalInput, totalOutput);
  const niahReport = formatNIAHReport(niahResults);
  const summaryReport = formatSummaryReport(
    niahResults,
    {
      sessions: longMemSessions.length,
      baselineAnswer: baseLongMemAnswer,
      managedAnswer: managedLongMemAnswer,
      recalledCount: longMem.managed.recalledCount,
    },
    {
      baselineAnswer: baseDocAnswer,
      managedAnswer: managedDocAnswer,
      downgraded: docQA.managed.downgraded,
      usePercent: docQA.managed.usePercent,
    },
    cost,
  );

  const fullReport = `${summaryReport}\n\n${niahReport}\n\n## Token Usage\n- Input:  ${totalInput.toLocaleString()}\n- Output: ${totalOutput.toLocaleString()}\n- Total:  ${(totalInput + totalOutput).toLocaleString()}\n- Cost:   ${cost}\n`;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, "LLM_REPORT.md");
  writeFileSync(outPath, fullReport, "utf-8");

  console.log("=".repeat(60));
  console.log(`  Done! Report: ${outPath}`);
  console.log(`  Cost: ${cost} (in: ${totalInput.toLocaleString()} out: ${totalOutput.toLocaleString()})`);
  console.log("=".repeat(60));
  console.log("");
  console.log(niahReport);
}

void main();
