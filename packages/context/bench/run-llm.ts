// @structfocus/context — 多模型验收基准（四模型矩阵对比）
//
// 用法：
//   npx tsx packages/context/bench/run-llm.ts
//
// 设置你想跑的模型对应的 API Key（可同时设多个，会逐个跑并出对比表）：
//   ZHIPU_API_KEY=xxx          → GLM-4-Flash（智谱，免费）
//   DEEPSEEK_API_KEY=sk-xxx    → DeepSeek-Chat（最便宜 ¥1/1M）
//   DASHSCOPE_API_KEY=sk-xxx   → 通义千问 qwen-plus（131K 上下文；可用 QWEN_MODEL 覆盖）
//   OPENAI_API_KEY=sk-xxx      → GPT-4o-mini
//
// 也可用统一变量显式指定单模型（优先级最高）：
//   STRUCT_LLM_API_KEY=xxx STRUCT_LLM_BASE_URL=https://api.openai.com/v1 STRUCT_LLM_MODEL=gpt-4o-mini
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

// ─── 模型预设（按 Key 环境变量自动探测）─────────────────

interface ModelPreset {
  name: string;
  envKey: string;
  baseUrl: string;
  model: string;
  modelEnv?: string; // 可选：用环境变量覆盖模型名
}

const MODEL_PRESETS: ModelPreset[] = [
  { name: "GLM-4-Flash (智谱)", envKey: "ZHIPU_API_KEY", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { name: "DeepSeek-Chat", envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { name: "Qwen-Plus (通义千问)", envKey: "DASHSCOPE_API_KEY", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", modelEnv: "QWEN_MODEL" },
  { name: "GPT-4o-mini (OpenAI)", envKey: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
];

function detectConfigs(): LLMConfig[] {
  const configs: LLMConfig[] = [];

  // 统一显式覆盖优先
  if (process.env.STRUCT_LLM_API_KEY) {
    configs.push({
      baseUrl: process.env.STRUCT_LLM_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.STRUCT_LLM_API_KEY,
      model: process.env.STRUCT_LLM_MODEL ?? "gpt-4o-mini",
    });
  }

  for (const p of MODEL_PRESETS) {
    const key = process.env[p.envKey];
    if (key) {
      configs.push({
        baseUrl: p.baseUrl,
        apiKey: key,
        model: p.modelEnv ? (process.env[p.modelEnv] ?? p.model) : p.model,
      });
    }
  }
  return configs;
}

function estimateTokens(texts: string[]): number {
  let total = 0;
  for (const t of texts) total += Math.ceil(t.length / 3.5); // 中文加权
  return total;
}

function costRMB(config: LLMConfig, inputTokens: number, outputTokens: number): string {
  const u = config.baseUrl;
  if (u.includes("deepseek")) return `≈ ¥${((inputTokens / 1e6) * 1 + (outputTokens / 1e6) * 2).toFixed(4)} (DeepSeek)`;
  if (u.includes("bigmodel")) return "免费（智谱 GLM-4-Flash）";
  if (u.includes("dashscope")) return `≈ ¥${((inputTokens / 1e6) * 0.8 + (outputTokens / 1e6) * 2).toFixed(4)} (Qwen)`;
  if (u.includes("openai")) return `≈ $${((inputTokens / 1e6) * 0.15 + (outputTokens / 1e6) * 0.6).toFixed(4)} (OpenAI)`;
  return "未知";
}

// ─── 题面（三题固定，所有模型共用，保证可比）────────────

const NEEDLE_TASK = {
  id: "needle-in-haystack",
  description: "你正在重构一个支付系统的数据库层，请依次处理各文件的修改。",
  needle: {
    content: "【重要】生产环境配置已更新：数据库连接串为 postgresql://db-prod.internal:5432/payroll_v3，数据库密码存放在 secrets/db-prod.yaml 文件中。请不要在任何日志中打印此连接串。",
    source: "synthetic benchmark fixture",
    step: 15,
  },
  question: "生产环境数据库的密码在哪个文件中？请直接给出文件名。如果你不知道，请说你不知道。",
  expectedAnswer: "db-prod.yaml",
  totalSteps: 40,
  noiseSteps: 39,
};

const CONSISTENCY_TASK = {
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

const EFFICIENCY_TASK = {
  id: "token-efficiency",
  description: "分析并修复 src/utils/ 目录下的性能问题",
  steps: 30,
  toolChunkSize: 800,
  noisePerStep: 6,
  expectedFocusFiles: ["src/utils/perf.ts", "src/utils/cache.ts"],
};

// ─── 单个模型跑全部题 ─────────────────────────────────

interface ModelRow {
  config: LLMConfig;
  needle: { baseline: string; managed: string; baseOk: boolean; mgrOk: boolean; tag: string };
  consistency: { baseline: string; managed: string };
  efficiency: { baselinePeak: number; managedPeak: number; dropPct: string; evicted: number; compressed: number };
  cost: string;
}

async function runModel(config: LLMConfig): Promise<ModelRow> {
  const label = `${config.model} @ ${config.baseUrl}`;
  console.log(`\n🚀 模型: ${label}`);
  let totalInput = 0;
  let totalOutput = 0;

  // 题 1：Needle-in-Haystack
  const needleResult = await runNeedleTask(NEEDLE_TASK);
  console.log("  题1 发送朴素基线...");
  const needleBaseAnswer = await callLLM(config, needleResult.baseline.messages as LLMMessage[]);
  totalInput += estimateTokens(needleResult.baseline.messages.map((m) => m.content));
  totalOutput += estimateTokens([needleBaseAnswer]);
  console.log("  题1 发送 StructFocus...");
  const needleManagedAnswer = await callLLM(config, needleResult.managed.messages as LLMMessage[]);
  totalInput += estimateTokens(needleResult.managed.messages.map((m) => m.content));
  totalOutput += estimateTokens([needleManagedAnswer]);
  const baseOk = needleBaseAnswer.includes(NEEDLE_TASK.expectedAnswer);
  const mgrOk = needleManagedAnswer.includes(NEEDLE_TASK.expectedAnswer);
  let tag = "🤝 平局";
  if (baseOk !== mgrOk) tag = mgrOk ? "🏆 StructFocus 胜" : "⚠️ 朴素胜";
  console.log(`  题1: ${tag}`);

  // 题 2：跨文件一致性
  const consistencyResult = runConsistencyTask(CONSISTENCY_TASK);
  console.log("  题2 发送朴素基线...");
  const consBaseAnswer = await callLLM(config, consistencyResult.baseline.messages as LLMMessage[]);
  totalInput += estimateTokens(consistencyResult.baseline.messages.map((m) => m.content));
  totalOutput += estimateTokens([consBaseAnswer]);
  console.log("  题2 发送 StructFocus...");
  const consManagedAnswer = await callLLM(config, consistencyResult.managed.messages as LLMMessage[]);
  totalInput += estimateTokens(consistencyResult.managed.messages.map((m) => m.content));
  totalOutput += estimateTokens([consManagedAnswer]);

  // 题 3：Token 效率
  const efficiencyResult = runEfficiencyTask(EFFICIENCY_TASK);
  const dropPct = ((1 - efficiencyResult.managed.peakTokens / efficiencyResult.baseline.peakTokens) * 100).toFixed(1);
  console.log(`  题3: 峰值下降 ${dropPct}%`);

  return {
    config,
    needle: { baseline: needleBaseAnswer, managed: needleManagedAnswer, baseOk, mgrOk, tag },
    consistency: { baseline: consBaseAnswer, managed: consManagedAnswer },
    efficiency: {
      baselinePeak: efficiencyResult.baseline.peakTokens,
      managedPeak: efficiencyResult.managed.peakTokens,
      dropPct,
      evicted: efficiencyResult.managed.evictedCount,
      compressed: efficiencyResult.managed.compressedCount,
    },
    cost: costRMB(config, totalInput, totalOutput),
  };
}

// ─── 矩阵报告 ─────────────────────────────────────────

function formatMatrix(rows: ModelRow[]): string {
  const lines: string[] = [];
  lines.push("# StructFocus 多模型验收基准矩阵");
  lines.push(`> ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## 横向对比表");
  lines.push("");
  lines.push("| 模型 | Needle 基线 | Needle StructFocus | 题1 结果 | Token 峰值下降 | 费用 |");
  lines.push("| --- | ---: | ---: | --- | ---: | --- |");
  for (const r of rows) {
    const b = r.needle.baseOk ? "✅" : "❌";
    const m = r.needle.mgrOk ? "✅" : "❌";
    lines.push(
      `| ${r.config.model} | ${b} | ${m} | ${r.needle.tag} | ${r.efficiency.dropPct}% | ${r.cost} |`,
    );
  }
  lines.push("");
  lines.push("> 说明：三题题面固定，所有模型共用，保证可比。Needle 题考察「大海捞针」召回；Token 效率考察峰值压缩。");
  lines.push("> 若某模型 Needle 基线 ✅ 而 StructFocus ❌，通常是 StructFocus 把针压缩进了胶囊、召回时机偏晚，可结合 `conservative` 模式调优（见下方）。");
  lines.push("");

  for (const r of rows) {
    lines.push(`## ${r.config.model} @ ${r.config.baseUrl}`);
    lines.push("");
    lines.push(`- Needle 基线回答：${r.needle.baseline.slice(0, 200)}`);
    lines.push(`- Needle StructFocus：${r.needle.managed.slice(0, 200)}`);
    lines.push(`- 跨文件一致性 基线：${r.consistency.baseline.slice(0, 200)}`);
    lines.push(`- 跨文件一致性 StructFocus：${r.consistency.managed.slice(0, 200)}`);
    lines.push(`- Token 效率：基线峰值 ${r.efficiency.baselinePeak} → StructFocus 峰值 ${r.efficiency.managedPeak}（下降 ${r.efficiency.dropPct}%），驱逐 ${r.efficiency.evicted} / 压缩 ${r.efficiency.compressed}`);
    lines.push(`- 费用：${r.cost}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── 主流程 ─────────────────────────────────────────

async function main() {
  const configs = detectConfigs();

  if (configs.length === 0) {
    console.log("=".repeat(60));
    console.log("  需要至少一个模型的 API Key，可同时设多个（会逐个跑 + 出对比表）：");
    console.log("");
    console.log("  $env:ZHIPU_API_KEY=\"xxx\"          (智谱 GLM-4-Flash，免费)");
    console.log("  $env:DEEPSEEK_API_KEY=\"sk-xxx\"     (DeepSeek，最便宜 ¥1/1M)");
    console.log("  $env:DASHSCOPE_API_KEY=\"sk-xxx\"    (通义千问 qwen-plus)");
    console.log("  $env:OPENAI_API_KEY=\"sk-xxx\"       (GPT-4o-mini)");
    console.log("  或统一指定：$env:STRUCT_LLM_API_KEY=xxx STRUCT_LLM_MODEL=gpt-4o-mini");
    console.log("");
    console.log("  然后重新运行: npx tsx packages/context/bench/run-llm.ts");
    console.log("=".repeat(60));
    return;
  }

  console.log(`检测到 ${configs.length} 个模型，开始逐个跑验收基准...\n`);

  const rows: ModelRow[] = [];
  for (const cfg of configs) {
    const row = await runModel(cfg);
    rows.push(row);
    // 每个模型单独写一份详情报告（保持旧行为）
    const detail = formatLLMTestReport(
      // runModel 内部已调用过 task，这里复算一次纯消息结构以喂给 formatter
      runNeedleTask(NEEDLE_TASK),
      runConsistencyTask(CONSISTENCY_TASK),
      runEfficiencyTask(EFFICIENCY_TASK),
      { needle: { baseline: row.needle.baseline, managed: row.needle.managed }, consistency: { baseline: row.consistency.baseline, managed: row.consistency.managed } },
    );
    const __dirname = dirname(fileURLToPath(import.meta.url));
    writeFileSync(resolve(__dirname, `LLM_REPORT_${cfg.model.replace(/[^a-z0-9]/gi, "_")}.md`), detail + `\n## 费用\n\n- ${row.cost}\n`, "utf-8");
  }

  const matrix = formatMatrix(rows);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, "BENCHMARK_MATRIX.md");
  writeFileSync(outPath, matrix, "utf-8");

  console.log("═".repeat(60));
  console.log(`  多模型验收完成！共 ${rows.length} 个模型。`);
  console.log(`  对比矩阵：${outPath}`);
  console.log("═".repeat(60));
  console.log(matrix);
}

void main();
