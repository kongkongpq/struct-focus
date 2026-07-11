// @struct/context - ContextBuilder 实现

import type {
  IContextBuilder,
  IMemoryProvider,
  BuildOptions,
  AssembledContext,
  Message,
  ContextPointer,
  ContextSignal,
  RetrievedMemory,
  PointerPlaceholder,
  TokenUsage,
} from "@struct/framework";
import { Pipeline, type NamedMiddleware } from "@struct/framework";
import { PointerRegistry } from "./pointer.js";
import { BudgetManager, TOTAL_BUDGET, FIXED_OVERHEAD } from "./budget.js";
import { CodeExplorer } from "./explorer.js";

/** 辅助：创建带 name 的 NamedMiddleware（绕过函数 name 只读限制） */
function named<T>(name: string, fn: (ctx: T, next: () => Promise<void>) => Promise<void>): NamedMiddleware<T> {
  const wrapper = fn as NamedMiddleware<T>;
  Object.defineProperty(wrapper, "name", { value: name, configurable: true });
  return wrapper;
}

interface BuildContext {
  options: BuildOptions;
  memory?: IMemoryProvider;
  systemPrompt: string;
  messages: Message[];
  pointers: ContextPointer[];
  pointerPlaceholders: PointerPlaceholder[];
  signals: ContextSignal[];
  retrievedMemories: RetrievedMemory[];
  budget: BudgetManager;
  pointerRegistry: PointerRegistry;
  explorer: CodeExplorer;
}

export class ContextBuilder implements IContextBuilder {
  private readonly pipeline: Pipeline<BuildContext>;
  private readonly registry: PointerRegistry;
  private readonly explorer: CodeExplorer;

  constructor() {
    this.pipeline = new Pipeline<BuildContext>();
    this.registry = new PointerRegistry();
    this.explorer = new CodeExplorer();

    // 注册 6 层中间件
    this.pipeline.use(this.fixedLayer);
    this.pipeline.use(this.sessionLayer);
    this.pipeline.use(this.retrievalLayer);
    this.pipeline.use(this.toolsLayer);
    this.pipeline.use(this.codeExplorerLayer);
    this.pipeline.use(this.budgetCheckLayer);
  }

  async build(options: BuildOptions, memory?: IMemoryProvider): Promise<AssembledContext> {
    if (memory) this.registry.setMemoryProvider(memory);

    const ctx: BuildContext = {
      options,
      memory,
      systemPrompt: "",
      messages: [...(options.history ?? [])],
      pointers: [],
      pointerPlaceholders: [],
      signals: [],
      retrievedMemories: [],
      budget: new BudgetManager(),
      pointerRegistry: this.registry,
      explorer: this.explorer,
    };

    const result = await this.pipeline.run(ctx);
    if (!result.ok) {
      // 管道失败仍返回可用上下文
    }

    return {
      systemPrompt: ctx.systemPrompt,
      messages: ctx.messages,
      pointers: ctx.pointers,
      pointerPlaceholders: ctx.pointerPlaceholders,
      tokenUsage: ctx.budget.toTokenUsage(),
      signals: ctx.signals,
      retrievedMemories: ctx.retrievedMemories.length > 0 ? ctx.retrievedMemories : undefined,
    };
  }

  // ── Layer 1: fixed（系统提示 + 基础信息） ──────────────

  private fixedLayer: NamedMiddleware<BuildContext> = named("fixed", async (ctx: BuildContext, next: () => Promise<void>) => {
      const parts: string[] = [];
      parts.push("You are a Struct Bridge AI Coding Agent.");
      parts.push("Follow the user's instructions precisely.");

      // 项目上下文
      if (ctx.memory) {
        const projectCtx = ctx.memory.getProjectContext();
        if (projectCtx) parts.push(`\n## Project Context\n${projectCtx}`);
      }

      ctx.systemPrompt = parts.join("\n");
      ctx.budget.consume("fixed", BudgetManager.estimateTokens(ctx.systemPrompt));
      await next();
    });

  // ── Layer 2: session（会话历史 + 当前用户消息） ────────

  private sessionLayer: NamedMiddleware<BuildContext> = named("session", async (ctx: BuildContext, next: () => Promise<void>) => {
      const userMsg: Message = { role: "user", content: ctx.options.userMessage };
      ctx.messages.push(userMsg);

      const sessionText = ctx.messages.map((m) => m.content).join("\n");
      ctx.budget.consume("session", BudgetManager.estimateTokens(sessionText));
      await next();
    });

  // ── Layer 3: retrieval（记忆检索 + knowledge_query） ────

  private retrievalLayer: NamedMiddleware<BuildContext> = named("retrieval", async (ctx: BuildContext, next: () => Promise<void>) => {
      if (ctx.memory) {
        // T1 同步检索（200ms 超时）
        const query = ctx.options.knowledgeQuery ?? ctx.options.userMessage;
        const memories = ctx.memory.searchSync(query, { timeoutMs: 200, limit: 5 });
        ctx.retrievedMemories = [...memories];

        // 查找关联指针
        if (ctx.options.activeFiles) {
          for (const file of ctx.options.activeFiles) {
            const pointers = ctx.memory.findPointersByFile(file);
            for (const p of pointers) {
              ctx.pointerRegistry.register(p);
            }
          }
        }

        // 检索到的记忆加入系统提示
        if (memories.length > 0) {
          const memText = memories.map((m) => `- [${m.kind}] ${m.summary}`).join("\n");
          ctx.systemPrompt += `\n\n## Retrieved Memories\n${memText}`;
        }

        ctx.budget.consume("retrieval", BudgetManager.estimateTokens(
          ctx.retrievedMemories.map((m) => m.summary).join(""),
        ));
      }
      await next();
    });

  // ── Layer 4: tools（工具定义 + 隐式信号） ──────────────

  private toolsLayer: NamedMiddleware<BuildContext> = named("tools", async (ctx: BuildContext, next: () => Promise<void>) => {
      // 工具描述（简化版，实际由 agent 注入）
      const toolText = "Available tools: file_read, file_write, file_edit, shell_exec, code_search, test_run, ...";
      ctx.systemPrompt += `\n\n## Tools\n${toolText}`;
      ctx.budget.consume("tools", BudgetManager.estimateTokens(toolText));
      await next();
    });

  // ── Layer 5: codeExplorer（文件/符号定位） ─────────────

  private codeExplorerLayer: NamedMiddleware<BuildContext> = named("codeExplorer", async (ctx: BuildContext, next: () => Promise<void>) => {
      // 从用户消息提取关键词
      const keywords = ctx.options.userMessage
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 5);

      if (keywords.length > 0) {
        try {
          const relevantFiles = await ctx.explorer.findRelevant(ctx.options.cwd, keywords);
          if (relevantFiles.length > 0) {
            const fileList = relevantFiles.slice(0, 10).map((f) => `- ${f.path}`).join("\n");
            ctx.systemPrompt += `\n\n## Relevant Files\n${fileList}`;
            ctx.budget.consume("retrieval", BudgetManager.estimateTokens(fileList));
          }
        } catch { /* skip on error */ }
      }

      // 指针占位（将完整内容替换为轻量指针）
      const allPointers = ctx.pointerRegistry.getAll();
      const deduped = ctx.pointerRegistry.deduplicate();
      for (const pointer of deduped) {
        const placeholder: PointerPlaceholder = {
          pointerId: pointer.id,
          topic: pointer.topic,
          importance: pointer.importance,
          estimatedTokens: 50, // 指针占位 ~50 tokens
        };
        ctx.pointerPlaceholders.push(placeholder);
        ctx.pointers.push(pointer);

        // 强制展开 high 指针
        if (pointer.importance === "high") {
          ctx.pointerRegistry.markExpanded(pointer.id);
        }
      }

      ctx.budget.consume("retrieval", ctx.pointerPlaceholders.length * 50);
      await next();
    });

  // ── Layer 6: budgetCheck（预算截断 + 驱逐） ────────────

  private budgetCheckLayer: NamedMiddleware<BuildContext> = named("budgetCheck", async (ctx: BuildContext, next: () => Promise<void>) => {
      // 检查是否超预算
      if (ctx.budget.isOverBudget()) {
        // 按驱逐优先级截断
        // 1. 旧工具输出 → [已省略]
        ctx.messages = ctx.messages.map((m) => {
          if (m.role === "tool" && m.content.length > 500) {
            return { ...m, content: "[已省略]" };
          }
          return m;
        });

        // 2. 已展开指针包 → 重新压缩（非 high）
        if (ctx.budget.isOverBudget()) {
          for (const p of ctx.pointers) {
            if (p.importance !== "high") {
              ctx.pointerRegistry.compress(p.id);
            }
          }
        }

        // 3. 低相关记忆（截断到 2 条）
        if (ctx.budget.isOverBudget() && ctx.retrievedMemories.length > 2) {
          ctx.retrievedMemories = ctx.retrievedMemories.slice(0, 2);
        }
      }

      await next();
    });
}
