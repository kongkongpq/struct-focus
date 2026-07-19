// LoCoMo Baseline — DeepSeek V3 (deepseek-chat)
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_KEY = "***REMOVED***";
const API = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";
const MAX_QA = 15; // 15 per convo, 10 convos = 150 total

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callLLM(msgs, mt) {
  mt = mt || 80;
  for (let i = 0; i <= 6; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        body: JSON.stringify({ model: MODEL, messages: msgs, temperature: 0, max_tokens: mt }),
      });
      const body = await res.text();
      if (!res.ok) {
        if (res.status === 429 && i < 6) { console.log(`  429 retry ${i + 1} (${res.headers.get('retry-after') || 'no-retry-after'})`); await sleep((i + 2) * 8000); continue; }
        console.log(`  API ERR ${res.status}: ${body.slice(0, 200)}`);
        return "ERR:" + res.status;
      }
      const d = JSON.parse(body);
      return d?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      if (i < 6) { console.log(`  net err retry ${i + 1}: ${String(e).slice(0,60)}`); await sleep((i + 2) * 8000); continue; }
      return "ERR:" + String(e).slice(0, 40);
    }
  }
  return "ERR:retries";
}

function check(expected, got) {
  if (!got || got.startsWith("ERR")) return false;
  if (expected === "undefined" || expected === "null" || expected === "") {
    const g = got.toLowerCase();
    return g.includes("don't know") || g.includes("unsure") || g.includes("not mentioned") || g.includes("unanswerable") || g.includes("not stated") || g.includes("not specified") || g.includes("cannot") || g.includes("can't") || g.includes("no information") || g.includes("unclear");
  }
  // normalize
  const a = expected.toLowerCase().trim().replace(/[,.!?;:]+$/g, ""), b = got.toLowerCase().trim().replace(/[,.!?;:]+$/g, "");
  if (b.includes(a) || a.includes(b)) return true;
  // numeric match
  const nA = a.match(/\d+/g), nB = b.match(/\d+/g);
  if (nA && nB && nA.some(n => nB.includes(n))) return true;
  // key word overlap
  const wA = a.split(/\s+/).filter(w => w.length > 3);
  if (wA.length > 1) {
    const hit = wA.filter(w => b.includes(w)).length;
    if (hit / wA.length >= 0.7) return true;
  }
  // single key word
  if (wA.length === 1 && wA[0].length > 3 && b.includes(wA[0])) return true;
  return false;
}

function flatten(conv) {
  const lines = [];
  const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
  const keys = Object.keys(conv.conversation).filter(k => k.startsWith("session_") && !k.endsWith("_date_time"));
  keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));
  for (const sk of keys) {
    const date = conv.conversation[sk + "_date_time"];
    if (date) lines.push("\n--- " + sk + " " + date + " ---");
    for (const t of (conv.conversation[sk] || [])) {
      const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
      lines.push(who + ": " + (t.text || ""));
    }
  }
  return lines.join("\n").slice(0, 128000); // deepseek-chat 128K context, cap for safety
}

const CAT_NAMES = { 1: "Single-hop", 2: "Temporal", 3: "Multi-hop", 4: "Open-domain", 5: "Unanswerable" };

async function main() {
  console.log("=== LoCoMo Baseline — DeepSeek V3 ===");
  console.log("Model: " + MODEL + " | 10 convos × " + MAX_QA + " QA\n");

  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));
  let grandTotal = 0, grandOk = 0;
  let catOk = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, catTot = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const allResults = [];

  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const qaList = conv.qa.slice(0, MAX_QA);
    const dialog = flatten(conv);

    console.log("\n━━━ Convo " + (ci + 1) + "/10: " + conv.conversation.speaker_a + " & " + conv.conversation.speaker_b + " ━━━");
    console.log("  Dialog: " + dialog.length.toLocaleString() + " chars, QA: " + qaList.length);

    const sysMsg = "You are answering questions about a conversation between " + conv.conversation.speaker_a + " and " + conv.conversation.speaker_b +
      ". Read the ENTIRE conversation carefully, then answer each question concisely based ONLY on what is stated. " +
      "For dates, be precise. If the answer is not in the conversation, say exactly \"Not mentioned.\"";

    let ok = 0;
    const deets = [];

    for (let qi = 0; qi < qaList.length; qi++) {
      const qa = qaList[qi];
      const expected = String(qa.answer != null ? qa.answer : "undefined");
      const cat = qa.category || 1;

      const ans = await callLLM([
        { role: "system", content: sysMsg },
        { role: "user", content: "CONVERSATION:\n" + dialog + "\n\nQUESTION: " + qa.question },
      ], 120);

      const correct = check(expected, ans);
      if (correct) { ok++; grandOk++; catOk[cat] = (catOk[cat] || 0) + 1; }
      grandTotal++; catTot[cat] = (catTot[cat] || 0) + 1;

      const icon = correct ? "✓" : "✗";
      const tag = "Cat" + cat + " " + CAT_NAMES[cat].slice(0, 4);

      deets.push({
        qi: qi + 1, cat, tag,
        question: qa.question.slice(0, 100),
        expected: expected.slice(0, 60),
        correct, ans: ans?.slice(0, 80)?.replace(/\n/g, " "),
      });

      console.log("  Q" + (qi + 1) + " " + tag + " [" + icon + "] " + expected.slice(0, 40) + " | " + (ans || "").slice(0, 60).replace(/\n/g, " "));
      await sleep(200);
    }

    allResults.push({ ci: ci + 1, a: conv.conversation.speaker_a, b: conv.conversation.speaker_b, ok, total: qaList.length, deets });
    console.log("  → " + ok + "/" + qaList.length + " (" + (ok / qaList.length * 100).toFixed(0) + "%)");
    if (ci < data.length - 1) await sleep(3000);
  }

  // Report
  const now = new Date().toISOString();
  const pct = (grandOk / grandTotal * 100).toFixed(1);
  const lines = [
    "# LoCoMo Baseline — DeepSeek V3",
    "**Date**: " + now + " | **Model**: " + MODEL + " (128K context)",
    "**Accuracy**: " + grandOk + "/" + grandTotal + " (**" + pct + "%**)",
    "",
    "## By Category",
  ];
  for (let c = 1; c <= 5; c++) {
    if (catTot[c] > 0) lines.push("- Cat " + c + " " + CAT_NAMES[c] + ": " + catOk[c] + "/" + catTot[c] + " (" + (catOk[c] / catTot[c] * 100).toFixed(0) + "%)");
  }
  lines.push("", "## Per-Conversation");
  for (const r of allResults) {
    lines.push("### Convo " + r.ci + " — " + r.a + " & " + r.b + " — " + r.ok + "/" + r.total + " (" + (r.ok / r.total * 100).toFixed(0) + "%)");
    for (const d of r.deets.slice(0, 15)) {
      lines.push("- **Q" + d.qi + "** " + d.tag + " [" + (d.correct ? "✓" : "✗") + "]: " + d.question);
      lines.push("  - Expected: " + d.expected + " | Got: " + d.ans);
    }
    lines.push("");
  }

  const out = join(__dir, "..", "LOCOMO_V3_BASELINE.md");
  writeFileSync(out, lines.join("\n"), "utf-8");
  console.log("\n═══ FINAL ═══");
  console.log("V3 Baseline: " + grandOk + "/" + grandTotal + " (" + pct + "%)");
  console.log("Report: " + out);

  // Print category breakdown
  console.log("\nCategory breakdown:");
  for (let c = 1; c <= 5; c++) {
    if (catTot[c] > 0) console.log("  Cat " + c + " " + CAT_NAMES[c] + ": " + catOk[c] + "/" + catTot[c] + " (" + (catOk[c] / catTot[c] * 100).toFixed(0) + "%)");
  }
}

main().catch(e => console.error("FATAL:", e));
