// @structfocus/framework - 上下文构建器接口与契约

import type { ContextPointer } from "../memory/pointer.js";

// ─── 上下文指针占位（展开前） ─────────────────────────────

export interface PointerPlaceholder {
  readonly pointerId: string;
  readonly topic: string;
  readonly importance: "high" | "medium" | "low";
  readonly estimatedTokens: number;
}

// ─── 预算切片 ─────────────────────────────────────────────

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

// ─── 组装后的上下文 ───────────────────────────────────────

export interface AssembledContext {
  readonly systemPrompt: string;
  readonly messages: readonly import("../plugins/types.js").Message[];
  readonly pointers: readonly ContextPointer[];
  readonly pointerPlaceholders: readonly PointerPlaceholder[];
  readonly tokenUsage: TokenUsage;
  /** 隐式信号（来自 Harness：已知 bug / 相关测试 / 依赖影响 / 低置信度记忆） */
  readonly signals: readonly ContextSignal[];
  /** 检索命中的记忆摘要 */
  readonly retrievedMemories?: readonly RetrievedMemory[];
}

export interface RetrievedMemory {
  readonly kind: string;
  readonly summary: string;
  readonly relevance: number;
}

export interface ContextSignal {
  readonly type: "known-bug" | "related-test" | "dependency-impact" | "low-confidence";
  readonly message: string;
  readonly detail?: string;
}

// ─── 构建选项 ─────────────────────────────────────────────

export interface BuildOptions {
  readonly cwd: string;
  readonly userMessage: string;
  readonly sessionId: string;
  readonly history?: readonly import("../plugins/types.js").Message[];
  readonly maxTokens?: number;
  /** LLM Pull 信号：显式 knowledge_query */
  readonly knowledgeQuery?: string;
  /** 当前活跃文件（触发自动关联指针） */
  readonly activeFiles?: readonly string[];
}

// ─── IMemoryProvider：context 通过此接口与记忆交互（DI，不直接 import memory 包） ──

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

// ─── IContextBuilder ──────────────────────────────────────

export interface IContextBuilder {
  build(options: BuildOptions, memory?: IMemoryProvider): Promise<AssembledContext>;
}
