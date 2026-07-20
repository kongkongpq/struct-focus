// LoCoMo Hardcore v3: LongContextRecall 验证
// 新 API: recallRelevant + injectRecall + forgetScoped + summarizeAndCapsule
// 小窗口强制大量驱逐 → 每段召回 → 用完 forget → 下一段重新召回

import { readFileSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";

const __dir = dirname(fileURLToPath(import.meta.url));
const ctxUrl = pathToFileURL("E:/Develop/SrcuctAgent/packages/context/dist/index.js").href;
const { ContextManager } = await import(ctxUrl);

// ─── 配置 ────────────────────────────────────────────
const API_KEY = process.env.LOCOMO_API_KEY ?? "";
const API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const CM_WINDOW = 30000;
const MAX_QA = 15;
const MAX_CTX = 124000;
const RECALL_LIMIT = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── LLM 调用 ──────────────────────────────────────────
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

// ─── 答案检查 ──────────────────────────────────────────
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

// ─── 对话扁平化 ────────────────────────────────────────
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

// ─── 提取关键实体（说话者名、日期、主题词） ────────────
function extractKeywords(conv) {
  const A = conv.conversation.speaker_a || "A";
  const B = conv.conversation.speaker_b || "B";
  const lines = [];
  const keys = Object.keys(conv.conversation).filter((k) => k.startsWith("session_") && !k.endsWith("_date_time"));
  for (const sk of keys) {
    for (const t of conv.conversation[sk] || []) {
      lines.push(t.text || "");
    }
  }
  const allText = lines.join(" ");
  // 提取大写首字母词（可能是专有名词）
  const properNouns = new Set();
  for (const m of allText.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)) {
    const w = m[1];
    if (!["The","This","That","When","Where","What","It","Its","Are","Was","Were","Have","Has","Had","Not","But","And","For","With","From","You","Your","They","Their","Here","There","About","Would","Could","Should","Will","Can","May","Also","Very","Then","Than","Just","Some","Any","Each","Every","Other","More"].includes(w)) {
      properNouns.add(w);
    }
  }
  // 提取数字+单位的模式
  const patterns = new Set();
  for (const m of allText.matchAll(/(\d+[\s]?[KkMm]\b|\d+[\s]?(?:years?|months?|days?|hours?|weeks?))/g)) {
    patterns.add(m[1]);
  }
  return { speakers: [A, B], properNouns: [...properNouns].slice(0, 10), patterns: [...patterns].slice(0, 5) };
}

// ══════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════

async function main() {
  console.log("=== LoCoMo Hardcore v3: LongContextRecall ===");
  console.log("Model: " + MODEL + " | Window: " + CM_WINDOW + " tokens | Recall: " + RECALL_LIMIT + " per query");
  console.log("策略: 每段对话前按说话者+主题 recallRelevant → inject → 用完 forgetScoped\n");

  const data = JSON.parse(readFileSync(join(__dir, "locomo10.json"), "utf-8"));

  // Phase 1: Feed all convos with tiny window → massive autoManage
  const tmpDir = mkdtempSync(join(tmpdir(), "locomo-hc3-"));
  const cm = new ContextManager({
    maxWindow: CM_WINDOW,
    storeRoot: join(tmpDir, "content-store"),
    capsuleRoot: join(tmpDir, "capsules"),
  });

  console.log("Feeding " + data.length + " convos through CM (window=" + CM_WINDOW + ")...");
  let totalFed = 0, totalEvicted = 0;
  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const A = conv.conversation.speaker_a || "A", B = conv.conversation.speaker_b || "B";
    const keys = Object.keys(conv.conversation).filter((k) => k.startsWith("session_") && !k.endsWith("_date_time"));
    keys.sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));

    for (const sk of keys) {
      for (const t of conv.conversation[sk] || []) {
        const who = t.speaker === A ? A : t.speaker === B ? B : t.speaker;
        const text = who + ": " + (t.text || "");
        totalFed += text.length;
        cm.appendUser(text);
      }
      const r = await cm.autoManage();
      totalEvicted += r.evictedCount;
      if (r.triggerLevel >= 0) {
        console.log("  C" + (ci + 1) + " " + sk + ": " + r.usePercent + "% L" + r.triggerLevel + " evict:" + r.evictedCount + " comp:" + r.compressedCount + " trunc:" + r.truncatedCount);
      }
    }
  }

  await sleep(2000); // ContentStore async writes settle

  const stats = cm.getStats();
  console.log("\nCM final: fed=" + totalFed.toLocaleString() + " chars, " + stats.activeEntries + " active, " +
    stats.evictedEntries + " evicted (" + totalEvicted + " total evictions), " +
    stats.totalTokens + " tok / " + CM_WINDOW + " (" + stats.usePercent + "%)");
  // Check ContentStore
  const store = cm.getStore();
  console.log("ContentStore entries: checking...");

  // Phase 2: Per-convo QA with BL (full text) vs CM (recallRelevant → inject → QA → forgetScoped)
  let blOk = 0, cmOk = 0, total = 0;
  let cmGtBl = 0, blGtCm = 0, tie = 0;
  const catBl = {}, catCm = {}, catTot = {};

  for (let ci = 0; ci < data.length; ci++) {
    const conv = data[ci];
    const qas = conv.qa.slice(0, MAX_QA);
    const A = conv.conversation.speaker_a || "A";
    const B = conv.conversation.speaker_b || "B";
    const blText = flatten(conv);
    const kw = extractKeywords(conv);

    // ─── CM side: recallRelevant + inject ───
    // Query strategy: use speaker names + proper nouns
    const queries = [
      `${A} ${B}`,
      ...kw.properNouns.slice(0, 3),
    ].filter(Boolean);

    let totalRecalled = 0;
    for (const q of queries) {
      const result = await cm.recallRelevant(q, RECALL_LIMIT);
      totalRecalled += result.entries.length;
      cm.injectRecall(result);
    }

    const cmMsgs = cm.toMessages("");
    const cmText = cmMsgs
      .filter((m) => m.role !== "assistant")
      .map((m) => m.content)
      .join("\n");

    console.log("Convo " + (ci + 1) + " " + A + " & " + B +
      ": BL=" + blText.length.toLocaleString() + "c CM=" + cmText.length.toLocaleString() + "c " +
      "recalled=" + totalRecalled + " queries=[" + queries.join(",") + "]");

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

    // ─── 用完 forgetScoped，下一段重新召回 ───
    const forgot = cm.forgetScoped();
    if (forgot > 0) console.log("  forgetScoped: " + forgot + " recall entries cleaned");
    console.log("");

    await sleep(2000);
  }

  // ─── 汇总 ───
  console.log("═══ FINAL ═══");
  console.log("BL: " + blOk + "/" + total + " (" + (blOk / total * 100).toFixed(1) + "%)");
  console.log("CM: " + cmOk + "/" + total + " (" + (cmOk / total * 100).toFixed(1) + "%)");
  console.log("CM>BL: " + cmGtBl + " | BL>CM: " + blGtCm + " | Tie: " + tie);
  const net = cmOk - blOk;
  console.log("Net: " + (net >= 0 ? "+" : "") + net + " (" + (net >= 0 ? "CM wins" : "BL wins") + ")");

  for (let c = 1; c <= 5; c++) {
    if (catTot[c] > 0) {
      console.log("  Cat" + c + ": BL " + (catBl[c] || 0) + " CM " + (catCm[c] || 0) + " /" + catTot[c] +
        " (" + ((catCm[c] || 0) - (catBl[c] || 0) >= 0 ? "+" : "") + ((catCm[c] || 0) - (catBl[c] || 0)) + ")");
    }
  }

  console.log("\nDone. CM window=" + CM_WINDOW + " model=" + MODEL);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
