// LoCoMo benchmark — Baseline vs CM (chunk-summarize)
// ACL 2024 benchmark: snap-research/locomo
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.LOCOMO_API_KEY ?? "";
const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const MODEL = "glm-4-flash";
const API_URL = BASE_URL + "/chat/completions";
const MAX_QA = 15;

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function callLLM(messages, maxTokens) {
  maxTokens = maxTokens || 200;
  for (var i = 0; i <= 5; i++) {
    try {
      var res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        body: JSON.stringify({ model: MODEL, messages: messages, temperature: 0, max_tokens: maxTokens }),
      });
      if (!res.ok) {
        var txt = await res.text().catch(function () { return ""; });
        if (res.status === 429 && i < 5) { await sleep((i + 2) * 10000); continue; }
        return "ERR:" + res.status;
      }
      var data = await res.json();
      return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    } catch (e) {
      if (i < 5) { await sleep((i + 2) * 10000); continue; }
      return "ERR:" + String(e).slice(0, 50);
    }
  }
  return "ERR:retries";
}

function fuzzyScore(expected, got) {
  if (!got || got.startsWith("ERR")) return false;
  if (expected === "undefined" || expected === "null" || expected === "") {
    var g = got.toLowerCase();
    return g.includes("don't know") || g.includes("unsure") || g.includes("not mentioned") || g.includes("unanswerable");
  }
  var a = expected.toLowerCase().trim();
  var b = got.toLowerCase().trim();
  if (b.includes(a) || a.includes(b)) return true;
  var numA = a.match(/\d+/), numB = b.match(/\d+/);
  if (numA && numB && numA[0] === numB[0]) return true;
  var wordA = a.split(/\s+/)[0];
  if (wordA && wordA.length > 3 && b.includes(wordA)) return true;
  return false;
}

function flattenConv(conv) {
  var lines = [];
  var sessions = Object.keys(conv.conversation).filter(function (k) {
    return k.startsWith("session_") && !k.endsWith("_date_time");
  });
  sessions.sort(function (a, b) {
    return parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", ""));
  });
  var A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
  for (var si = 0; si < sessions.length; si++) {
    var sk = sessions[si];
    var date = conv.conversation[sk + "_date_time"];
    var turns = conv.conversation[sk] || [];
    if (date) lines.push("\n--- " + sk + " " + date + " ---");
    for (var ti = 0; ti < turns.length; ti++) {
      var t = turns[ti];
      var who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
      lines.push(who + ": " + (t.text || ""));
    }
  }
  return lines.join("\n");
}

function chunkText(text, size) {
  var chunks = [];
  var pos = 0;
  while (pos < text.length) {
    var end = Math.min(pos + size, text.length);
    if (end < text.length) {
      var nl = text.lastIndexOf("\n", end);
      if (nl > pos + size / 2) end = nl;
    }
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

async function runConvo(idx, conv) {
  var qaList = conv.qa.slice(0, MAX_QA);
  var dialog = flattenConv(conv);
  if (idx > 0) await sleep(4000);

  // CM: chunk & summarize each chunk
  var chunks = chunkText(dialog, 12000);
  var summaries = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    var s = await callLLM([
      { role: "system", content: "Extract key facts, events, dates, people, and relationships as concise bullets. Be thorough." },
      { role: "user", content: chunks[ci] },
    ], 300);
    if (s && !s.startsWith("ERR")) summaries.push(s);
  }
  var cmCtx = summaries.join("\n");
  var baseSys = "Read the conversation between " + conv.conversation.speaker_a + " and " + conv.conversation.speaker_b +
    ". Answer concisely based on it. If the answer is NOT in the conversation, say \"Not mentioned.\"";

  var blOk = 0, cmOk = 0;
  var details = [];

  for (var qi = 0; qi < qaList.length; qi++) {
    var qa = qaList[qi];
    var expected = String(qa.answer != null ? qa.answer : "undefined");
    var cat = qa.category;

    // Baseline: raw dialog truncated
    var blAns = await callLLM([
      { role: "system", content: baseSys },
      { role: "user", content: "CONVERSATION:\n" + dialog.slice(0, 55000) + "\n\nQUESTION: " + qa.question },
    ], 100);

    // CM: summaries + recent context
    var cmAns = await callLLM([
      { role: "system", content: baseSys },
      { role: "user", content: "KEY FACTS FROM CONVERSATION:\n" + cmCtx + "\n\nRECENT DIALOG:\n" + dialog.slice(-3000) + "\n\nQUESTION: " + qa.question },
    ], 100);

    if (fuzzyScore(expected, blAns)) blOk++;
    if (fuzzyScore(expected, cmAns)) cmOk++;

    var shorten = function (s) { return s.replace(/\n/g, "/").slice(0, 100); };
    details.push({
      q: qa.question.slice(0, 70), cat: cat, expected: expected.slice(0, 50),
      bl: fuzzyScore(expected, blAns), cm: fuzzyScore(expected, cmAns),
      blAns: shorten(blAns), cmAns: shorten(cmAns),
    });
    await sleep(1200);
  }
  return { blOk: blOk, cmOk: cmOk, total: qaList.length, details: details };
}

async function main() {
  console.log("=== LoCoMo Benchmark (ACL 2024) ===");
  console.log("Model: " + MODEL + " | 10 convos x " + MAX_QA + " QA\n");

  var dataFile = join(__dir, "locomo10.json");
  var data = JSON.parse(readFileSync(dataFile, "utf-8"));
  var grandBl = 0, grandCm = 0, grandTotal = 0;
  var results = [];

  for (var i = 0; i < data.length; i++) {
    console.log("\n=== Convo " + (i + 1) + "/" + data.length + " ===");
    var r = await runConvo(i, data[i]);
    grandBl += r.blOk; grandCm += r.cmOk; grandTotal += r.total;
    results.push(r);
    console.log("BL: " + r.blOk + "/" + r.total + " | CM: " + r.cmOk + "/" + r.total);
  }

  var report = join(__dir, "..", "LOCOMO_REPORT.md");
  var lines = [
    "# LoCoMo Benchmark Results",
    "**Date**: " + new Date().toISOString() + " | **Model**: " + MODEL,
    "**Dataset**: snap-research/locomo (ACL 2024), 10 conversations",
    "",
    "## Overall",
    "| | Baseline | CM (chunk-summarize) |",
    "| --- | --- | --- |",
    "| Correct | " + grandBl + "/" + grandTotal + " (" + (grandBl / grandTotal * 100).toFixed(1) + "%) | " + grandCm + "/" + grandTotal + " (" + (grandCm / grandTotal * 100).toFixed(1) + "%) |",
    "",
    "## Per-Conversation",
  ];
  for (var ri = 0; ri < results.length; ri++) {
    var r = results[ri];
    lines.push("### Convo " + (ri + 1) + " — BL " + r.blOk + "/" + r.total + " | CM " + r.cmOk + "/" + r.total);
    for (var di = 0; di < Math.min(r.details.length, 8); di++) {
      var d = r.details[di];
      lines.push("- **Q** (Cat " + d.cat + "): " + d.q);
      lines.push("  - Expected: " + d.expected);
      lines.push("  - BL [" + (d.bl ? "✓" : "✗") + "]: " + d.blAns);
      lines.push("  - CM [" + (d.cm ? "✓" : "✗") + "]: " + d.cmAns);
      lines.push("");
    }
  }
  writeFileSync(report, lines.join("\n"), "utf-8");
  console.log("\nReport: " + report);
  console.log("\nFINAL: BL " + grandBl + "/" + grandTotal + " (" + (grandBl / grandTotal * 100).toFixed(1) + "%) vs CM " + grandCm + "/" + grandTotal + " (" + (grandCm / grandTotal * 100).toFixed(1) + "%)");
}

main().catch(function (e) { console.error(e); process.exit(1); });
