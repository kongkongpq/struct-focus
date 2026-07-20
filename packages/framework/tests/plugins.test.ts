// framework 测试 - PluginManager
import { describe, it, expect, vi } from "vitest";
import { PluginManager, type IPlugin } from "@structfocus/framework";

function makePlugin(id: string, priority: number): IPlugin {
  return {
    id,
    priority,
    hooks: {
      onBeforeAgent: vi.fn(async () => ({ systemPrompt: `${id}-prompt` })),
      onAfterAgent: vi.fn(),
      onBeforeTool: vi.fn(),
      onAfterTool: vi.fn(),
      onRunCompleted: vi.fn(),
      onError: vi.fn(),
    },
  };
}

describe("PluginManager", () => {
  it("register/unregister 基本管理", () => {
    const pm = new PluginManager();
    const p = makePlugin("p1", 10);
    pm.register(p);
    expect(pm.count()).toBe(1);
    expect(pm.get("p1")).toBe(p);
    pm.unregister("p1");
    expect(pm.count()).toBe(0);
  });

  it("list 按 priority 降序排序", () => {
    const pm = new PluginManager();
    pm.register(makePlugin("low", 1));
    pm.register(makePlugin("high", 100));
    pm.register(makePlugin("mid", 50));
    const list = pm.list();
    expect(list[0]!.id).toBe("high");
    expect(list[1]!.id).toBe("mid");
    expect(list[2]!.id).toBe("low");
  });

  it("遍历快照：遍历中卸载不崩", () => {
    const pm = new PluginManager();
    pm.register(makePlugin("p1", 10));
    pm.register(makePlugin("p2", 5));
    const list1 = pm.list();
    pm.unregister("p1");
    const list2 = pm.list();
    expect(list1).toHaveLength(2);
    expect(list2).toHaveLength(1);
    expect(list2[0]!.id).toBe("p2");
  });

  it("invokeAgentHooks 按 priority 顺序调用", async () => {
    const pm = new PluginManager();
    const order: string[] = [];
    const p1: IPlugin = {
      id: "p1",
      priority: 100,
      hooks: {
        onBeforeAgent: async () => {
          order.push("p1");
        },
      },
    };
    const p2: IPlugin = {
      id: "p2",
      priority: 1,
      hooks: {
        onBeforeAgent: async () => {
          order.push("p2");
        },
      },
    };
    pm.register(p2);
    pm.register(p1);
    await pm.invokeAgentHooks("onBeforeAgent", {
      runContext: { sessionId: "s", messages: [], cwd: "." },
      phase: "before",
    });
    expect(order).toEqual(["p1", "p2"]);
  });

  it("单插件异常隔离不中断后续", async () => {
    const pm = new PluginManager();
    const p1: IPlugin = {
      id: "p1",
      priority: 100,
      hooks: {
        onBeforeAgent: async () => {
          throw new Error("p1 crash");
        },
      },
    };
    const p2 = makePlugin("p2", 1);
    pm.register(p1);
    pm.register(p2);
    const { errors } = await pm.invokeAgentHooks("onBeforeAgent", {
      runContext: { sessionId: "s", messages: [], cwd: "." },
      phase: "before",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("PLUGIN_ERROR");
    expect(p2.hooks.onBeforeAgent).toHaveBeenCalled();
  });

  it("invokeToolHooks 支持 blockTool 阻止执行", async () => {
    const pm = new PluginManager();
    const p1: IPlugin = {
      id: "guard",
      priority: 100,
      hooks: {
        onBeforeTool: async () => ({
          blockTool: true,
          blockReason: "Dangerous",
        }),
      },
    };
    const p2 = makePlugin("p2", 1);
    pm.register(p1);
    pm.register(p2);
    const { blocked } = await pm.invokeToolHooks("onBeforeTool", {
      toolCall: { tool: "shell_exec", args: { cmd: "rm -rf /" } },
      runContext: { sessionId: "s", messages: [], cwd: "." },
      phase: "before",
    });
    expect(blocked).toBeDefined();
    expect(blocked!.reason).toBe("Dangerous");
    // p2 不应被调用（被 p1 阻止）
    expect(p2.hooks.onBeforeTool).not.toHaveBeenCalled();
  });

  it("clear 清空所有插件", () => {
    const pm = new PluginManager();
    pm.register(makePlugin("p1", 10));
    pm.register(makePlugin("p2", 5));
    pm.clear();
    expect(pm.count()).toBe(0);
  });
});
