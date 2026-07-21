// LoCoMo Hardcore v2: all 10 convos → CM (small window → mass eviction) → recall + QA
// KEY FIX: await cm.autoManage() (was fire-and-forget Promise)
import { readFileSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";

const __dir = dirname(fileURLToPath(import.meta.url));
const ctxUrl = new URL("../../dist/index.js", import.meta.url).href;
const { ContextManager } = await import(ctxUrl);

const API_KEY = process.env.LOCOMO_API_KEY ?? "";
const API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const MAX_QA = 15;
const CM_WINDOW = 30000; // Very small to force early/often eviction
const MAX_CTX = 124000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callLLM(msgs, mt = 120) {
  for (let i = 0; i <= 6; i++) {
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY }, body: JSON.stringify({ model: MODEL, messages: msgs, temperature: 0, max_tokens: mt }) });
      const b = await r.text();
      if (!r.ok) { if (r.status === 429 && i < 6) { await sleep((i + 2) * 15000); continue; } return "ERR:" + r.status; }
      return JSON.parse(b)?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) { if (i < 6) { await sleep((i + 2) * 15000); continue; } return "ERR:" + String(e).slice(0, 40); }
  }
}

function check(expected, got) {
  if (!got || got.startsWith("ERR")) return false;
  if (expected === "undefined" || expected === "null" || expected === "") { const g = got.toLowerCase(); return g.includes("don't know") || g.includes("unsure") || g.includes("not mentioned") || g.includes("unanswerable") || g.includes("cannot") || g.includes("no information"); }
  const a = expected.toLowerCase().trim().replace(/[,.!?;:]+$/g, ""), b = got.toLowerCase().trim().replace(/[,.!?;:]+$/g, "");
  if (b.includes(a) || a.includes(b)) return true;
  const nA = a.match(/\d+/g), nB = b.match(/\d+/g);
  if (nA && nB && nA.some(n => nB.includes(n))) return true;
  const wA = a.split(/\s+/).filter(w => w.length > 3);
  if (wA.length > 1 && wA.filter(w => b.includes(w)).length / wA.length >= 0.7) return true;
  if (wA.length === 1 && wA[0]?.length > 3 && b.includes(wA[0])) return true;
  return false;
}

function flatten(conv) {
  const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
  const lines = [];
  const keys = Object.keys(conv.conversation).filter(k => k.startsWith("session_") && !k.endsWith("_date_time"));
  keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));
  for (const sk of keys) {
    const dt = conv.conversation[sk + "_date_time"];
    if (dt) lines.push("\n=== " + sk + " " + dt + " ===");
    for (const t of (conv.conversation[sk] || [])) {
      const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
      lines.push(who + ": " + (t.text || ""));
    }
  }
  return lines.join("\n");
}

const CAT_NAMES = { 1: "Single-hop", 2: "Temporal", 3: "Multi-hop", 4: "Open-domain", 5: "Unanswerable" };

async function main() {
  console.log("=== LoCoMo Hardcore v2: CM window=" + CM_WINDOW + " ===");
  console.log("Model: " + MODEL + " | BL = per-convo full text | CM = mass-evicted + ContentStore recall\n");

  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));

  // Phase 1: Feed all 10 convos through CM with tiny window → massive autoManage
  const tmpDir = mkdtempSync(join(tmpdir(), "locomo-hc2-"));
  const cm = new ContextManager({ maxWindow: CM_WINDOW, storeRoot: join(tmpDir, "content-store"), capsuleRoot: join(tmpDir, "capsules") });

  console.log("Feeding " + data.length + " convos...");
  let totalFed = 0;
  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
    // roadmap 一.1：每轮对话显式开启独立对话，归档上一轮并打 conversationId 标记
    cm.newConversation("c" + (ci + 1));
    const keys = Object.keys(conv.conversation).filter(k => k.startsWith("session_") && !k.endsWith("_date_time"));
    keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));

    for (const sk of keys) {
      for (const t of (conv.conversation[sk] || [])) {
        const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
        totalFed += (who + ": " + (t.text || "")).length;
        cm.appendUser(who + ": " + (t.text || ""));
      }
      const r = await cm.autoManage(); // ← CRITICAL: await
      if (r.triggerLevel >= 0) {
        console.log("  C" + (ci + 1) + " " + sk + ": " + r.usePercent + "% L" + r.triggerLevel + " evict:" + r.evictedCount + " comp:" + r.compressedCount + " trunc:" + r.truncatedCount);
      }
    }
  }
  
  // Wait for ContentStore async writes to complete
  await sleep(2000);

  const stats = cm.getStats();
  console.log("\nCM final: fed=" + totalFed.toLocaleString() + " chars, " + stats.activeEntries + " active, " + stats.evictedEntries + " evicted, " + stats.totalTokens + " tok / " + CM_WINDOW + " (" + stats.usePercent + "%)\n");

  // Phase 2: Run QA — per convo, BL vs CM+recall
  let blOk = 0, cmOk = 0, total = 0, catBl = {}, catCm = {}, catTot = {};

  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci], qas = conv.qa.slice(0, MAX_QA);
    const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
    const blText = flatten(conv);

    // Recall relevant context from ContentStore by question text
    let recalled = 0;
    for (const qa of qas) {
      const result = await cm.recallRelevant(qa.question, 3);
      if (result.entries.length > 0) {
        cm.injectRecall(result);
        recalled += result.entries.length;
      }
    }

    // Build CM context (injected recalls are now in entries)
    const msgs = cm.toMessages("");
    const cmContent = msgs.filter(m => m.role !== "assistant").map(m => m.content).join("\n");
    const cmText = "=== CONVERSATION CONTEXT ===\n" + cmContent;

    // Clean up injected recalls after this convo's QA
    cm.forgetScoped();

    console.log("Convo " + (ci + 1) + " " + A + " & " + B + ": BL=" + blText.length.toLocaleString() + "c CM=" + cmText.length.toLocaleString() + "c recalled=" + recalled);

    const sys = "Conversation between " + A + " and " + B + ". Answer concisely. If not in context: \"Not mentioned.\"";
    let bOk = 0, cOk = 0;

    for (let qi = 0; qi < qas.length; qi++) {
      const q = qas[qi], exp = String(q.answer ?? "undefined"), cat = q.category || 1;
      const [bAns, cAns] = await Promise.all([
        callLLM([{ role: "system", content: sys }, { role: "user", content: "CONVERSATION:\n" + blText.slice(0, MAX_CTX) + "\n\nQ: " + q.question }], 100),
        callLLM([{ role: "system", content: sys }, { role: "user", content: cmText.slice(0, MAX_CTX) + "\n\nQ: " + q.question }], 100),
      ]);
      const bc = check(exp, bAns), cc = check(exp, cAns);
      if (bc) { bOk++; blOk++; catBl[cat] = (catBl[cat] || 0) + 1; }
      if (cc) { cOk++; cmOk++; catCm[cat] = (catCm[cat] || 0) + 1; }
      total++; catTot[cat] = (catTot[cat] || 0) + 1;
      console.log("  Q" + (qi + 1) + " C" + cat + " BL:" + (bc ? "✓" : "✗") + " CM:" + (cc ? "✓" : "✗") + " | " + exp.slice(0, 35) + " | B:" + (bAns || "").slice(0, 45).replace(/\n/g, " ") + " | C:" + (cAns || "").slice(0, 45).replace(/\n/g, " "));
      await sleep(1500);
    }
    console.log("  → BL " + bOk + "/" + qas.length + " CM " + cOk + "/" + qas.length);
    if (ci < data.length - 1) await sleep(2000);
  }

  console.log("\n═══ FINAL ═══");
  console.log("BL: " + blOk + "/" + total + " (" + (blOk / total * 100).toFixed(1) + "%)");
  console.log("CM: " + cmOk + "/" + total + " (" + (cmOk / total * 100).toFixed(1) + "%)");
  for (let c = 1; c <= 5; c++) if (catTot[c] > 0) console.log("  Cat" + c + ": BL " + (catBl[c] || 0) + " CM " + (catCm[c] || 0) + " /" + catTot[c]);
}
main().catch(e => console.error("FATAL:", e));
