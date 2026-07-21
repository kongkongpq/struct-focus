import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ContextManager,
  LongContextEngine,
} from "@structfocus/context";

/** 把 toMessages 的所有 content 拼成一个字符串，便于断言「某对话内容未泄漏」 */
function messagesText(msgs: { content: string | null }[]): string {
  return msgs.map((m) => m.content ?? "").join("\n");
}

describe("roadmap 一.1 Per-Conversation 隔离", () => {
  let m: ContextManager;
  let dir: string;

  beforeEach(() => {
    // 隔离存储，避免污染共享的 process.cwd()/.structfocus/content-store
    dir = mkdtempSync(path.join(tmpdir(), "sf-conv-"));
    m = new ContextManager({
      maxWindow: 200_000,
      storeRoot: path.join(dir, "content"),
      capsuleRoot: path.join(dir, "capsules"),
    });
  });

  it("newConversation(id) 切换对话并给条目打标", () => {
    m.newConversation("c1");
    m.appendUser("c1 专属信号 apple", { source: "c1" });
    m.appendAssistant("c1 回复 banana", { source: "c1" });
    expect(m.getCurrentConversationId()).toBe("c1");
    expect(m.getAllEntries().every((e) => e.conversationId === "c1")).toBe(true);

    m.newConversation("c2");
    m.appendUser("c2 专属信号 cherry", { source: "c2" });
    expect(m.getCurrentConversationId()).toBe("c2");
    // 切换后活跃条目只剩 c2（c1 已归档）
    expect(m.getEntries().length).toBe(1);
    expect(m.getEntries()[0]!.conversationId).toBe("c2");
  });

  it("toMessages 仅渲染当前对话条目（两对话互不污染）", () => {
    m.newConversation("c1");
    m.appendUser("c1 专属信号 apple", { source: "c1" });
    m.appendAssistant("c1 回复 banana", { source: "c1" });

    m.newConversation("c2");
    m.appendUser("c2 专属信号 cherry", { source: "c2" });
    m.appendAssistant("c2 回复 durian", { source: "c2" });

    const text = messagesText(m.toMessages("system-prompt"));
    // c2 的内容在，c1 的内容不应泄漏
    expect(text).toContain("cherry");
    expect(text).toContain("durian");
    expect(text).not.toContain("apple");
    expect(text).not.toContain("banana");
  });

  it("ContentStore.search 按 conversationId 过滤召回", async () => {
    m.newConversation("c1");
    m.appendUser("c1 秘密坐标 39.9N", { source: "c1" });
    m.appendUser("c1 背景 unrelated-A", { source: "c1" });
    m.appendUser("c1 背景 unrelated-B", { source: "c1" });

    // 切换对话 → c1 条目归档到 ContentStore（带 conversationId=c1）
    m.newConversation("c2");
    m.appendUser("c2 普通对话 unrelated", { source: "c2" });

    // 归档是异步 save，等待落盘 + 索引就绪（生产环境本就最终一致）
    await new Promise((r) => setTimeout(r, 60));

    const store = m.getStore();
    // 默认（不过滤）能命中 c1 的归档内容（store 内多文档使 BM25 idf>0）
    const all = await store.search("坐标", { mode: "bm25", topK: 5 });
    expect(all.length).toBe(1);

    // 按 c2 过滤 → c1 的内容被隔离，命中 0
    const c2only = await store.search("坐标", { mode: "bm25", topK: 5, conversationId: "c2" });
    expect(c2only.length).toBe(0);

    // 按 c1 过滤 → 命中 1
    const c1only = await store.search("坐标", { mode: "bm25", topK: 5, conversationId: "c1" });
    expect(c1only.length).toBe(1);
  });

  it("LongContextEngine.recall 默认只召回当前对话", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-conv-"));
    const engine = new LongContextEngine({
      storeRoot: path.join(dir, "content"),
      capsuleRoot: path.join(dir, "capsules"),
      minEntriesForSummarize: 2,
      autoSummarize: false,
    });

    // c1：喂入一个 needle 并概括（内容落 ContentStore，带 conversationId=c1）
    engine.newConversation("c1");
    engine.feed("c1 秘密坐标 39.9N alpha", { type: "user", source: "c1" });
    engine.feed("c1 跟进 beta", { type: "user", source: "c1" });
    await engine.flush({ topic: "c1-needle" });

    // c2：完全不同的对话
    engine.newConversation("c2");
    engine.feed("c2 普通工作 unrelated", { type: "user", source: "c2" });

    // 当前对话是 c2：recall 默认按 c2 过滤 → 找不到 c1 的 needle
    const cur = await engine.recall("秘密坐标");
    expect(cur.entries.length).toBe(0);

    // 显式指定 c1 → 命中
    const c1recall = await engine.recall("秘密坐标", { conversationId: "c1" });
    expect(c1recall.entries.length).toBe(1);
  });
});
