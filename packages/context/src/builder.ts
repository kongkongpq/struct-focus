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
import type {
  ContextEntry,
  TaskContext,
  ContextPlacement,
  LLMMessage,
  EntryType,
  CacheControlBreakpoint,
} from "./types.js";

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

// ─── 六层 Context Builder 管线（设计 §3 / LongContextRecall 扩展 2026-07-19） ───
//
// 把内部 ContextEntry[] 组装成下一轮 LLM 输入（LLMMessage[]）。
// 逻辑上区分 I-Context（指令/系统，前缀缓存稳定）与 D-Context（数据，可压缩/驱逐），
// 物理上同处一个上下文窗口。
//
// 分层：
//   L1 System    —— 系统提示（稳定，打 cacheControl 断点）
//   L2 Git       —— 项目上下文：当前分支 / 改动文件（可选，detectGitInfo 提供）
//   L3 Task      —— 任务上下文：编辑文件 / 失败测试 / 子任务 / 最近错误
//   L4 Focused   —— 聚焦层：显式强调当前聚焦文件（与 D-Context 中的受保护条目呼应）
//   L5 History   —— 历史层：按时间顺序渲染所有活跃条目
//                   - L2_working: 完整渲染当前工作和最近对话
//                   - L3_compressed: 替换为 ~100 token observation（胶囊摘要 + expand 指令）
//                   - L4_raw: 不渲染（仅在精确召回时从 ContentStore 取出）
//   L6 Budget    —— 预算检查层：高占用时追加一行告警（真正的驱逐决策在 autoManage）

const ROLE_BY_TYPE: Record<EntryType, LLMMessage["role"]> = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
  memory: "user",
  observation: "user",
};

function tagFor(e: ContextEntry): string {
  if (e.type === "memory") return "[memory] ";
  if (e.type === "observation") return "[observation] ";
  if (e.sourceType) return `[${e.sourceType}] `;
  return "";
}

/** L1：系统提示 */
function buildSystem(input: BuildContextInput): LLMMessage {
  return {
    role: "system",
    content: input.systemPrompt,
    cacheControl: { type: "ephemeral" } satisfies CacheControlBreakpoint,
  };
}

/** L2：Git 项目上下文（可选） */
function buildGit(input: BuildContextInput): LLMMessage | null {
  if (!input.gitInfo || input.gitInfo.trim().length === 0) return null;
  return {
    role: "system",
    content: `## 项目上下文（git）\n${input.gitInfo.trim()}`,
  };
}

/** L3：任务上下文 */
function buildTask(tc: TaskContext): LLMMessage | null {
  const lines = ["## 当前任务上下文"];
  if (tc.editingFiles.length) lines.push(`- 编辑中文件：${tc.editingFiles.join(", ")}`);
  if (tc.failingTests.length) lines.push(`- 失败测试：${tc.failingTests.join(", ")}`);
  if (tc.currentSubtasks.length) lines.push(`- 子任务：${tc.currentSubtasks.join(" / ")}`);
  if (tc.focusedSymbols.length) lines.push(`- 聚焦符号：${tc.focusedSymbols.join(", ")}`);
  if (tc.recentErrors.length) {
    lines.push("- 最近错误：");
    for (const e of tc.recentErrors.slice(0, 5)) {
      lines.push(`  - ${e.file ? `[${e.file}] ` : ""}${e.message}`);
    }
  }
  if (lines.length === 1) return null;
  return { role: "system", content: lines.join("\n") };
}

/** L4：聚焦层（强调当前聚焦文件） */
function buildFocused(tc: TaskContext, entries: ContextEntry[]): LLMMessage | null {
  if (tc.editingFiles.length === 0) return null;
  const protectedIds = new Set(
    entries
      .filter((e) => e.protectedBy === "editingFile" && e.source && tc.editingFiles.includes(e.source))
      .map((e) => e.id),
  );
  const lines = ["## 聚焦文件（受保护，绝不驱逐）"];
  for (const f of tc.editingFiles) {
    const present = protectedIds.size > 0 && entries.some((e) => e.source === f && protectedIds.has(e.id));
    lines.push(`- ${f}${present ? "  ✓ 已在上下文" : ""}`);
  }
  return { role: "system", content: lines.join("\n") };
}

/** L5：历史层（按时间顺序渲染活跃条目，保持原始 user/assistant 交替结构） */
function buildHistory(entries: ContextEntry[], placementMap?: Map<string, ContextPlacement>): LLMMessage[] {
  const ordered = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const messages: LLMMessage[] = [];
  for (const e of ordered) {
    // placementMap 优先，回退到条目自带 placement（与 manager.toMessages 一致）
    const placement = placementMap?.get(e.id) ?? e.placement;
    // L4_raw：不渲染
    if (placement?.target === "L4_raw") continue;
    // L3_compressed：替换为胶囊摘要
    if (placement?.target === "L3_compressed") {
      const summary =
        placement.capsuleSummary ??
        (e.compressed && e.compressedContent ? e.compressedContent : e.content.slice(0, 200));
      messages.push({
        role: "user",
        content: `📦 [胶囊] ${summary}\n调用 expand:context("${e.id}") 展开完整记录`,
      });
      continue;
    }
    // L2_working：按原始类型渲染
    const text = e.compressed && e.compressedContent ? e.compressedContent : e.content;
    const role =
      e.type === "observation" || e.type === "tool"
        ? "user" // API 工具输出用 user 角色
        : e.type === "memory"
          ? "user"
          : ROLE_BY_TYPE[e.type] ?? "user";
    // 保留原始类型标记但不破坏角色交替：user/assistant 不加前缀，其他加轻量标记
    const prefix = e.type === "user" || e.type === "assistant" ? "" : tagFor(e);
    messages.push({ role, content: `${prefix}${text}` });
  }
  return messages;
}

/** L6：预算检查层（高占用告警） */
function buildBudget(usePercent: number): LLMMessage | null {
  if (usePercent < 85) return null;
  const level = usePercent >= 90 ? "紧急" : "偏高";
  return {
    role: "system",
    content: `⚠️ 上下文占用 ${usePercent.toFixed(0)}%（${level}）。引擎已在每步自动管理（驱逐/压缩/聚焦）；如仍超限，请主动 forget 非必要文件。`,
  };
}

/**
 * 组装上下文（六层管线）。纯函数，无副作用。
 * ContextManager.toMessages 的底层实现。
 */
export interface BuildContextInput {
  systemPrompt: string;
  entries: ContextEntry[];
  taskContext?: TaskContext;
  usePercent: number;
  gitInfo?: string;
  placementMap: Map<string, ContextPlacement>;
}

export function buildContext(input: BuildContextInput): LLMMessage[] {
  // 仅渲染活跃条目（已驱逐的不进入下一轮 LLM 输入）
  const entries = input.entries.filter((e) => !e.evicted);
  const messages: LLMMessage[] = [];
  messages.push(buildSystem(input));
  const git = buildGit(input);
  if (git) messages.push(git);
  const task = input.taskContext ? buildTask(input.taskContext) : null;
  if (task) messages.push(task);
  const focused = input.taskContext ? buildFocused(input.taskContext, entries) : null;
  if (focused) messages.push(focused);
  messages.push(...buildHistory(entries, input.placementMap));
  const budget = buildBudget(input.usePercent);
  if (budget) messages.push(budget);
  return messages;
}
