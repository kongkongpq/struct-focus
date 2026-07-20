// @struct/context — 验收测试运行入口
//
// 用法：
//   npx tsx packages/context/bench/run-llm.ts
//
// 需要配置环境变量（三选一，国内都能用）：
//   DEEPSEEK_API_KEY=sk-xxx
//   或
//   ZHIPU_API_KEY=xxx
//   或
//   MOONSHOT_API_KEY=sk-xxx
//
// 无 SDK 依赖，纯 fetch + typescript。

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  callLLM,
  runNeedleTask,
  runConsistencyTask,
  runEfficiencyTask,
  formatLLMTestReport,
  type LLMConfig,
  type LLMMessage,
} from "./llm-harness.js";

// ─── 自动检测 API ─────────────────────────────────────────

function detectConfig(): LLMConfig | null {
  // 按优先级：DeepSeek > 智谱 > Moonshot
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      baseUrl: "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: "deepseek-chat",
    };
  }
  if (process.env.ZHIPU_API_KEY) {
    return {
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: process.env.ZHIPU_API_KEY,
      model: "glm-4-flash",   // 免费/便宜
    };
  }
  if (process.env.MOONSHOT_API_KEY) {
    return {
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: process.env.MOONSHOT_API_KEY,
      model: "moonshot-v1-8k",
    };
  }
  return null;
}

function estimateTokens(texts: string[]): number {
  let total = 0;
  for (const t of texts) {
    total += Math.ceil(t.length / 3.5);  // 中文加权
  }
  return total;
}

function costRMB(config: LLMConfig, inputTokens: number, outputTokens: number): string {
  if (config.baseUrl.includes("deepseek")) {
    // DeepSeek: ¥1/1M input, ¥2/1M output
    const rmb = (inputTokens / 1_000_000) * 1 + (outputTokens / 1_000_000) * 2;
    return `≈ ¥${rmb.toFixed(4)} (DeepSeek)`;
  }
  if (config.baseUrl.includes("bigmodel")) {
    // 智谱 GLM-4-Flash 免费
    return "免费（智谱 GLM-4-Flash）";
  }
  if (config.baseUrl.includes("moonshot")) {
    // Moonshot: ¥12/1M tokens
    const rmb = ((inputTokens + outputTokens) / 1_000_000) * 12;
    return `≈ ¥${rmb.toFixed(4)} (Moonshot)`;
  }
  return "未知";
}

// ─── 主流程 ────────────────────────────────────────────────

async function main() {
  const config = detectConfig();

  if (!config) {
    console.log("=".repeat(60));
    console.log("  需要 API Key，请设置以下环境变量之一：");
    console.log("");
    console.log("  $env:DEEPSEEK_API_KEY=\"sk-xxx\"     (推荐，最便宜 ¥1/1M tokens)");
    console.log("  $env:ZHIPU_API_KEY=\"xxx\"           (智谱，GLM-4-Flash 免费)");
    console.log("  $env:MOONSHOT_API_KEY=\"sk-xxx\"     (月之暗面)");
    console.log("");
    console.log("  然后重新运行: npx tsx packages/context/bench/run-llm.ts");
    console.log("=".repeat(60));
    return;
  }

  console.log(`🚀 使用 ${config.model} @ ${config.baseUrl}`);
  console.log("");

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ═══════════════════════════════════════════════════════
  // 题 1：Needle-in-Haystack
  // ═══════════════════════════════════════════════════════

  console.log("─".repeat(50));
  console.log("题 1：Needle-in-Haystack（大海捞针）");
  console.log("─".repeat(50));

  const needleTask = {
    id: "needle-in-haystack",
    description: "你正在重构一个支付系统的数据库层，请依次处理各文件的修改。",
    needle: {
      content: "【重要】生产环境配置已更新：数据库连接串为 postgresql://db-prod.internal:5432/payroll_v3，数据库密码存放在 secrets/db-prod.yaml 文件中。请不要在任何日志中打印此连接串。",
      source: "docs/deployment-guide.md",
      step: 15,
    },
    question: "生产环境数据库的密码在哪个文件中？请直接给出文件名。如果你不知道，请说你不知道。",
    expectedAnswer: "db-prod.yaml",
    totalSteps: 40,
    noiseSteps: 39,
  };

  const needleResult = runNeedleTask(needleTask);
  console.log(`  朴素基线: ${needleResult.baseline.entries} 条 / ${needleResult.baseline.peakTokens} tokens / ${needleResult.baseline.messages.length} messages`);
  console.log(`  管理组:   ${needleResult.managed.entries} 条 / ${needleResult.managed.peakTokens} tokens / ${needleResult.managed.messages.length} messages`);

  // 调用 LLM
  console.log("  发送朴素基线到 LLM...");
  const needleBaseAnswer = await callLLM(config, needleResult.baseline.messages as LLMMessage[]);
  totalInputTokens += estimateTokens(needleResult.baseline.messages.map(m => m.content));
  totalOutputTokens += estimateTokens([needleBaseAnswer]);
  console.log(`  朴素基线回答: "${needleBaseAnswer.slice(0, 150)}"`);

  console.log("  发送 StructAgent 到 LLM...");
  const needleManagedAnswer = await callLLM(config, needleResult.managed.messages as LLMMessage[]);
  totalInputTokens += estimateTokens(needleResult.managed.messages.map(m => m.content));
  totalOutputTokens += estimateTokens([needleManagedAnswer]);
  console.log(`  StructAgent回答: "${needleManagedAnswer.slice(0, 150)}"`);

  const needleWin = needleBaseAnswer.includes(needleTask.expectedAnswer) !== needleManagedAnswer.includes(needleTask.expectedAnswer);
  console.log(`  结果: ${needleWin ? (needleManagedAnswer.includes(needleTask.expectedAnswer) ? "🏆 StructAgent 胜" : "⚠️ 朴素胜") : "🤝 平局"}`);
  console.log("");

  // ═══════════════════════════════════════════════════════
  // 题 2：跨文件决策一致性
  // ═══════════════════════════════════════════════════════

  console.log("─".repeat(50));
  console.log("题 2：跨文件决策一致性");
  console.log("─".repeat(50));

  const consistencyTask = {
    id: "cross-file-consistency",
    description: "你需要为一个 Node.js 后端项目实现 JWT 认证系统。请依次处理 auth.ts、token.ts、api.ts 三个文件。",
    steps: [
      {
        step: 1,
        file: "src/auth.ts",
        content: "你正在修改 src/auth.ts。决定：JWT access token 有效期 15 分钟，refresh token 有效期 7 天。用户登录后 access token 存入 Redis (key: `session:{userId}`)，refresh token 存入数据库 `refresh_tokens` 表。",
        question: "access token 和 refresh token 分别存在哪里？",
        expectedAnswer: "Redis",
      },
      {
        step: 6,
        file: "src/token.ts",
        content: "你正在修改 src/token.ts。实现 `refreshAccessToken()` 函数：从数据库 `refresh_tokens` 表读取 refresh token，校验后生成新 access token（15分钟），同时轮转 refresh token（旧 token 标记为 used，生成新的 7 天有效 token 写入 `refresh_tokens` 表）。",
      },
      {
        step: 11,
        file: "src/api.ts",
        content: "你正在修改 src/api.ts。添加认证中间件 `authMiddleware()`：从请求头 Bearer token 提取 access token → 查 Redis `session:{userId}` 校验 → 通过后放行。如果 access token 过期，返回 401 并提示客户端用 refresh token 换新。注意：不要绕过 Redis 直接查数据库。",
      },
    ],
  };

  const consistencyResult = runConsistencyTask(consistencyTask);
  console.log(`  朴素基线: ${consistencyResult.baseline.entries} 条 / ${consistencyResult.baseline.peakTokens} tokens`);
  console.log(`  管理组:   ${consistencyResult.managed.entries} 条 / ${consistencyResult.managed.peakTokens} tokens`);

  console.log("  发送朴素基线到 LLM...");
  const consBaseAnswer = await callLLM(config, consistencyResult.baseline.messages as LLMMessage[]);
  totalInputTokens += estimateTokens(consistencyResult.baseline.messages.map(m => m.content));
  totalOutputTokens += estimateTokens([consBaseAnswer]);
  console.log(`  朴素基线: "${consBaseAnswer.slice(0, 200)}"`);

  console.log("  发送 StructAgent 到 LLM...");
  const consManagedAnswer = await callLLM(config, consistencyResult.managed.messages as LLMMessage[]);
  totalInputTokens += estimateTokens(consistencyResult.managed.messages.map(m => m.content));
  totalOutputTokens += estimateTokens([consManagedAnswer]);
  console.log(`  StructAgent: "${consManagedAnswer.slice(0, 200)}"`);
  console.log("");

  // ═══════════════════════════════════════════════════════
  // 题 3：Token 效率
  // ═══════════════════════════════════════════════════════

  console.log("─".repeat(50));
  console.log("题 3：Token 效率");
  console.log("─".repeat(50));

  const efficiencyTask = {
    id: "token-efficiency",
    description: "分析并修复 src/utils/ 目录下的性能问题",
    steps: 30,
    toolChunkSize: 800,
    noisePerStep: 6,
    expectedFocusFiles: ["src/utils/perf.ts", "src/utils/cache.ts"],
  };

  const efficiencyResult = runEfficiencyTask(efficiencyTask);
  const eDrop = ((1 - efficiencyResult.managed.peakTokens / efficiencyResult.baseline.peakTokens) * 100).toFixed(1);
  console.log(`  朴素峰值: ${efficiencyResult.baseline.peakTokens} tokens`);
  console.log(`  管理峰值: ${efficiencyResult.managed.peakTokens} tokens`);
  console.log(`  峰值下降: ${eDrop}%`);
  console.log(`  驱逐条目: ${efficiencyResult.managed.evictedCount}`);
  console.log(`  压缩条目: ${efficiencyResult.managed.compressedCount}`);
  console.log("");

  // ═══════════════════════════════════════════════════════
  // 报告
  // ═══════════════════════════════════════════════════════

  const report = formatLLMTestReport(needleResult, consistencyResult, efficiencyResult, {
    needle: { baseline: needleBaseAnswer, managed: needleManagedAnswer },
    consistency: { baseline: consBaseAnswer, managed: consManagedAnswer },
  });

  // 追加费用信息
  const cost = costRMB(config, totalInputTokens, totalOutputTokens);
  const reportWithCost = report + `\n## 费用\n\n- 总输入 Token（估算）：${totalInputTokens.toLocaleString()}\n- 总输出 Token（估算）：${totalOutputTokens.toLocaleString()}\n- 费用：${cost}\n`;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, "LLM_REPORT.md");
  writeFileSync(outPath, reportWithCost, "utf-8");

  console.log("═".repeat(60));
  console.log("  验收测试完成！");
  console.log(`  总费用：${cost}`);
  console.log(`  报告：${outPath}`);
  console.log("═".repeat(60));
  console.log("");
  console.log(reportWithCost);
}

void main();
