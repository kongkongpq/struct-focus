// LoCoMo benchmark: Baseline vs ContextManager via chunk-summarize pipeline
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "locomo10.json");
const OUT = path.join(__dirname, "..", "LOCOMO_REPORT.md");

// ═══════ API config — key passed as env var LLM_API_KEY ═══════
const BASE = process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
const MODEL = process.env.LLM_MODEL ?? "glm-4-flash";
const KEY = process.env.LLM_API_KEY ?? "";

if (!KEY) { console.error("Missing LLM_API_KEY"); process.exit(1); }

function chatUrl(b: string) {
  const u = b.replace(/\/+$/, "");
  if (u.endsWith("/v4") || u.includes("/api/paas")) return `${u}/chat/completions`;
  if (u.includes("/compatible-mode")) return `${u}/v1/chat/completions`;
  return `${u}/v1/chat/completions`;
}
const API_URL = chatUrl(BASE);

// ═══════════ LLM API ═══════════
async function delayMs(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callLLM(messages: { role: string; content: string }[], maxTokens = 200): Promise<string> {
  for (let i = 0; i <= 5; i++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: maxTokens }),
      });
      if (!res.ok) {
        const _txt = await res.text().catch(() => "");
        if (res.status === 429 && i < 5) { await delayMs((i + 2) * 10000); continue; }
        return `ERR:${res.status}`;
      }
      const data = (await res.json()) as any;
      return data?.choices?.[0]?.message?.content ?? "";
    } catch (e: any) {
      if (i < 5) { await delayMs((i + 2) * 10000); continue; }
      return `ERR:${String(e).slice(0, 50)}`;
    }
  }
  return "ERR:retries";
}

// ═══════════ Scoring ═══════════
function fuzzyScore(expected: string, got: string): boolean {
  if (!got || got.startsWith("ERR")) return false;
  if (expected === "undefined" || expected === "null" || expected === "") {
    return got.toLowerCase().includes("don't know") || got.toLowerCase().includes("unsure") ||
      got.toLowerCase().includes("not mentioned") || got.toLowerCase().includes("unanswerable");
  }
  const a = expected.toLowerCase().trim();
  const b = got.toLowerCase().trim();
  if (b.includes(a) || a.includes(b)) return true;
  const numA = a.match(/\d+/);
  const numB = b.match(/\d+/);
  if (numA && numB && numA[0] === numB[0]) return true;
  const wordA = a.split(/\s+/)[0];
  if (wordA && wordA.length > 3 && b.includes(wordA)) return true;
  return false;
}

// ═══════════ Flatten conversation ═══════════
function flattenConversation(conv: any): string {
  const lines: string[] = [];
  const sessions: string[] = [];
  for (const k of Object.keys(conv.conversation)) {
    if (k.startsWith("session_") && !k.endsWith("_date_time")) sessions.push(k);
  }
  sessions.sort((a, b) => parseInt(a.replace("session_","")) - parseInt(b.replace("session_","")));
  const A = conv.conversation.speaker_a || "A";
  const B = conv.conversation.speaker_b || "B";
  for (const sk of sessions) {
    const date = conv.conversation[`${sk}_date_time`];
    const turns = (conv.conversation[sk] || []) as any[];
    if (date) lines.push(`\n--- ${sk} ${date} ---`);
    for (const t of turns) {
      const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
      lines.push(`${who}: ${t.text || ""}`);
    }
  }
  return lines.join("\n");
}

function chunkDialog(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + chunkSize, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > pos + chunkSize / 2) end = nl;
    }
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

// ═══════════ Run one conversation ═══════════
async function runConversation(idx: number, conv: any, maxQA: number) {
  const qaList = conv.qa.slice(0, maxQA);
  const dialog = flattenConversation(conv);
  if (idx > 0) await delayMs(4000);

  // CM: chunk → summarize each chunk
  const chunks = chunkDialog(dialog, 12000);
  const chunkSummaries: string[] = [];
  for (const chunk of chunks) {
    const sumMsg = [
      { role: "system", content: "Extract key facts/events/dates/relationships as concise bullets." },
      { role: "user", content: chunk },
    ];
    const s = await callLLM(sumMsg, 300);
    if (s && !s.startsWith("ERR")) chunkSummaries.push(s);
  }

  const cmContext = chunkSummaries.join("\n");
  const systemMsg = `Read the conversation between ${conv.conversation.speaker_a} and ${conv.conversation.speaker_b}. Answer concisely. If not in conversation, say "Not mentioned."`;

  let blOk = 0, cmOk = 0;
  const details: any[] = [];

  for (const qa of qaList) {
    const expected = String(qa.answer ?? "undefined");
    const cat = qa.category;

    // Baseline
    const blAns = await callLLM([
      { role: "system", content: systemMsg },
      { role: "user", content: `CONVERSATION:\n${dialog.slice(0, 55000)}\n\nQUESTION: ${qa.question}` },
    ], 100);

    // CM
    const cmAns = await callLLM([
      { role: "system", content: systemMsg },
      { role: "user", content: `KEY FACTS:\n${cmContext}\n\nRECENT:\n${dialog.slice(-3000)}\n\nQUESTION: ${qa.question}` },
    ], 100);

    const blS = fuzzyScore(expected, blAns);
    const cmS = fuzzyScore(expected, cmAns);
    if (blS) blOk++; if (cmS) cmOk++;
    details.push({ q: qa.question.slice(0, 60), cat, expected: expected.slice(0, 50), bl: blS, cm: cmS, blAns: blAns.slice(0, 80), cmAns: cmAns.slice(0, 80) });
    await delayMs(1200);
  }
  return { blOk, cmOk, total: qaList.length, details };
}

// ═══════════ Main ═══════════
async function main() {
  console.log("═══ LoCoMo Benchmark (ACL 2024) ═══");
  console.log(`Model: ${MODEL} | 10 convos x up-to-15 QA\n`);

  const raw = fs.readFileSync(DATA, "utf-8");
  const data = JSON.parse(raw);

  const _catNames: Record<number,string> = {1:"Single-hop",2:"Temporal",3:"Multi-hop",4:"Open-domain",5:"Unanswerable"};
  let grandBl=0, grandCm=0, grandTotal=0;
  const allResults: any[] = [];

  for (let i=0; i<data.length; i++) {
    const r = await runConversation(i, data[i], 15);
    grandBl += r.blOk; grandCm += r.cmOk; grandTotal += r.total;
    allResults.push(r);
    console.log(`Convo ${i+1}: BL ${r.blOk}/${r.total} | CM ${r.cmOk}/${r.total}`);
  }

  const lines = [
    `# LoCoMo Benchmark – Baseline vs CM`,
    `**Date**: ${new Date().toISOString()} | **Model**: ${MODEL}`,
    `**Dataset**: snap-research/locomo (ACL 2024), 10 conversations`,
    ``,
    `## Overall`,
    `| | Baseline | CM (chunk-summarize) |`,
    `|---|---|---|`,
    `| Correct | ${grandBl}/${grandTotal} (${(grandBl/grandTotal*100).toFixed(1)}%) | ${grandCm}/${grandTotal} (${(grandCm/grandTotal*100).toFixed(1)}%) |`,
    ``,
    `## Per-Conversation`,
  ];
  for (let i=0; i<allResults.length; i++) {
    const r = allResults[i];
    lines.push(`### Convo ${i+1}: BL ${r.blOk}/${r.total} | CM ${r.cmOk}/${r.total}`);
    for (const d of r.details.slice(0,6)) {
      lines.push(`- Q: ${d.q} (Cat ${d.cat}, expected: ${d.expected})`);
      lines.push(`  BL [${d.bl?"✅":"❌"}]: ${d.blAns}`);
      lines.push(`  CM [${d.cm?"✅":"❌"}]: ${d.cmAns}`);
    }
  }
  fs.writeFileSync(OUT, lines.join("\n"), "utf-8");
  console.log(`\n📄 ${OUT}`);
  console.log(`Final: BL ${grandBl}/${grandTotal} vs CM ${grandCm}/${grandTotal}`);
}
main().catch(e => { console.error(e); process.exit(1); });
