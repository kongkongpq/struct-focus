// @structfocus/context — 从 @structfocus/framework 内联的类型
//
// 原因：删除 framework 包后，context 需要这些类型契约来支持
// ContextBuilder / PointerRegistry / BudgetManager。
// 这些定义原属 framework/src/context/builder.ts、memory/pointer.ts、
// plugins/types.ts。内联后不产生新的运行时依赖。

import type { Id } from "./types.js";

// ─── 指针类型（原 framework/src/memory/pointer.ts） ─────────

export type PointerType = "decision" | "file-content" | "tool-output" | "session-state" | "error-context";
export type Importance = "high" | "medium" | "low";

export interface ContextPointer {
  readonly id: Id<"pointer">;
  readonly type: PointerType;
  readonly topic: string;
  readonly files: readonly string[];
  readonly decision?: string;
  readonly keywords: readonly string[];
  /** 毫秒时间戳（原用 ISO 字符串 Timestamp，内联统一为 number） */
  readonly timestamp: number;
  readonly importance: Importance;
  readonly linkedCapsuleIds?: readonly string[];
  /** 完整内容的 JSONL 行号或外部引用 */
  readonly contentRef: string;
  /** 估算 tokens 数 */
  readonly estimatedTokens: number;
}

// ─── 消息类型（原 framework/src/plugins/types.ts） ──────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly unknown[];
  readonly name?: string;
}

// ─── 预算切片（原 framework/src/context/builder.ts） ────────

export interface TokenSlice {
  readonly layer: string;
  readonly tokens: number;
}

export interface TokenUsage {
  readonly total: number;
  readonly slices: readonly TokenSlice[];
  readonly budget: number;
  readonly remaining: number;
}

// ─── 指针占位 ──────────────────────────────────────────────

export interface PointerPlaceholder {
  readonly pointerId: string;
  readonly topic: string;
  readonly importance: Importance;
  readonly estimatedTokens: number;
}

// ─── 检索记忆 ──────────────────────────────────────────────

export interface RetrievedMemory {
  readonly kind: string;
  readonly summary: string;
  readonly relevance: number;
}

// ─── 上下文信号 ────────────────────────────────────────────

export interface ContextSignal {
  readonly type: "known-bug" | "related-test" | "dependency-impact" | "low-confidence";
  readonly message: string;
  readonly detail?: string;
}

// ─── 构建选项 ──────────────────────────────────────────────

export interface BuildOptions {
  readonly cwd: string;
  readonly userMessage: string;
  readonly sessionId: string;
  readonly history?: readonly Message[];
  readonly maxTokens?: number;
  /** LLM Pull 信号：显式 knowledge_query */
  readonly knowledgeQuery?: string;
  /** 当前活跃文件（触发自动关联指针） */
  readonly activeFiles?: readonly string[];
}

// ─── 组装后的上下文 ────────────────────────────────────────

export interface AssembledContext {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly pointers: readonly ContextPointer[];
  readonly pointerPlaceholders: readonly PointerPlaceholder[];
  readonly tokenUsage: TokenUsage;
  /** 隐式信号（来自 Harness：已知 bug / 相关测试 / 依赖影响 / 低置信度记忆） */
  readonly signals: readonly ContextSignal[];
  /** 检索命中的记忆摘要 */
  readonly retrievedMemories?: readonly RetrievedMemory[];
}

// ─── IMemoryProvider（DI，不直接 import memory 包） ─────────

export interface IMemoryProvider {
  /** 同步检索（200ms 超时，侧车 T1） */
  searchSync(query: string, opts?: { timeoutMs?: number; limit?: number }): readonly RetrievedMemory[];
  /** 按文件查找关联指针 */
  findPointersByFile(file: string): readonly ContextPointer[];
  /** 展开指针为完整内容 */
  expandPointer(pointerId: string): string | null;
  /** 获取 ONBOARDING/环境包 */
  getProjectContext(): string | null;
}

// ─── IContextBuilder ───────────────────────────────────────

export interface IContextBuilder {
  build(options: BuildOptions, memory?: IMemoryProvider): Promise<AssembledContext>;
}
