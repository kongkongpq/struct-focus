// @structfocus/memory - 标准插件工厂

import type { IPlugin, InjectResult, AgentContext, ToolContext, RunResult } from "@structfocus/framework";
import type { Memory } from "./memory.js";

/**
 * createPlugin: 返回标准 IPlugin，供 agent 的 PluginManager 注册。
 * - onBeforeAgent: 同步注入（200ms 超时，侧车 T1）
 * - onAfterAgent: 异步提取（fire-and-forget，侧车 T3）
 * - onRunCompleted: 触发胶囊封装
 */
export function createMemoryPlugin(memory: Memory): IPlugin {
  return {
    id: "struct-memory",
    priority: 10,
    description: "五层记忆 + 侧车语义（同步注入/异步提取/胶囊触发）",
    hooks: {
      onBeforeAgent: async (ctx: AgentContext): Promise<InjectResult | void> => {
        if (ctx.phase !== "before") return;

        // 同步检索（T1 200ms 超时）
        const query = ctx.runContext.messages[ctx.runContext.messages.length - 1]?.content ?? "";
        const results = memory.searchSync(query, 200, { limit: 5 });

        if (results.length === 0) return;

        // 注入记忆摘要到系统提示
        const memoryText = results
          .map((r) => `- [${r.kind}] ${r.summary}`)
          .join("\n");

        return {
          systemPrompt: `\n## 相关记忆\n${memoryText}\n`,
        };
      },

      onAfterAgent: async (ctx: AgentContext): Promise<InjectResult | void> => {
        if (ctx.phase !== "after" || !ctx.response) return;

        // 异步提取（T3 fire-and-forget）
        // 注意：实际提取逻辑由 agent 编排，此处仅触发
        const content = ctx.response.content;
        if (content && content.length > 0) {
          // 记录决策（简单启发式：包含"决定"/"选择"/"采用"的句子）
          const decisions = content
            .split(/[。.\n]/)
            .filter((s: string) => /决定|选择|采用|使用|方案/.test(s))
            .slice(0, 3);

          for (const decision of decisions) {
            if (decision.trim().length > 10) {
              memory.record({
                kind: "decision",
                content: decision.trim(),
                tags: ["auto-extracted"],
              }).catch(() => {}); // fire-and-forget
            }
          }
        }
      },

      onBeforeTool: async (ctx: ToolContext): Promise<InjectResult | void> => {
        if (ctx.phase !== "before") return;

        // 检测文件操作 → 触发指针自动关联
        const toolCall = ctx.toolCall;
        const fileArg = toolCall.args["path"] ?? toolCall.args["file"];
        if (typeof fileArg === "string") {
          const pointers = memory.findPointersByFile(fileArg);
          if (pointers.length > 0) {
            const pointerText = pointers
              .slice(0, 3)
              .map((p) => `- [${p.importance}] ${p.topic} (${p.id})`)
              .join("\n");
            return {
              systemPrompt: `\n## 关联上下文指针\n${pointerText}\n`,
            };
          }
        }
      },

      onAfterTool: async (ctx: ToolContext): Promise<InjectResult | void> => {
        if (ctx.phase !== "after" || !ctx.toolResult) return;

        // 测试类工具成功 → 标记可触发胶囊
        if (
          ctx.toolResult.success &&
          ctx.toolResult.testPassed === true
        ) {
          // 胶囊触发由 agent 核心循环编排
        }
      },

      onRunCompleted: async (_result: RunResult): Promise<void> => {
        // 后台维护（T5）：处理重试队列
        await memory.processCapsuleRetryQueue().catch(() => {});
      },

      onError: async (error: unknown): Promise<void> => {
        // 记录错误到记忆
        const message = error instanceof Error ? error.message : String(error);
        memory.record({
          kind: "error",
          content: message,
          tags: ["runtime-error"],
        }).catch(() => {});
      },
    },
  };
}
