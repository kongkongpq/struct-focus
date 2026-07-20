// structfocus-agent - BYOK LLM 客户端（fetch，支持 DeepSeek/智谱/OpenAI/Ollama）
// v2: 修复 tool_calls 解析 + 多轮对话 tool 历史

export interface LLMConfig {
  readonly provider: "deepseek" | "zhipu" | "openai" | "ollama" | "mock";
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly LLMToolCall[];
}

export interface LLMToolCall {
  readonly id: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string; // JSON string
  };
}

export interface LLMResponse {
  readonly content: string;
  readonly toolCalls?: LLMToolCall[];
  readonly usage?: { promptTokens: number; completionTokens: number };
  readonly finishReason?: string;
}

export interface LLMClient {
  chat(messages: readonly LLMMessage[], tools?: unknown[]): Promise<LLMResponse>;
}

// ─── Provider 默认 URL ──────────────────────────────────

const PROVIDER_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  ollama: "http://localhost:11434/v1/chat/completions",
};

// ─── 智谱模型名映射 ─────────────────────────────────────

const ZHIPU_MODELS: Record<string, string> = {
  "glm-4": "glm-4",
  "glm-4-flash": "glm-4-flash",
  "glm-4-plus": "glm-4-plus",
  "glm-4v": "glm-4v",
  "glm-3-turbo": "glm-3-turbo",
};

// ─── 创建客户端 ──────────────────────────────────────────

export function createLLMClient(config: LLMConfig): LLMClient {
  if (config.provider === "mock") return createMockLLMClient(config);
  if (config.provider === "zhipu") return createZhipuClient(config);
  return createOpenAICompatibleClient(config);
}

// ─── OpenAI 兼容客户端 ──────────────────────────────────

function createOpenAICompatibleClient(config: LLMConfig): LLMClient {
  const baseUrl = config.baseUrl ?? PROVIDER_URLS[config.provider] ?? PROVIDER_URLS.openai!;
  return {
    async chat(messages: readonly LLMMessage[], tools?: unknown[]): Promise<LLMResponse> {
      const body = buildOpenAIBody(config, messages, tools);
      const resp = await fetchWithRetry(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      return parseResponse(await resp.json());
    },
  };
}

// ─── 智谱客户端 ─────────────────────────────────────────

function createZhipuClient(config: LLMConfig): LLMClient {
  const baseUrl = config.baseUrl ?? PROVIDER_URLS.zhipu!;
  return {
    async chat(messages: readonly LLMMessage[], tools?: unknown[]): Promise<LLMResponse> {
      const body = buildZhipuBody(config, messages, tools);
      const resp = await fetchWithRetry(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      });
      return parseResponse(await resp.json());
    },
  };
}

// ─── 请求体构建 ─────────────────────────────────────────

function buildOpenAIBody(config: LLMConfig, messages: readonly LLMMessage[], tools?: unknown[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(toApiMessage),
    temperature: config.temperature ?? 0.3,
    max_tokens: config.maxTokens ?? 4096,
    stream: false,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

function buildZhipuBody(config: LLMConfig, messages: readonly LLMMessage[], tools?: unknown[]): Record<string, unknown> {
  const model = ZHIPU_MODELS[config.model] ?? config.model;
  const body: Record<string, unknown> = {
    model,
    messages: messages.map(toApiMessage),
    temperature: config.temperature ?? 0.3,
    max_tokens: config.maxTokens ?? 4096,
    stream: false,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

// ─── 消息格式化（OpenAI/智谱共用） ──────────────────────

function toApiMessage(m: LLMMessage): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: m.role };

  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    msg.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    msg.content = m.content;
  } else if (m.role === "tool") {
    msg.content = m.content ?? "";
    msg.tool_call_id = m.toolCallId ?? "";
  } else {
    msg.content = m.content ?? "";
  }

  return msg;
}

// ─── 响应解析 ───────────────────────────────────────────

function parseResponse(data: any): LLMResponse {
  const choice = data.choices?.[0];
  const message = choice?.message;

  const rawToolCalls: any[] | undefined = message?.tool_calls;
  const toolCalls: LLMToolCall[] | undefined =
    rawToolCalls && rawToolCalls.length > 0
      ? rawToolCalls.map((tc: any) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "{}",
          },
        }))
      : undefined;

  return {
    content: message?.content ?? "",
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
      : undefined,
    finishReason: choice?.finish_reason ?? "stop",
  };
}

// ─── 重试 fetch ─────────────────────────────────────────

async function fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;
      if ((resp.status === 429 || resp.status >= 500) && i < retries) {
        await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, i), 8000)));
        continue;
      }
      const text = await resp.text().catch(() => "");
      lastError = new Error(`LLM API error ${resp.status}: ${text.slice(0, 500)}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (i < retries) await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, i), 8000)));
    }
  }
  throw lastError ?? new Error("LLM request failed");
}

// ─── Mock 客户端 ─────────────────────────────────────────

export function createMockLLMClient(config: LLMConfig): LLMClient {
  const responses = config.model === "custom" ? ["Mock response 1", "Mock response 2"] : ["I'll help you with that.", "Let me check the code.", "Done!"];
  let idx = 0;
  return {
    async chat(_messages: readonly LLMMessage[], _tools?: unknown[]): Promise<LLMResponse> {
      const content = responses[idx % responses.length] ?? "Mock response"; idx++;
      return { content, usage: { promptTokens: 100, completionTokens: 50 }, finishReason: "stop" };
    },
  };
}
