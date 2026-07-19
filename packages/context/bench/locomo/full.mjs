// LoCoMo full benchmark: all 10 conversations × up-to-15 QA each
// Baseline vs CM (chunk-summarize pipeline)
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_KEY = "***REMOVED***.***REMOVED***";
const BASE = "https://open.bigmodel.cn/api/paas/v4";
const MODEL = "glm-4-flash";
const API = BASE + "/chat/completions";
const MAX_QA = 15;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callLLM(msgs, mt) {
  mt = mt || 100;
  for (let i = 0; i <= 8; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        body: JSON.stringify({ model: MODEL, messages: msgs, temperature: 0, max_tokens: mt }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        if (res.status === 429 && i < 8) { console.log(`  429 retry ${i + 1}...`); await sleep((i + 2) * 10000); continue; }
        return "ERR:" + res.status;
      }
      const d = await res.json();
      return d?.choices?.[0]?.message?.content || "";
    } catch (e) {
      if (i < 8) { console.log(`  net err retry ${i + 1}...`); await sleep((i + 2) * 10000); continue; }
      return "ERR:" + String(e).slice(0, 40);
    }
  }
  return "ERR:retries";
}

function fuzzy(expected, got) {
  if (!got || got.startsWith("ERR")) return false;
  if (expected === "undefined" || expected === "null" || expected === "") {
    const g = got.toLowerCase();
    return g.includes("don't know") || g.includes("unsure") || g.includes("not mentioned") || g.includes("unanswerable");
  }
  const a = expected.toLowerCase().trim(), b = got.toLowerCase().trim();
  if (b.includes(a) || a.includes(b)) return true;
  const nA = a.match(/\d+/), nB = b.match(/\d+/);
  if (nA && nB && nA[0] === nB[0]) return true;
  const wA = a.split(/\s+/)[0];
  if (wA && wA.length > 3 && b.includes(wA)) return true;
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
  return lines.join("\n");
}

function chunk(text, sz) {
  const c = [];
  let p = 0;
  while (p < text.length) {
    let end = Math.min(p + sz, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > p + sz / 2) end = nl;
    }
    c.push(text.slice(p, end));
    p = end;
  }
  return c;
}

async function main() {
  console.log("=== LoCoMo Full Benchmark ===");
  console.log("Model: " + MODEL + " | " + MAX_QA + " QA per convo\n");

  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));
  let grandBl = 0, grandCm = 0, grandTotal = 0;
  const results = [];

  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const qaList = conv.qa.slice(0, MAX_QA);
    const dialog = flatten(conv);
    if (ci > 0) await sleep(5000);

    console.log("\n━━━ Convo " + (ci + 1) + "/" + data.length + " ━━━");
    console.log("  Dialog: " + dialog.length + " chars, QA: " + qaList.length);

    // CM: chunk & summarize
    const chunks = chunk(dialog, 15000);
    console.log("  Chunks to summarize: " + chunks.length);
    const sums = [];
    for (const c of chunks) {
      const s = await callLLM([
        { role: "system", content: "Extract key facts, events, dates, people, and relationships from this conversation as concise bullet points. Be thorough but concise." },
        { role: "user", content: c },
      ], 300);
      if (s && !s.startsWith("ERR")) sums.push(s);
      await sleep(1500);
    }
    const cmCtx = sums.join("\n");
    console.log("  Summary size: " + cmCtx.length + " chars");

    const sysMsg = "Read this conversation between " + conv.conversation.speaker_a + " and " +
      conv.conversation.speaker_b + ". Answer concisely based on it. If the answer is NOT in the conversation, say \"Not mentioned.\"";

    let blOk = 0, cmOk = 0;
    const deets = [];

    for (let qi = 0; qi < qaList.length; qi++) {
      const qa = qaList[qi];
      const expected = String(qa.answer != null ? qa.answer : "undefined");

      const blAns = await callLLM([
        { role: "system", content: sysMsg },
        { role: "user", content: "CONVERSATION:\n" + dialog.slice(0, 55000) + "\n\nQUESTION: " + qa.question },
      ], 100);
      const cmAns = await callLLM([
        { role: "system", content: sysMsg },
        { role: "user", content: "KEY FACTS:\n" + cmCtx + "\n\nRECENT DIALOG:\n" + dialog.slice(-3000) + "\n\nQUESTION: " + qa.question },
      ], 100);

      const bS = fuzzy(expected, blAns), cS = fuzzy(expected, cmAns);
      if (bS) blOk++; if (cS) cmOk++;

      const sh = (s) => String(s || "").replace(/\n/g, "/").slice(0, 80);
      deets.push({
        q: qa.question.slice(0, 80), cat: qa.category,
        expected: expected.slice(0, 50),
        bl: bS, cm: cS, blAns: sh(blAns), cmAns: sh(cmAns),
      });

      const icon = (x) => x ? "✓" : "✗";
      console.log("  Q" + (qi + 1) + " Cat" + qa.category + " BL[" + icon(bS) + "] CM[" + icon(cS) + "] " + expected.slice(0, 35));
      await sleep(1500);
    }

    grandBl += blOk; grandCm += cmOk; grandTotal += qaList.length;
    results.push({ convo: ci + 1, blOk, cmOk, total: qaList.length, details: deets });
    console.log("  → BL " + blOk + "/" + qaList.length + " | CM " + cmOk + "/" + qaList.length);
  }

  // Report
  const out = join(__dir, "..", "LOCOMO_REPORT.md");
  const catNames = { 1: "Single-hop", 2: "Temporal", 3: "Multi-hop", 4: "Open-domain", 5: "Unanswerable" };
  const lines = [
    "# LoCoMo Benchmark — Full Results",
    "**Date**: " + new Date().toISOString() + " | **Model**: " + MODEL + " | **Context**: 128K",
    "**Dataset**: [snap-research/locomo](https://github.com/snap-research/locomo) (ACL 2024) — 10 ultra-long conversations (~200K total dialog tokens)",
    "",
    "## Summary",
    "",
    "| | Baseline | CM (chunk-summarize) |",
    "| --- | --- | --- |",
    "| Accuracy | " + (grandBl / grandTotal * 100).toFixed(1) + "% | " + (grandCm / grandTotal * 100).toFixed(1) + "% |",
    "| Correct | " + grandBl + "/" + grandTotal + " | " + grandCm + "/" + grandTotal + " |",
    "",
    "## Per-Conversation",
  ];

  for (const r of results) {
    lines.push("### Convo " + r.convo + " — BL " + r.blOk + "/" + r.total + " | CM " + r.cmOk + "/" + r.total);
    for (let di = 0; di < Math.min(r.details.length, 12); di++) {
      const d = r.details[di];
      lines.push("- **Q** (Cat " + d.cat + "): " + d.q);
      lines.push("  - Expected: " + d.expected);
      lines.push("  - BL [" + (d.bl ? "✓" : "✗") + "]: " + d.blAns);
      lines.push("  - CM [" + (d.cm ? "✓" : "✗") + "]: " + d.cmAns);
      lines.push("");
    }
  }

  writeFileSync(out, lines.join("\n"), "utf-8");
  console.log("\n═══ FINAL ═══");
  console.log("BL: " + grandBl + "/" + grandTotal + " (" + (grandBl / grandTotal * 100).toFixed(1) + "%)");
  console.log("CM: " + grandCm + "/" + grandTotal + " (" + (grandCm / grandTotal * 100).toFixed(1) + "%)");
  console.log("Report: " + out);
}

main().catch(e => console.error(e));
