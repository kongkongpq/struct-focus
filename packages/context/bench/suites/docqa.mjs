// 超窗口长文档 QA suite (roadmap 三.1) — 真实运行（需 GLM key）
//
// 一篇超过小窗口的长文档作为最旧条目写入，随后灌入填充使其溢出。
// BL = 朴素截断（长文档被丢弃）；CM = StructFocus 压缩 + 召回（文档原文被检索还原并作答）。
// 指标：BL/CM 准确率（GLM 评判）+ recall@K。

import { runAB, makeFiller, estimateTokens, modelName, warmup } from "./bench-llm.mjs";
import { makeBenchResult } from "./bench-result.mjs";

const MAX_WINDOW = 700;

const DOC =
  "§1 系统架构：网关层采用 Envoy 做边缘代理，全局限流阈值设为 5000 QPS，单实例 800 QPS。" +
  "§2 存储设计：订单表按 user_id 哈希分 64 库，冷热分离，冷数据每日归档到对象存储，热表保留 30 天。" +
  "§3 容灾方案：交易系统双活机房分别部署在 上海 与 深圳，跨城同步 RPO 小于 5 秒，RTO 小于 60 秒。" +
  "§4 安全合规：所有密钥通过 KMS 托管，访问令牌有效期 15 分钟，密钥每季度轮换一次。" +
  "§5 性能基线：核心交易链路 P99 目标 150 毫秒，最近一次压测实测 138 毫秒，错误率 0.02%。" +
  "§6 观测体系：指标走 Prometheus，日志走 OpenTelemetry，核心链路 100% 采样，告警平均触达 20 秒内。" +
  "§7 发布策略：采用按用户分桶的灰度，先放 5% 流量观察 10 分钟，错误率无上升再全量。" +
  "§8 成本优化：离线计算迁到 Spot 实例，预计月度账单下降 38%，但仍保留 20% 常驻保底容量。";

const QUESTIONS = [
  { q: "网关层的全局限流阈值是多少？", gold: "5000 QPS", marker: "5000 QPS" },
  { q: "订单表按什么维度分库？一共分了多少库？", gold: "按 user_id 哈希分 64 库", marker: "64 库" },
  { q: "交易系统双活机房部署在哪两个城市？", gold: "上海 与 深圳", marker: "深圳" },
  { q: "核心交易链路的 P99 目标延迟是多少？", gold: "150 毫秒", marker: "150 毫秒" },
];

function buildEntries() {
  const entries = [{ content: DOC, type: "observation" }];
  let fillers = makeFiller(4);
  while (entries.reduce((a, e) => a + estimateTokens(e.content), 0) < MAX_WINDOW * 2.4) {
    fillers = fillers.concat(makeFiller(4));
    entries.push(...fillers.slice(-4).map((c) => ({ content: c, type: "observation" })));
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
    `BL(朴素截断) 长文档准确率=${blAcc}，CM(StructFocus 压缩+召回)=${cmAcc}；` +
    `recall@1/3/5=${hit("hit1")}/${hit("hit3")}/${hit("hit5")}。` +
    (mock ? "" : `GLM=${modelName()}。`);

  return makeBenchResult(
    "docqa",
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
