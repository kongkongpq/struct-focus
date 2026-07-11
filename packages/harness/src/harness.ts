// @struct/harness - Harness 核心类

import type { ToolDef, ToolCall, ToolResult } from "@struct/framework";
import { retry } from "@struct/framework";
import { Policy } from "./policy.js";
import { ProcessExecutor } from "./executor/process.js";
import { AuditLog } from "./audit.js";
import { StateManager } from "./state.js";
import { TOOL_MAP } from "./tools/defs.js";
import { sanitizeOutput, classifyError } from "./pipeline/sanitize.js";
import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";

export interface HarnessOptions {
  readonly cwd: string;
  readonly policy?: Policy;
  readonly stateDir?: string;
  readonly auditPath?: string;
}

export class Harness {
  readonly cwd: string;
  readonly policy: Policy;
  readonly executor: ProcessExecutor;
  readonly audit: AuditLog;
  readonly state: StateManager;
  private tools = new Map<string, ToolDef>(TOOL_MAP);
  private disabledTools = new Set<string>();

  constructor(opts: HarnessOptions) {
    this.cwd = opts.cwd;
    this.policy = opts.policy ?? new Policy();
    this.executor = new ProcessExecutor();
    const stateDir = opts.stateDir ?? path.join(opts.cwd, ".agent", "state");
    this.state = new StateManager(stateDir);
    this.audit = new AuditLog(opts.auditPath ?? path.join(stateDir, "audit.jsonl"));
  }

  async init(): Promise<void> {
    await this.state.init();
    await this.audit.init();
  }

  registerTools(tools: readonly ToolDef[]): void {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  disableTool(name: string): void { this.disabledTools.add(name); }
  enableTool(name: string): void { this.disabledTools.delete(name); }
  listTools(): readonly ToolDef[] { return Array.from(this.tools.values()).filter((t) => !this.disabledTools.has(t.name)); }
  getTool(name: string): ToolDef | undefined { return this.tools.get(name); }

  async exec(toolCall: ToolCall, opts?: { abortSignal?: AbortSignal; retryMax?: number }): Promise<ToolResult> {
    const start = Date.now();
    const toolDef = this.tools.get(toolCall.tool);

    if (!toolDef) return { success: false, output: "", error: `未知工具: ${toolCall.tool}`, durationMs: Date.now() - start, retryable: false };
    if (this.disabledTools.has(toolCall.tool)) return { success: false, output: "", error: `工具已禁用`, durationMs: Date.now() - start, blocked: true, blockedReason: "disabled", retryable: false };

    if (toolCall.tool === "shell_exec") {
      const cmd = String(toolCall.args["command"] ?? "");
      const danger = this.policy.isDangerous(cmd);
      if (danger.dangerous) {
        const result: ToolResult = { success: false, output: "", error: `危险命令拦截: ${danger.reason}`, durationMs: Date.now() - start, blocked: true, blockedReason: danger.reason, retryable: false };
        await this.audit.append({ timestamp: new Date().toISOString(), tool: toolCall.tool, args: toolCall.args, result: "blocked", durationMs: result.durationMs, reason: danger.reason });
        return result;
      }
    }

    const perm = this.checkPermission(toolCall);
    if (perm.denied) {
      const result: ToolResult = { success: false, output: "", error: `权限拒绝: ${perm.reason}`, durationMs: Date.now() - start, blocked: true, blockedReason: perm.reason, retryable: false };
      await this.audit.append({ timestamp: new Date().toISOString(), tool: toolCall.tool, args: toolCall.args, result: "blocked", durationMs: result.durationMs, reason: perm.reason });
      return result;
    }

    let result = await this.executeTool(toolCall, opts?.abortSignal);
    if (!result.success && result.retryable && opts?.retryMax !== 0) {
      try {
        const retried = await retry(async () => this.executeTool(toolCall, opts?.abortSignal), { maxAttempts: opts?.retryMax ?? 2, baseDelayMs: 500, jitter: true }, opts?.abortSignal);
        if (retried.success) result = retried;
      } catch { /* 重试失败保留原 result */ }
    }

    const san = sanitizeOutput(result.output);
    const sanErr = result.error ? sanitizeOutput(result.error) : undefined;
    const finalResult: ToolResult = { ...result, output: san.sanitized, error: sanErr?.sanitized, durationMs: Date.now() - start };

    await this.audit.append({ timestamp: new Date().toISOString(), tool: toolCall.tool, args: toolCall.args, result: result.success ? "success" : result.blocked ? "blocked" : "error", exitCode: result.exitCode, durationMs: finalResult.durationMs, reason: result.blockedReason, filesChanged: result.filesChanged });
    return finalResult;
  }

  private async executeTool(toolCall: ToolCall, abortSignal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    const args = toolCall.args;
    const cwd = String(args["cwd"] ?? this.cwd);

    try {
      switch (toolCall.tool) {
        case "file_read": {
          const c = await fs.readFile(String(args["path"]), "utf-8");
          return { success: true, output: c, durationMs: Date.now() - start };
        }
        case "file_write": {
          const p = String(args["path"]); await this.state.atomicWrite(p, String(args["content"]));
          return { success: true, output: `写入 ${p}`, durationMs: Date.now() - start, filesChanged: [p] };
        }
        case "file_edit": {
          const p = String(args["path"]); const o = String(args["old_str"]); const n = String(args["new_str"]);
          const c = await fs.readFile(p, "utf-8");
          if (!c.includes(o)) return { success: false, output: "", error: "old_str not found", durationMs: Date.now() - start, retryable: false };
          await this.state.atomicWrite(p, c.replace(o, n));
          return { success: true, output: `编辑 ${p}`, durationMs: Date.now() - start, filesChanged: [p] };
        }
        case "file_append": {
          const p = String(args["path"]); await fs.appendFile(p, String(args["content"]), "utf-8");
          return { success: true, output: `追加 ${p}`, durationMs: Date.now() - start, filesChanged: [p] };
        }
        case "file_delete": {
          const p = String(args["path"]); await fs.unlink(p);
          return { success: true, output: `删除 ${p}`, durationMs: Date.now() - start, filesChanged: [p] };
        }
        case "file_list": {
          const entries = await fs.readdir(String(args["path"]), { withFileTypes: true });
          return { success: true, output: entries.map((e: Dirent) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).join("\n"), durationMs: Date.now() - start };
        }
        case "file_mkdir": {
          await fs.mkdir(String(args["path"]), { recursive: args["recursive"] !== false });
          return { success: true, output: "目录已创建", durationMs: Date.now() - start };
        }
        case "file_search": {
          const pat = String(args["pattern"]); const sp = String(args["path"] ?? this.cwd); const res: string[] = [];
          const walk = async (d: string) => {
            for (const item of await fs.readdir(d, { withFileTypes: true })) {
              if (item.name === "node_modules" || item.name === ".git") continue;
              const f = path.join(d, item.name);
              if (item.isDirectory()) await walk(f);
              else { try { (await fs.readFile(f, "utf-8")).split("\n").forEach((l, i) => { if (l.includes(pat)) res.push(`${f}:${i+1}: ${l.trim()}`); }); } catch {} }
            }
          };
          await walk(sp);
          return { success: true, output: res.join("\n") || "无匹配", durationMs: Date.now() - start };
        }
        case "shell_exec": case "shell_npm": case "shell_pnpm":
        case "test_run": case "lint_run": case "typecheck_run": case "build_run": {
          const cmd = this.buildCommand(toolCall.tool, args);
          const r = await this.executor.exec(cmd.split(" ")[0]!, cmd.split(" ").slice(1), { cwd, timeoutMs: Number(args["timeout"] ?? this.policy.defaultTimeoutMs), maxOutputBytes: this.policy.maxOutputBytes, abortSignal, shell: true });
          const ec = r.exitCode !== 0 ? classifyError(r.stderr, r.exitCode) : { retryable: false };
          const isTest = toolCall.tool === "test_run";
          return { success: r.exitCode === 0, output: r.stdout || r.stderr, error: r.exitCode !== 0 ? r.stderr : undefined, exitCode: r.exitCode, durationMs: Date.now() - start, retryable: ec.retryable, testPassed: isTest ? r.exitCode === 0 : undefined };
        }
        case "git_status": { const r = await this.executor.exec("git", ["status", "--short"], { cwd, timeoutMs: 10000, shell: false, abortSignal }); return { success: r.exitCode === 0, output: r.stdout, error: r.stderr, exitCode: r.exitCode, durationMs: Date.now() - start }; }
        case "git_diff": { const r = await this.executor.exec("git", ["diff", ...(args["file"] ? [String(args["file"])] : [])], { cwd, timeoutMs: 10000, shell: false, abortSignal }); return { success: r.exitCode === 0, output: r.stdout, error: r.stderr, exitCode: r.exitCode, durationMs: Date.now() - start }; }
        case "git_add": { const r = await this.executor.exec("git", ["add", ...String(args["files"] ?? ".").split(/\s+/)], { cwd, timeoutMs: 10000, shell: false, abortSignal }); return { success: r.exitCode === 0, output: r.stdout || "已添加", error: r.stderr, exitCode: r.exitCode, durationMs: Date.now() - start }; }
        case "git_commit": { const r = await this.executor.exec("git", ["commit", "-m", String(args["message"])], { cwd, timeoutMs: 10000, shell: false, abortSignal }); return { success: r.exitCode === 0, output: r.stdout || "已提交", error: r.stderr, exitCode: r.exitCode, durationMs: Date.now() - start }; }
        case "git_log": { const r = await this.executor.exec("git", ["log", "--oneline", `-${String(args["limit"] ?? "10")}`], { cwd, timeoutMs: 10000, shell: false, abortSignal }); return { success: r.exitCode === 0, output: r.stdout, error: r.stderr, exitCode: r.exitCode, durationMs: Date.now() - start }; }
        case "git_push": { const pa = ["push", ...(args["force"] === true ? ["--force"] : []), String(args["remote"] ?? "origin")]; if (args["branch"]) pa.push(String(args["branch"])); const r = await this.executor.exec("git", pa, { cwd, timeoutMs: 30000, shell: false, abortSignal }); return { success: r.exitCode === 0, output: r.stdout || "已推送", error: r.stderr, exitCode: r.exitCode, durationMs: Date.now() - start }; }
        case "code_search": {
          const rx = new RegExp(String(args["pattern"]), "i"); const sp = String(args["path"] ?? this.cwd); const res: string[] = [];
          const walk = async (d: string) => {
            for (const item of await fs.readdir(d, { withFileTypes: true })) {
              if (item.name === "node_modules" || item.name === ".git" || item.name === "dist") continue;
              const f = path.join(d, item.name);
              if (item.isDirectory()) await walk(f);
              else { try { (await fs.readFile(f, "utf-8")).split("\n").forEach((l, i) => { if (rx.test(l)) res.push(`${f}:${i+1}: ${l.trim()}`); }); } catch {} }
            }
          };
          await walk(sp);
          return { success: true, output: res.join("\n") || "无匹配", durationMs: Date.now() - start };
        }
        case "code_symbols": {
          const fp = String(args["path"]); const c = await fs.readFile(fp, "utf-8"); const syms: string[] = [];
          c.split("\n").forEach((l, i) => {
            const fm = l.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
            const cm = l.match(/(?:export\s+)?class\s+(\w+)/);
            const vm = l.match(/(?:export\s+)?const\s+(\w+)/);
            if (fm) syms.push(`${fp}:${i+1}: function ${fm[1]}`);
            if (cm) syms.push(`${fp}:${i+1}: class ${cm[1]}`);
            if (vm) syms.push(`${fp}:${i+1}: const ${vm[1]}`);
          });
          return { success: true, output: syms.join("\n") || "无符号", durationMs: Date.now() - start };
        }
        case "knowledge_query": return { success: true, output: "knowledge_query 由 agent 记忆系统处理", durationMs: Date.now() - start };
        case "status_budget": case "status_progress": case "status_memory": case "status_health":
          return { success: true, output: `${toolCall.tool}: OK`, durationMs: Date.now() - start };
        default: return { success: false, output: "", error: `工具未实现: ${toolCall.tool}`, durationMs: Date.now() - start, retryable: false };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const ec = classifyError(msg, -1);
      return { success: false, output: "", error: msg, durationMs: Date.now() - start, retryable: ec.retryable };
    }
  }

  private buildCommand(tool: string, args: Record<string, unknown>): string {
    switch (tool) {
      case "shell_exec": return String(args["command"] ?? "");
      case "shell_npm": return `npm ${args["args"] ?? ""}`;
      case "shell_pnpm": return `pnpm ${args["args"] ?? ""}`;
      case "test_run": return String(args["command"] ?? "npm test");
      case "lint_run": return String(args["command"] ?? "npm run lint");
      case "typecheck_run": return String(args["command"] ?? "npx tsc --noEmit");
      case "build_run": return String(args["command"] ?? "npm run build");
      default: return String(args["command"] ?? "");
    }
  }

  private checkPermission(toolCall: ToolCall): { denied: boolean; reason?: string } {
    const op = this.toolToOperation(toolCall.tool);
    const sc = this.toolToScope(toolCall.tool);
    if (!op || !sc) return { denied: false };
    const target = String(toolCall.args["path"] ?? toolCall.args["file"] ?? toolCall.args["command"] ?? toolCall.tool);
    const perm = this.policy.checkPermission(op as any, sc as any, target);
    if (perm.decision === "deny") return { denied: true, reason: perm.reason };
    return { denied: false };
  }

  private toolToOperation(tool: string): string | null {
    if (tool.startsWith("file_write") || tool.startsWith("file_edit") || tool.startsWith("file_append")) return "write";
    if (tool.startsWith("file_read") || tool.startsWith("file_list") || tool.startsWith("file_search")) return "read";
    if (tool.startsWith("file_delete")) return "delete";
    if (tool.startsWith("shell_")) return "execute";
    if (tool.startsWith("git_push")) return "git-push";
    return null;
  }

  private toolToScope(tool: string): string | null {
    if (tool.startsWith("file_")) return "file";
    if (tool.startsWith("shell_")) return "process";
    if (tool.startsWith("git_")) return "system";
    return null;
  }
}
