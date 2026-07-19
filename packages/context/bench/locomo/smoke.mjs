// Quick smoke test: 1 convo × 5 QA
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_KEY = "***REMOVED***.***REMOVED***";
const BASE = "https://open.bigmodel.cn/api/paas/v4";
const MODEL = "glm-4-flash";
const API = BASE + "/chat/completions";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callLLM(msgs, mt) {
  mt = mt || 100;
  for (let i = 0; i <= 5; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        body: JSON.stringify({ model: MODEL, messages: msgs, temperature: 0, max_tokens: mt }),
      });
      if (!res.ok) {
        if (res.status === 429 && i < 5) { await sleep((i + 2) * 10000); continue; }
        return "ERR:" + res.status;
      }
      const d = await res.json();
      return d?.choices?.[0]?.message?.content || "";
    } catch (e) {
      if (i < 5) { await sleep((i + 2) * 10000); continue; }
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
  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));
  const conv = data[0];
  const qaList = conv.qa.slice(0, 5);
  const dialog = flatten(conv);
  console.log("Dialog chars:", dialog.length, "QA:", qaList.length);

  // CM: chunk summarize
  const chunks = chunk(dialog, 15000);
  console.log("Chunks:", chunks.length);
  const sums = [];
  for (const c of chunks) {
    console.log("Summarizing chunk...");
    const s = await callLLM([
      { role: "system", content: "Extract key facts/events/dates/people as bullets. Be thorough." },
      { role: "user", content: c },
    ], 300);
    console.log("  ->", s.slice(0, 80).replace(/\n/g, " "));
    if (s && !s.startsWith("ERR")) sums.push(s);
    await sleep(1000);
  }
  const cmCtx = sums.join("\n");

  const sys = "Read this conversation between " + conv.conversation.speaker_a + " and " + conv.conversation.speaker_b +
    ". Answer concisely. If not in conversation, say \"Not mentioned.\"";

  let bl = 0, cm = 0;
  for (let i = 0; i < qaList.length; i++) {
    const qa = qaList[i];
    const expected = String(qa.answer != null ? qa.answer : "undefined");

    const blAns = await callLLM([
      { role: "system", content: sys },
      { role: "user", content: "CONVERSATION:\n" + dialog.slice(0, 50000) + "\n\nQ: " + qa.question },
    ], 100);
    const cmAns = await callLLM([
      { role: "system", content: sys },
      { role: "user", content: "KEY FACTS:\n" + cmCtx + "\n\nRECENT:\n" + dialog.slice(-3000) + "\n\nQ: " + qa.question },
    ], 100);

    const bS = fuzzy(expected, blAns), cS = fuzzy(expected, cmAns);
    if (bS) bl++; if (cS) cm++;
    console.log(`Q${i + 1} (Cat ${qa.category}): BL[${bS ? "✓" : "✗"}] CM[${cS ? "✓" : "✗"}]  expected:${expected.slice(0, 30)}`);
    await sleep(1500);
  }

  console.log(`\nRESULT: BL ${bl}/${qaList.length} | CM ${cm}/${qaList.length}`);
}
main().catch(e => console.error(e));
