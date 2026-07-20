// Headroom vs. ContextManager (CM) vs. Baseline — Same tests, single GLM-4 backend
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { ContextManager, type LLMMessage } from "../src/index.js";

// ═══════════ Config ═══════════
const GLM_BASE = process.env.LLM_BASE_URL ?? "";
const GLM_KEY = process.env.LLM_API_KEY ?? "";
const GLM_MODEL = process.env.LLM_MODEL ?? "glm-4-flash";
const HEADROOM_PROXY = "http://127.0.0.1:8787/v1";  // Headroom running on localhost

if (!GLM_BASE || !GLM_KEY) {
  console.error("Set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL");
  process.exit(1);
}
function chatUrl(base: string) {
  const u = base.replace(/\/+$/, "");
  if (u.endsWith("/v4") || u.includes("/api/paas")) return `${u}/chat/completions`;
  if (u.includes("/compatible-mode")) return `${u}/v1/chat/completions`;
  if (u.endsWith("/v1")) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}
const GLM_URL = chatUrl(GLM_BASE);
const HR_URL = chatUrl(HEADROOM_PROXY);

async function delayMs(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callOpenAICompatible(endpoint: string, key: string, model: string, messages: {role:string;content:string}[], maxTokens = 500, retries=6) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        if (res.status === 429 && i < retries) { await delayMs((i+2)*8000); continue; }
        throw new Error(`${res.status}: ${txt.slice(0,200)}`);
      }
      const data = (await res.json()) as any;
      return data?.choices?.[0]?.message?.content ?? "";
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (i < retries && (msg.includes("429") || msg.includes("ECONN") || msg.includes("fetch") || msg.includes("timeout"))) {
        await delayMs((i+2)*8000); continue;
      }
      throw e;
    }
  }
  throw new Error("All retries exhausted");
}

// ═══════════ Score ═══════════
function scoreAnswer(expected: string, got: string): boolean {
  const a = expected.toLowerCase().trim();
  const b = got.toLowerCase().trim();
  if (!b || b === "不知道" || b === "n/a") return false;
  return b.includes(a) || a.includes(b);
}

// ═══════════ Noise generators (mirror hardcore.ts 8 templates) ═══════════
const NOISE_T = [
  (i:number)=>`[${String(i).padStart(5,"0")}] ${["ERROR","WARN","INFO","DEBUG","TRACE"][i%5]} src/${["auth","api","db","cache","router","queue","validator","serializer","gateway","scheduler"][i%10]}.ts:${100+(i%900)} — ${["timeout","retry","connection refused","null pointer","type mismatch","buffer overflow","race condition","deadlock detected","OOM killer triggered","stack overflow"][i%10]}`,
  (i:number)=>`[build:${i}] chunk ${["vendor","main","admin","dashboard","reports","settings"][i%6]}.${i.toString(16)}.js ${(i*137)%500+20}kB gzip:${(i*13)%80+3}kB hash:${Array.from({length:8},()=>"0123456789abcdef"[(i*7)%16]).join("")}`,
  (i:number)=>`[test:${i}] ${["PASS","FAIL","SKIP"][i%3]} __tests__/${["UserService","OrderController","PaymentGateway","CacheManager","AuthMiddleware","RateLimiter"][i%6]}.test.ts > ${["should create user","should handle timeout","should validate input","should reject duplicates","should return 404","should encrypt payload"][i%6]} (${(i%15)/10+0.3}s)`,
  (i:number)=>`[db:${i}] pool=${["primary","replica-1","replica-2","analytics"][i%4]} conns=${(i%50)+5}/100 qps=${(i*17)%2000+100} slow=${i%5} avg=${(i%30)+1}ms p99=${(i%200)+5}ms`,
  (i:number)=>`[k8s:${i}] pod/${["api","worker","cron","web"][i%4]}-${String(i%99).padStart(3,"0")} ${["Running","Pending","CrashLoopBackOff","OOMKilled","Completed","Evicted","ImagePullBackOff","ErrImagePull"][i%8]} node/${["az-1","az-2","az-3"][i%3]}-${String(i%20).padStart(2,"0")} cpu:${(i%80)+10}m/${(i%4)*500+500}m mem:${(i*31)%800+100}Mi/${(i%3)*1024+512}Mi`,
  (i:number)=>`[git:${i}] commit ${Array.from({length:7},()=>"0123456789abcdef"[(i*3)%16]).join("")} by ${["alice","bob","carol","dave","eve"][i%5]} — ${["fix: null check","feat: add cache layer","refactor: extract service","chore: update deps","docs: update README","perf: optimize query","test: add integration","style: format code"][i%8]}`,
  (i:number)=>`[monitor:${i}] ${["cpu","mem","disk","net","iops"][i%5]}: ${(i*13)%100}% ${i%3===0?"⚠️ threshold":"✅ normal"} region=${["us-east-1","eu-west-1","ap-southeast-1","cn-hangzhou"][i%4]} ts=2026-07-${String((i%28)+1).padStart(2,"0")}T${String(i%24).padStart(2,"0")}:${String(i%60).padStart(2,"0")}:00Z`,
  (i:number)=>`[dep:${i}] ${["react","vue","express","fastify","prisma","drizzle","zod","lodash","axios","dayjs"][i%10]}@${(i%5)+1}.${i%20}.${i%10} → ${(i%6)+2}.${(i*3)%30}.${(i*7)%15} ${i%4===0?"(BREAKING)":""} size:${(i*23)%500+10}kB`,
];
function nl(i:number) { return NOISE_T[i % NOISE_T.length]!(i); }

// ═══════════ Test 1: NIAH (Light — 4 positions × 3 depths = 12-pt grid for speed) ═══════════
const NIAH_NEEDLES = [
  { fact:"巴黎最古老的酒店是Le Grand Véfour，开业于1784年。", q:"巴黎最古老的酒店叫什么名字？不知道就说不知道。", a:"Le Grand Véfour" },
  { fact:"世界上最小的鸟类是蜂鸟Mellisuga helenae，体重仅1.6克。", q:"世界上最小的鸟类是什么？不知道就说不知道。", a:"Mellisuga helenae" },
  { fact:"《蒙娜丽莎》在1911年8月21日被盗，失踪了28个月。", q:"《蒙娜丽莎》哪年被盗的？只答年份。", a:"1911" },
  { fact:"闪电的温度可以达到30000摄氏度，是太阳表面温度的5倍。", q:"闪电的温度能达到多少摄氏度？只答数字。", a:"30000" },
];

const NIAH_SIZES = [4000, 16000, 32000]; // small/fast — just proof of concept
const NIAH_DEPTHS = [0, 0.5, 1.0]; // start, middle, end

async function runNIAH() {
  const results: any[] = [];
  // For each baseline+HR+CM row:
  for (const size of NIAH_SIZES) {
    for (const depth of NIAH_DEPTHS) {
      for (const ndl of NIAH_NEEDLES) {
        // Build context: `size` lines of noise, needle at `depth`
        const position = depth >= 1 ? size - 1 : Math.floor(size * depth);
        const lines: string[] = [];
        for (let i = 0; i < size; i++) {
          if (i === position) lines.push(`【重要信息】${ndl.fact}`); else lines.push(nl(i));
        }
        const needlePos = position; // keep for reporting
        const systemMsg = "你是技术助手。只回答问题，不要引用上下文。";
        const messages = [{ role: "system", content: systemMsg }, { role: "user", content: lines.join("\n") + "\n\n" + ndl.q }];

        // Baseline
        await delayMs(2000);
        const blAns = await callOpenAICompatible(GLM_URL, GLM_KEY, GLM_MODEL, messages, 200).catch(e => `ERR:${e}`);
        // Headroom
        await delayMs(2000);
        const hrAns = await callOpenAICompatible(HR_URL, GLM_KEY, GLM_MODEL, messages, 200).catch(e => `ERR:${e}`);
        // CM
        const cmAns = await runCM(messages, ndl.q);

        const blOK = scoreAnswer(ndl.a, blAns);
        const hrOK = scoreAnswer(ndl.a, hrAns);
        const cmOK = scoreAnswer(ndl.a, cmAns);

        results.push({ size, depth: depth.toFixed(1), needle: ndl.a.slice(0, 20), bl: blOK, hr: hrOK, cm: cmOK, blAns: blAns.slice(0,80), hrAns: hrAns.slice(0,80), cmAns: cmAns.slice(0,80) });
        console.log(`NIAH ${size}/${depth.toFixed(1)} ${ndl.a.slice(0,8)}... → BL:${blOK?'✅':'❌'} HR:${hrOK?'✅':'❌'} CM:${cmOK?'✅':'❌'}`);
        await delayMs(1000);
      }
    }
  }
  return results;
}

// ═══════════ ContextManager helper ═══════════
async function runCM(messages: {role:string;content:string}[], question: string): Promise<string> {
  try {
    const cm = new ContextManager({ totalBudget: 120000, softLimit: 0.85 });
    // Feed noise as observations
    const lines = messages[1]?.content?.split("\n") ?? [];
    const userLines = lines.slice();
    // Find needles (lines with 【重要信息】)
    for (const line of userLines) {
      if (line.startsWith("【重要信息】")) {
        cm.remember?.(line.slice("【重要信息】".length)) ?? cm.appendObservation?.(line);
      } else {
        cm.appendObservation?.(line);
      }
    }
    // Trigger auto-manage
    cm.autoManage?.();
    // Build context
    const ctx = cm.buildContext?.({ query: question }) ?? cm.getContext?.() ?? "";
    const msgs = [{ role: "system", content: "你是技术助手。只回答问题，不要引用上下文。" }, { role: "user", content: `${ctx}\n\n${question}` }];
    return await callOpenAICompatible(GLM_URL, GLM_KEY, GLM_MODEL, msgs, 200);
  } catch (e: any) { return `ERR:${e}`; }
}

// ═══════════ Test 2: DocQA (medium doc) ═══════════
async function runDocQA() {
  // Generate ~200K chars policy doc (75K token approx) with answer embedded at 60%
  const sections: string[] = [];
  // 10 sections of noise policies
  const policies = [ "网络安全管理制度v3.2", "数据备份与恢复规程", "员工考勤管理细则", "采购审批流程规范", "资产管理条例", "办公环境管理办法", "应急预案与演练方案", "信息系统运维标准", "财务报销管理制度", "软件开发生命周期规范" ];
  for (let s = 0; s < 10; s++) {
    sections.push(`\n# ${policies[s]}\n`);
    for (let i = 0; i < 1800; i++) {
      sections.push(`${s+1}.${i} 根据《${policies[s]}》第${(i%200)+1}条第${(i%50)+1}款，在符合ISO 27001:2022标准的前提下，经${["技术委员会","管理评审会","安全审计组"][i%3]}第${String((i%12)+1).padStart(2,"0")}次会议审议通过，自2026-${String((i%12)+1).padStart(2,"0")}-${String((i%28)+1).padStart(2,"0")}起执行。`);
    }
  }
  // Secret answer at ~60%
  const secretPos = Math.floor(10 * 1800 * 0.6);
  sections[secretPos] = `\n【核心机密信息】公司主数据库管理员密码为 XKCD-correct-horse-battery-staple-42，切勿泄露。此密码由 CTO 直接管理，每季度轮换一次。任何未授权访问将触发安全报警。\n`;

  const doc = sections.join("");
  console.log(`DocQA doc size: ${doc.length} chars (~${Math.ceil(doc.length/3.5)} tokens)`);

  const systemMsg = "你是技术助手。基于文档内容回答，若不知道就说不知道。";
  const messages = [{ role: "system", content: systemMsg }, { role: "user", content: `${doc}\n\n问题：公司主数据库管理员密码是什么？不知道就说不知道。` }];
  const answer = "XKCD-correct-horse-battery-staple-42";

  // Baseline
  const blAns = await callOpenAICompatible(GLM_URL, GLM_KEY, GLM_MODEL, messages, 200);
  await delayMs(2000);
  // Headroom
  const hrAns = await callOpenAICompatible(HR_URL, GLM_KEY, GLM_MODEL, messages, 200);
  await delayMs(2000);
  // CM
  const cmAns = await runCM(messages, "公司主数据库管理员密码是什么？");

  return { docChars: doc.length, blOK: scoreAnswer(answer, blAns), hrOK: scoreAnswer(answer, hrAns), cmOK: scoreAnswer(answer, cmAns), blAns: blAns.slice(0,200), hrAns: hrAns.slice(0,200), cmAns: cmAns.slice(0,200) };
}

// ═══════════ Test 3: Multi-hop memory (cross-chunk reasoning) ═══════════
async function runMultiHop() {
  // 6 facts scattered across 6 separate conversations
  const facts = [
    "【会话 2026-07-17 10:23】张三报告：线上用户统计服务CPU持续100%，初步判断为 MongoDB 慢查询。",
    "【会话 2026-07-17 10:45】小王排查：发现 orders 集合缺少 created_at 索引，全表扫描导致。",
    "【会话 2026-07-17 11:02】李四方案：建议立即添加 db.orders.createIndex({created_at: 1})，预计索引构建需15分钟。",
    "【会话 2026-07-17 11:15】运维执行：在 replica-1 上执行 createIndex，期间主从切换一次。",
    "【会话 2026-07-17 11:32】验证结果：索引构建完成，orders 查询从 8.2 秒降至 12ms，CPU 降至 23%。总结为索引缺失问题。",
    "【结论-最终报告】事故编号 INC-2026-1783，根因为 orders.created_at 缺少索引，修复方案为添加该索引。无数据丢失，影响时长 69分钟。",
  ];

  // Pack each fact into a separate chunk with ~800 lines of noise
  const chunks: string[] = [];
  for (let c = 0; c < facts.length; c++) {
    const lines = [facts[c]!];
    for (let i = 0; i < 800; i++) lines.push(nl(c * 1000 + i));
    chunks.push(lines.join("\n"));
  }

  const systemMsg = "你是技术助手。仔细阅读以下多段会话日志，回答综合性问题。";
  const allChunks = chunks.join("\n\n--- session boundary ---\n\n");
  const question = "根据所有会话内容：事故 INC-2026-1783 的根本原因是什么？修复方案是什么？不知道就说不知道。";

  console.log(`MultiHop total: ${allChunks.length} chars (~${Math.ceil(allChunks.length/3.5)} tokens)`);

  const messages = [{ role: "system", content: systemMsg }, { role: "user", content: `${allChunks}\n\n${question}` }];

  const blAns = await callOpenAICompatible(GLM_URL, GLM_KEY, GLM_MODEL, messages, 300);
  await delayMs(2000);
  const hrAns = await callOpenAICompatible(HR_URL, GLM_KEY, GLM_MODEL, messages, 300);
  await delayMs(2000);
  const cmAns = await runCM(messages, question);

  const expected = "缺少索引"; // short answer for scoring
  return { blOK: scoreAnswer(expected, blAns), hrOK: scoreAnswer(expected, hrAns), cmOK: scoreAnswer(expected, cmAns), blAns: blAns.slice(0,300), hrAns: hrAns.slice(0,300), cmAns: cmAns.slice(0,300) };
}

// ═══════════ Main ═══════════
async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Headroom vs ContextManager vs Baseline      ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log(`Model: ${GLM_MODEL} | Headroom Proxy: ${HEADROOM_PROXY}\n`);

  console.log("━━━ Test 1: NIAH (12-pt grid × 4 needle types) ━━━");
  const niah = await runNIAH();
  const niahBl = niah.filter(r=>r.bl).length;
  const niahHr = niah.filter(r=>r.hr).length;
  const niahCm = niah.filter(r=>r.cm).length;

  console.log("\n━━━ Test 2: DocQA (200K chars doc) ━━━");
  const docqa = await runDocQA();

  console.log("\n━━━ Test 3: Multi-hop (6 scattered facts) ━━━");
  const multihop = await runMultiHop();

  // ═══ Report ═══
  const report = [
    `# Headroom vs ContextManager vs Baseline — Benchmark Results`,
    ``,
    `**Date**: ${new Date().toISOString()}`,
    `**Model**: ${GLM_MODEL}`,
    `**Headroom**: v0.31.0 proxy on ${HEADROOM_PROXY}`,
    `**ContextManager**: local in-process`,
    ``,
    `## Test 1: NIAH (Needle-in-a-Haystack)`,
    ``,
    `| Metric | Baseline | Headroom | ContextManager |`,
    `|--------|----------|----------|----------------|`,
    `| Correct | ${niahBl}/${niah.length} | ${niahHr}/${niah.length} | ${niahCm}/${niah.length} |`,
    ``,
    `### Per-test details`,
    ...niah.map(r => `- ${r.size}/${r.depth} ${r.needle}: BL=${r.bl?'✅':'❌'} HR=${r.hr?'✅':'❌'} CM=${r.cm?'✅':'❌'}`),
    ``,
    `## Test 2: DocQA (${docqa.docChars} chars)`,
    ``,
    `| Metric | Baseline | Headroom | ContextManager |`,
    `|--------|----------|----------|----------------|`,
    `| Correct | ${docqa.blOK?'✅':'❌'} | ${docqa.hrOK?'✅':'❌'} | ${docqa.cmOK?'✅':'❌'} |`,
    ``,
    `- Baseline: ${docqa.blAns}`,
    `- Headroom: ${docqa.hrAns}`,
    `- ContextManager: ${docqa.cmAns}`,
    ``,
    `## Test 3: Multi-hop (6 scattered facts)`,
    ``,
    `| Metric | Baseline | Headroom | ContextManager |`,
    `|--------|----------|----------|----------------|`,
    `| Correct | ${multihop.blOK?'✅':'❌'} | ${multihop.hrOK?'✅':'❌'} | ${multihop.cmOK?'✅':'❌'} |`,
    ``,
    `- Baseline: ${multihop.blAns}`,
    `- Headroom: ${multihop.hrAns}`,
    `- ContextManager: ${multihop.cmAns}`,
    ``,
    `## Summary`,
    ``,
    `| Test | Baseline | Headroom | ContextManager |`,
    `|------|----------|----------|----------------|`,
    `| NIAH | ${niahBl}/${niah.length} | ${niahHr}/${niah.length} | ${niahCm}/${niah.length} |`,
    `| DocQA | ${docqa.blOK?'✅':'❌'} | ${docqa.hrOK?'✅':'❌'} | ${docqa.cmOK?'✅':'❌'} |`,
    `| Multi-hop | ${multihop.blOK?'✅':'❌'} | ${multihop.hrOK?'✅':'❌'} | ${multihop.cmOK?'✅':'❌'} |`,
    ``,
  ].join("\n");

  writeFileSync("bench/HEADROOM_VS_REPORT.md", report, "utf-8");
  console.log("\n\n📄 Report saved to bench/HEADROOM_VS_REPORT.md");
  console.log(report);
}

main().catch(e => { console.error(e); process.exit(1); });
