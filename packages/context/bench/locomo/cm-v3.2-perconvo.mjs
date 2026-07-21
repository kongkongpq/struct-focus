// LoCoMo Hardcore v3.2: Per-convo fresh CM (correct architecture)
// Key: 每个 convo 独立 CM 实例 → feed → autoManage 驱逐 → capsule → recall
// 对照 Baseline 是全量对话文本

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
const CM_WINDOW = 16000; // ~50K chars window — tight enough to force eviction
const RECALL_LIMIT = 8;
const MAX_CTX = 124000;
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

// ══════════════════════════════════════════════════════════
async function main() {
  console.log("=== LoCoMo Hardcore v3.2: Per-convo fresh CM ===\n");
  console.log("Window: " + CM_WINDOW + " tok | Model: " + MODEL + " | Recall limit: " + RECALL_LIMIT + "\n");

  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));

  let blTotal = 0, cmTotal = 0, totalQa = 0;
  let cmGtBl = 0, blGtCm = 0, tie = 0;
  const catBl = {}, catCm = {}, catTot = {};

  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const qas = conv.qa;
    const A = conv.conversation.speaker_a || "A";
    const B = conv.conversation.speaker_b || "B";
    const blText = flatten(conv);

    // ─── Per-convo fresh CM instance ───
    const tmpDir = mkdtempSync(join(tmpdir(), "locomo-c" + (ci + 1) + "-"));
    const cm = new ContextManager({
      maxWindow: CM_WINDOW,
      storeRoot: join(tmpDir, "content-store"),
      capsuleRoot: join(tmpDir, "capsules"),
    });
    const store = cm.getStore();
    const convoTag = "convo_" + (ci + 1);

    // Feed 该 convo 的所有消息
    let totalFed = 0;
    const keys = Object.keys(conv.conversation).filter((k) => k.startsWith("session_") && !k.endsWith("_date_time"));
    keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));

    for (const sk of keys) {
      for (const t of conv.conversation[sk] || []) {
        const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
        const text = who + ": " + (t.text || "");
        totalFed += text.length;
        cm.appendUser(text, { source: convoTag });
      }
      await cm.autoManage();
    }
    await sleep(1000);
    const stats = cm.getStats();
    const evicted = stats.evictedEntries || 0;

    // 从驱逐的内容中召回
    let recalled = 0;
    const names = [A, B].flatMap((n) => n.split(/\s+/)).filter((w) => w.length > 1);
    for (const name of [...new Set(names)]) {
      try {
        const results = await store.search(name, {
          mode: "bm25",
          topK: RECALL_LIMIT,
          sourcePattern: convoTag,
        });
        for (const r of results) {
          cm.appendObservation(
            "[recall] " + (r.entry.source || "") + "\n" + r.entry.originalContent.slice(0, 2500),
            { source: r.entry.source, sourceType: "tool_output", taskRelevance: 0.5 }
          );
          recalled++;
        }
      } catch (_) {}
    }

    // 构建 CM 上下文
    const cmMsgs = cm.toMessages("");
    const cmText = cmMsgs.filter((m) => m.role !== "assistant").map((m) => m.content).join("\n");

    const blChars = blText.length;
    const cmChars = cmText.length;
    const evictPct = totalFed > 0 ? (evicted / Math.max(1, totalFed / 500)) * 100 : 0;

    console.log("C" + (ci + 1) + " " + A + " & " + B +
      " | fed=" + totalFed.toLocaleString() + "c" +
      " active=" + stats.activeEntries +
      " evicted=" + evicted +
      " recalled=" + recalled +
      " | BL=" + blChars.toLocaleString() + "c" +
      " CM=" + cmChars.toLocaleString() + "c");

    const sys = "Conversation between " + A + " and " + B +
      ". Answer concisely from the conversation. If not in context: \"Not mentioned.\"";
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
      if (bc) { bOk++; blTotal++; catBl[cat] = (catBl[cat] || 0) + 1; }
      if (cc) { cOk++; cmTotal++; catCm[cat] = (catCm[cat] || 0) + 1; }
      if (cc && !bc) cmGtBl++;
      else if (bc && !cc) blGtCm++;
      else if (bc && cc) tie++;
      totalQa++;
      catTot[cat] = (catTot[cat] || 0) + 1;

      const mark = cc && !bc ? " ⭐CM>BL" : bc && !cc ? " ⚠BL>CM" : "";
      console.log("  Q" + (qi + 1) + " C" + cat + " BL:" + (bc ? "✓" : "✗") + " CM:" + (cc ? "✓" : "✗") + mark +
        " | " + exp.slice(0, 30) +
        " | B:" + (bAns || "").slice(0, 35).replace(/\n/g, " ") +
        " | C:" + (cAns || "").slice(0, 35).replace(/\n/g, " "));
      await sleep(1500);
    }

    console.log("  → BL " + bOk + "/" + qas.length + " CM " + cOk + "/" + qas.length +
      " (net: " + (cOk - bOk) + ")\n");
    await sleep(2000);
  }

  console.log("═══ FINAL ═══");
  console.log("BL: " + blTotal + "/" + totalQa + " (" + (blTotal / totalQa * 100).toFixed(1) + "%)");
  console.log("CM: " + cmTotal + "/" + totalQa + " (" + (cmTotal / totalQa * 100).toFixed(1) + "%)");
  console.log("CM>BL: " + cmGtBl + " | BL>CM: " + blGtCm + " | Tie: " + tie);
  const net = cmTotal - blTotal;
  console.log("Net: " + (net >= 0 ? "+" : "") + net);

  for (let c = 1; c <= 5; c++) {
    if (catTot[c] > 0) {
      const d = (catCm[c] || 0) - (catBl[c] || 0);
      console.log("  Cat" + c + ": BL " + (catBl[c] || 0) + " CM " + (catCm[c] || 0) +
        " /" + catTot[c] + " (" + (d >= 0 ? "+" : "") + d + ")");
    }
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
