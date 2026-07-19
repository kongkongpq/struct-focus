// LoCoMo ContextManager Benchmark — GLM-4-flash
// 真正的 CM 路线: ContentStore + CapsuleStore + buildContext
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";

const __dir = dirname(fileURLToPath(import.meta.url));

const ctxUrl = pathToFileURL("E:/Develop/SrcuctAgent/packages/context/dist/index.js").href;
const { ContextManager } = await import(ctxUrl);

const API_KEY = "***REMOVED***.***REMOVED***";
const API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const MAX_QA = 15;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callLLM(msgs, mt = 120) {
  for (let i = 0; i <= 6; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        body: JSON.stringify({ model: MODEL, messages: msgs, temperature: 0, max_tokens: mt }),
      });
      const body = await res.text();
      if (!res.ok) {
        if (res.status === 429 && i < 6) { console.log(`  429 retry ${i + 1}`); await sleep((i + 2) * 10000); continue; }
        console.log(`  API ERR ${res.status}: ${body.slice(0, 150)}`);
        return "ERR:" + res.status;
      }
      return JSON.parse(body)?.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      if (i < 6) { console.log(`  net retry ${i + 1}`); await sleep((i + 2) * 10000); continue; }
      return "ERR:" + String(e).slice(0, 40);
    }
  }
  return "ERR:retries";
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

// GLM-4-flash baseline from earlier full run (LOCOMO_REPORT.md)
const BL_SCORES = [8, 2, 3, 3, 2, 4, 2, 5, 5, 3];
const BL_TOTAL = 37;

async function main() {
  console.log("=== LoCoMo ContextManager Benchmark — GLM-4-flash ===");
  console.log("Model: " + MODEL + " | 10 convos × " + MAX_QA + " QA | ContentStore + CapsuleStore\n");

  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));
  let grandCmOk = 0, grandTotal = 0, catOk = {}, catTot = {};

  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci], qaList = conv.qa.slice(0, MAX_QA);
    const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";

    console.log("\n━━━ Convo " + (ci + 1) + "/10: " + A + " & " + B + " ━━━");

    const tmpDir = mkdtempSync(join(tmpdir(), "locomo-cm-"));
    const cm = new ContextManager({
      maxWindow: 128000,
      storeRoot: join(tmpDir, "content-store"),
      capsuleRoot: join(tmpDir, "capsules"),
    });

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
      const report = cm.autoManage();
      if (report.triggerLevel >= 0) {
        console.log("  [CM] " + sk + " use%" + report.usePercent + " L" + report.triggerLevel + " evict:" + report.evictedCount + " comp:" + report.compressedCount);
      }
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
      const ans = await callLLM([
        { role: "system", content: sysMsg },
        { role: "user", content: "CONVERSATION CONTEXT:\n" + cmText.slice(0, 124000) + "\n\nQUESTION: " + qa.question },
      ], 100);
      const correct = check(expected, ans);
      if (correct) { cmOk++; grandCmOk++; catOk[cat] = (catOk[cat] || 0) + 1; }
      grandTotal++; catTot[cat] = (catTot[cat] || 0) + 1;
      const icon = correct ? "✓" : "✗";
      console.log("  Q" + (qi + 1) + " Cat" + cat + " [" + icon + "] " + expected.slice(0, 40) + " | " + (ans || "").slice(0, 60).replace(/\n/g, " "));
      await sleep(1500);
    }
    console.log("  → CM " + cmOk + "/" + qaList.length + " vs BL " + BL_SCORES[ci] + "/" + qaList.length);
    if (ci < data.length - 1) await sleep(3000);
  }

  const pct = (grandCmOk / grandTotal * 100).toFixed(1);
  console.log("\n═══ FINAL ═══");
  console.log("BL: " + BL_TOTAL + "/" + grandTotal + " (" + (BL_TOTAL / grandTotal * 100).toFixed(1) + "%)");
  console.log("CM: " + grandCmOk + "/" + grandTotal + " (" + pct + "%)");
  for (let c = 1; c <= 5; c++) {
    if (catTot[c] > 0) console.log("  Cat " + c + ": " + (catOk[c] || 0) + "/" + catTot[c] + " (" + ((catOk[c] || 0) / catTot[c] * 100).toFixed(0) + "%)");
  }
}
main().catch(e => console.error("FATAL:", e));
