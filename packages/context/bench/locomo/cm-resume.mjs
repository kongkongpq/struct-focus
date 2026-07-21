// Resume LoCoMo CM — convos 9-10 only (GLM-4-flash)
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ctxUrl = new URL("../../dist/index.js", import.meta.url).href;
const { ContextManager } = await import(ctxUrl);

const API_KEY = process.env.LOCOMO_API_KEY ?? "";
const API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callLLM(msgs, mt = 100) {
  for (let i = 0; i <= 6; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        body: JSON.stringify({ model: MODEL, messages: msgs, temperature: 0, max_tokens: mt }),
      });
      const body = await res.text();
      if (!res.ok) {
        if (res.status === 429 && i < 6) { await sleep((i + 2) * 10000); continue; }
        return "ERR:" + res.status;
      }
      return JSON.parse(body)?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      if (i < 6) { await sleep((i + 2) * 10000); continue; }
      return "ERR:" + String(e).slice(0, 40);
    }
  }
}

function check(expected, got) {
  if (!got || got.startsWith("ERR")) return false;
  if (expected === "undefined" || expected === "null" || expected === "") {
    const g = got.toLowerCase();
    return g.includes("don't know") || g.includes("unsure") || g.includes("not mentioned") || g.includes("unanswerable") || g.includes("cannot") || g.includes("no information");
  }
  const a = expected.toLowerCase().trim().replace(/[,.!?;:]+$/g, ""), b = got.toLowerCase().trim().replace(/[,.!?;:]+$/g, "");
  if (b.includes(a) || a.includes(b)) return true;
  const nA = a.match(/\d+/g), nB = b.match(/\d+/g);
  if (nA && nB && nA.some(n => nB.includes(n))) return true;
  const wA = a.split(/\s+/).filter(w => w.length > 3);
  if (wA.length > 1 && wA.filter(w => b.includes(w)).length / wA.length >= 0.7) return true;
  if (wA.length === 1 && wA[0].length > 3 && b.includes(wA[0])) return true;
  return false;
}

const CAT_NAMES = { 1: "Single-hop", 2: "Temporal", 3: "Multi-hop", 4: "Open-domain", 5: "Unanswerable" };

async function runConvo(ci, conv, maxQA) {
  const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
  const qaList = conv.qa.slice(0, maxQA);
  console.log("\n━━━ Convo " + ci + ": " + A + " & " + B + " ━━━");

  const tmpDir = mkdtempSync(join(tmpdir(), "locomo-cm2-"));
  const cm = new ContextManager({ maxWindow: 128000, storeRoot: join(tmpDir, "content-store"), capsuleRoot: join(tmpDir, "capsules") });

  const keys = Object.keys(conv.conversation).filter(k => k.startsWith("session_") && !k.endsWith("_date_time"));
  keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));
  let totalChars = 0;
  for (const sk of keys) {
    for (const t of (conv.conversation[sk] || [])) {
      const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
      const text = who + ": " + (t.text || "");
      totalChars += text.length;
      cm.appendUser(text);
    }
    const r = cm.autoManage();
    if (r.triggerLevel >= 0) console.log("  [CM] " + sk + " use%" + r.usePercent + " L" + r.triggerLevel + " evict:" + r.evictedCount);
  }
  const msgs = cm.toMessages();
  const cmText = msgs.filter(m => m.role === "system" || m.role === "user").map(m => m.content).join("\n");
  console.log("  Chars: " + totalChars.toLocaleString() + " → CM: " + cmText.length.toLocaleString() + " (" + (cmText.length / Math.max(1, totalChars) * 100).toFixed(0) + "%)");

  const sysMsg = "You are answering questions about a conversation between " + A + " and " + B +
    ". Answer concisely based ONLY on the provided context. If not in context, say \"Not mentioned.\"";
  let cmOk = 0;
  for (let qi = 0; qi < qaList.length; qi++) {
    const qa = qaList[qi];
    const expected = String(qa.answer != null ? qa.answer : "undefined");
    const cat = qa.category || 1;
    const ans = await callLLM([{ role: "system", content: sysMsg }, { role: "user", content: "CONVERSATION CONTEXT:\n" + cmText.slice(0, 124000) + "\n\nQUESTION: " + qa.question }], 100);
    const correct = check(expected, ans);
    if (correct) cmOk++;
    console.log("  Q" + (qi + 1) + " Cat" + cat + " [" + (correct ? "✓" : "✗") + "] " + expected.slice(0, 40) + " | " + (ans || "").slice(0, 60).replace(/\n/g, " "));
    await sleep(1500);
  }
  console.log("  → CM " + cmOk + "/" + qaList.length);
  return cmOk;
}

async function main() {
  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));
  // Convo 9 (index 8) and 10 (index 9)
  const c9 = await runConvo(9, data[8], 15);
  await sleep(3000);
  const c10 = await runConvo(10, data[9], 15);
  console.log("\nDone. C9=" + c9 + " C10=" + c10);
}
main().catch(e => console.error("FATAL:", e));
