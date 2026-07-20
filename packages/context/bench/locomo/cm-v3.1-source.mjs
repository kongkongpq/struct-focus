// LoCoMo Hardcore v3.1: LongContextRecall + sourcePattern fix
// Key fix: Phase 1 tags entries with convo_id → Phase 2 recallRelevant passes sourcePattern

import { readFileSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";

const __dir = dirname(fileURLToPath(import.meta.url));
const ctxUrl = pathToFileURL("E:/Develop/SrcuctAgent/packages/context/dist/index.js").href;
const { ContextManager } = await import(ctxUrl);

const API_KEY = process.env.LOCOMO_API_KEY ?? "";
const API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const CM_WINDOW = 30000;
const MAX_QA = 15;
const MAX_CTX = 124000;
const RECALL_LIMIT = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callLLM(msgs, mt = 120) {
  for (let i = 0; i <= 6; i++) {
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        body: JSON.stringify({ model: MODEL, messages: msgs, temperature: 0, max_tokens: mt }),
      });
      const b = await r.text();
      if (!r.ok) {
        if (r.status === 429 && i < 6) { await sleep((i + 2) * 15000); continue; }
        return "ERR:" + r.status;
      }
      return JSON.parse(b)?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      if (i < 6) { await sleep((i + 2) * 15000); continue; }
      return "ERR:" + String(e).slice(0, 40);
    }
  }
}

function check(expected, got) {
  if (!got || got.startsWith("ERR")) return false;
  if (expected === "undefined" || expected === "null" || expected === "") {
    const g = got.toLowerCase();
    return g.includes("don't know") || g.includes("unsure") || g.includes("not mentioned") ||
      g.includes("unanswerable") || g.includes("cannot") || g.includes("no information");
  }
  const a = expected.toLowerCase().trim().replace(/[,.!?;:]+$/g, ""),
        b = got.toLowerCase().trim().replace(/[,.!?;:]+$/g, "");
  if (b.includes(a) || a.includes(b)) return true;
  const nA = a.match(/\d+/g), nB = b.match(/\d+/g);
  if (nA && nB && nA.some((n) => nB.includes(n))) return true;
  const wA = a.split(/\s+/).filter((w) => w.length > 3);
  if (wA.length > 1 && wA.filter((w) => b.includes(w)).length / wA.length >= 0.7) return true;
  if (wA.length === 1 && wA[0]?.length > 3 && b.includes(wA[0])) return true;
  return false;
}

function flatten(conv) {
  const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
  const lines = [];
  const keys = Object.keys(conv.conversation).filter((k) => k.startsWith("session_") && !k.endsWith("_date_time"));
  keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));
  for (const sk of keys) {
    const dt = conv.conversation[sk + "_date_time"];
    if (dt) lines.push("\n=== " + sk + " " + dt + " ===");
    for (const t of conv.conversation[sk] || []) {
      const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
      lines.push(who + ": " + (t.text || ""));
    }
  }
  return lines.join("\n");
}

// Extract keywords from QA questions + first few lines of conversation
function extractQueries(conv) {
  const A = conv.conversation.speaker_a || "A";
  const B = conv.conversation.speaker_b || "B";
  const qaQuestions = (conv.qa || []).slice(0, MAX_QA).map((q) => q.question || "");
  const allQText = qaQuestions.join(" ");
  // Extract important-looking words from questions
  const questionWords = new Set();
  for (const m of allQText.matchAll(/\b([A-Z][a-z]{3,}(?:\s+[A-Z][a-z]{3,})?)\b/g)) {
    const w = m[1];
    if (!/[Tt]he|[Tt]his|[Tt]hat|[Ww]hen|[Ww]here|[Ww]hat|[Ww]hich|[Tt]here|[Tt]hese|[Ww]ould|[Cc]ould|[Ss]hould|[Bb]ased|[Aa]bout|[Dd]uring|[Ww]ithout|[Bb]etween|[Hh]owever|[Nn]either|[Ww]hether/.test(w)) {
      questionWords.add(w);
    }
  }
  // Also add speaker names + key entities from conversation text
  const queries = [A + " " + B, ...questionWords].slice(0, 3);
  return { queries, speakerA: A, speakerB: B };
}

// ══════════════════════════════════════════════════════════
async function main() {
  console.log("=== LoCoMo Hardcore v3.1: sourcePattern fix ===");
  console.log("Fix: feed 时打 convo_N 标签，recall 时 scope 到 sourcePattern\n");

  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));

  const tmpDir = mkdtempSync(join(tmpdir(), "locomo-hc31-"));
  const cm = new ContextManager({
    maxWindow: CM_WINDOW,
    storeRoot: join(tmpDir, "content-store"),
    capsuleRoot: join(tmpDir, "capsules"),
  });
  const store = cm.getStore();

  // Phase 1: Feed convos with source tagging
  console.log("Phase 1: Feeding " + data.length + " convos (window=" + CM_WINDOW + ")");
  let totalFed = 0;
  const convoSources = []; // track source tag per convo
  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const convoTag = "convo_" + (ci + 1);
    convoSources.push(convoTag);
    const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
    const keys = Object.keys(conv.conversation).filter((k) => k.startsWith("session_") && !k.endsWith("_date_time"));
    keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));

    for (const sk of keys) {
      for (const t of conv.conversation[sk] || []) {
        const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
        const text = who + ": " + (t.text || "");
        totalFed += text.length;
        cm.appendUser(text, { source: convoTag }); // ← KEY: tag with convo id
      }
      await cm.autoManage();
    }
    console.log("  C" + (ci + 1) + " " + A + " & " + B + " tagged=" + convoTag);
  }

  await sleep(2000);
  const stats = cm.getStats();
  console.log("\nPhase 1 done: fed=" + totalFed.toLocaleString() + "c, " +
    stats.activeEntries + " active, " + stats.evictedEntries + " evicted\n");

  // Phase 2: QA with sourcePattern recall
  let blOk = 0, cmOk = 0, total = 0;
  let cmGtBl = 0, blGtCm = 0, tie = 0;
  const catBl = {}, catCm = {}, catTot = {};

  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const qas = conv.qa.slice(0, MAX_QA);
    const convoTag = convoSources[ci];
    const A = conv.conversation.speaker_a || "A";
    const B = conv.conversation.speaker_b || "B";
    const blText = flatten(conv);
    const { queries } = extractQueries(conv);

    // ─── CM: recallRelevant with sourcePattern ───
    const cmBackup = cm.toMessages("").filter((m) => m.role !== "assistant").map((m) => m.content).join("\n");
    // recall relevant entries scoped to this convo
    let totalRecalled = 0;
    for (const q of queries) {
      try {
        const results = await store.search(q, { mode: "fts5", topK: RECALL_LIMIT, sourcePattern: convoTag });
        for (const r of results) {
          cm.appendObservation(
            "[recall] " + (r.entry.source || "") + "\n" + r.entry.originalContent.slice(0, 3000),
            { source: r.entry.source, sourceType: "tool_output", taskRelevance: 0.6 }
          );
          totalRecalled++;
        }
      } catch (e) { /* search may throw if index empty */ }
    }

    const cmMsgs = cm.toMessages("");
    const cmText = cmMsgs.filter((m) => m.role !== "assistant").map((m) => m.content).join("\n");

    console.log("Convo " + (ci + 1) + " " + A + " & " + B +
      ": BL=" + blText.length.toLocaleString() + "c CM=" + cmText.length.toLocaleString() + "c " +
      "recalled=" + totalRecalled + " tag=" + convoTag);

    const sys = "Conversation between " + A + " and " + B + ". Answer concisely. If not in context: \"Not mentioned.\"";
    let bOk = 0, cOk = 0;

    for (let qi = 0; qi < qas.length; qi++) {
      const q = qas[qi];
      const exp = String(q.answer ?? "undefined");
      const cat = q.category || 1;

      const [bAns, cAns] = await Promise.all([
        callLLM([{ role: "system", content: sys }, { role: "user", content: "CONVERSATION:\n" + blText.slice(0, MAX_CTX) + "\n\nQ: " + q.question }], 100),
        callLLM([{ role: "system", content: sys }, { role: "user", content: cmText.slice(0, MAX_CTX) + "\n\nQ: " + q.question }], 100),
      ]);

      const bc = check(exp, bAns), cc = check(exp, cAns);
      if (bc) { bOk++; blOk++; catBl[cat] = (catBl[cat] || 0) + 1; }
      if (cc) { cOk++; cmOk++; catCm[cat] = (catCm[cat] || 0) + 1; }
      if (cc && !bc) cmGtBl++;
      else if (bc && !cc) blGtCm++;
      else if (bc && cc) tie++;
      total++;
      catTot[cat] = (catTot[cat] || 0) + 1;

      const mark = cc && !bc ? " ⭐CM>BL" : bc && !cc ? " ⚠BL>CM" : "";
      console.log("  Q" + (qi + 1) + " C" + cat + " BL:" + (bc ? "✓" : "✗") + " CM:" + (cc ? "✓" : "✗") + mark +
        " | " + exp.slice(0, 35) +
        " | B:" + (bAns || "").slice(0, 40).replace(/\n/g, " ") +
        " | C:" + (cAns || "").slice(0, 40).replace(/\n/g, " "));
      await sleep(1500);
    }

    console.log("  → BL " + bOk + "/" + qas.length + " CM " + cOk + "/" + qas.length + " (net: " + (cOk - bOk) + ")");

    // forget recall entries for next convo
    const forgot = cm.forgetScoped();
    console.log("  forgetScoped: " + forgot + "\n");
    await sleep(2000);
  }

  console.log("═══ FINAL ═══");
  console.log("BL: " + blOk + "/" + total + " (" + (blOk / total * 100).toFixed(1) + "%)");
  console.log("CM: " + cmOk + "/" + total + " (" + (cmOk / total * 100).toFixed(1) + "%)");
  console.log("CM>BL: " + cmGtBl + " | BL>CM: " + blGtCm + " | Tie: " + tie);
  const net = cmOk - blOk;
  console.log("Net: " + (net >= 0 ? "+" : "") + net);

  for (let c = 1; c <= 5; c++) {
    if (catTot[c] > 0) {
      const d = (catCm[c] || 0) - (catBl[c] || 0);
      console.log("  Cat" + c + ": BL " + (catBl[c] || 0) + " CM " + (catCm[c] || 0) + " /" + catTot[c] +
        " (" + (d >= 0 ? "+" : "") + d + ")");
    }
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
