#!/usr/bin/env node
// struct-agent - CLI 入口

import * as readline from "node:readline";
import { StructAgent, type StructAgentOptions } from "./agent/struct-agent.js";
import { toolStats } from "./agent/tools-registry.js";

// ─── 命令行参数解析 ────────────────────────────────────────

interface CLIOptions {
  cwd: string;
  provider: "deepseek" | "zhipu" | "openai" | "ollama" | "mock";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  verbose: boolean;
  maxSteps: number;
}

function parseArgs(raw: string[]): CLIOptions {
  const args = raw.slice(2);
  const opts: CLIOptions = {
    cwd: process.cwd(),
    provider: (process.env["STRUCT_PROVIDER"] as any) ?? "mock",
    model: process.env["STRUCT_MODEL"] ?? "mock",
    verbose: false,
    maxSteps: 30,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--cwd": case "-C": opts.cwd = args[++i]!; break;
      case "--provider": case "-P": opts.provider = args[++i]! as any; break;
      case "--model": case "-M": opts.model = args[++i]!; break;
      case "--api-key": case "-K": opts.apiKey = args[++i]!; break;
      case "--base-url": case "-B": opts.baseUrl = args[++i]!; break;
      case "--verbose": case "-V": opts.verbose = true; break;
      case "--max-steps": case "-S": opts.maxSteps = parseInt(args[++i]!, 10); break;
      case "--help": case "-H": printHelp(); process.exit(0);
    }
  }

  // 从环境变量补充
  opts.apiKey ??= process.env["STRUCT_API_KEY"];
  return opts;
}

function printHelp(): void {
  console.log(`
struct-agent - Struct Bridge 参考实现 CLI

用法:
  struct-agent [选项]
  echo "你的需求" | struct-agent [选项]

选项:
  -C, --cwd <path>       工作目录 (默认: 当前目录)
  -P, --provider <name>  LLM provider: deepseek|zhipu|openai|ollama|mock (默认: mock)
  -M, --model <name>     模型名称
  -K, --api-key <key>    API Key (也可用环境变量 STRUCT_API_KEY)
  -B, --base-url <url>   自定义 API 地址
  -S, --max-steps <n>    最大步数 (默认: 30)
  -V, --verbose          详细日志
  -H, --help             显示帮助

环境变量:
  STRUCT_PROVIDER    默认 provider
  STRUCT_MODEL       默认 model
  STRUCT_API_KEY     API Key

内置命令:
  /memory add <内容>     记录一条显式记忆
  /memory list           列出最近记忆
  /memory search <关键词> 搜索记忆
  /capsule create        从本次会话创建知识胶囊
  /tools                 列出可用工具
  /stats                 查看统计
  /exit, /quit           退出
`);
}

// ─── 命令行命令处理 ────────────────────────────────────────

async function handleCommand(input: string, agent: StructAgent): Promise<string | null> {
  const trimmed = input.trim();

  if (trimmed === "/exit" || trimmed === "/quit") {
    await agent.destroy();
    return "__EXIT__";
  }

  if (trimmed === "/tools") {
    const stats = toolStats(agent.harness);
    return `工具统计: ${stats.total} 个工具, ${stats.enabled} 启用, ${stats.disabled} 禁用\n分类: ${JSON.stringify(stats.categories)}`;
  }

  if (trimmed === "/stats") {
    return `工作目录: ${agent.cwd}\n模型: ${agent.options.llm.model}\n状态: ${agent.sm.current}\n步骤: ${agent.loopDetector.getSteps()}`;
  }

  if (trimmed.startsWith("/memory add ")) {
    const content = trimmed.slice("/memory add ".length).trim();
    if (!content) return "用法: /memory add <内容>";
    await agent.memory.record({ kind: "fact", content, tags: ["explicit"] });
    return `✅ 已记住: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`;
  }

  if (trimmed.startsWith("/memory search ")) {
    const query = trimmed.slice("/memory search ".length).trim();
    if (!query) return "用法: /memory search <关键词>";
    const results = agent.memory.searchSync(query, 500, { limit: 10 });
    if (results.length === 0) return "未找到相关记忆";
    return results.map((r, i) => `${i + 1}. [${r.kind}] ${r.summary}`).join("\n");
  }

  if (trimmed === "/memory list") {
    const records = agent.memory.getRecords();
    if (records.length === 0) return "暂无记忆";
    return records.slice(0, 10).map((r, i) => `${i + 1}. [${r.kind}] ${r.content.slice(0, 100)}`).join("\n");
  }

  if (trimmed === "/capsule create") {
    try {
      await agent.memory.recordCapsule({
        requirement: "从 CLI 手动创建的胶囊",
        modifications: [],
        keyDecisions: [],
        testResults: [],
        knownLimitations: [],
        linkedPointers: [],
        tags: ["cli"],
        trigger: "user-remember",
      });
      return "✅ 知识胶囊已创建";
    } catch {
      return "❌ 创建失败";
    }
  }

  // 普通消息 → 交给 agent
  return null;
}

// ─── 主入口 ────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliOpts = parseArgs(process.argv);

  console.log(`🤖 Struct Agent v0.1.0
─────────────────────────────────────
工作目录: ${cliOpts.cwd}
Provider:  ${cliOpts.provider}
模型:      ${cliOpts.model}
─────────────────────────────────────
输入消息开始交互，输入 /help 查看命令，Ctrl+C 退出
`);

  const opts: StructAgentOptions = {
    cwd: cliOpts.cwd,
    llm: {
      provider: cliOpts.provider,
      model: cliOpts.model,
      apiKey: cliOpts.apiKey,
      baseUrl: cliOpts.baseUrl,
    },
    verbose: cliOpts.verbose,
    maxSteps: cliOpts.maxSteps,
  };

  const agent = new StructAgent(opts);
  await agent.init();

  // 检查是否有管道输入
  const hasPipe = !process.stdin.isTTY;
  if (hasPipe) {
    // 非交互模式：读取 stdin，运行一次，输出结果
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
    }
    input = input.trim();
    if (input) {
      const cmdResult = await handleCommand(input, agent);
      if (cmdResult === "__EXIT__") return;
      if (cmdResult) {
        console.log(cmdResult);
        return;
      }
      const result = await agent.run(input);
      console.log(result.response.content);
    }
    await agent.destroy();
    return;
  }

  // 交互模式
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }

    const cmdResult = await handleCommand(input, agent);
    if (cmdResult === "__EXIT__") break;
    if (cmdResult) {
      console.log(cmdResult);
      rl.prompt();
      continue;
    }

    // 正常 agent 运行
    try {
      const result = await agent.run(input);
      console.log(`\n${result.response.content}\n`);
      if (result.stats) {
        console.log(`[${result.stats.steps}步 ${result.stats.toolCalls}工具 ${result.stats.durationMs}ms ${result.stats.tokensUsed}token]`);
      }
    } catch (err) {
      console.error(`❌ Error: ${String(err)}`);
    }

    rl.prompt();
  }

  rl.close();
  await agent.destroy();
  console.log("\n👋 Bye!");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
