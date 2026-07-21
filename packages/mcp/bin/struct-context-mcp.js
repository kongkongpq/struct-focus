#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// npm 执行 bin 时不会加 --experimental-strip-types，Node 不认识 .ts，
// 这里用包装脚本重新拉起带该 flag 的 node 来跑 src/index.ts。
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");

const child = spawn("node", ["--experimental-strip-types", src], { stdio: "inherit", shell: false });

// 把子进程退出码/信号透传给外层，保证 npx / 上层调用能拿到真实结果
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
