// @struct/harness - 策略：沙箱级别、危险命令黑名单、N维权限矩阵、ASK_ONCE

import type { PermissionMatrix, PermissionRule, PermissionDecision, RiskLevel, SandboxLevel } from "@struct/framework";

// ─── 危险命令黑名单 ────────────────────────────────────────

const DANGEROUS_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+-rf\s+\/?(--no-preserve-root)?\s*\/?$/i, reason: "rm -rf 根目录" },
  { pattern: /\brm\s+-rf\s+\/(?:[a-zA-Z]:(?:\/|\\)?|$)/i, reason: "rm -rf 绝对路径根" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/i, reason: "fork bomb" },
  { pattern: /\bmkfs\./i, reason: "格式化磁盘" },
  { pattern: /\bdd\s+.*of=\/dev\//i, reason: "dd 写入设备" },
  { pattern: /\bchmod\s+-R\s+777\s+\//i, reason: "chmod 777 根目录" },
  { pattern: /\b(git\s+push\s+--force|git\s+push\s+-f)\s+.*main/i, reason: "force push main" },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh/i, reason: "curl pipe shell" },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh/i, reason: "wget pipe shell" },
  { pattern: /\bshutdown\b/i, reason: "关机命令" },
  { pattern: /\breboot\b/i, reason: "重启命令" },
  { pattern: /\bkillall\b/i, reason: "killall" },
];

// ─── 默认权限矩阵 ──────────────────────────────────────────

export const DEFAULT_PERMISSIONS: PermissionMatrix = [
  { operation: "write", scope: "file", pattern: "*.env*", decision: "deny", reason: "环境文件禁止写入" },
  { operation: "write", scope: "file", pattern: "**/.env*", decision: "deny", reason: ".env 禁止写入" },
  { operation: "write", scope: "directory", pattern: "/etc/**", decision: "deny", reason: "系统目录禁止写入" },
  { operation: "write", scope: "directory", pattern: "/usr/**", decision: "deny", reason: "系统目录禁止写入" },
  { operation: "write", scope: "directory", pattern: "C:/Windows/**", decision: "deny", reason: "Windows 系统目录禁止写入" },
  { operation: "git-push", scope: "system", pattern: "*", decision: "ask", reason: "git push 需确认" },
  { operation: "git-push", scope: "system", pattern: "*main*", decision: "deny", reason: "禁止 force push main" },
  { operation: "delete", scope: "file", pattern: "*.json", decision: "ask", reason: "删除 JSON 需确认" },
  { operation: "delete", scope: "directory", pattern: "node_modules/**", decision: "allow", reason: "node_modules 可删" },
  { operation: "execute", scope: "process", pattern: "npm *", decision: "allow" },
  { operation: "execute", scope: "process", pattern: "node *", decision: "allow" },
  { operation: "execute", scope: "process", pattern: "git *", decision: "allow" },
  { operation: "execute", scope: "process", pattern: "tsc *", decision: "allow" },
  { operation: "execute", scope: "process", pattern: "vitest *", decision: "allow" },
  { operation: "execute", scope: "process", pattern: "pnpm *", decision: "allow" },
  { operation: "read", scope: "file", pattern: "*", decision: "allow" },
  { operation: "read", scope: "directory", pattern: "*", decision: "allow" },
];

// ─── 风险 → 沙箱级别映射 ──────────────────────────────────

export const RISK_TO_SANDBOX: Record<RiskLevel, SandboxLevel> = {
  safe: 0,
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ─── Policy ────────────────────────────────────────────────

export interface PolicyOptions {
  permissions?: PermissionMatrix;
  sandboxOverrides?: Partial<Record<RiskLevel, SandboxLevel>>;
  askOnceTrust?: Set<string>;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
}

export class Policy {
  readonly permissions: PermissionMatrix;
  readonly sandboxOverrides: Partial<Record<RiskLevel, SandboxLevel>>;
  readonly askOnceTrust: Set<string>;
  readonly maxOutputBytes: number;
  readonly defaultTimeoutMs: number;

  constructor(opts: PolicyOptions = {}) {
    this.permissions = opts.permissions ?? DEFAULT_PERMISSIONS;
    this.sandboxOverrides = opts.sandboxOverrides ?? {};
    this.askOnceTrust = opts.askOnceTrust ?? new Set();
    this.maxOutputBytes = opts.maxOutputBytes ?? 1024 * 1024;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30000;
  }

  getSandboxLevel(risk: RiskLevel): SandboxLevel {
    return this.sandboxOverrides[risk] ?? RISK_TO_SANDBOX[risk] ?? 0;
  }

  isDangerous(command: string): { dangerous: boolean; reason?: string } {
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { dangerous: true, reason };
      }
    }
    return { dangerous: false };
  }

  checkPermission(
    operation: PermissionRule["operation"],
    scope: PermissionRule["scope"],
    target: string,
  ): { decision: PermissionDecision; reason?: string } {
    let matched: PermissionRule | undefined;
    const sorted = [...this.permissions].sort(
      (a, b) => b.pattern.length - a.pattern.length,
    );

    for (const rule of sorted) {
      if (rule.operation === operation && rule.scope === scope) {
        if (this.matchPattern(rule.pattern, target)) {
          matched = rule;
          break;
        }
      }
    }

    if (!matched) {
      return { decision: "ask", reason: "无匹配规则，默认询问" };
    }

    if (matched.decision === "ask-once") {
      const key = `${operation}:${scope}:${target}`;
      if (this.askOnceTrust.has(key)) {
        return { decision: "allow", reason: "已在本会话信任" };
      }
    }

    return { decision: matched.decision, reason: matched.reason };
  }

  trustAskOnce(
    operation: PermissionRule["operation"],
    scope: PermissionRule["scope"],
    target: string,
  ): void {
    const key = `${operation}:${scope}:${target}`;
    this.askOnceTrust.add(key);
  }

  private matchPattern(pattern: string, target: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const regex = new RegExp(`^${regexStr}$`, "i");
    return regex.test(target);
  }
}
