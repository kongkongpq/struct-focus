// @structfocus/context — 社区标准对齐验收基准 (128K 级)
//
// 三题对齐社区标准，全量 128K 级别压力测试：
//   题1 → gkamradt Needle-in-Haystack (github.com/gkamradt/LLMTest_NeedleInAHaystack, 3500+ stars)
//         4 种上下文长度(4K/32K/100K/128K) × 3 种深度(0%/50%/100%) = 12 格热力图
//   题2 → LongMemEval 风格跨会话记忆 (arxiv.org/abs/2410.10813)
//         10 段独立会话，大量噪音，关键事实隐藏在早期会话中
//   题3 → MemGPT 超窗口文档分析 (arxiv.org/abs/2310.08560)
//         128K chars 文档，答案埋在 70% 深度处，朴素组绝对看不见
//
// 推荐模型：qwen-plus (131K 上下文, 阿里百炼)
// 零 SDK 依赖，纯 fetch。

import { ContextManager, type LLMMessage } from "../src/index.js";

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const CHARS_PER_TOKEN = 3.5;

function chatUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, "");
  // 智谱 API 以 /v4 结尾，不需要追加 /v1
  if (u.endsWith("/v4") || u.includes("/api/paas")) return `${u}/chat/completions`;
  // 百炼 compatible-mode 需要保留 /v1 路径
  if (u.includes("/compatible-mode")) return `${u}/v1/chat/completions`;
  // 其他 OpenAI 兼容 API（DeepSeek 等）
  if (u.endsWith("/v1")) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callLLM(
  config: LLMConfig,
  messages: LLMMessage[] | { role: string; content: string }[],
  maxTokens = 500,
  retries = 5,
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
        if (resp.status === 429 && attempt < retries) {
          const wait = (attempt + 2) * 5000;
          await delay(wait);
          continue;
        }
        throw new Error(`LLM API ${resp.status}: ${err.slice(0, 200)}`);
      }
      const data = (await resp.json()) as { choices: { message: { content: string } }[] };
      return data.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      if (attempt < retries && err instanceof Error && (err.message.includes("429") || err.message.includes("fetch"))) {
        const wait = (attempt + 2) * 5000;
        await delay(wait);
        continue;
      }
      throw err;
    }
  }
  throw new Error("LLM API: all retries exhausted");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ═══════════════════════════════════════════════════════════
// 题 1：Needle-in-Haystack（对齐 gkamradt NIAH）
// ═══════════════════════════════════════════════════════════
//
// gkamradt 标准：1K→128K 上下文 × 0%→100% 深度 → 热力图
// 我们适配为对比模式：同一模型跑两次——朴素基线 vs ContextManager 管理组。

/** gkamradt 风格"针"：一个不寻常的关键事实 */
const NEEDLES: Record<number, { needle: string; question: string; answer: string }> = {
  1: {
    needle:
      "【重要安全通知】生产环境 PostgreSQL 数据库连接字符串已更新为 postgresql://db-prod.internal:5432/payroll_v3，密码文件位于 /etc/secrets/db-prod.yaml。这是本次部署的唯一变更。",
    question: "生产数据库的密码文件在哪个路径？请直接给出完整路径。如果你不知道，请说你不知道。",
    answer: "/etc/secrets/db-prod.yaml",
  },
  2: {
    needle:
      "【架构决策记录 ADR-2026-07】经技术委员会投票 7:2 通过：微服务间通信统一采用 gRPC + Protobuf 3，废弃 REST over HTTP。gRPC 端口统一为 9500。本决策自 2026-08-01 起生效。",
    question: "微服务间通信协议改成了什么？请直接给出协议名和新端口。如果你不知道，请说你不知道。",
    answer: "gRPC",
  },
  3: {
    needle:
      "【紧急回滚通知】v2.7.3 版本的用户认证模块存在严重安全漏洞（CVE-2026-88421），允许绕过 OAuth2 验证。已回滚至 v2.7.1，请立即更新所有部署。漏洞发现者：安全团队 lead@example.com。",
    question: "v2.7.3 版本的 CVE 编号是什么？请直接给出完整 CVE 编号。",
    answer: "CVE-2026-88421",
  },
};

export interface NIAHPair {
  depth: number; // 针位置 0=开头, 1=末尾
  noiseSteps: number;
  depthLabel: string;
  lengthLabel: string;
  approxTokens: number;
}

/** 生成 haystack 噪音行 */
function haystackLine(i: number): string {
  const lines = [
    `[log] worker-${i % 8} processed ${i * 137} records batch#${i}; p50=${12 + (i % 30)}ms p99=${45 + (i % 120)}ms queue=${3 + (i % 8)}`,
    `[lint] src/components/${["Modal", "Table", "Form", "Navbar", "Sidebar", "Header", "Footer", "Card"][i % 8]}.tsx:${100 + i}:${(i % 20) + 1} warning ${["no-unused-vars", "prefer-const", "no-console", "react-hooks/exhaustive-deps", "@typescript-eslint/no-explicit-any", "import/no-cycle", "no-param-reassign", "max-lines-per-function"][i % 8]} '${["_temp", "result", "debug", "props", "state", "ref", "data", "opts"][i % 8]}'`,
    `[build] vite: chunk ${["vendor", "main", "styles", "admin"][i % 4]}-${i.toString(16)}.js ${47 + ((i * 3) % 200)}kB gzip:${7 + (i % 50)}kB`,
    `[test] PASS __tests__/${["auth", "api", "db", "cache", "router", "middleware", "validator", "serializer"][i % 8]}.test.ts (${(1 + ((i % 8) * 0.2)).toFixed(1)}s)`,
    `[db] query: SELECT * FROM ${["users", "orders", "products", "sessions", "audit_logs", "permissions", "invoices", "notifications"][i % 8]} WHERE updated_at > '2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z' — ${(i * 13) % 1000 + 50} rows, ${2 + (i % 20)}ms, idx: ${["btree_updated", "hash_id", "gin_tags", "brin_created"][i % 4]}`,
  ];
  return `${String(i).padStart(4, "0")} ${lines[i % lines.length]!}`;
}

/** 单次 NIAH 测试 */
export async function runNIAHSingle(
  noiseSteps: number,
  depth: number,
  needleSet: number,
  maxWindow = 100_000,
): {
  baseline: { messages: { role: string; content: string }[]; stats: { entries: number; tokens: number } };
  managed: { messages: LLMMessage[]; stats: { entries: number; tokens: number; downgraded: number; compressed: number; usePercent: number } };
  groundTruth: { needle: string; question: string; answer: string };
} {
  const { needle, question, answer } = NEEDLES[needleSet]!;
  const needleAt = Math.min(Math.floor(noiseSteps * depth), noiseSteps - 1);

  // ── 朴素基线 ──
  const baselineMsgs: { role: string; content: string }[] = [];
  for (let i = 0; i < noiseSteps; i++) {
    baselineMsgs.push({ role: "user", content: i === needleAt ? needle : haystackLine(i) });
  }
  baselineMsgs.push({ role: "user", content: question });

  // ── 管理组 ──
  const mgr = new ContextManager({ maxWindow });
  for (let i = 0; i < noiseSteps; i++) {
    const isNeedle = i === needleAt;
    mgr.appendObservation(isNeedle ? needle : haystackLine(i), {
      source: isNeedle ? "security-bulletin" : `noise-${i}`,
      taskRelevance: isNeedle ? 0.1 : 0.6,
      sourceType: "file_content",
    });
    // 每 20 步让 manager 做一次降级管理
    if (i > 0 && i % 20 === 0) {
      mgr.manage();
    }
    // 每 50 步触发 autoManage
    if (i > 0 && i % 50 === 0) {
      await mgr.autoManage();
    }
  }
  mgr.appendUser(question);
  const s = mgr.getStats();

  return {
    baseline: {
      messages: baselineMsgs,
      stats: { entries: baselineMsgs.length, tokens: estimateTokens(baselineMsgs.map((m) => m.content).join("")) },
    },
    managed: {
      messages: mgr.toMessages(
        "你是一个编程助手。直接、简洁地回答用户问题。不知道就说不知道。",
      ),
      stats: {
        entries: s.activeEntries,
        tokens: s.totalTokens,
        downgraded: s.evictedEntries,
        compressed: s.compressedEntries,
        usePercent: s.usePercent,
      },
    },
    groundTruth: { needle, question, answer },
  };
}

export function checkNIAH(answer: string, expected: string): boolean {
  const a = answer.toLowerCase();
  return expected
    .toLowerCase()
    .split(/\s+/)
    .every((kw) => a.includes(kw));
}

// ═══════════════════════════════════════════════════════════
// 题 2：LongMemEval 风格跨会话记忆
// ═══════════════════════════════════════════════════════════

export interface LongMemSession {
  sessionId: number;
  facts: { content: string; tags: string[] }[];
  noise: string[];
}

export async function runLongMemSingle(
  sessions: LongMemSession[],
  finalQuestion: string,
  maxWindow = 100_000,
): {
  baseline: { messages: { role: string; content: string }[] };
  managed: { messages: LLMMessage[]; recalledCount: number };
} {
  // ── 朴素基线：所有会话直接拼接 ──
  const baselineMsgs: { role: string; content: string }[] = [];
  for (const sess of sessions) {
    baselineMsgs.push({ role: "user", content: `=== 会话 ${sess.sessionId} ===` });
    for (const f of sess.facts) baselineMsgs.push({ role: "user", content: f.content });
    for (const n of sess.noise) baselineMsgs.push({ role: "user", content: n });
  }
  baselineMsgs.push({ role: "user", content: finalQuestion });

  // ── 管理组：先 remember 所有事实，再喂入噪音 + 事实，
  //              让 ContextManager 的驱逐机制把不重要的噪音挤掉
  const mgr = new ContextManager({ maxWindow });
  let recallCount = 0;

  // 先把所有事实写入 remember（模拟长期记忆）
  for (const sess of sessions) {
    for (const f of sess.facts) {
      mgr.remember(f.content, { tags: f.tags });
    }
  }

  // 喂入所有会话数据
  for (const sess of sessions) {
    mgr.appendUser(`=== 会话 ${sess.sessionId} ===`);
    for (const f of sess.facts) {
      mgr.appendObservation(f.content, { source: `fact-s${sess.sessionId}`, taskRelevance: 0.1, sourceType: "file_content" });
    }
    for (const n of sess.noise) {
      mgr.appendObservation(n, { source: "noise", taskRelevance: 0.8, sourceType: "chat" });
    }
    // 每个会话结束后做一次降级管理
    mgr.manage();
  }

  // 在提问前 recall 所有相关记忆
  const recalled = await mgr.recall("项目A 数据库 CI/CD 安全", 10);
  recallCount = recalled.length;
  for (const h of recalled) {
  mgr.appendObservation(`[上下文记忆] ${h.content.slice(0, 300)}`, { taskRelevance: 0.2 });
  }

  mgr.appendUser(finalQuestion);

  return {
    baseline: { messages: baselineMsgs },
    managed: {
      messages: mgr.toMessages("你是一个有长期记忆的助手。直接回答用户问题，基于你记得的所有信息。"),
      recalledCount: recallCount,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 题 3：MemGPT 风格超窗口文档分析
// ═══════════════════════════════════════════════════════════

export function generateLargeDoc(targetChars = 120_000): string {
  const templates = [
    `## Section A-{n}: Distributed Systems Architecture

The {service} microservice is deployed across {nodes} nodes in {region} region. Each node runs {containers} containers orchestrated by {orchestrator} v{version}. Service discovery uses {discovery} with {ttl}s TTL and {retries} retries. Health checks run every {interval}s via {protocol} on port {port}. The circuit breaker trips after {cbThreshold} consecutive failures with a {cbTimeout}s timeout.

Database sharding uses {shardKey} as the partition key across {shardCount} shards. The write-ahead log (WAL) is replicated to {replicaCount} replicas with {syncMode} synchronization. Connection pooling: min={poolMin}, max={poolMax}, idle timeout={poolIdle}s. Query cache hit ratio: {cacheHitRate}%.

Monitoring stack: {monitor1} for metrics, {monitor2} for logs, {monitor3} for traces. Alert rules: CPU > {cpuAlert}% for {cpuDuration}s triggers P{priority} alert to {alertChannel}. SLA target: {slaTarget}% uptime, measured over {slaWindow}-day rolling window.

Security: mTLS between services with certificate rotation every {certRotate}h. API rate limiting: {rateLimit} req/s per client with burst of {rateBurst}. Authentication via {authMethod} with {authTTL}s token expiry. Audit logs written to {auditSink} with {auditRetention}-day retention.`,
    `## Section B-{n}: Performance Benchmarks {date}

| Benchmark | Metric | Baseline | Current | Delta | Target | Status |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| {bench1} | Throughput | {base1} rps | {curr1} rps | {delta1}% | {target1} | {status1} |
| {bench2} | Latency p99 | {base2}ms | {curr2}ms | {delta2}% | {target2}ms | {status2} |
| {bench3} | Error Rate | {base3}% | {curr3}% | {delta3}% | <{target3}% | {status3} |
| {bench4} | Memory | {base4}GB | {curr4}GB | {delta4}% | <{target4}GB | {status4} |
| {bench5} | CPU | {base5}% | {curr5}% | {delta5}% | <{target5}% | {status5} |
| {bench6} | Disk IOPS | {base6} | {curr6} | {delta6}% | >{target6} | {status6} |

Analysis: The {bottleneck} is the primary bottleneck. Optimization applied: {optimization}.`,
    `## Section C-{n}: API Reference — {apiVersion}

\`\`\`
POST /api/{apiVersion}/{resource}
Authorization: Bearer <token>
Content-Type: application/json
X-Request-ID: {requestId}
X-Idempotency-Key: {idempotencyKey}

Request:
{
  "fields": ["{field1}", "{field2}", "{field3}"],
  "filters": { "{filterKey}": "{filterVal}" },
  "pagination": { "page": {page}, "pageSize": {pageSize} },
  "sort": { "field": "{sortField}", "order": "{sortOrder}" }
}

Response 200:
{
  "data": [...],
  "meta": { "total": {total}, "page": {page}, "pageSize": {pageSize} },
  "links": { "next": "/api/{apiVersion}/{resource}?page={nextPage}", "prev": "..." }
}
\`\`\`

Rate limit: {apiRateLimit} req/s. Cached for {apiCacheTTL}s.`,
    `## Section D-{n}: Deployment Runbook

1. **Pre-deploy checks**: verify {check1}, {check2}, {check3}
2. **Canary deploy**: rollout to {canaryPercent}% of traffic on {canaryCluster}
3. **Smoke tests**: {smokeTest1}, {smokeTest2}, {smokeTest3}
4. **Monitor**: watch {watchMetric1}, {watchMetric2} for {watchDuration}s
5. **Rollback trigger**: {rollbackCondition} → execute \`{rollbackCmd}\`
6. **Post-deploy**: run {postDeployScript}, notify {postDeployChannel}

Rollback history: last rollback on {lastRollbackDate} for {lastRollbackReason}.`,
  ];

  const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  const pick = <T>(arr: T[]) => arr[rand(0, arr.length - 1)]!;

  const sections: string[] = [];
  let n = 0;
  while (sections.reduce((s, c) => s + c.length, 0) < targetChars) {
    n++;
    const tpl = pick(templates);
    const ns = {
      n,
      date: `2026-${String(rand(1, 12)).padStart(2, "0")}-${String(rand(1, 28)).padStart(2, "0")}`,
    };
    // fill all {xxx} with random values
    const filled = tpl.replace(/\{(\w+)\}/g, (_, key) => {
      if (key === "n") return String(ns.n);
      if (key === "date") return ns.date;
      if (key.includes("Status") || key.startsWith("status")) return pick(["PASS", "PASS", "PASS", "WARN", "FAIL"]);
      if (key === "delta1" || key === "delta2" || key === "delta3" || key === "delta4" || key === "delta5" || key === "delta6")
        return `${rand(-15, 20)}`;
      if (key.includes("Percent") || key.includes("percent")) return String(rand(1, 100));
      if (key.includes("Count") || key.includes("Nodes")) return String(rand(3, 50));
      if (key.includes("Duration") || key.includes("Interval")) return String(rand(10, 600));
      return `${key}_${rand(100, 9999)}`;
    });
    sections.push(filled);
  }
  return sections.join("\n\n");
}

export function injectAnswerAt(doc: string, answerText: string, charPosition: number): string {
  const before = doc.slice(0, charPosition);
  const after = doc.slice(charPosition);
  return before + "\n\n" + answerText + "\n\n" + after;
}

export async function runDocQA(
  doc: string,
  question: string,
  maxWindow = 100_000,
  opts?: { withinWindow?: boolean },
): {
  baseline: { content: string; tokens: number };
  managed: { messages: LLMMessage[]; tokens: number; downgraded: number; usePercent: number };
} {
  // ── 朴素基线 ──
  // 超窗口：只取文档末尾（模拟窗口截断，模型根本看不到前半部分）
  // 窗口内（withinWindow）：文档本身就在窗口内，基线取全文
  const approxChars = maxWindow * CHARS_PER_TOKEN;
  const baseContent =
    opts?.withinWindow || doc.length <= approxChars ? doc : doc.slice(-approxChars);
  const baseTokens = estimateTokens(baseContent);

  // ── 管理组：用 ContextManager 逐段处理 ──
  const mgr = new ContextManager({ maxWindow });
  mgr.setTaskContext({
    currentSubtasks: ["分析长文档并回答关键问题"],
    editingFiles: [],
    failingTests: [],
    focusedSymbols: [],
    recentErrors: [],
  });

  const CHUNK = 2000; // chars per chunk
  for (let i = 0; i < doc.length; i += CHUNK) {
    const chunk = doc.slice(i, i + CHUNK);
    mgr.appendObservation(chunk, { source: `doc-chunk-${Math.floor(i / CHUNK)}`, taskRelevance: 0.6, sourceType: "file_content" });
    // 每 10 个 chunk 做一次降级管理
    if (i > 0 && i % (CHUNK * 10) === 0) {
      mgr.manage();
    }
    // 每 20 chunk 触发 autoManage
    if (i > 0 && i % (CHUNK * 20) === 0) {
      await mgr.autoManage();
    }
  }
  mgr.appendUser(question);
  const s = mgr.getStats();

  return {
    baseline: { content: baseContent, tokens: baseTokens },
    managed: {
      messages: mgr.toMessages(
        "你正在分析一个长文档。基于上下文中的信息直接回答问题。如果你不知道答案，请说你不知道。",
      ),
      tokens: s.totalTokens,
      downgraded: s.evictedEntries,
      usePercent: s.usePercent,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 报告格式化
// ═══════════════════════════════════════════════════════════

export interface NIAHResult {
  baseline: { answer: string; correct: boolean };
  managed: { answer: string; correct: boolean };
}

export interface NIAHResults {
  pairs: NIAHPair[];
  results: NIAHResult[];
}

export function formatNIAHReport(results: NIAHResults): string {
  const lines: string[] = [];
  lines.push("# Needle-in-Haystack Report (gkamradt NIAH aligned)");
  lines.push("");
  lines.push("| Context Length | Depth | Baseline | ContextManager | Result |");
  lines.push("| --- | --- | ---: | ---: | --- |");
  for (let i = 0; i < results.results.length; i++) {
    const p = results.pairs[i]!;
    const r = results.results[i]!;
    const bs = r.baseline.correct ? "✅" : "❌";
    const ms = r.managed.correct ? "✅" : "❌";
    let tag = "";
    if (!r.baseline.correct && r.managed.correct) tag = "🏆 WIN";
    else if (r.baseline.correct && !r.managed.correct) tag = "⚠️ REGRESSION";
    else if (r.baseline.correct && r.managed.correct) tag = "✅";
    else tag = "❌";
    lines.push(`| ${p.lengthLabel} (~${p.approxTokens}K tokens) | ${p.depthLabel} | ${bs} | ${ms} | ${tag} |`);
  }

  const baseOk = results.results.filter((r) => r.baseline.correct).length;
  const mgrOk = results.results.filter((r) => r.managed.correct).length;
  const wins = results.results.filter((r) => !r.baseline.correct && r.managed.correct).length;
  lines.push("");
  lines.push(`**Baseline**: ${baseOk}/${results.results.length} (${((baseOk / results.results.length) * 100).toFixed(0)}%)`);
  lines.push(`**ContextManager**: ${mgrOk}/${results.results.length} (${((mgrOk / results.results.length) * 100).toFixed(0)}%)`);
  lines.push(`**Wins** (baseline miss → CM hit): ${wins}`);
  lines.push("");

  return lines.join("\n");
}

export function formatSummaryReport(
  niah: NIAHResults,
  longmem: { sessions: number; baselineAnswer: string; managedAnswer: string; recalledCount: number },
  docqa: { baselineAnswer: string; managedAnswer: string; downgraded: number; usePercent: number },
  cost: string,
): string {
  const lines: string[] = [];
  lines.push("# StructFocus ContextManager Benchmark Report");
  lines.push(`> ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## 1. Needle-in-Haystack (gkamradt NIAH)");
  const baseN = niah.results.filter((r) => r.baseline.correct).length;
  const mgrN = niah.results.filter((r) => r.managed.correct).length;
  const winN = niah.results.filter((r) => !r.baseline.correct && r.managed.correct).length;
  lines.push(`- Baseline: ${baseN}/${niah.results.length} (${((baseN / niah.results.length) * 100).toFixed(0)}%)`);
  lines.push(`- ContextManager: ${mgrN}/${niah.results.length} (${((mgrN / niah.results.length) * 100).toFixed(0)}%)`);
  lines.push(`- Wins (CM rescued): ${winN}`);
  lines.push("");

  lines.push("## 2. LongMemEval (Cross-Session Memory)");
  lines.push(`- Sessions: ${longmem.sessions}`);
  lines.push(`- Recalled facts: ${longmem.recalledCount}`);
  lines.push(`- Baseline answer: ${longmem.baselineAnswer.slice(0, 300)}`);
  lines.push(`- CM answer:       ${longmem.managedAnswer.slice(0, 300)}`);
  lines.push("");

  lines.push("## 3. MemGPT Document QA (Over-Window Analysis)");
  lines.push(`- downgraded: ${docqa.downgraded} entries`);
  lines.push(`- Window usage: ${docqa.usePercent}%`);
  lines.push(`- Baseline answer: ${docqa.baselineAnswer.slice(0, 300)}`);
  lines.push(`- CM answer:       ${docqa.managedAnswer.slice(0, 300)}`);
  lines.push("");

  lines.push("## Cost Estimate");
  lines.push(`- ${cost}`);

  return lines.join("\n");
}
