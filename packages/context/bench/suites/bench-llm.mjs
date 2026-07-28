// 共享 GLM 客户端 + StructFocus A/B 评测框架 (roadmap 三.1)
//
// 纯 Node ESM，依赖已编译的 dist/index.js（由 `tsc -b packages/context` 产出）。
// GLM key 读取顺序：STRUCT_LLM_API_KEY → LLM_API_KEY → OPENAI_API_KEY（与引擎选项一致）。
// 压缩层走确定性 structuredCompress（不调 LLM，零成本、可复现），LLM 仅用于「作答 + 评判」，
// 即真实产品面向 LLM 的链路。

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ctxUrl = new URL("../../dist/index.js", import.meta.url).href;
const { LongContextEngine, BudgetManager } = await import(ctxUrl);

// ── 环境 / 配置 ──────────────────────────────────────────
export const API_KEY =
  process.env.STRUCT_LLM_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
export const BASE_URL =
  process.env.STRUCT_LLM_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  "https://open.bigmodel.cn/api/paas/v4";
export const MODEL =
  process.env.STRUCT_LLM_MODEL || process.env.LLM_MODEL || "glm-4-flash";

export function hasGLM() {
  return !!API_KEY;
}
export function modelName() {
  return MODEL;
}

/** 估算 token 数（与引擎一致的 BudgetManager 估计器） */
export function estimateTokens(text) {
  return BudgetManager.estimateTokens(text);
}

// ── GLM chat（OpenAI 兼容） ──────────────────────────────
export async function chat(system, user, { temperature = 0, retries = 3, timeout = 60_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const resp = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: MODEL,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      clearTimeout(timer);
      if (resp.status === 429) {
        await sleep(1500 * (attempt + 1));
        lastErr = new Error("rate limited (429)");
        continue;
      }
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`GLM ${resp.status}: ${t.slice(0, 200)}`);
      }
      const j = await resp.json();
      return j.choices?.[0]?.message?.content?.trim() ?? "";
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("glm chat failed");
}

/** 严格评分员：候选答案是否答对（事实一致即可，允许表述不同） */
export async function judge(question, gold, answer) {
  const sys =
    "你是严格的评分员。只回答 YES 或 NO。判断候选答案是否正确地回答了问题；" +
    "允许表述不同，只要关键事实一致即为 YES；若候选答案缺失、错误或答非所问则为 NO。";
  const usr =
    `问题: ${question}\n标准答案: ${gold}\n候选答案: ${answer}\n\n候选答案是否正确？只回答 YES 或 NO。`;
  const r = (await chat(sys, usr)).trim().toUpperCase();
  return r.startsWith("YES");
}

// ── StructFocus A/B 评测 ─────────────────────────────────
//
// entries: [{ content, type?: "user"|"tool"|"observation" }]（顺序=时间序，最早在前）
// query / gold / targetMarker（仅出现在答案条目中的唯一标记，用于 recall@K）
// 返回：baseline / structfocus 两组作答 + recall@K 指标
export async function runAB({
  entries,
  query,
  gold,
  targetMarker,
  maxWindow = 4000,
  systemPrompt = "You are a precise assistant. Answer concisely.",
}) {
  const useGLM = hasGLM();

  // 作答 + 评判：有 key 走真实 GLM；无 key 用确定性桩（仍跑真实引擎压缩+召回）。
  async function answerAndJudge(context, marker) {
    if (useGLM) {
      const ans = await chat(systemPrompt, `${context}\n\n问题: ${query}\n请只给出简洁答案。`);
      const cor = await judge(query, gold, ans);
      return { answer: ans, correct: cor };
    }
    const present = context.includes(marker);
    return {
      answer: present ? gold : "（无法回答：相关上下文已被窗口丢弃）",
      correct: present,
    };
  }

  // ── BL：朴素 FIFO 截断到 token 预算（模拟无 StructFocus 的普通上下文窗口）──
  let used = 0;
  const keep = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = estimateTokens(entries[i].content);
    if (used + t > maxWindow * 0.9 && keep.length > 0) break;
    keep.unshift(entries[i]);
    used += t;
  }
  const blContext = keep.map((e) => `[${e.type || "obs"}] ${e.content}`).join("\n\n");
  const bl = await answerAndJudge(blContext, targetMarker);

  // ── CM：StructFocus 压缩 + 召回 ──
  const root = mkdtempSync(join(tmpdir(), "sf-bench-"));
  let cm = { answer: "", correct: false }, recall = null;
  try {
    const engine = new LongContextEngine({
      maxWindow,
      storeRoot: root,
      autoSummarize: false, // 压缩走确定性 structuredCompress，不调 LLM
      llmCall: (p) => chat("你是上下文压缩助手。", p),
      llmHealthCheck: async () => true,
    });
    for (const e of entries) engine.feed(e.content, { type: e.type || "observation" });
    await engine.autoManage();
    await engine.recallAndInject(query);
    const cmMsgs = engine.getContextManager().toMessages(systemPrompt);
    const cmContext = cmMsgs.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    cm = await answerAndJudge(cmContext, targetMarker);

    // recall@K（ContentStore BM25；targetMarker 仅在答案条目出现）
    const hits = await engine.getStore().search(query, {
      mode: "bm25",
      topK: 5,
      conversationId: engine.getCurrentConversationId(),
    });
    const hitK = (k) =>
      hits.slice(0, k).some((h) => (h.entry?.originalContent || "").includes(targetMarker));
    recall = { total: hits.length, hit1: hitK(1), hit3: hitK(3), hit5: hitK(5) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    baseline: bl,
    structfocus: cm,
    recall,
    mock: !useGLM,
  };
}

// ── 合成数据工具 ─────────────────────────────────────────
const FILLER_TOPICS = [
  "项目周会讨论了下季度路线图，重点是提升可观测性。",
  "CI 流水线新增了类型检查阶段，失败会阻断合并。",
  "数据库从单机迁移到一主两从，读流量已切到从库。",
  "前端引入了组件库，统一了按钮与表单样式。",
  "监控告警接入了企业微信机器人，P0 直接电话。",
  "缓存层从本地内存换成了 Redis 集群，命中率升到 92%。",
  "日志采集改用 OpenTelemetry，链路追踪覆盖核心接口。",
  "鉴权模块支持了 OIDC，单点登录已上线内网。",
  "灰度发布按用户分桶，先放 5% 流量观察错误率。",
  "压测显示下单接口在 800 QPS 时 P99 升到 320ms。",
];

/** 生成 n 段填充文本（与查询无关，用于制造窗口压力） */
export function makeFiller(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = FILLER_TOPICS[i % FILLER_TOPICS.length];
    out.push(`${base}（补充背景 ${i + 1}：${lorem(60)}）`);
  }
  return out;
}

function lorem(n) {
  const words = "我们针对该模块做了梳理，确认接口契约稳定，后续仅做内部优化不影响对外行为。".repeat(4);
  return words.slice(0, n);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** GLM 冷启动预热：发一个极小请求，避免首条真实调用因冷启动超时 */
export async function warmup() {
  try {
    await chat("ping", "reply with: ok");
    return true;
  } catch {
    return false;
  }
}
