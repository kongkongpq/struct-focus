// framework 测试 - 扩展类型契约：ContextPointer / KnowledgeCapsule / PermissionMatrix / ToolResult
import { describe, it, expect } from "vitest";
import type {
  ContextPointer,
  KnowledgeCapsule,
  EnvironmentPackage,
  PermissionMatrix,
  PermissionRule,
  ToolResult,
  ToolDef,
  SandboxLevel,
  MemoryRecord,
} from "@structfocus/framework";

describe("ContextPointer 类型契约", () => {
  it("可构造完整 ContextPointer", () => {
    const p: ContextPointer = {
      id: "ptr_001" as any,
      type: "decision",
      topic: "选择了 vitest",
      files: ["package.json", "vitest.workspace.ts"],
      decision: "使用 vitest 而非 jest",
      keywords: ["test", "vitest"],
      timestamp: new Date().toISOString() as any,
      importance: "high",
      linkedCapsuleIds: ["cap_001"],
      contentRef: "pointers.jsonl:42",
      estimatedTokens: 50,
    };
    expect(p.importance).toBe("high");
    expect(p.files).toHaveLength(2);
  });

  it("importance 三级", () => {
    const levels: ContextPointer["importance"][] = ["high", "medium", "low"];
    expect(levels).toHaveLength(3);
  });

  it("type 覆盖所有指针类型", () => {
    const types: ContextPointer["type"][] = [
      "decision",
      "file-content",
      "tool-output",
      "session-state",
      "error-context",
    ];
    expect(types).toHaveLength(5);
  });
});

describe("KnowledgeCapsule 类型契约", () => {
  it("可构造完整 KnowledgeCapsule", () => {
    const c: KnowledgeCapsule = {
      id: "cap_001" as any,
      requirement: "实现 EventBus 异常不传播",
      modifications: [{ file: "events/bus.ts", change: "添加 try/catch" }],
      keyDecisions: ["使用 Error[] 收集而非 throw"],
      testResults: [{ testName: "emit 收集异常", passed: true }],
      knownLimitations: ["async handler reject 不等待"],
      linkedPointers: ["ptr_001"],
      tags: ["eventbus", "error-isolation"],
      timestamp: new Date().toISOString() as any,
      status: "active",
      parent: undefined,
      dependsOn: ["cap_000"],
      confidence: 0.9,
      trigger: "test-pass",
    };
    expect(c.status).toBe("active");
    expect(c.trigger).toBe("test-pass");
    expect(c.confidence).toBe(0.9);
  });

  it("status 四种状态", () => {
    const statuses: KnowledgeCapsule["status"][] = [
      "active",
      "deprecated",
      "needs-verify",
      "raw",
    ];
    expect(statuses).toHaveLength(4);
  });

  it("trigger 四种触发方式", () => {
    const triggers: KnowledgeCapsule["trigger"][] = [
      "test-pass",
      "debug-resolved",
      "user-remember",
      "heartbeat",
    ];
    expect(triggers).toHaveLength(4);
  });

  it("版本链 parent + dependsOn", () => {
    const c: KnowledgeCapsule = {
      id: "cap_002" as any,
      requirement: "v2",
      modifications: [],
      keyDecisions: [],
      testResults: [],
      knownLimitations: [],
      linkedPointers: [],
      tags: [],
      timestamp: new Date().toISOString() as any,
      status: "active",
      parent: "cap_001",
      dependsOn: ["cap_000", "cap_001"],
      trigger: "test-pass",
    };
    expect(c.parent).toBe("cap_001");
    expect(c.dependsOn).toHaveLength(2);
  });
});

describe("EnvironmentPackage 类型契约", () => {
  it("可构造完整 EnvironmentPackage", () => {
    const env: EnvironmentPackage = {
      id: "env_001" as any,
      projectName: "structfocus",
      rootPath: "/path/to/repo",
      layers: [
        {
          name: "layer_framework",
          description: "框架层",
          files: ["packages/framework/src/index.ts"],
          keyPatterns: ["EventBus", "PluginManager"],
        },
      ],
      onboarding: "# StructFocus\n框架层...",
      timestamp: new Date().toISOString() as any,
    };
    expect(env.layers).toHaveLength(1);
    expect(env.layers[0]!.name).toBe("layer_framework");
  });
});

describe("PermissionMatrix 类型契约", () => {
  it("可构造 N 维权限规则", () => {
    const rules: PermissionMatrix = [
      {
        operation: "write",
        scope: "file",
        pattern: "*.env",
        decision: "deny",
        reason: "环境文件禁止写入",
      },
      {
        operation: "execute",
        scope: "process",
        pattern: "rm *",
        decision: "ask",
      },
      {
        operation: "read",
        scope: "directory",
        pattern: "src/**",
        decision: "allow",
      },
      {
        operation: "git-push",
        scope: "system",
        pattern: "*",
        decision: "ask-once",
      },
    ];
    expect(rules).toHaveLength(4);
    expect(rules[0]!.decision).toBe("deny");
    expect(rules[3]!.decision).toBe("ask-once");
  });

  it("PermissionDecision 四种决策", () => {
    const decisions: PermissionRule["decision"][] = ["allow", "deny", "ask", "ask-once"];
    expect(decisions).toHaveLength(4);
  });
});

describe("ToolResult 结构化字段契约", () => {
  it("携带 filesChanged + testPassed（死循环检测依赖）", () => {
    const r: ToolResult = {
      success: true,
      output: "All tests passed",
      durationMs: 1200,
      filesChanged: ["src/index.ts", "tests/base.test.ts"],
      testPassed: true,
    };
    expect(r.filesChanged).toEqual(["src/index.ts", "tests/base.test.ts"]);
    expect(r.testPassed).toBe(true);
  });

  it("被拦截时 blocked + blockedReason", () => {
    const r: ToolResult = {
      success: false,
      output: "",
      durationMs: 0,
      blocked: true,
      blockedReason: "Dangerous command: rm -rf /",
      retryable: false,
    };
    expect(r.blocked).toBe(true);
    expect(r.blockedReason).toContain("rm -rf");
    expect(r.retryable).toBe(false);
  });

  it("可重试标记", () => {
    const r: ToolResult = {
      success: false,
      output: "ETIMEDOUT",
      durationMs: 5000,
      retryable: true,
      error: "network timeout",
    };
    expect(r.retryable).toBe(true);
  });
});

describe("ToolDef 类型契约", () => {
  it("可构造完整工具定义", () => {
    const def: ToolDef = {
      name: "file_read",
      description: "读取文件内容",
      category: "fs",
      params: [
        { name: "path", type: "string", description: "文件路径", required: true },
      ],
      risk: "safe",
      disableable: false,
      enabledByDefault: true,
    };
    expect(def.risk).toBe("safe");
    expect(def.params[0]!.name).toBe("path");
  });

  it("RiskLevel 五级", () => {
    const levels: ToolDef["risk"][] = ["safe", "low", "medium", "high", "critical"];
    expect(levels).toHaveLength(5);
  });

  it("SandboxLevel 四级", () => {
    const levels: SandboxLevel[] = [0, 1, 2, 3];
    expect(levels).toHaveLength(4);
  });
});

describe("MemoryRecord 类型契约", () => {
  it("可构造四类记忆记录", () => {
    const kinds: MemoryRecord["kind"][] = ["decision", "fact", "error", "pref"];
    expect(kinds).toHaveLength(4);
  });

  it("带 confidence 和 deprecated", () => {
    const r: MemoryRecord = {
      id: "mem_001" as any,
      kind: "decision",
      content: "使用 JSONL 而非 SQLite",
      tags: ["storage"],
      timestamp: new Date().toISOString() as any,
      confidence: 0.8,
      deprecated: false,
    };
    expect(r.confidence).toBe(0.8);
    expect(r.deprecated).toBe(false);
  });
});
