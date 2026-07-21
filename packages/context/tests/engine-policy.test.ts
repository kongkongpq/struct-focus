import { describe, it, expect } from "vitest";
import { LongContextEngine } from "@structfocus/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeEngine(): LongContextEngine {
  const root = mkdtempSync(join(tmpdir(), "sf-engine-"));
  return new LongContextEngine({
    autoSummarize: false,
    storeRoot: root,
    capsuleRoot: join(root, "caps"),
  });
}

describe("LongContextEngine.setManagementPolicy 透传", () => {
  it("默认非保守；setManagementPolicy 热更新并透传到 ContextManager", () => {
    const engine = makeEngine();
    expect(engine.getManagementPolicy().conservative).toBe(false);

    engine.setManagementPolicy({ conservative: true, emergencyThreshold: 0.99 });

    const after = engine.getManagementPolicy();
    expect(after.conservative).toBe(true);
    expect(after.emergencyThreshold).toBe(0.99);
    // 底层 manager 同步
    expect(engine.getContextManager().getManagementPolicy().conservative).toBe(true);
    expect(engine.getContextManager().getManagementPolicy().emergencyThreshold).toBe(0.99);
  });

  it("部分字段合并，不破坏其他默认值", () => {
    const engine = makeEngine();
    engine.setManagementPolicy({ conservative: true });
    const p = engine.getManagementPolicy();
    expect(p.conservative).toBe(true);
    expect(p.hardThreshold).toBe(0.5);
    expect(p.softThreshold).toBe(0.2);
    expect(p.emergencyThreshold).toBe(0.85);
  });
});
