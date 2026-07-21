import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextManager } from "@structfocus/context";

/** 取 history 流（去掉 toMessages 最前面的 system 提示等） */
function historyFlow(msgs: { role: string; content: string | null }[]): { role: string; content: string }[] {
  // 跳过开头的 system 提示 + 可能的 system 召回块/任务块，返回直到结尾前的所有消息
  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));
}

describe("roadmap 一.2 toMessages 时序保持", () => {
  let m: ContextManager;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sf-tl-"));
    m = new ContextManager({ maxWindow: 200_000, storeRoot: path.join(root, "cs"), capsuleRoot: path.join(root, "cap") });
  });

  it("10 轮 user/assistant 交替 → 输出严格 10 对 user/assistant，无内联标记", () => {
    for (let i = 0; i < 10; i++) {
      m.appendUser(`用户第 ${i + 1} 轮提问`);
      m.appendAssistant(`助手第 ${i + 1} 轮回答`);
    }
    const msgs = m.toMessages("你是助手");
    const flow = historyFlow(msgs);

    // 恰好 20 条历史消息
    expect(flow.length).toBe(20);

    // 角色严格交替：user, assistant, user, assistant ...
    for (let i = 0; i < flow.length; i++) {
      const expected = i % 2 === 0 ? "user" : "assistant";
      expect(flow[i]!.role).toBe(expected);
    }

    // 没有任何 role=system 混入历史流（已由 historyFlow 过滤，这里确认过滤后无遗漏 system）
    expect(msgs.filter((x) => x.role === "system").length).toBeGreaterThanOrEqual(1); // 至少系统提示

    // 历史流内禁止出现伪造的 [observation]/[recall]/[胶囊] 内联标记
    for (const f of flow) {
      expect(f.content.startsWith("[observation]")).toBe(false);
      expect(f.content.startsWith("[recall]")).toBe(false);
    }
  });

  it("首条历史消息必须是 user（对话从用户开始）", () => {
    m.appendUser("第一轮");
    m.appendAssistant("回复");
    m.appendUser("第二轮");
    m.appendAssistant("回复2");
    const flow = historyFlow(m.toMessages("sys"));
    expect(flow[0]!.role).toBe("user");
    expect(flow[flow.length - 1]!.role).toBe("assistant");
  });

  it("L3_compressed 胶囊召回作为 system 前缀注入，不破坏对话流交替", async () => {    m.appendUser("当前任务相关对话");
    m.appendAssistant("了解，正在处理");
    // 追加一条旧对话并压缩为胶囊
    m.appendUser("三个月前的旧讨论细节");
    const entries = m.getEntries();
    const oldEntry = entries[entries.length - 1]!;
    await m.place(oldEntry.id, "L3_compressed", "system", "概括为胶囊", {
      capsuleSummary: "旧讨论：项目架构决策",
      capsuleId: "capsule_old1",
    });

    const msgs = m.toMessages("sys");
    // 胶囊召回块应以 system 角色出现在历史流之前
    const recallBlock = msgs.find(
      (x) => x.role === "system" && typeof x.content === "string" && x.content.includes("上下文召回: capsule_old1"),
    );
    expect(recallBlock).toBeDefined();
    expect(recallBlock!.content).toContain("旧讨论：项目架构决策");

    // 历史流中不应再出现该压缩条目的原文
    const flow = historyFlow(msgs);
    for (const f of flow) {
      expect(f.content).not.toContain("三个月前的旧讨论细节");
    }
    // 历史流仍保持 user/assistant 交替
    for (let i = 0; i < flow.length; i++) {
      const expected = i % 2 === 0 ? "user" : "assistant";
      expect(flow[i]!.role).toBe(expected);
    }
  });

  it("召回注入为 system 角色，不伪造成 user/assistant 交替 (roadmap 一.2 项3)", async () => {
    // 喂 3 条对话
    const docs = ["决定采用 Rust 重写核心模块", "团队下周评审架构方案", "部署目标定为欧洲节点"];
    for (const d of docs) {
      m.appendUser(d);
    }
    // 归档到 ContentStore 并移出活跃窗口（模拟历史上下文），recallRelevant 只召回窗口外内容
    m.newConversation("c2");
    await new Promise((r) => setTimeout(r, 80)); // 等异步 save 落盘 + 索引就绪

    // 召回「Rust」相关历史并注入
    await m.recallScoped("Rust", 3);
    const recalled = m.getEntries().filter((x) => !x.evicted && x.content.startsWith("[recall]"));
    expect(recalled.length).toBeGreaterThan(0);
    // 注入条目类型必须是 system（不是 user/assistant）
    expect(recalled[0]!.type).toBe("system");

    const msgs = m.toMessages("sys");
    const recallMsg = msgs.find(
      (x) => x.role === "system" && typeof x.content === "string" && x.content.includes("[recall]"),
    );
    expect(recallMsg).toBeDefined();

    // 历史流里不应混入 [recall] 的 user/assistant 伪造条目
    const flow = historyFlow(msgs);
    for (const f of flow) {
      expect(f.content.startsWith("[recall]")).toBe(false);
    }

    // forgetScoped 能清理 system 类型召回条目
    const cleaned = m.forgetScoped();
    expect(cleaned).toBe(recalled.length);
    const after = m.getEntries().filter((x) => !x.evicted && x.content.startsWith("[recall]"));
    expect(after.length).toBe(0);
  });
});
