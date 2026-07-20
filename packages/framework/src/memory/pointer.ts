// @structfocus/framework - 记忆扩展类型：可逆指针 / 知识胶囊 / 环境包 / 权限矩阵 / 信号

import type { Id, Timestamp, JsonObject } from "../types/base.js";

// ─── 上下文可逆指针（替代有损摘要） ─────────────────────────

export type PointerType = "decision" | "file-content" | "tool-output" | "session-state" | "error-context";
export type Importance = "high" | "medium" | "low";

export interface ContextPointer {
  readonly id: Id<"pointer">;
  readonly type: PointerType;
  readonly topic: string;
  readonly files: readonly string[];
  readonly decision?: string;
  readonly keywords: readonly string[];
  readonly timestamp: Timestamp;
  readonly importance: Importance;
  readonly linkedCapsuleIds?: readonly string[];
  /** 完整内容的 JSONL 行号或外部引用 */
  readonly contentRef: string;
  /** 估算 tokens 数 */
  readonly estimatedTokens: number;
}

// ─── 知识胶囊（行业空白，原创性最高） ───────────────────────

export type CapsuleStatus = "active" | "deprecated" | "needs-verify" | "raw";

export interface CapsuleModification {
  readonly file: string;
  readonly change: string;
}

export interface CapsuleTestResult {
  readonly testName: string;
  readonly passed: boolean;
  readonly output?: string;
}

export interface KnowledgeCapsule {
  readonly id: Id<"capsule">;
  readonly requirement: string;
  readonly modifications: readonly CapsuleModification[];
  readonly keyDecisions: readonly string[];
  readonly testResults: readonly CapsuleTestResult[];
  readonly knownLimitations: readonly string[];
  readonly linkedPointers: readonly string[];
  readonly tags: readonly string[];
  readonly timestamp: Timestamp;
  /** 版本链/依赖/状态 */
  readonly status: CapsuleStatus;
  readonly parent?: string;
  readonly dependsOn?: readonly string[];
  readonly confidence?: number;
  /** 触发方式 */
  readonly trigger: "test-pass" | "debug-resolved" | "user-remember" | "heartbeat";
}

// ─── 环境打包（项目记忆 layer） ────────────────────────────

export interface EnvironmentLayer {
  readonly name: string;
  readonly description: string;
  readonly files: readonly string[];
  readonly keyPatterns: readonly string[];
  readonly notes?: string;
}

export interface EnvironmentPackage {
  readonly id: Id<"env">;
  readonly projectName: string;
  readonly rootPath: string;
  readonly layers: readonly EnvironmentLayer[];
  readonly onboarding: string;
  readonly timestamp: Timestamp;
}

// ─── N 维权限矩阵 ──────────────────────────────────────────

export type PermissionOperation = "read" | "write" | "execute" | "network" | "delete" | "git-push";
export type PermissionScope = "file" | "directory" | "process" | "network" | "system";
export type PermissionPattern = string; // glob 或正则

export type PermissionDecision = "allow" | "deny" | "ask" | "ask-once";

export interface PermissionRule {
  readonly operation: PermissionOperation;
  readonly scope: PermissionScope;
  readonly pattern: PermissionPattern;
  readonly decision: PermissionDecision;
  readonly reason?: string;
}

export type PermissionMatrix = readonly PermissionRule[];

// ─── 隐式信号（Harness → Context） ─────────────────────────

export type SignalType =
  | "known-bug"
  | "related-test"
  | "dependency-impact"
  | "low-confidence-memory";

export interface HarnessSignal {
  readonly type: SignalType;
  readonly message: string;
  readonly detail?: string;
  readonly source?: string;
}

// ─── 记忆记录（4 类：decisions/facts/errors/prefs） ─────────

export type MemoryKind = "decision" | "fact" | "error" | "pref";

export interface MemoryRecord {
  readonly id: Id<"memory">;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly context?: JsonObject;
  readonly tags: readonly string[];
  readonly timestamp: Timestamp;
  readonly confidence?: number;
  readonly deprecated?: boolean;
}
