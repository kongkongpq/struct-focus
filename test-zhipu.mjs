#!/usr/bin/env node
// test-zhipu.mjs - 直接测试 StructAgent + 智谱 GLM-4
// 用法: node test-zhipu.mjs [工作目录]

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 动态导入编译后的模块
const { StructAgent } = await import("../dist/agent/index.js");

const cwd = process.argv[2] ?? process.cwd();
const model = process.env["STRUCT_MODEL"] ?? "glm-4-flash";

console.log(`🤖 Struct Agent Test
═══════════════════════════════
工作目录: ${cwd}
模型:     ${model}
Provider: zhipu
═══════════════════════════════
`);

const agent = new StructAgent({
  cwd,
  llm: {
    provider: "zhipu",
    model,
    apiKey: process.env["STRUCT_API_KEY"],
    temperature: 0.1,
    maxTokens: 2048,
  },
  maxSteps: 8,
  verbose: true,
});

await agent.init();

// 测试任务：在 cwd 下创建一个 hello.ts 文件
const task = process.argv[3] ?? "在当前目录创建一个 hello.ts 文件，内容为 TypeScript 的 greet 函数，然后编译并测试它";

console.log(`📝 任务: ${task}\n`);

const startTime = Date.now();
const result = await agent.run(task);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n═══════════════════════════════`);
console.log(`📊 结果 (${elapsed}s)`);
console.log(`   成功:    ${result.success}`);
console.log(`   步数:    ${result.stats?.steps ?? 0}`);
console.log(`   工具调用: ${result.stats?.toolCalls ?? 0}`);
console.log(`   Tokens:  ${result.stats?.tokensUsed ?? 0}`);
console.log(`   死循环:  ${result.stats?.loopDetected ?? false}`);
console.log(`   中断:    ${result.stats?.aborted ?? false}`);
console.log(`   回复:    ${(result.response?.content ?? "").slice(0, 300)}`);
if (result.error) console.log(`   错误:    ${result.error}`);

await agent.destroy();
