// @struct/harness - 6 阶段命令管道

import type { ToolDef, ToolCall, ToolResult, RiskLevel } from "@struct/framework";
import { Policy } from "../policy.js";
import { sanitizeOutput, detectAnomalies, classifyError } from "./sanitize.js";
import type { ProcessExecutor } from "../executor/process.js";
import type { AuditLog } from "../audit.js";

export type PipelineStage = "parse" | "classify" | "validate" | "transform" | "sanitize" | "execute";

export interface PipelineContext {
  toolCall: ToolCall;
  toolDef: ToolDef | undefined;
  cwd: string;
  policy: Policy;
  executor: ProcessExecutor;
  audit: AuditLog;
  abortSignal?: AbortSignal;
  // 管道中间状态
  parsedArgs?: Record<string, unknown>;
  risk?: RiskLevel;
  blocked?: { reason: string };
  command?: string;
  args?: string[];
  result?: ToolResult;
}

/**
 * 6 阶段命令管道：
 * 1. Parse: 解析参数
 * 2. Classify: 分类风险 + 危险命令检测
 * 3. Validate: 权限矩阵检查
 * 4. Transform: 参数转换（路径规范化等）
 * 5. Sanitize: 输出后处理（脱敏）
 * 6. Execute: 执行
 */
export async function runPipeline(ctx: PipelineContext): Promise<ToolResult> {
  const start = Date.now();

  // Stage 1: Parse
  try {
    ctx.parsedArgs = parseArgs(ctx.toolCall, ctx.toolDef);
  } catch (e) {
    const result: ToolResult = {
      success: false,
      output: "",
      error: `参数解析失败: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - start,
      retryable: false,
    };
    return result;
  }

  // Stage 2: Classify
  if (ctx.toolDef) {
    ctx.risk = ctx.toolDef.risk;
  }
  if (ctx.toolCall.tool === "shell_exec" && ctx.parsedArgs["command"]) {
    const cmd = String(ctx.parsedArgs["command"]);
    const danger = ctx.policy.isDangerous(cmd);
    if (danger.dangerous) {
      const result: ToolResult = {
        success: false,
        output: "",
        error: `危险命令被拦截: ${danger.reason}`,
        durationMs: Date.now() - start,
        blocked: true,
        blockedReason: danger.reason,
        retryable: false,
      };
      await ctx.audit.append({
        timestamp: new Date().toISOString(),
        tool: ctx.toolCall.tool,
        args: ctx.parsedArgs,
        result: "blocked",
        durationMs: result.durationMs,
        reason: danger.reason,
      });
      return result;
    }
  }

  // Stage 3: Validate
  if (ctx.toolDef) {
    const operation = toolToOperation(ctx.toolCall.tool);
    const scope = toolToScope(ctx.toolCall.tool);
    const target = getTarget(ctx.toolCall, ctx.parsedArgs);
    if (operation && scope && target) {
      const perm = ctx.policy.checkPermission(operation as any, scope as any, target);
      if (perm.decision === "deny") {
        const result: ToolResult = {
          success: false,
          output: "",
          error: `权限拒绝: ${perm.reason ?? "策略禁止"}`,
          durationMs: Date.now() - start,
          blocked: true,
          blockedReason: perm.reason,
          retryable: false,
        };
        await ctx.audit.append({
          timestamp: new Date().toISOString(),
          tool: ctx.toolCall.tool,
          args: ctx.parsedArgs,
          result: "blocked",
          durationMs: result.durationMs,
          reason: perm.reason,
        });
        return result;
      }
    }
  }

  // Stage 4: Transform（路径规范化等）
  if (ctx.parsedArgs["path"] && typeof ctx.parsedArgs["path"] === "string") {
    const raw = ctx.parsedArgs["path"];
    if (!raw.startsWith("/") && !raw.match(/^[A-Z]:/i)) {
      ctx.parsedArgs["path"] = require("node:path").resolve(ctx.cwd, raw);
    }
  }

  // Stage 5 + 6: Execute + Sanitize（在 execute 后对输出脱敏）
  // 执行逻辑由 Harness 的 exec 方法处理，管道返回 parsed context
  return {
    success: true,
    output: "",
    durationMs: Date.now() - start,
  };
}

function parseArgs(toolCall: ToolCall, toolDef: ToolDef | undefined): Record<string, unknown> {
  const args = { ...toolCall.args };
  if (toolDef) {
    for (const param of toolDef.params) {
      if (param.required && !(param.name in args)) {
        if (param.default !== undefined) {
          args[param.name] = param.default;
        } else {
          throw new Error(`缺少必需参数: ${param.name}`);
        }
      }
    }
  }
  return args;
}

function toolToOperation(tool: string): string | null {
  if (tool.startsWith("file_write") || tool.startsWith("file_edit")) return "write";
  if (tool.startsWith("file_read")) return "read";
  if (tool.startsWith("file_delete")) return "delete";
  if (tool.startsWith("shell_exec")) return "execute";
  if (tool.startsWith("git_push")) return "git-push";
  return null;
}

function toolToScope(tool: string): string | null {
  if (tool.startsWith("file_")) return "file";
  if (tool.startsWith("shell_")) return "process";
  if (tool.startsWith("git_")) return "system";
  return null;
}

function getTarget(toolCall: ToolCall, args: Record<string, unknown>): string | null {
  return String(args["path"] ?? args["file"] ?? args["command"] ?? toolCall.tool);
}

export { sanitizeOutput, detectAnomalies, classifyError };
