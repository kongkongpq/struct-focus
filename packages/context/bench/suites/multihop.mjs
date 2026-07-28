// Multi-hop QA suite (roadmap 三.1) — 真实运行（需 GLM key）
//
// 3 篇文档各含部分事实，问题需跨文档多跳推理（如：Apollo 团队负责人 → 张明 → 兼任数据平台架构师）。
// 文档作为最旧条目写入，填充文本使其溢出小窗口。
// BL = 朴素截断（文档被丢弃，无法多跳）；CM = StructFocus 压缩 + 召回（相关文档被检索并作答）。
// 指标：BL/CM 准确率（GLM 评判）+ recall@K。

import { runAB, makeFiller, estimateTokens, modelName, warmup } from "./bench-llm.mjs";
import { makeBenchResult } from "./bench-result.mjs";

const MAX_WINDOW = 1500;

const DOCS = [
  "文档A：团队 Apollo 负责支付网关模块，技术负责人是 张明。",
  "文档B：张明 同时兼任 数据平台 组的架构师，分管实时计算。",
  "文档C：数据平台 组本季度目标是把实时 pipeline 的端到端延迟降到 200ms 以内。",
];

const QUESTIONS = [
  { q: "Apollo 团队的技术负责人还负责哪个组？", gold: "数据平台组", marker: "张明" },
  { q: "数据平台组本季度的延迟目标是多少？", gold: "200ms 以内", marker: "200ms" },
  { q: "支付网关由哪个团队负责？其技术负责人是谁？", gold: "Apollo 团队，张明", marker: "Apollo" },
  { q: "张明担任架构师的组，本季度目标是什么？", gold: "将实时 pipeline 延迟降到 200ms 以内", marker: "数据平台" },
];

function buildEntries() {
  const entries = DOCS.map((c) => ({ content: c, type: "observation" }));
  let fillers = makeFiller(8);
  while (entries.reduce((a, e) => a + estimateTokens(e.content), 0) < MAX_WINDOW * 2.4) {
    fillers = fillers.concat(makeFiller(8));
    entries.push(...fillers.slice(-8).map((c) => ({ content: c, type: "observation" })));
  }
  return entries;
}

export async function run() {
  await warmup();
  const entries = buildEntries();
  const rows = [];
  for (const item of QUESTIONS) {
    const r = await runAB({
      entries,
      query: item.q,
      gold: item.gold,
      targetMarker: item.marker,
      maxWindow: MAX_WINDOW,
    });
    rows.push({ q: item.q, gold: item.gold, ...r });
  }

  const acc = (f) => Math.round((rows.filter(f).length / rows.length) * 1000) / 1000;
  const blAcc = acc((r) => r.baseline.correct);
  const cmAcc = acc((r) => r.structfocus.correct);
  const hit = (k) => acc((r) => r.recall?.[k]);
  const mock = rows.some((r) => r.mock);
  const model = mock ? "MOCK(no-key)" : modelName();
  const note =
    (mock ? "MOCK(无 GLM key，确定性桩验证召回机制，非真实 LLM 评判): " : "") +
    `BL(朴素截断) 多跳准确率=${blAcc}，CM(StructFocus 压缩+召回)=${cmAcc}；` +
    `recall@1/3/5=${hit("hit1")}/${hit("hit3")}/${hit("hit5")}。` +
    (mock ? "" : `GLM=${modelName()}。`);

  return makeBenchResult(
    "multihop",
    model,
    {
      BL: {
        label: "naive FIFO truncation",
        score: { accuracy: blAcc },
        details: rows.map((r) => ({ q: r.q, correct: r.baseline.correct, answer: r.baseline.answer.slice(0, 80) })),
      },
      CM: {
        label: "StructFocus compress+recall",
        score: { accuracy: cmAcc, recallAt1: hit("hit1"), recallAt3: hit("hit3"), recallAt5: hit("hit5") },
        details: rows.map((r) => ({
          q: r.q,
          correct: r.structfocus.correct,
          recall: r.recall,
          answer: r.structfocus.answer.slice(0, 80),
        })),
      },
    },
    note,
  );
}
