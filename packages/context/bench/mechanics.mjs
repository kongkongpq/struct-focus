// @structfocus/context — DocQA 机制证明（无需 LLM，纯架构验证）
//
// 复刻 runDocQA 的分块 + ContextManager 逻辑，验证一个核心论点：
//   超窗口时 StructFocus 把答案旧 chunk 降级/落盘 → 模型看不到答案 → 诚实说"不知道"
//     （这是模型上下文窗口的硬限制，不是 StructFocus 架构问题）
//   窗口内时答案 chunk 不被驱逐 → StructFocus 帮模型定位到原文位置
//
// 用法：node packages/context/bench/mechanics.mjs
// 依赖：已构建的 context/dist（pnpm build 或 tsc -b packages/context）

import { ContextManager } from "../dist/index.js";

const CHUNK = 2000; // chars per chunk（与 harness.ts runDocQA 一致）
const MAX_WINDOW = 65_000; // tokens（与 run.ts 一致）

const ANSWER = "\n=== PRICING NOTICE === Enterprise Edition annual fee adjusted from ¥99,800 to ¥129,800. Verification code: PRC-2026-Q3-88421. === END ===\n";
const QUESTION = "Enterprise Edition 年费调整后是多less？验证码是多少？不知道就说不知道。";

function filler(chars) {
  const line = "[log] worker-3 processed 411 records batch#7; p50=27ms p99=88ms queue=5\n";
  let s = "";
  while (s.length < chars) s += line;
  return s.slice(0, chars);
}
function inject(doc, text, pos) {
  return doc.slice(0, pos) + "\n\n" + text + "\n\n" + doc.slice(pos);
}

function run(doc, question) {
  const m = new ContextManager({ maxWindow: MAX_WINDOW });
  m.setTaskContext({ currentSubtasks: ["分析长文档并回答关键问题"], editingFiles: [], failingTests: [], focusedSymbols: [], recentErrors: [] });
  for (let i = 0; i < doc.length; i += CHUNK) {
    m.appendObservation(doc.slice(i, i + CHUNK), { source: `doc-chunk-${Math.floor(i / CHUNK)}`, taskRelevance: 0.6, sourceType: "file_content" });
    if (i > 0 && i % (CHUNK * 10) === 0) m.manage();
    if (i > 0 && i % (CHUNK * 20) === 0) m.autoManage();
  }
  m.appendUser(question);
  const msgs = m.toMessages("你正在分析一个长文档。基于上下文中的信息直接回答问题。如果你不知道答案，请说你不知道。");
  const assembled = msgs.map((x) => x.content).join("\n");
  const stats = m.getStats();
  return { assembled, usePercent: stats.usePercent, active: stats.activeEntries, total: stats.totalTokens };
}

console.log("=== StructFocus DocQA 机制证明（无需 LLM）===\n");

// 超窗口：230K chars ≈ 66K tokens > 65K 窗口，答案在 70% 深度（最旧处）
const overDoc = inject(filler(230_000), ANSWER, Math.floor(230_000 * 0.7));
const over = run(overDoc, QUESTION);
const overFound = over.assembled.includes("PRC-2026-Q3-88421");

// 窗口内：40K chars ≈ 11K tokens < 65K 窗口，答案在 30% 深度
const withinDoc = inject(filler(40_000), ANSWER, Math.floor(40_000 * 0.3));
const within = run(withinDoc, QUESTION);
const withinFound = within.assembled.includes("PRC-2026-Q3-88421");

console.log(`超窗口 doc : ${(overDoc.length / 1000).toFixed(0)}K chars (~${Math.round(overDoc.length / 3.5 / 1000)}K tokens)，答案在 70% 深度`);
console.log(`  组装上下文含答案原文 : ${overFound ? "是" : "否"}`);
console.log(`  → ${overFound ? "答案仍可见" : '答案被降级/落盘，模型看不到 → 会诚实说"不知道"（模型窗口硬限制，非架构问题）'}`);
console.log(`  usePercent=${over.usePercent}%  activeEntries=${over.active}  totalTokens=${over.total}\n`);

console.log(`窗口内 doc : ${(withinDoc.length / 1000).toFixed(0)}K chars (~${Math.round(withinDoc.length / 3.5 / 1000)}K tokens)，答案在 30% 深度`);
console.log(`  组装上下文含答案原文 : ${withinFound ? "是" : "否"}`);
console.log(`  → ${withinFound ? "答案存活，StructFocus 帮模型定位到原文位置" : "答案未被保留（异常，需排查）"}`);
console.log(`  usePercent=${within.usePercent}%  activeEntries=${within.active}  totalTokens=${within.total}\n`);

console.log(overFound === false && withinFound === true
  ? "✅ 机制验证通过：超窗口丢失 / 窗口内保留，符合预期。"
  : "⚠️ 结果与预期不符，请检查管理策略（emergencyThreshold / conservative）。");
