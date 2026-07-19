// @struct/context — LLM 调用封装
//
// 统一对外的 chat 函数：支持真实 OpenAI 兼容 API（GLM-4 / DeepSeek /
// 通义 qwen 等），以及离线「mock」模式（确定性回退，无需 API Key）。
//
// mock 模式语义：LLM 回答 = 回显它收到的 prompt 全文。
//   这样评分（关键词是否出现在注入上下文中）等价于「该关键词是否进入了 LLM 的上下文窗口」，
//   从而确定性地复现 A/B/C 三线的差异，用于管线自检，不消耗任何 API 额度。

import type { LLMMessage } from "../src/index.js";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** chat 函数签名：传入消息数组，返回回答文本 */
export type ChatFn = (messages: LLMMessage[]) => Promise<string>;

const CHARS_PER_TOKEN = 3.5;

/** 与 packages/context 其它模块一致的 token 估算 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 从环境变量探测 LLM 配置。优先级：
 *   LLM_BASE_URL + LLM_API_KEY + LLM_MODEL（通用 OpenAI 兼容）
 *   GLM_API_KEY（智谱，自动补 baseUrl/model）
 *   DASHSCOPE_API_KEY（通义百炼 qwen-plus）
 *   DEEPSEEK_API_KEY（DeepSeek）
 * 都没有则返回 null（应走 mock）。
 */
export function detectLLMConfig(): LLMConfig | null {
  if (
    process.env.LLM_BASE_URL &&
    process.env.LLM_API_KEY &&
    process.env.LLM_MODEL
  ) {
    return {
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
    };
  }
  if (process.env.GLM_API_KEY) {
    return {
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: process.env.GLM_API_KEY,
      model: process.env.GLM_MODEL ?? "glm-4-flash",
    };
  }
  if (process.env.DASHSCOPE_API_KEY) {
    return {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      apiKey: process.env.DASHSCOPE_API_KEY,
      model: "qwen-plus",
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      baseUrl: "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: "deepseek-chat",
    };
  }
  return null;
}

function chatUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, "");
  if (u.endsWith("/v4") || u.includes("/api/paas")) return `${u}/chat/completions`;
  if (u.includes("/compatible-mode")) return `${u}/v1/chat/completions`;
  if (u.includes("/v1") && (u.endsWith("/v1") || u.endsWith("/v1/"))) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 免费档（glm-4-flash 等）RPM 极低，且请求可能被服务端长时间挂起。
// 三道防线：
//   1) 调用间强制「自适应」间隔：初始 900ms，一旦遇 429 自动拉大，稳定后收回，
//      从而绕开限流风暴（重试退避是兜底，不应成为常态）；
//   2) 单次 fetch 加 30s 硬超时，挂起时快速失败而非永久阻塞；
//   3) 超时/中断均可重试。
const REQUEST_TIMEOUT_MS = 30000;
const INTERVAL_FLOOR = 900; // 稳定时的最小间隔（≈66 RPM）
const INTERVAL_CAP = 20000; // 限速严重时的最大间隔（免费档约 5 RPM，需 ≥12s）
let minInterval = INTERVAL_FLOOR;
let lastCallTs = 0;

async function throttle(): Promise<void> {
  const wait = minInterval - (Date.now() - lastCallTs);
  if (wait > 0) await delay(wait);
}

/** 真实 LLM 调用（纯 fetch，零 SDK 依赖） */
async function callReal(config: LLMConfig, messages: LLMMessage[]): Promise<string> {
  for (let attempt = 0; attempt <= 5; attempt++) {
    await throttle();
    try {
      lastCallTs = Date.now();
      const resp = await fetch(chatUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0,
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        if (resp.status === 429 && attempt < 5) {
          // 遇限流：拉大后续调用间隔（自适应），并做短退避
          minInterval = Math.min(INTERVAL_CAP, Math.ceil(minInterval * 2));
          await delay(1000 * (attempt + 1));
          continue;
        }
        throw new Error(`LLM API ${resp.status}: ${err.slice(0, 200)}`);
      }
      // 成功：间隔逐步收回到下限（避免永久过保守）
      minInterval = Math.max(INTERVAL_FLOOR, Math.floor(minInterval * 0.92));
      const data = (await resp.json()) as {
        choices: { message: { content: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      const isRetryable =
        err instanceof Error &&
        (err.message.includes("429") ||
          err.message.includes("fetch") ||
          err.message.toLowerCase().includes("abort") ||
          err.message.toLowerCase().includes("timeout") ||
          (err as { name?: string }).name === "TimeoutError" ||
          (err as { name?: string }).name === "AbortError");
      if (attempt < 5 && isRetryable) {
        minInterval = Math.min(INTERVAL_CAP, Math.ceil(minInterval * 2));
        await delay(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error("LLM API: 重试用尽");
}

/**
 * 创建 chat 函数。
 * @param config 真实配置；为 null 时仅 mock 可用
 * @param mock   是否强制 mock（离线确定性）
 */
export function createChatFn(config: LLMConfig | null, mock: boolean): ChatFn {
  if (mock || !config) {
    // 离线确定性回退：回显 prompt（用于管线自检，不消耗额度）
    return async (messages: LLMMessage[]): Promise<string> => {
      const prompt = messages.map((m) => m.content ?? "").join("\n");
      return `【mock 回显】根据上下文：\n${prompt}`;
    };
  }
  return (messages: LLMMessage[]) => callReal(config, messages);
}

/** 便捷封装：直接对一段 prompt 字符串提问 */
export function quickPrompt(chat: ChatFn, prompt: string): Promise<string> {
  return chat([{ role: "user", content: prompt }]);
}
