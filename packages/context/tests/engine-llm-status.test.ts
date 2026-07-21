import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LongContextEngine } from "../src/longcontext-engine.js";

function tmpDir(): string {
  return path.join(tmpdir(), `struct-llm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

describe("LLM 压缩失败告警（三级状态 + 健康检查）", () => {
  it("未触发时状态 unknown，配置后 configured=true", () => {
    const dir = tmpDir();
    const engine = new LongContextEngine({ storeRoot: dir, capsuleRoot: dir + "/cap" });
    expect(engine.getLlmStatus().status).toBe("unknown");
    expect(engine.getLlmStatus().configured).toBe(false);
    engine.setLlmCall(async () => "ok");
    expect(engine.getLlmStatus().configured).toBe(true);
    expect(engine.getLlmStatus().status).toBe("unknown");
    return cleanup(dir);
  });

  it("LLM 调用失败被追踪：status 降级 + 首次告警 + 回退仍产出", async () => {
    const dir = tmpDir();
    const logs: string[] = [];
    const engine = new LongContextEngine({
      storeRoot: dir,
      capsuleRoot: dir + "/cap",
      minEntriesForSummarize: 1,
      keepRecent: 0,
      logger: (m) => logs.push(m),
      llmCall: async () => {
        throw new Error("boom 401 Unauthorized");
      },
    });
    engine.feed("用户在做 StructFocus 项目，遇到 LLM 压缩失败的问题。需要排查 401 错误。");
    engine.feed("尝试更换 API Key，但依然报错，压缩结果不准。");
    const out = await engine.summarize();
    // 失败应降级为确定性回退，仍产出胶囊，不抛错
    expect(out).not.toBeNull();
    const st = engine.getLlmStatus();
    expect(st.failureCount).toBeGreaterThanOrEqual(1);
    expect(st.status).toBe("degraded");
    expect(st.lastError).toContain("boom");
    expect(st.lastSuccessAt).toBeNull();
    // 首次失败应记录告警
    expect(logs.some((l) => l.includes("首次调用失败"))).toBe(true);
    return cleanup(dir);
  });

  it("连续失败≥5 升级为 failed", async () => {
    const dir = tmpDir();
    const engine = new LongContextEngine({
      storeRoot: dir,
      capsuleRoot: dir + "/cap",
      minEntriesForSummarize: 1,
      keepRecent: 0,
      llmCall: async () => {
        throw new Error("boom");
      },
    });
    for (let i = 0; i < 6; i++) {
      engine.feed(`第 ${i} 段上下文，关于 StructFocus 的压缩管线调试。`);
      await engine.summarize();
    }
    expect(engine.getLlmStatus().status).toBe("failed");
    expect(engine.getLlmStatus().failureCount).toBeGreaterThanOrEqual(5);
    return cleanup(dir);
  });

  it("checkLlmHealth 反映可达性；未配置返回 false 且 healthy=null", async () => {
    const dir = tmpDir();
    const okEngine = new LongContextEngine({
      storeRoot: dir,
      capsuleRoot: dir + "/cap",
      llmHealthCheck: async () => true,
    });
    expect(await okEngine.checkLlmHealth()).toBe(true);
    expect(okEngine.getLlmStatus().healthy).toBe(true);

    const noneEngine = new LongContextEngine({ storeRoot: dir + "2", capsuleRoot: dir + "/cap2" });
    expect(await noneEngine.checkLlmHealth()).toBe(false);
    expect(noneEngine.getLlmStatus().healthy).toBeNull();
    return cleanup(dir);
  });

  it("LLM 成功调用后 status=ok 并记录 lastSuccessAt", async () => {
    const dir = tmpDir();
    const engine = new LongContextEngine({
      storeRoot: dir,
      capsuleRoot: dir + "/cap",
      minEntriesForSummarize: 1,
      keepRecent: 0,
      llmCall: async () => "[目标]: 测试\n[关键发现]: 无\n[决策]: 无\n[下一步]: 无",
    });
    engine.feed("用户在做 StructFocus 项目，需要验证 LLM 压缩成功路径。");
    const out = await engine.summarize();
    expect(out).not.toBeNull();
    const st = engine.getLlmStatus();
    expect(st.status).toBe("ok");
    expect(st.lastSuccessAt).not.toBeNull();
    expect(st.failureCount).toBe(0);
    return cleanup(dir);
  });
});
