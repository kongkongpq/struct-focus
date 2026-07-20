// @struct/context — Hardcore v2: 真正超窗口 DocQA + 时序矛盾 Multi-hop + 语义干扰 NIAH
// GLM-4 128K 上下文专用
import { ContextManager, type LLMMessage } from "../src/index.js";

// ═══════════ Config ═══════════

export interface LLMConfig { baseUrl: string; apiKey: string; model: string; }
const CHARS_PER_TOKEN = 3.5;

function chatUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, "");
  if (u.endsWith("/v4") || u.includes("/api/paas")) return `${u}/chat/completions`;
  if (u.includes("/compatible-mode")) return `${u}/v1/chat/completions`;
  if (u.endsWith("/v1")) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

async function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export async function callLLM(
  config: LLMConfig,
  messages: { role: string; content: string }[],
  maxTokens = 500,
  retries = 8,
): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(chatUrl(config.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: 0, max_tokens: maxTokens }),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        if (resp.status === 429 && attempt < retries) { await delay((attempt + 2) * 8000); continue; }
        throw new Error(`LLM API ${resp.status}: ${err.slice(0, 200)}`);
      }
      const data = (await resp.json()) as { choices: { message: { content: string } }[] };
      return data.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      if (attempt < retries && err instanceof Error && (err.message.includes("429") || err.message.includes("fetch"))) {
        await delay((attempt + 2) * 8000); continue;
      }
      throw err;
    }
  }
  throw new Error("LLM API: all retries exhausted");
}

// ═══════════ Noise (8 templates, varied) ═══════════

const NOISE = [
  (i: number) => `[${String(i).padStart(5,"0")}] ${"ERROR WARN INFO DEBUG TRACE".split(" ")[i%5]} src/${["auth","api","db","cache","router","queue","validator","serializer","gateway","scheduler"][i%10]}.ts:${100+(i%900)} — ${["timeout","retry","connection refused","null pointer","type mismatch","buffer overflow","race condition","deadlock detected","OOM killer triggered","stack overflow"][i%10]}`,
  (i: number) => `[build:${i}] chunk ${["vendor","main","admin","dashboard","reports","settings"][i%6]}.${i.toString(16)}.js ${(i*137)%500+20}kB gzip:${(i*13)%80+3}kB hash:${Array.from({length:8},()=>"0123456789abcdef"[(i*7)%16]).join("")}`,
  (i: number) => `[test:${i}] ${"PASS FAIL SKIP".split(" ")[i%3]} __tests__/${["UserService","OrderController","PaymentGateway","CacheManager","AuthMiddleware","RateLimiter"][i%6]}.test.ts > ${["should create user","should handle timeout","should validate input","should reject duplicates","should return 404","should encrypt payload"][i%6]} (${(i%15)/10+0.3}s)`,
  (i: number) => `[db:${i}] pool=${["primary","replica-1","replica-2","analytics"][i%4]} conns=${(i%50)+5}/100 qps=${(i*17)%2000+100} slow=${i%5} avg=${(i%30)+1}ms p99=${(i%200)+5}ms`,
  (i: number) => `[k8s:${i}] pod/${["api","worker","cron","web"][i%4]}-${String(i%99).padStart(3,"0")} ${["Running","Pending","CrashLoopBackOff","OOMKilled","Completed","Evicted","ImagePullBackOff","ErrImagePull"][i%8]} node/${["az-1","az-2","az-3"][i%3]}-${String(i%20).padStart(2,"0")} cpu:${(i%80)+10}m/${(i%4)*500+500}m mem:${(i*31)%800+100}Mi/${(i%3)*1024+512}Mi`,
  (i: number) => `[git:${i}] commit ${Array.from({length:7},()=>"0123456789abcdef"[(i*3)%16]).join("")} by ${["alice","bob","carol","dave","eve"][i%5]} — ${["fix: null check","feat: add cache layer","refactor: extract service","chore: update deps","docs: update README","perf: optimize query","test: add integration","style: format code"][i%8]}`,
  (i: number) => `[monitor:${i}] ${["cpu","mem","disk","net","iops"][i%5]}: ${(i*13)%100}% ${i%3===0?"⚠️ threshold":"✅ normal"} region=${["us-east-1","eu-west-1","ap-southeast-1","cn-hangzhou"][i%4]} ts=2026-07-${String((i%28)+1).padStart(2,"0")}T${String(i%24).padStart(2,"0")}:${String(i%60).padStart(2,"0")}:00Z`,
  (i: number) => `[dep:${i}] ${["react","vue","express","fastify","prisma","drizzle","zod","lodash","axios","dayjs"][i%10]}@${(i%5)+1}.${i%20}.${i%10} → ${(i%6)+2}.${(i*3)%30}.${(i*7)%15} ${i%4===0?"(BREAKING)":""} size:${(i*23)%500+10}kB`,
];

function noiseLine(i: number): string { return NOISE[i % NOISE.length]!(i); }

// ═══════════ Needles (10 real + 3 semantic distractors) ═══════════

interface Needle { fact: string; question: string; answer: string; }

export const HARD_NEEDLES: Needle[] = [
  // 0 — incident
  { fact: "【生产事故 #INC-2026-07842】7月17日 14:23，stripe-prod 主节点 OOM，北美 47 分钟支付失败。根因：Redis 连接池泄漏 12,847 connections。修复 v3.8.2-hotfix。值班：zhang.san@company.com | P1", question: "支付网关事故的根本原因是什么？用一句话回答。不知道就说不知道。", answer: "Redis 连接池泄漏" },
  // 1 — ADR
  { fact: "【ADR-2026-031 技术选型】架构委员会 9:3 通过：消息队列从 RabbitMQ 迁移至 Apache Pulsar v3.2。关键：多租户 + Geo-Replication，延迟降 40%。Q4 迁移。负责人：li.si@company.com", question: "消息队列迁移目标是什么产品+版本？用一句话。不知道就说不知道。", answer: "Apache Pulsar v3.2" },
  // 2 — CVE
  { fact: "【CVE-2026-99173 | CVSS 9.8 Critical】FastJSON v2.0.43 反序列化 RCE。影响：所有 parseObject() 未启用 SafeMode 的服务。修复：升级 v2.0.45+ 或 setSafeMode(true)。", question: "CVE-2026-99173 的 CVSS 评分是多少？只答数字。不知道就说不知道。", answer: "9.8" },
  // 3 — DB migration
  { fact: "【数据迁移 DM-2026-Q3】用户画像：MongoDB 4.4 → TiDB v7.5 LTS。user_profiles 32亿行 + user_behaviors 187亿行。双写→全量同步→灰度切流。回滚72h。DBA：wang.wu@company.com", question: "用户画像迁移的目标数据库是什么？产品+版本。不知道就说不知道。", answer: "TiDB v7.5" },
  // 4 — cost
  { fact: "【成本优化 Q2-2026】AWS us-east-1 月支出 $847,293，同比+34%。Top3：EC2 $312K (36.8%), RDS $198K (23.4%), S3 $87K (10.3%)。RI可省$96K/月。审批：CFO", question: "Q2-2026 AWS月支出中 EC2 占多少？只答美元数字。不知道就说不知道。", answer: "$312K" },
  // 5 — K8s incident
  { fact: "【K8s 事故 INC-2026-08112】7月16日 02:11，prod-cluster 3 个 node 同时 NotReady。根因：kubelet 证书于 02:00 过期未自动轮换。影响：127 pods 被驱逐，用户登录中断 22 分钟。修复：手动签发证书 + 配置 cert-manager auto-renew。值班：chen.li@ops.com | P0", question: "K8s 证书过期事故影响多少 pods 被驱逐？只答数字。不知道就说不知道。", answer: "127" },
  // 6 — API breaking change
  { fact: "【API Breaking Change v3→v4】2026-09-01 起 /api/v3/users 废弃。新接口 /api/v4/users 返回格式从 snake_case 改为 camelCase。userId → id, createdAt → created。迁移窗口 90 天。影响 14 个内部服务。协调人：api-team@company.com", question: "API v3→v4 迁移中，userId 字段改为？只答新字段名。不知道就说不知道。", answer: "id" },
  // 7 — ML training
  { fact: "【ML 训练报告 2026-W28】推荐模型 v4.2：训练 4×A100 80GB, 历时 47h, loss 0.0234→0.0087。AUC 0.943 (基线 0.917)。在线 A/B：CTR +12.7%, 收入 +8.3%。模型大小 7.8GB (ONNX)。部署：Triton Inference Server v2.41。", question: "推荐模型 v4.2 的 AUC 是多少？只答数字。不知道就说不知道。", answer: "0.943" },
  // 8 — security audit
  { fact: "【安全审计 2026-H1 报告】总计发现 47 个漏洞：Critical 3、High 11、Medium 23、Low 10。最严重：SQL 注入 (order-service)、SSRF (file-proxy)、未授权 API (admin-panel)。全部 Critical 已于 7/15 前修复。审计方：PwC Cyber。下次审计：2026-12。", question: "2026-H1安全审计中 Critical 级别漏洞有几个？只答数字。不知道就说不知道。", answer: "3" },
  // 9 — SLO report
  { fact: "【SLO 报告 2026-Q2】核心服务可用性：api-gateway 99.97%、user-service 99.95%、order-service 99.91%、payment-service 99.99%。仅 order-service 未达 99.95% SLO（欠 0.04%）。根因：6月18日 GC pause 导致 12min 不可用。改进：G1GC → ZGC。", question: "Q2 哪个服务未达 SLO 目标？只答服务名。不知道就说不知道。", answer: "order-service" },
];

// Semantic distractors: same TOPIC as real needles, WRONG answer
// distractor[0] mimics needle[0] (incident topic), distractor[1] mimics needle[1] (ADR topic)
const DISTRACTOR_NEEDLES: Needle[] = [
  { fact: "【生产事故 #INC-2026-99999】7月17日 14:23，stripe-prod 主节点 OOM，北美 47 分钟支付失败。根因：MySQL 连接池泄漏 12,847 connections。修复 v3.8.2-hotfix。值班：zhang.san@company.com | P1", question: "支付网关事故的根本原因是什么？用一句话回答。不知道就说不知道。", answer: "MySQL 连接池泄漏" },
  { fact: "【ADR-2026-999 技术选型】消息队列从 RabbitMQ 迁移至 Apache Kafka v3.6。关键：生态成熟，社区支持更广。Q4 迁移。", question: "消息队列迁移目标是什么产品+版本？用一句话。不知道就说不知道。", answer: "Apache Kafka v3.6" },
  { fact: "【CVE-2026-99999 | CVSS 7.2 High】FastJSON v2.0.43 反序列化漏洞。影响有限。修复：升级 v2.0.45+。", question: "CVE-2026-99173 的 CVSS 评分是多少？只答数字。不知道就说不知道。", answer: "7.2" },
];

// ═══════════ NIAH Grid Config ═══════════

export interface HardNIAHPair {
  noiseSteps: number; depth: number;
  depthLabel: string; lengthLabel: string; approxTokens: number;
}

// Standard 20-cell grid: 5 docs × 4 depths
export const STANDARD_GRID: HardNIAHPair[] = [
  { noiseSteps: 50, depth: 0.0, depthLabel: "Start(0%)", lengthLabel: "4K", approxTokens: 4 },
  { noiseSteps: 50, depth: 0.33, depthLabel: "1/3(33%)", lengthLabel: "4K", approxTokens: 4 },
  { noiseSteps: 50, depth: 0.66, depthLabel: "2/3(66%)", lengthLabel: "4K", approxTokens: 4 },
  { noiseSteps: 50, depth: 1.0, depthLabel: "End(100%)", lengthLabel: "4K", approxTokens: 4 },
  { noiseSteps: 200, depth: 0.0, depthLabel: "Start(0%)", lengthLabel: "16K", approxTokens: 16 },
  { noiseSteps: 200, depth: 0.33, depthLabel: "1/3(33%)", lengthLabel: "16K", approxTokens: 16 },
  { noiseSteps: 200, depth: 0.66, depthLabel: "2/3(66%)", lengthLabel: "16K", approxTokens: 16 },
  { noiseSteps: 200, depth: 1.0, depthLabel: "End(100%)", lengthLabel: "16K", approxTokens: 16 },
  { noiseSteps: 400, depth: 0.0, depthLabel: "Start(0%)", lengthLabel: "32K", approxTokens: 32 },
  { noiseSteps: 400, depth: 0.33, depthLabel: "1/3(33%)", lengthLabel: "32K", approxTokens: 32 },
  { noiseSteps: 400, depth: 0.66, depthLabel: "2/3(66%)", lengthLabel: "32K", approxTokens: 32 },
  { noiseSteps: 400, depth: 1.0, depthLabel: "End(100%)", lengthLabel: "32K", approxTokens: 32 },
  { noiseSteps: 800, depth: 0.0, depthLabel: "Start(0%)", lengthLabel: "64K", approxTokens: 64 },
  { noiseSteps: 800, depth: 0.33, depthLabel: "1/3(33%)", lengthLabel: "64K", approxTokens: 64 },
  { noiseSteps: 800, depth: 0.66, depthLabel: "2/3(66%)", lengthLabel: "64K", approxTokens: 64 },
  { noiseSteps: 800, depth: 1.0, depthLabel: "End(100%)", lengthLabel: "64K", approxTokens: 64 },
  { noiseSteps: 1200, depth: 0.0, depthLabel: "Start(0%)", lengthLabel: "96K", approxTokens: 96 },
  { noiseSteps: 1200, depth: 0.33, depthLabel: "1/3(33%)", lengthLabel: "96K", approxTokens: 96 },
  { noiseSteps: 1200, depth: 0.66, depthLabel: "2/3(66%)", lengthLabel: "96K", approxTokens: 96 },
  { noiseSteps: 1200, depth: 1.0, depthLabel: "End(100%)", lengthLabel: "96K", approxTokens: 96 },
];

export function runHardNIAHSingle(
  noiseSteps: number, depth: number, needleIdx: number,
  maxWindow: number, distractorIdx?: number,
): { baseline: { messages: { role: string; content: string }[]; stats: { entries: number; tokens: number } };
     managed: { messages: LLMMessage[]; stats: { entries: number; tokens: number; evicted: number; compressed: number; usePercent: number } };
     groundTruth: { fact: string; question: string; answer: string; distractorAnswer?: string };
   } {
  const needle = HARD_NEEDLES[needleIdx % HARD_NEEDLES.length]!;
  const needlePos = Math.min(Math.floor(noiseSteps * depth), noiseSteps - 1);

  let distractorPos = -1;
  let distractor: Needle | undefined;
  if (distractorIdx !== undefined) {
    distractor = DISTRACTOR_NEEDLES[distractorIdx % DISTRACTOR_NEEDLES.length]!;
    distractorPos = Math.min(Math.floor(noiseSteps * 0.6), noiseSteps - 1);
    if (distractorPos === needlePos) distractorPos = Math.max(0, distractorPos - 3);
  }

  // Baseline
  const bl: { role: string; content: string }[] = [];
  for (let i = 0; i < noiseSteps; i++) {
    if (i === needlePos) bl.push({ role: "user", content: needle.fact });
    else if (i === distractorPos) bl.push({ role: "user", content: distractor!.fact });
    else bl.push({ role: "user", content: noiseLine(i) });
  }
  bl.push({ role: "user", content: needle.question });

  // Managed
  const mgr = new ContextManager({ maxWindow });
  for (let i = 0; i < noiseSteps; i++) {
    if (i === needlePos) {
      mgr.appendObservation(needle.fact, { source: "needle", taskRelevance: 0.02, sourceType: "file_content" });
    } else if (i === distractorPos) {
      mgr.appendObservation(distractor!.fact, { source: "distractor", taskRelevance: 0.02, sourceType: "file_content" });
    } else {
      mgr.appendObservation(noiseLine(i), { source: `noise-${i}`, taskRelevance: 0.75, sourceType: "file_content" });
    }
    if (i > 0 && i % 30 === 0) mgr.manage();
    if (i > 0 && i % 60 === 0) mgr.autoManage();
  }
  mgr.appendUser(needle.question);
  const s = mgr.getStats();

  return {
    baseline: { messages: bl, stats: { entries: bl.length, tokens: estimateTokens(bl.map(m => m.content).join("")) } },
    managed: { messages: mgr.toMessages("你是技术助手。直接简洁回答。不知道就说不知道。"),
      stats: { entries: s.activeEntries, tokens: s.totalTokens, downgraded: s.evictedEntries, compressed: s.compressedEntries, usePercent: s.usePercent } },
    groundTruth: { fact: needle.fact, question: needle.question, answer: needle.answer, distractorAnswer: distractor?.answer },
  };
}

export function checkHardNIAH(answer: string, expected: string): boolean {
  return answer.toLowerCase().trim().includes(expected.toLowerCase().trim());
}

// ═══════════ Test 2: DocQA — TRULY over-window (750K chars, answer at 35%) ═══════════
// 750K chars ≈ 214K tokens. Baseline takes last 128K tokens ≈ last 448K chars.
// Answer at 35% = 262.5K from start → 750K-448K=302K → 262.5K < 302K → baseline MISSES ✅

export function generateLargeDocHard(charCount: number): string {
  const sections = [
    "# 系统架构设计文档 v4.7\n\n## 1. 概述\n本系统采用微服务架构，基于 Kubernetes v1.29 部署于 AWS EKS...\n",
    "## 2. 网络拓扑\nVPC CIDR: 10.240.0.0/16\n子网: public 10.240.1.0/24, private 10.240.2.0/24, data 10.240.3.0/24\nNAT Gateway: nat-0a1b2c3d4e5f67890\n",
    "## 3. 服务清单\n| 服务名 | 端口 | 副本 | CPU | 内存 | 语言 |\n|--------|------|------|-----|------|------|\n",
  ];
  const svcRows = [
    "| api-gateway | 8080 | 8 | 2 | 4Gi | Go 1.22 |\n",
    "| user-service | 8081 | 6 | 1 | 2Gi | Java 21 |\n",
    "| order-service | 8082 | 10 | 2 | 4Gi | Java 21 |\n",
    "| payment-service | 8083 | 4 | 1 | 2Gi | Rust 1.78 |\n",
    "| notification-service | 8084 | 3 | 0.5 | 1Gi | TypeScript |\n",
    "| analytics-service | 8085 | 2 | 4 | 8Gi | Python 3.12 |\n",
  ];

  let doc = sections.join("");
  doc += svcRows.join("");
  doc += "\n## 4. 数据库集群\n\n";

  let i = 0;
  while (doc.length < charCount) {
    i++;
    doc += `### 4.${i} 集群节点 node-${String(i).padStart(3, "0")}\n`;
    doc += `- 实例类型: ${["r6g.xlarge","r6g.2xlarge","r6g.4xlarge","r6g.8xlarge","r6g.16xlarge"][i%5]}\n`;
    doc += `- 存储: ${(i*17)%500+100}GB gp3, IOPS ${(i*31)%10000+3000}, 吞吐 ${(i*13)%500+125}MB/s\n`;
    doc += `- 连接数: ${(i*7)%500+50}/${(i%4)*200+400}\n`;
    doc += `- QPS: read ${(i*23)%5000+1000}, write ${(i*11)%2000+200}\n`;
    doc += `- 复制延迟: ${(i%10)/10}ms (max ${(i%20)/10}ms)\n`;
    doc += `- 备份: 每日 03:00 UTC, 保留 ${(i%7)+7} 天, 最后成功: 2026-07-${String((i%17)+1).padStart(2,"0")}\n\n`;
  }

  return doc.slice(0, charCount);
}

export function injectAnswerAtHard(doc: string, answer: string, position: number): string {
  return doc.slice(0, position) + answer + doc.slice(position);
}

export function runDocQAHard(
  doc: string, question: string, maxWindow: number,
): { baseline: { content: string; tokens: number };
     managed: { messages: LLMMessage[]; tokens: number; evicted: number; usePercent: number };
   } {
  // Baseline: sliding window — last maxWindow tokens worth of chars
  const baselineChars = Math.floor(maxWindow * CHARS_PER_TOKEN);
  const baselineContent = doc.slice(-baselineChars);

  const mgr = new ContextManager({ maxWindow });
  const chunks = doc.match(/[\s\S]{1,500}/g) || [doc];
  for (let i = 0; i < chunks.length; i++) {
    mgr.appendObservation(chunks[i]!, { source: `doc-${i}`, taskRelevance: 0.55, sourceType: "file_content" });
    if (i > 0 && i % 80 === 0) {
      mgr.manage();
      mgr.autoManage();
    }
  }
  mgr.appendUser(question);
  const s = mgr.getStats();

  return {
    baseline: { content: baselineContent, tokens: estimateTokens(baselineContent) },
    managed: {
      messages: mgr.toMessages("你是技术文档分析助手。直接简洁回答。不知道就说不知道。"),
      tokens: s.totalTokens, downgraded: s.evictedEntries, usePercent: s.usePercent,
    },
  };
}

// ═══════════ Test 3: Multi-hop with TEMPORAL CONTRADICTIONS ═══════════
// 30 sessions: early sessions have WRONG/outdated info, later sessions correct it.
// Tests whether CM can identify the "latest truth" vs earlier contradictions.

export interface MultiHopSession { id: number; fact: string; tags: string[]; }

export function runMultiHopMemory(
  sessions: MultiHopSession[],
  noisePerSession: number,
  question: string,
  maxWindow: number,
): { baseline: { messages: { role: string; content: string }[] };
     managed: { messages: LLMMessage[]; recalledCount: number };
   } {
  const bl: { role: string; content: string }[] = [];
  const mgr = new ContextManager({ maxWindow });

  for (const sess of sessions) {
    mgr.appendObservation(sess.fact, { source: `sess-${sess.id}`, taskRelevance: 0.03, tags: sess.tags, sourceType: "file_content" });
    bl.push({ role: "user", content: sess.fact });

    for (let i = 0; i < noisePerSession; i++) {
      const n = noiseLine(sess.id * 1000 + i);
      bl.push({ role: "user", content: n });
      mgr.appendObservation(n, { source: `noise-s${sess.id}-${i}`, taskRelevance: 0.75, sourceType: "file_content" });
    }
  }

  mgr.autoManage();
  const recalled = mgr.recall("project atlas timeline final");
  mgr.appendUser(question);
  bl.push({ role: "user", content: question });

  return {
    baseline: { messages: bl },
    managed: { messages: mgr.toMessages("你是项目助理。直接回答。基于所有信息给出最准确的答案。不知道就说不知道。"),
      recalledCount: recalled.length },
  };
}
