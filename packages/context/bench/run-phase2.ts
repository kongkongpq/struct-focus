// @structfocus/context — Phase 2 only: DocQA + Multi-hop (skip NIAH)
import * as hc from "./hardcore.js";

const cfg = {
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey: process.env.LLM_API_KEY!,
  model: process.env.LLM_MODEL!,
};

async function retryLLM(cfg: hc.LLMConfig, messages: any[], maxTokens: number, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      return await hc.callLLM(cfg, messages, maxTokens);
    } catch (e: any) {
      console.log(`  ⚠️ retry ${i + 1}/${retries}: ${e.message?.slice(0, 80)}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 5000 * (i + 1)));
      else throw e;
    }
  }
  return "";
}

async function main() {
  console.log(`🚀 ${cfg.model} — Phase 2 (DocQA + Multi-hop)\n`);

  // ═══ DocQA 450K chars ═══
  console.log("=".repeat(60));
  console.log("Test 2: DocQA 450K chars, answer at 80%");
  console.log("=".repeat(60));

  const answerText = `\n\n=== [CONFIDENTIAL] IR-2026-0042 ===\n2026-07-15 08:47 UTC — unauthorized access on jump-prod-01 (10.240.3.17).\nAttacker exploited CVE-2026-88421 in OpenSSH 9.2p1.\nRoot cause: SSH MaxAuthTries=30 (default), allowing brute force.\nImpact: payroll-db-prod, crm-db-prod, analytics-db-prod snapshots exfiltrated (~420GB).\nRemediation: MaxAuthTries=3, fail2ban deployed, credentials rotated.\nSeverity: CRITICAL / P0 | IC: chen.liu@company.com\n=== END ===\n\n`;

  let doc = hc.generateLargeDocHard(450_000);
  const ansPos = Math.floor(doc.length * 0.8);
  doc = hc.injectAnswerAtHard(doc, answerText, ansPos);
  const q = "这次安全事件的根本原因是什么？CVE 编号？受影响系统有哪些？";

  const dqa = await hc.runDocQAHard(doc, q, 128_000);
  console.log(`  Doc: ${(doc.length/1000)|0}K chars (~${Math.round(doc.length/3.5/1000)}K tokens)`);
  console.log(`  Answer at 80% (~${Math.round(ansPos/3.5/1000)}K tokens)`);
  console.log(`  CM evicted: ${dqa.managed.evicted}, window: ${dqa.managed.usePercent}%`);

  const bDoc = await retryLLM(cfg, [{ role: "user", content: dqa.baseline.content + "\n\n" + q }], 300);
  const mDoc = await retryLLM(cfg, dqa.managed.messages as any, 300);

  console.log(`  BL: ${bDoc.slice(0, 300)}`);
  console.log(`  CM: ${mDoc.slice(0, 300)}`);

  // ═══ Multi-hop Memory ═══
  console.log("\n" + "=".repeat(60));
  console.log("Test 3: Multi-hop Memory — 15 sessions × 40 noise");
  console.log("=".repeat(60));

  const sessions = [
    { id: 1, fact: "【S1】Project Phoenix 立项，初始预算 ¥5,000,000。技术栈 Go + PostgreSQL。", tags: ["phoenix"] },
    { id: 2, fact: "【S2】Phoenix 预算追加至 ¥8,500,000，需自建 GPU 集群 8×A100。", tags: ["phoenix","gpu"] },
    { id: 3, fact: "【S3】Phoenix 架构：微服务 7 个 (gateway/user/order/inference/billing/audit/notification)。", tags: ["phoenix"] },
    { id: 4, fact: "【S4】Phoenix SOC2 Type II 合规，截止 2026-12-31。", tags: ["phoenix"] },
    { id: 5, fact: "【S5】Phoenix 推理选型：vLLM v0.6.3 + Qwen2.5-72B，A100 QPS 240。", tags: ["phoenix"] },
    { id: 6, fact: "【S6】Phoenix DB：PG16 + ClickHouse 24.3，Debezium CDC。", tags: ["phoenix"] },
    { id: 7, fact: "【S7】Phoenix 前端：React 19 + Next.js 15 + shadcn/ui。", tags: ["phoenix"] },
    { id: 8, fact: "【S8】Phoenix 里程碑：8/15 内测, 9/1 公测, 10/1 GA。延期罚 0.5%/天。", tags: ["phoenix"] },
    { id: 9, fact: "【S9】Phoenix 安全：2 高危 (IDOR + JWT none)，修复：统一鉴权 + RS256。", tags: ["phoenix"] },
    { id: 10, fact: "【S10】Phoenix 成本：¥230K/月，ROI 18月。", tags: ["phoenix"] },
    { id: 11, fact: "【S11】Phoenix 隐私：阿里云上海，PII AES-256-GCM。", tags: ["phoenix"] },
    { id: 12, fact: "【S12】Phoenix 灾备：RPO≤5min, RTO≤30min，深圳灾备。", tags: ["phoenix"] },
    { id: 13, fact: "【S13】Phoenix 监控：Prometheus+Grafana+Loki+Tempo，SLO 99.9%。", tags: ["phoenix"] },
    { id: 14, fact: "【S14】Phoenix API：OpenAPI 3.0，Rate Limit 1000/min。", tags: ["phoenix"] },
    { id: 15, fact: "【S15·FINAL】Phoenix：Go 1.23 + PG16 + ClickHouse 24.3 + Redis 7.2 + Kafka 3.7 (Pulsar被否决!)。vLLM v0.6.3 + Qwen2.5-72B。前端 React 19 + Next.js 15。预算 ¥8,500,000。GA 2026-10-01。", tags: ["phoenix","final"] },
  ];

  const mhQ = "Phoenix项目：1.总预算？2.最终消息队列Kafka还是Pulsar？3.推理框架和模型？4.安全漏洞？5.GA日期？";

  const mh = await hc.runMultiHopMemory(sessions, 40, mhQ, 128_000);
  console.log(`  Recalled: ${mh.managed.recalledCount} entries`);

  const bMh = await retryLLM(cfg, mh.baseline.messages, 500);
  const mMh = await retryLLM(cfg, mh.managed.messages, 500);

  console.log(`  BL: ${bMh.slice(0, 400)}`);
  console.log(`  CM: ${mMh.slice(0, 400)}`);

  console.log("\nDone ✅");
}

main().catch(e => { console.error(e); process.exit(1); });
