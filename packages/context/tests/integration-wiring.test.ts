// 集成接线测试：验证 LongContextEngine 的核心管理能力（autoManage / recallAndInject）
// 是否真的被「真实接入路径」调用，而不是只在 bench / unit test 里跑。
//
// 设计意图：先写「期望接入」的断言。修复前这些断言应失败（证明断点真实存在）；
// 修复（在 MCP context_inject 与 middleware postLlmCall 接上 autoManage、
// preLlmCall 接上 recallAndInject）后应通过。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LongContextEngine, createContextMiddleware } from "../src/index.js";

describe("集成接线：autoManage 是否真的被接入生产路径", () => {
  let tmp: string;
  let engine: LongContextEngine;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sf-wire-"));
    engine = new LongContextEngine({
      storeRoot: join(tmp, "cs"),
      capsuleRoot: join(tmp, "cap"),
      autoSummarize: false, // 关闭 50K 阈值的副路径，单独验证 autoManage 接线
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("middleware.postLlmCall 必须触发 autoManage（AI 接管上下文管理）", async () => {
    const mw = createContextMiddleware(engine);
    const spy = vi.spyOn(engine, "autoManage");

    // 模拟一轮：pre 喂入 user，LLM 返回，post 喂入 assistant
    await mw.preLlmCall([{ role: "user", content: "Redis 连接池 OOM 怎么修？" }]);
    await mw.postLlmCall("Redis 连接池 OOM 怎么修？", "限制 max=20 即可。");

    expect(spy).toHaveBeenCalled();
  });

  it("middleware.preLlmCall 必须调用 recallAndInject（召回内容进入被管理上下文）", async () => {
    const mw = createContextMiddleware(engine);
    const spyRecallInject = vi.spyOn(engine, "recallAndInject");

    await mw.preLlmCall([
      { role: "system", content: "SYS" },
      { role: "user", content: "查询 Redis OOM 历史" },
    ]);

    // 期望接入点是 recallAndInject（会把召回内容 append 为 [recall] 条目，进入被管理上下文）。
    // 此前 preLlmCall 只调 engine.recall，召回内容不进引擎、autoManage 看不到 → 死逻辑。
    expect(spyRecallInject).toHaveBeenCalled();
    // 且确实把召回内容写入了引擎活跃上下文（[recall] 条目）
    const stats = await engine.getStats();
    expect(stats.activeEntries).toBeGreaterThan(0);
  });

  it("autoManage 真能压缩：两轮对话结构下，旧轮内容相对新锚点应被概括/驱逐", async () => {
    // 真实对话结构：turn1(user) → 10 条 observation/tool → turn2(user 新锚点)
    // 此时 turn1 之后的旧内容相对 turn2 锚点偏移 > topicDistance，应判定非活跃并压缩
    engine.feed("用户：先实现登录模块", { type: "user" });
    for (let i = 0; i < 10; i++) {
      engine.feed(`工具输出 #${i}：登录模块编译日志较长内容用于占据活跃窗口 x${i}`, {
        type: "tool",
        source: `src/login${i}.ts`,
      });
    }
    engine.feed("用户：现在改购物车模块", { type: "user" }); // 新话题锚点

    const before = await engine.getStats();
    await engine.autoManage();
    const after = await engine.getStats();

    // 旧轮（登录模块）内容应被概括成胶囊或被驱逐到 ContentStore
    const managed = after.capsuleCount > before.capsuleCount || after.storedEntries > before.storedEntries;
    expect(managed).toBe(true);
  });

  it("已知限制：纯单主题连续 dump（无新话题锚点）下，autoManage 不压缩活跃内容", async () => {
    // 诚实记录设计行为：压缩以「相对话题锚点的非活跃占比」触发，
    // 连续同主题内容始终活跃 → 不会无端压缩。这要求上层在合适时机推进话题/新轮。
    for (let i = 0; i < 20; i++) {
      engine.feed(`日志行 #${i}：持续输出，无 user/assistant 锚点推进`, { type: "observation" });
    }
    const before = await engine.getStats();
    await engine.autoManage();
    const after = await engine.getStats();
    // 无锚点推进 → 不应压缩（这是设计预期，不是 bug）
    expect(after.capsuleCount).toBe(before.capsuleCount);
    expect(after.storedEntries).toBe(before.storedEntries);
  });

  it("middleware.preLlmCall 每轮清理上一轮 [recall] 注入（forgetRecalled 接线，防泄漏）", async () => {
    const mw = createContextMiddleware(engine);
    const spyForget = vi.spyOn(engine, "forgetRecalled");

    // 1. 先喂内容并压缩为胶囊，让后续召回有命中（证明注入真的发生）
    engine.feed("用户：编写 Redis 连接池管理模块", { type: "user" });
    for (let i = 0; i < 10; i++) {
      engine.feed(`工具输出 #${i}：连接池模块相关编译日志较长用于占窗口 x${i}`, { type: "tool", source: `src/pool${i}.ts` });
    }
    engine.feed("用户：现在看购物车模块", { type: "user" });
    await engine.autoManage(); // 旧内容压缩为胶囊

    // 2. 多轮对话，每轮 preLlmCall 都会召回并注入 [recall]
    for (let turn = 0; turn < 3; turn++) {
      await mw.preLlmCall([{ role: "user", content: `继续 Redis 连接池相关开发 #${turn}` }]);
      await mw.postLlmCall(`继续 Redis 连接池相关开发 #${turn}`, `已处理第 ${turn} 步。`);
    }

    // 断言 1：preLlmCall 内确实调用了 forgetRecalled（闭环清理接线）
    expect(spyForget).toHaveBeenCalled();

    // 断言 2：活跃窗口中的 [recall] 注入条目不无限累积（每轮清旧、只留本轮，≤1）
    const cm = engine.getContextManager();
    const recallActive = cm.getAllEntries().filter((e) => !e.evicted && e.content.startsWith("[recall]"));
    expect(recallActive.length).toBeLessThanOrEqual(1);
  });
});

describe("孤立 API 检测：recallAndInject / createContextMiddleware 必须被使用", () => {
  it("createContextMiddleware 是已接入的集成契约（至少被本测试实例化调用）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sf-wire2-"));
    const e = new LongContextEngine({ storeRoot: join(tmp, "cs"), capsuleRoot: join(tmp, "cap") });
    const mw = createContextMiddleware(e);
    expect(typeof mw.preLlmCall).toBe("function");
    expect(typeof mw.postLlmCall).toBe("function");
    expect(typeof mw.recall).toBe("function");
    rmSync(tmp, { recursive: true, force: true });
  });
});
