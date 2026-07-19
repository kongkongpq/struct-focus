// @struct/context — Hardcore v2 Runner
// 750K DocQA + 30-segment temporal Multi-hop + 10-needle semantic-distractor NIAH
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as hc from "./hardcore.js";

async function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const RETRY_LLM = async (cfg: hc.LLMConfig, msgs: any[], mt: number, retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try { return await hc.callLLM(cfg, msgs, mt); }
    catch (e: any) {
      console.log(`  ⚠️ retry ${i + 1}/${retries}: ${e.message?.slice(0, 80)}`);
      if (i < retries - 1) await delay(8000 * (i + 1));
      else throw e;
    }
  }
  return "";
};

async function main() {
  const cfg: hc.LLMConfig | null = (() => {
    if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL) {
      return { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
    }
    return null;
  })();
  if (!cfg) { console.log("Set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL"); return; }

  console.log(`🚀 Model: ${cfg.model} @ ${cfg.baseUrl}`);
  const MAX_W = 128_000;
  let totalInput = 0, totalOutput = 0;

  // ═══════════════════════════════════════════════════
  // Test 1: NIAH 20-cell grid (preserved from v1, re-verify)
  // ═══════════════════════════════════════════════════
  console.log("=".repeat(60));
  console.log("Test 1: Hard NIAH — 20-cell grid + distractors");
  console.log("=".repeat(60));

  let baseOk = 0, mgrOk = 0, wins = 0;
  let cell = 0;

  for (const pair of hc.STANDARD_GRID) {
    cell++;
    const needleIdx = cell % 10; // rotate through 10 real needles
    const hasDist = cell % 2 === 0;
    const distIdx = hasDist ? (cell % 3) : undefined;

    const result = hc.runHardNIAHSingle(pair.noiseSteps, pair.depth, needleIdx, MAX_W, distIdx);
    const tag = `${pair.lengthLabel} ${pair.depthLabel}${hasDist ? " +SEM-DIST" : ""}`;
    process.stdout.write(`  ${tag.padEnd(28)}`);

    await delay(3000);
    const baseAns = await RETRY_LLM(cfg, result.baseline.messages, 200);
    totalInput += hc.estimateTokens(result.baseline.messages.map(m => m.content).join(" "));
    totalOutput += hc.estimateTokens(baseAns);

    await delay(3000);
    const mgrAns = await RETRY_LLM(cfg, result.managed.messages as any, 200);
    totalInput += result.managed.stats.tokens;
    totalOutput += hc.estimateTokens(mgrAns);

    const bOk = hc.checkHardNIAH(baseAns, result.groundTruth.answer);
    const mOk = hc.checkHardNIAH(mgrAns, result.groundTruth.answer);
    if (bOk) baseOk++; if (mOk) mgrOk++;

    // Also check if CM fell for distractor
    let extra = "";
    if (result.groundTruth.distractorAnswer && !bOk && !mOk) {
      const dOk = hc.checkHardNIAH(mgrAns, result.groundTruth.distractorAnswer);
      if (dOk) extra = " 💀DIST-TRAP";
    }

    let icon = "";
    if (!bOk && mOk) { icon = "🏆 WIN"; wins++; }
    else if (bOk && !mOk) icon = "⚠️ REGR";
    else if (bOk && mOk) icon = "✅";
    else icon = "❌";

    console.log(`${icon}${extra}  BL:${bOk ? "✓" : "✗"} CM:${mOk ? "✓" : "✗"} (ev:${result.managed.stats.evicted} use:${result.managed.stats.usePercent}%)`);
  }

  const totalN = hc.STANDARD_GRID.length;
  console.log(`\n  NIAH: BL ${baseOk}/${totalN} → CM ${mgrOk}/${totalN} (${wins} wins)\n`);

  // ═══════════════════════════════════════════════════
  // Test 2: DocQA 750K chars — truly over-window
  // ═══════════════════════════════════════════════════
  console.log("=".repeat(60));
  console.log("Test 2: DocQA 750K chars (~214K tokens), answer at 35%");
  console.log("=".repeat(60));

  const answerText = `\n\n=== [CONFIDENTIAL] IR-2026-0042 ===\n2026-07-15 08:47 UTC — unauthorized access on jump-prod-01 (10.240.3.17).\nAttacker exploited CVE-2026-88421 in OpenSSH 9.2p1.\nRoot cause: SSH MaxAuthTries=30 (default), allowing brute force.\nImpact: payroll-db-prod, crm-db-prod, analytics-db-prod snapshots exfiltrated (~420GB).\nRemediation: MaxAuthTries=3, fail2ban deployed, credentials rotated.\nSeverity: CRITICAL / P0 | IC: chen.liu@company.com\n=== END ===\n\n`;

  let doc = hc.generateLargeDocHard(750_000);
  const ansPos = Math.floor(doc.length * 0.35);
  doc = hc.injectAnswerAtHard(doc, answerText, ansPos);
  const q = "这次安全事件的根本原因是什么？CVE编号？受影响系统有哪些？";

  const dqa = hc.runDocQAHard(doc, q, MAX_W);
  console.log(`  Doc: ${(doc.length/1000)|0}K chars (~${Math.round(doc.length/3.5/1000)}K tokens)`);
  console.log(`  Answer at 35% (~${Math.round(ansPos/3.5/1000)}K tokens)`);
  console.log(`  Baseline window: ${(dqa.baseline.tokens/1000).toFixed(1)}K tokens (last ~${((dqa.baseline.tokens*3.5)/1000)|0}K chars)`);
  console.log(`  Answer at char ${ansPos} → baseline starts at char ${doc.length-Math.floor(MAX_W*3.5)} → ${ansPos < doc.length-Math.floor(MAX_W*3.5) ? "MISS (out of window ✅)" : "IN WINDOW ❌"}`);
  console.log(`  CM evicted: ${dqa.managed.evicted}, window: ${dqa.managed.usePercent}%`);

  process.stdout.write("  LLM BL...");
  const bDoc = await RETRY_LLM(cfg, [{ role: "user", content: dqa.baseline.content + "\n\n" + q }], 300);
  totalInput += dqa.baseline.tokens; totalOutput += hc.estimateTokens(bDoc);
  console.log("done");

  process.stdout.write("  LLM CM...");
  const mDoc = await RETRY_LLM(cfg, dqa.managed.messages as any, 300);
  totalInput += dqa.managed.tokens; totalOutput += hc.estimateTokens(mDoc);
  console.log("done");

  console.log(`  BL: ${bDoc.slice(0, 400)}`);
  console.log(`  CM: ${mDoc.slice(0, 400)}\n`);

  // ═══════════════════════════════════════════════════
  // Test 3: Multi-hop 30 sessions × 80 noise, TEMPORAL CONTRADICTIONS
  // ═══════════════════════════════════════════════════
  console.log("=".repeat(60));
  console.log("Test 3: Multi-hop 30 sessions × 80 noise + temporal contradictions");
  console.log("=".repeat(60));

  // Project Atlas: early sessions spread WRONG info, later sessions correct.
  const atlasSessions: hc.MultiHopSession[] = [
    { id: 1, fact: "【S1】Project Atlas 立项。预算 ¥2,000,000。技术栈 Node.js + MongoDB。消息队列：计划用 RabbitMQ。", tags: ["atlas","init"] },
    { id: 2, fact: "【S2】Atlas 团队：前端 3人、后端 4人、DevOps 1人。办公室设在深圳南山。", tags: ["atlas","team"] },
    { id: 3, fact: "【S3】Atlas 技术选型讨论：消息队列倾向 RabbitMQ，因为团队有经验。数据库考虑 MongoDB 做主要存储。", tags: ["atlas","tech"] },
    { id: 4, fact: "【S4】Atlas 架构评审：初步定为 Monolith + 3 worker 进程。GPU 需求暂无。", tags: ["atlas","arch"] },
    { id: 5, fact: "【S5】Atlas 竞品分析：对标项目 Falcon 已获 B 轮融资，Atlas 需加速。战略建议：不做 Monolith，改微服务。", tags: ["atlas","strategy"] },
    { id: 6, fact: "【S6 · 方向调整】Atlas 架构推翻：从 Monolith 转向微服务，分 8 个服务。预算追加至 ¥4,500,000。", tags: ["atlas","pivot"] },
    { id: 7, fact: "【S7】Atlas 微服务拆分：gateway, user, content, search, recommendation, analytics, billing, notification 共 8 个。Kafka 作为事件总线。", tags: ["atlas","services"] },
    { id: 8, fact: "【S8 · 重大纠正】Atlas 最终消息队列：Pulsar（不是 Kafka！之前文档有误）。Pulsar v3.2 原生多租户更适合 Atlas 的 SaaS 多客户模式。", tags: ["atlas","mq","correct"] },
    { id: 9, fact: "【S9】Atlas 存储层：PostgreSQL 16 作为主数据库（替代 MongoDB）。ClickHouse 24.3 做分析。", tags: ["atlas","db"] },
    { id: 10, fact: "【S10】Atlas GPU 需求浮现：推荐引擎需要推理能力。采购 4×A100 80GB。预算追加至 ¥7,800,000。", tags: ["atlas","gpu","budget"] },
    { id: 11, fact: "【S11】Atlas 推理框架评估：对比 vLLM、TGI、Triton。初选 TGI。", tags: ["atlas","inference"] },
    { id: 12, fact: "【S12】Atlas 安全方案：统一鉴权网关 (Kong Gateway) + JWT RS256。WAF: AWS Shield Advanced。", tags: ["atlas","security"] },
    { id: 13, fact: "【S13】Atlas 前端：React 19 + Next.js 15 + Tailwind CSS 4 + shadcn/ui。部署 Vercel Enterprise。", tags: ["atlas","frontend"] },
    { id: 14, fact: "【S14】Atlas 合规：需 ISO 27001 + SOC2 Type II。合规截止 2026-12-31。合规官 zhao.qian@company.com。", tags: ["atlas","compliance"] },
    { id: 15, fact: "【S15 · 推理推翻】Atlas 推理从 TGI 改为 vLLM v0.6.3！性能测试：vLLM QPS 240 vs TGI QPS 140，差 71%。部署方案：vLLM + Qwen2.5-72B-GPTQ-Int4。", tags: ["atlas","inference","correct"] },
    { id: 16, fact: "【S16】Atlas 负载测试：50K 并发 QPS。api-gateway P99 23ms, user-service P99 45ms。目标已达成。", tags: ["atlas","perf"] },
    { id: 17, fact: "【S17】Atlas 灾备：深圳主节点 + 成都灾备。RPO≤3min, RTO≤15min。演练 8/15 通过。", tags: ["atlas","dr"] },
    { id: 18, fact: "【S18】Atlas 隐私合规：用户数据 AES-256-GCM 加密。密钥在 AWS KMS (ap-east-1)。密钥轮换 30 天。PII 标记系统已上线。", tags: ["atlas","privacy"] },
    { id: 19, fact: "【S19】Atlas 可观测性：OpenTelemetry + Grafana + Tempo + Loki。告警通过飞书机器人 + PagerDuty。SLO: 99.95%。", tags: ["atlas","obs"] },
    { id: 20, fact: "【S20 · 最终预算】Atlas 终版预算：¥8,200,000（含 GPU ¥1,500K + 云 ¥3,200K + 人力 ¥3,500K）。ROI 预估 22 个月。", tags: ["atlas","budget","final"] },
    { id: 21, fact: "【S21】Atlas 灰度发布：8%→25%→50%→100%，每阶段观察 48h。功能开关用 LaunchDarkly。", tags: ["atlas","release"] },
    { id: 22, fact: "【S22】Atlas 用户反馈：内测 200 人，NPS 72。主要抱怨：搜索速度慢。优化方向：Elasticsearch 替换内置搜索。", tags: ["atlas","feedback"] },
    { id: 23, fact: "【S23 · 数据库最终确认】Atlas 数据库栈确认：PG16 (OLTP) + ClickHouse 24.3 (OLAP) + Redis 7.2 (Cache/Session) + Elasticsearch 8.14 (Search)。MongoDB 完全移除。", tags: ["atlas","db","final"] },
    { id: 24, fact: "【S24】Atlas CI/CD：GitHub Actions + ArgoCD。部署频率：日 3-5 次。回滚时间 < 3min。", tags: ["atlas","cicd"] },
    { id: 25, fact: "【S25】Atlas API 限流：基于用户 tier。Free 100/min, Pro 1000/min, Enterprise 10000/min。Token Bucket 算法。", tags: ["atlas","api"] },
    { id: 26, fact: "【S26】Atlas 国际化：首批 en-US + zh-CN。i18n 框架 next-intl。翻译管理 Crowdin。计划 Q1-2027 加 ja-JP + ko-KR。", tags: ["atlas","i18n"] },
    { id: 27, fact: "【S27】Atlas 日志：20TB/天。ELK 太贵 → 自建 ClickHouse + Grafana。成本降低 60% (¥180K/月 → ¥72K/月)。", tags: ["atlas","logs"] },
    { id: 28, fact: "【S28】Atlas 安全事件：7月3日发现 1 个 XSS (反射型) + 1 个 SSRF。CVSS 6.5 和 7.8。48h 内修复。CISO 确认无数据泄露。", tags: ["atlas","security"] },
    { id: 29, fact: "【S29】Atlas 里程碑：8/1 内部预览, 9/15 封闭内测, 11/1 公测, 2027-01-15 GA。每阶段需 CEO 签批。", tags: ["atlas","milestone"] },
    { id: 30, fact: "【S30 · 最终综合确认】Project Atlas 终态：Go 1.23 + PG16 + ClickHouse 24.3 + Redis 7.2 + Elasticsearch 8.14。消息队列：Pulsar v3.2（非 Kafka 非 RabbitMQ）。推理：vLLM v0.6.3 + Qwen2.5-72B-GPTQ-Int4。前端：React 19 + Next.js 15。安全提过 XSS/SSRF 各 1。预算：¥8,200,000。GA：2027-01-15。", tags: ["atlas","final","summary"] },
  ];

  // Questions that test: (a) timeline awareness (b) contradiction detection
  const mhQ = `Project Atlas 项目，请根据所有信息回答（优先以最新信息为准）：
1. 最终消息队列是什么？（注意：项目中途有过多次讨论和变更）
2. 推理框架和模型？
3. 最终预算金额（¥）？
4. 出现过哪些安全漏洞？
5. GA 日期？
6. 数据库栈包含哪些产品？（以最终确认为准）`;

  console.log(`  Sessions: ${atlasSessions.length}, Noise/session: 80`);
  const mh = hc.runMultiHopMemory(atlasSessions, 80, mhQ, MAX_W);
  const totalChars = atlasSessions.reduce((a, s) => a + s.fact.length + 80 * 120, 0);
  console.log(`  Total chars: ~${(totalChars/1000)|0}K (~${(totalChars/3.5/1000)|0}K tokens)`);
  console.log(`  Recalled: ${mh.managed.recalledCount} entries`);

  process.stdout.write("  LLM BL...");
  const bMh = await RETRY_LLM(cfg, mh.baseline.messages, 600);
  totalInput += hc.estimateTokens(mh.baseline.messages.map(m => m.content).join(" "));
  totalOutput += hc.estimateTokens(bMh);
  console.log("done");

  process.stdout.write("  LLM CM...");
  const mMh = await RETRY_LLM(cfg, mh.managed.messages, 600);
  totalInput += hc.estimateTokens(mh.managed.messages.map(m => typeof m.content === "string" ? m.content : "").join(" "));
  totalOutput += hc.estimateTokens(mMh);
  console.log("done");

  console.log(`  BL: ${bMh.slice(0, 500)}`);
  console.log(`  CM: ${mMh.slice(0, 500)}\n`);

  // ═══════════════════════════════════════════════════
  // Report
  // ═══════════════════════════════════════════════════
  const cost = `≈ ${((totalInput + totalOutput) / 1_000_000 * 2).toFixed(4)} CNY (est)`;
  const report = [
    `# Hardcore v2 Benchmark Report`,
    `> ${cfg.model} @ ${cfg.baseUrl} | ${new Date().toISOString()}`,
    ``,
    `## 1. NIAH (${totalN} cells, 10 needles, 3 semantic distractors)`,
    `- Baseline: ${baseOk}/${totalN}`,
    `- ContextManager: ${mgrOk}/${totalN}`,
    `- Wins: ${wins}`,
    ``,
    `## 2. DocQA (750K chars, answer at 35%)`,
    `- Answer in BL window: ${ansPos >= doc.length - Math.floor(MAX_W * 3.5) ? "YES (test invalid)" : "NO (test valid ✅)"}`,
    `- BL: ${bDoc.slice(0, 400)}`,
    `- CM: ${mDoc.slice(0, 400)}`,
    ``,
    `## 3. Multi-hop (30 sessions × 80 noise, temporal contradictions)`,
    `- Total chars: ${(totalChars/1000)|0}K`,
    `- Recalled: ${mh.managed.recalledCount}`,
    `- BL: ${bMh.slice(0, 500)}`,
    `- CM: ${mMh.slice(0, 500)}`,
    ``,
    `## Cost`,
    `- In: ${totalInput.toLocaleString()} Out: ${totalOutput.toLocaleString()}`,
    `- Total: ${(totalInput + totalOutput).toLocaleString()} tokens, ${cost}`,
  ].join("\n");

  const rp = resolve(dirname(fileURLToPath(import.meta.url)), "HARDCORE_V2_REPORT.md");
  writeFileSync(rp, report, "utf-8");

  console.log("=".repeat(60));
  console.log(`  Done! Report: ${rp}`);
  console.log(`  Cost: ${cost}`);
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });
