// NIAH suite (roadmap 三.1) — 真实运行（需 GLM key）
//
// 每根「针」是一个唯一代号，作为最旧的条目写入；随后灌入大量填充文本使其溢出小窗口。
// BL = 朴素 FIFO 截断（最旧针被丢弃）；CM = StructFocus 压缩 + 召回（针仍可被检索并作答）。
// 指标：BL/CM 作答准确率（GLM 评判）+ recall@K（ContentStore BM25 命中唯一代号）。

import { runAB, makeFiller, estimateTokens, modelName, warmup } from "./bench-llm.mjs";
import { makeBenchResult } from "./bench-result.mjs";

const MAX_WINDOW = 1500;

const NEEDLES = [
  { code: "GLF-7734", topic: "访问授权码" },
  { code: "X9-OMEGA-22", topic: "灰度项目代号" },
  { code: "TKN-5510-B", topic: "内部票据 ID" },
];

export async function run() {
  await warmup();
  const rows = [];
  for (const n of NEEDLES) {
    const needleEntry = `会议记录：本次发布的${n.topic}为 ${n.code}。该值在部署流水线通过后正式生效，请勿外传。`;
    const entries = [{ content: needleEntry, type: "observation" }];
    // 灌入填充直到超出窗口（保证最旧的针被压缩/驱逐）
    let fillers = makeFiller(8);
    while (entries.reduce((a, e) => a + estimateTokens(e.content), 0) < MAX_WINDOW * 2.4) {
      fillers = fillers.concat(makeFiller(8));
      entries.push(...fillers.slice(-8).map((c) => ({ content: c, type: "observation" })));
    }
    const query = `本次发布的${n.topic}是什么？`;
    const r = await runAB({
      entries,
      query,
      gold: n.code,
      targetMarker: n.code,
      maxWindow: MAX_WINDOW,
    });
    rows.push({ code: n.code, ...r });
  }

  const acc = (f) => Math.round((rows.filter(f).length / rows.length) * 1000) / 1000;
  const blAcc = acc((r) => r.baseline.correct);
  const cmAcc = acc((r) => r.structfocus.correct);
  const hit = (k) => acc((r) => r.recall?.[k]);
  const mock = rows.some((r) => r.mock);
  const model = mock ? "MOCK(no-key)" : modelName();
  const note =
    (mock ? "MOCK(无 GLM key，确定性桩验证召回机制，非真实 LLM 评判): " : "") +
    `BL(朴素截断) 准确率=${blAcc}，CM(StructFocus 压缩+召回) 准确率=${cmAcc}；` +
    `recall@1/3/5=${hit("hit1")}/${hit("hit3")}/${hit("hit5")}。` +
    (mock ? "" : `GLM=${modelName()}。`);

  return makeBenchResult(
    "niah",
    model,
    {
      BL: {
        label: "naive FIFO truncation",
        score: { accuracy: blAcc },
        details: rows.map((r) => ({
          code: r.code,
          correct: r.baseline.correct,
          answer: r.baseline.answer.slice(0, 80),
        })),
      },
      CM: {
        label: "StructFocus compress+recall",
        score: { accuracy: cmAcc, recallAt1: hit("hit1"), recallAt3: hit("hit3"), recallAt5: hit("hit5") },
        details: rows.map((r) => ({
          code: r.code,
          correct: r.structfocus.correct,
          recall: r.recall,
          answer: r.structfocus.answer.slice(0, 80),
        })),
      },
    },
    note,
  );
}
