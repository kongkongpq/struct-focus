// struct-agent - 核心循环 v2（修复：多轮对话消息历史累积）
// 唯一真相源：组装框架→插件→记忆→上下文→工具执行→LLM

import type {
  Message,
  RunResult,
  RunStats,
  AgentResponse,
  IMemoryProvider,
} from "@struct/framework";
import {
  EventBus,
  PluginManager,
  StateMachine,
  ConsoleLogger,
} from "@struct/framework";
import { Memory } from "@struct/memory";
import { createMemoryPlugin } from "@struct/memory";
import { Harness } from "@struct/harness";
import { ContextBuilder } from "@struct/context";
import { createLLMClient, type LLMClient, type LLMConfig, type LLMMessage, type LLMToolCall } from "./llm.js";
import { LoopDetector, type LoopDetectorOptions } from "./loop-detector.js";
import { SessionManager, type SessionState } from "./session.js";
import { setupTools, getToolSchemas, type ToolRegistryOptions } from "./tools-registry.js";

// ─── 配置 ──────────────────────────────────────────────────

export interface StructAgentOptions {
  readonly cwd: string;
  readonly llm: LLMConfig;
  readonly stateDir?: string;
  readonly tools?: ToolRegistryOptions;
  readonly loop?: Partial<LoopDetectorOptions>;
  readonly maxSteps?: number;
  readonly verbose?: boolean;
}

export const DEFAULTS = {
  maxSteps: 15,
  systemPrompt: `You are Struct Agent, a professional coding assistant.

You have access to tools for reading/writing/editing files, executing shell commands, git operations, code analysis, and testing.

Guidelines:
- Read a file BEFORE editing it. Never guess its contents.
- Run relevant tests AFTER making code changes.
- If a tool call fails, try a different approach — don't repeat the same failing call.
- Be concise: prefer actionable tool calls over long explanations.
- When you've completed the user's request, explain briefly what you did and stop.`,
} as const;

// ─── 事件类型 ──────────────────────────────────────────────

export type StructAgentEvents = {
  "step:start": { step: number };
  "step:end": { step: number; response: string };
  "tool:before": { tool: string; args: Record<string, unknown> };
  "tool:after": { tool: string; success: boolean; output: string };
  "loop:detected": { reason: string };
  "error": { message: string; step: number };
  "run:start": { sessionId: string };
  "run:end": { result: RunResult };
};

// ─── 核心类 ────────────────────────────────────────────────

export class StructAgent {
  readonly cwd: string;
  readonly stateDir: string;
  readonly options: Required<StructAgentOptions>;

  readonly events: EventBus<StructAgentEvents>;
  readonly plugins: PluginManager;
  readonly memory: Memory;
  readonly harness: Harness;
  readonly contextBuilder: ContextBuilder;
  readonly llm: LLMClient;
  readonly loopDetector: LoopDetector;
  readonly session: SessionManager;
  readonly sm: StateMachine;

  private logger: ConsoleLogger;

  constructor(options: StructAgentOptions) {
    this.options = {
      cwd: options.cwd,
      llm: options.llm,
      stateDir: options.stateDir ?? `${options.cwd}/.agent`,
      tools: options.tools ?? {},
      loop: options.loop ?? {},
      maxSteps: options.maxSteps ?? DEFAULTS.maxSteps,
      verbose: options.verbose ?? false,
    };

    this.cwd = this.options.cwd;
    this.stateDir = this.options.stateDir;

    this.events = new EventBus<StructAgentEvents>();
    this.plugins = new PluginManager();
    this.memory = new Memory({ rootPath: this.cwd });
    this.harness = new Harness({ cwd: this.cwd, stateDir: this.stateDir });
    this.contextBuilder = new ContextBuilder();
    this.llm = createLLMClient(this.options.llm);
    this.loopDetector = new LoopDetector({ maxSteps: this.options.maxSteps, ...this.options.loop });
    this.session = new SessionManager(this.stateDir);
    this.sm = new StateMachine();
    this.logger = new ConsoleLogger(this.options.verbose ? "debug" : "info");

    // 注册 MemoryPlugin
    this.plugins.register(createMemoryPlugin(this.memory));
  }

  async init(): Promise<void> {
    await this.memory.init();
    await this.harness.init();
    await this.session.init();
    setupTools(this.harness, this.options.tools);
    this.logger.info(`init: cwd=${this.cwd} model=${this.options.llm.model} tools=${this.harness.listTools().length}`);
  }

  // ─── 主入口 ────────────────────────────────────────────

  async run(userMessage: string, options?: { abortSignal?: AbortSignal }): Promise<RunResult> {
    const startTime = Date.now();
    const sessionState = this.session.createSession();
    this.sm.transition("running");
    this.events.emit("run:start", { sessionId: sessionState.id });

    let stepCount = 0;
    let toolCallsTotal = 0;
    let tokensUsed = 0;
    let aborted = false;
    let loopDetected = false;

    // 构建 Memory provider
    const memoryProvider: IMemoryProvider = {
      searchSync: (query, opts) => this.memory.searchSync(query, opts?.timeoutMs ?? 200, { limit: opts?.limit ?? 5 }),
      findPointersByFile: (file) => this.memory.findPointersByFile(file),
      expandPointer: (pointerId) => this.memory.expandPointer(pointerId),
      getProjectContext: () => this.memory.getOnboarding(),
    };

    // 构建初始上下文
    const context = await this.contextBuilder.build(
      { cwd: this.cwd, userMessage, sessionId: sessionState.id },
      memoryProvider,
    );

    // 拼装 system prompt（含注入的记忆）
    let systemPrompt = DEFAULTS.systemPrompt;
    if (context.retrievedMemories && context.retrievedMemories.length > 0) {
      const memText = context.retrievedMemories.map(
        (m) => `- [${m.kind}] ${m.summary} (置信度: ${m.relevance})`,
      ).join("\n");
      systemPrompt += `\n\n## 相关记忆\n${memText}`;
    }

    // ★ 关键修复：累积式消息列表，每轮追加 LLM 响应 + 工具结果
    const conversation: LLMMessage[] = [{ role: "system", content: systemPrompt }];
    // 把 ContextBuilder 返回的初始 messages（历史 + 用户消息）加入
    for (const m of context.messages ?? []) {
      conversation.push({ role: m.role as "user" | "assistant", content: m.content ?? "" });
    }

    // 工具 schema（LLM function calling 格式）
    const toolSchemas = getToolSchemas(this.harness);

    let finalResponse = "";

    try {
      while (stepCount < this.options.maxSteps) {
        stepCount++;
        this.events.emit("step:start", { step: stepCount });
        this.loopDetector.recordStep();

        // 检查 AbortSignal
        if (options?.abortSignal?.aborted) { aborted = true; break; }

        // ─── 调用 LLM ───────────────────────
        const response = await this.llm.chat(conversation, toolSchemas as unknown[]);
        tokensUsed += (response.usage?.promptTokens ?? 0) + (response.usage?.completionTokens ?? 0);
        finalResponse = response.content;
        this.events.emit("step:end", { step: stepCount, response: response.content });

        // 如果没有 tool calls，对话结束
        if (!response.toolCalls || response.toolCalls.length === 0) {
          // 把 assistant 回复加入对话
          conversation.push({ role: "assistant", content: response.content });
          break;
        }

        // ★ 加入 assistant 消息（带 tool_calls）
        conversation.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // ★ 执行所有 tool calls，逐个加入 conversation
        for (const tc of response.toolCalls) {
          if (options?.abortSignal?.aborted) { aborted = true; break; }

          toolCallsTotal++;
          this.loopDetector.recordToolCall(tc.function.name, JSON.parse(tc.function.arguments) as Record<string, unknown>);

          this.events.emit("tool:before", {
            tool: tc.function.name,
            args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
          });

          // 执行工具
          const result = await this.harness.exec({
            tool: tc.function.name,
            args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
          });

          this.events.emit("tool:after", {
            tool: tc.function.name,
            success: result.success,
            output: result.output?.slice(0, 500) ?? "",
          });

          // 跟踪文件修改
          if (result.filesChanged) {
            for (const file of result.filesChanged) {
              this.loopDetector.recordFileModification(file);
            }
          }

          // ★ 工具结果加入对话
          const toolOutput = result.success
            ? (result.output ?? "OK")
            : `ERROR: ${result.error ?? "Unknown error"}\n${result.output ?? ""}`;
          conversation.push({
            role: "tool",
            content: toolOutput.slice(0, 4000), // 截断长输出防 token 爆炸
            toolCallId: tc.id,
          });
        }

        if (aborted) break;

        // ─── 循环检测 ─────────────────────
        const loopCheck = this.loopDetector.detect();
        if (loopCheck.detected) {
          loopDetected = true;
          this.events.emit("loop:detected", { reason: loopCheck.reason! });
          this.logger.warn(`loop detected: ${loopCheck.reason}`);
          break;
        }
      }
    } catch (err: unknown) {
      this.logger.error(`run error: ${String(err)}`);
      this.events.emit("error", { message: String(err), step: stepCount });
      finalResponse = `Error: ${String(err)}`;
    }

    // ─── 收尾 ────────────────────────────
    this.sm.transition(aborted ? "stopped" : "idle");

    const stats: RunStats = {
      steps: stepCount,
      toolCalls: toolCallsTotal,
      tokensUsed,
      durationMs: Date.now() - startTime,
      loopDetected,
      aborted,
    };

    const result: RunResult = {
      success: !aborted && !loopDetected,
      response: { content: finalResponse },
      stats,
      error: loopDetected ? "Loop detected" : aborted ? "Aborted" : undefined,
    };

    this.events.emit("run:end", { result });
    this.loopDetector.reset();
    this.logger.info(`done: ${stats.steps} steps, ${stats.toolCalls} tools, ${stats.durationMs}ms`);

    return result;
  }

  async destroy(): Promise<void> {
    this.plugins.clear();
    this.events.clear();
    this.logger.info("destroyed");
  }
}
