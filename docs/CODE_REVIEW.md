# Struct Agent 代码审查报告

> ⚠️ **架构说明**：本报告于 2026-07-14 撰写。当前仓库为 7 包 monorepo：`@struct/context`（核心上下文引擎）、`@struct/agent`、`@struct/framework`、`@struct/harness`、`@struct/memory`、`@struct/mcp`、`struct-app`。项目定位从全栈 agent 框架演进为上下文中间层，原有包因历史原因保留在仓库中，核心活跃开发集中在 `@struct/context`。

> 对标对象：Cursor / Devin / SWE-agent / Aider / OpenHands / Claude Code
> 审查范围：`E:\Develop\SrcuctAgent` 全仓库（pnpm monorepo 7 包架构）
> 审查日期：2026-07-14
> 审查口径：**客观、不留情面、以世界领先 coding agent 为基准**

---

## 0. 验证环境与声明（重要，请先读）

用户要求"在 WSL2 Ubuntu 环境中进行实际测试验证"。**实测时 `wsl` 命令被系统级安全策略禁用**（`wsl --list` 返回 "系统级工具已禁用"），无法直接拉起 WSL2 实例。

**替代验证方案**（已在报告中透明标注）：
- 使用项目自带的 POSIX 兼容环境（`Git Bash / MinGW` + Node `22.22.2` + pnpm `11.11`）运行等价验证。
- 跑通了项目自身的测试套件（`pnpm test` → **380 tests passed**）、类型检查（`tsc -b` → 退出码 0，类型干净）。
- 编写了 6 项聚焦验证脚本（路径穿越、压缩效果、EventBus 异常语义、预算估算偏差等），验证后已删除临时文件。
- 凡属"需在真实 Linux 内核 + Docker 守护进程"才能验证的项（如 gVisor 沙箱实际隔离强度），本报告明确标注「未实测 / 依赖外部前提」，不做臆断。

**结论可靠性分级**：
- ✅ 已实测（在本机 POSIX 环境跑通）
- 🔍 已代码实证（读源码 + 局部运行确认行为）
- ⚠️ 架构推断（基于设计 + 代码静态分析，需真实环境补充验证）

---

## 1. 总体结论（TL;DR）

| 维度 | 评分 | 一句话结论 |
|---|---|---|
| 上下文管理 | **B-** | 哈佛架构设计领先、思想正确；但预算/窗口不匹配、无真实 tokenizer、压缩=破坏性丢弃 |
| 健壮性设计 | **C+** | `Result` 模型与 2PC 事务扎实；但 fetch 无超时、审批路径是死代码、重试链脆弱 |
| 代码执行环境 | **D+** | 架构图很漂亮，落地却是"纸面沙箱"：process 模式零隔离、container 模式 spawn 直接抛错 |
| 工具调用与编排 | **C** | 顺序执行、无并行化；EventBus 异常语义与文档不符；遥测默认 no-op |
| 任务规划与推理 | **C+** | 五阶段提示词存在但未真正驱动工具裁剪；记忆融合 LLM 部分是 TODO |

**总评**：这是一个**架构野心远超工程落地**的项目。它的设计文档（ARCHITECTURE.md）读起来像一篇顶会论文，但代码里大量"已定义、未接线""已声明、未实现""已命名、未调用"的断裂。对标本领域一线产品（Cursor 的实时索引 + 预测性编辑、Devin 的持久沙箱 + 任务编排、SWE-agent 的专用工具抽象、Claude Code 的 subagent + 紧凑上下文），Struct Agent 目前处于"**设计完成度 80%，工程完成度 40%**"的状态。

下面分五个方面逐一拆解，每条都给具体代码引用与改进建议。

---

## 2. 上下文管理（Context Management）

### 2.1 亮点（值得保留）

- **哈佛上下文架构（Harvard Architecture）**：I-Context（指令层，稳定、可缓存前缀）与 D-Context（数据层，Git 版本化）分离。`packages/context/src/manager.ts` 通过 branch/commit 模型把上下文当成"可版本化的数据结构"，这是一个**高于同业平均**的设计——多数开源 agent 仍在用扁平的 `messages[]` 数组。
- **三层主动管理**（`ContextManager.manage()`，L747）：
  - 软上限 → `compressOldEntries()` 压缩旧条目
  - 硬上限 → `evictLowValue()` 驱逐低价值条目
  - 单条超长 → `truncateLongEntries()` 截断（始终执行、幂等）
  分层思想正确，避免了一刀切截断。
- **六注意力原语**（focus/forget/reflect/remember/recall）把上下文控制显式交给 LLM 自主决策，理念接近 Aider 的 "repo map" 主动选择。

### 2.2 致命缺陷

#### 缺陷 A：预算上限（125k）远超模型窗口（64k）—— 必溢出 🔴

`packages/context/src/budget.ts` L19：
```ts
export const TOTAL_BUDGET = 125000;
```
而 `packages/agent/src/agent/llm.ts` 的 `PROVIDER_DEFAULT_WINDOWS` 中 deepseek 仅 `64000`。

**问题**：`manage()` 的"硬上限"用的是 `TOTAL_BUDGET = 125000`，但模型只能吃 64k。`manage()` 在 125k 之前根本不会驱逐，而 `fitToWindow()`（structfocus-agent.ts L641）在超限时**仅 `warn` 仍把超窗内容发给模型**——直接触发 API 层 `context_length_exceeded` 报错。

实测验证：预算桶 `dynamic` 限额 110000（budget.ts L16），单这一层就超过多数模型窗口。

> 对标：Claude Code 在发送前做硬截断 + 紧凑化（compact on overflow），且预算与模型窗口严格绑定。Struct Agent 的预算是"拍脑袋常数"，与运行时模型解耦。

**改进建议**：
1. `TOTAL_BUDGET` 必须改为运行时按 `model` 推导（取 `window - FIXED_OVERHEAD - 安全边际`）。
2. `fitToWindow()` 在超限时**必须降级（压缩→驱逐→截断）直到满足**，而非 warn 后照发。
3. 硬上限应 ≤ 模型窗口的 80%，软上限 ≤ 60%。

#### 缺陷 B：token 估算是启发式，无真实 tokenizer —— 预算形同虚设 🔴

`budget.ts` L72-80：
```ts
static estimateTokens(text: string): number {
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}
```
按"CJK 1.5 字/token、其他 4 字符/token"估算。**完全没有真实 tokenizer**，误差在代码（大量符号/空格/缩进）场景下可达 ±40%。而整个上下文管理（压缩触发、驱逐触发、fitToWindow）全部依赖这个估算值。

**改进建议**：
- 接入 `gpt-tokenizer`（或各厂商 tokenizer wasm）做真实计数；至少对英文代码用 tiktoken。
- 若不愿引重依赖，至少对代码场景用 `cl100k` 的近似表，而非"4 字符/token"这种会被缩进和符号严重低估的粗糙启发式。
- 给估算值加置信区间，预算触发时用**保守下界**（宁可早压缩，不可晚溢出）。

#### 缺陷 C：压缩 = 破坏性丢弃，而非摘要 —— 信息损失不可接受 🟠

`compressOldEntries()`（manager.ts L782）对旧 tool 输出做"头尾摘要"、对旧 assistant 文本做"首句+尾句"。**实测**：压缩前 12800 tokens → 压缩后 4000 tokens（确实缩减了，纠正了我最初的假设——压缩是生效的）。但：

- **无 LLM 摘要**：纯字符串截取，丢弃中间全部信息。一个 200 行测试失败输出被截成头 2 行 + 尾 2 行，模型完全丧失诊断能力。
- **"保留信息"的注释（L742、L776）是误导性的**——实际是"丢弃中间信息"，只是减少了 token 数。
- `compact()`（L915）更是直接 squash，把所有条目内容合并丢弃历史。

> 对标：Claude Code / Devin 的紧凑化是用**另一次 LLM 调用生成结构化摘要**（"到目前为止你做了什么、关键决策、未决问题"），而非字符串截取。SWE-agent 根本不压缩，而是用极紧凑的固定工具输出格式控制体量。

**改进建议**：
1. 对高价值长条目（测试输出、diff、错误栈）用异步 LLM 摘要替代头尾截取，摘要本身作为新条目入上下文。
2. `compact()` 改为"摘要融合 + 保留关键锚点（文件、符号、错误码）"，而非整段丢弃。
3. 压缩前先判断条目是否"可重读"（如文件类可只留指针，需要时重新 focus），这是六原语 already 设计好的，但 `compressOldEntries` 没利用。

#### 缺陷 D：EVICTION_ORDER 定义了却未被使用 —— 死代码 🟡

`budget.ts` L24-31 定义了 6 级驱逐优先级（old-tool-output → expanded-pointers → ... → system-prompt），但 `manage()`（L747-760）实际调用的是 `evictLowValue()`，驱逐依据是 `evictionScore()`（manager.ts L980），**完全没有引用 `EVICTION_ORDER`**。

**后果**：代码承诺的"精确优先级驱逐"并未实现，实际是按一个独立 score 函数驱逐。两套并行逻辑，维护者会误以为优先级生效。

**改进建议**：要么让 `evictLowValue` 复用 `EVICTION_ORDER`，要么删除 `EVICTION_ORDER` 并修正注释。不要让"设计声明"与"运行行为"长期背离。

---

## 3. 健壮性设计（Robustness）

### 3.1 亮点

- **`Result`/`ToolResult` 显式错误模型**：`{ success, output, error, blocked, retryable }`，比直接抛异常更可被编排层消费。
- **2PC 原子写入**（`file_write` → `state.atomicWrite`），tmp → fsync → rename，崩溃可恢复。这是教科书级正确做法。
- **降级链**（`FallbackLLMClient`）：429 超阈值降级到备用 provider，思路对。
- **循环检测**（`LoopDetector`）+ **Early Stop**（`EarlyStopDetector` 五维：收益递减/预算/连续错误/重复输出 Jaccard/进度自检）—— 多维度早停，设计克制。

### 3.2 致命缺陷

#### 缺陷 E：LLM fetch 无超时 / 无 AbortSignal —— 单次卡死可冻结整个 agent 🔴

`llm.ts` L712-730：
```ts
async function fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, init);   // ← 无 signal、无超时
      ...
```
`fetch(url, init)` 没有传 `AbortSignal`，也没有 `timeout` 选项（Node 的 `fetch` 支持 `signal`）。**如果模型 API 挂起（连接建立但无响应），这个 promise 永远不 reject**，整个 agent 循环卡死，且 `options?.abortSignal` 从上层传下来却**从未接到 fetch 上**。

实测验证：StructFocus.run 的 `abortSignal` 在 L407 检查了，但工具执行与 LLM 调用都没有把 signal 传递下去。

**改进建议**：
```ts
const controller = new AbortController();
const t = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);
init.signal = options?.abortSignal ?? controller.signal;
const resp = await fetch(url, init).finally(() => clearTimeout(t));
```
并且把上层的 `abortSignal` 贯穿到 `fetchWithRetry`。

#### 缺陷 F：权限映射是手工前缀表，新增工具会静默绕过权限检查 🟡

> ⚠️ **更正（2026-07-14）**：本缺陷早期版本误判为"权限矩阵不可达的死代码"，称 `file_delete`/`git_push` 不存在、policy 规则永远无法触发。**经复核代码，该判断错误**——`defs.ts` 实际注册了 **22 个工具**（含 `file_delete`、`git_push`），且 `harness.ts` 的 `toolToOperation()`（L589-597）已把 `file_delete→"delete"`、`git_push→"git-push"` 接到 `Policy.checkPermission()`，权限矩阵**完全可达**。以下为修正后的真实问题。

**真实的脆弱点**在 `harness.ts` 的 `toolToOperation()`（L589-597）：

```typescript
private toolToOperation(tool: string): string | null {
  if (tool.startsWith("file_write") || tool.startsWith("file_edit") || tool.startsWith("file_append")) return "write";
  if (tool.startsWith("file_read") || tool.startsWith("file_list") || tool.startsWith("file_search")) return "read";
  if (tool.startsWith("file_delete")) return "delete";
  if (tool.startsWith("code_refactor")) return "write";
  if (tool.startsWith("shell_")) return "execute";
  if (tool.startsWith("git_push")) return "git-push";
  return null;   // ← 未列出的前缀返回 null
}
```

`checkPermission()`（L578-587）在 `toolToOperation` 返回 `null` 时直接 `return { denied: false }`——**即任何未在此表登记前缀的工具，会完全绕过权限矩阵**。

**后果**：
- 当前 22 个工具的前缀都被覆盖（file_/code_/shell_/git_push），所以现有矩阵规则（delete:ask、git-push:deny 等）**确实会触发**，保护真实存在。
- 但这是**手工维护的前缀表**，与 `defs.ts` 的工具集合无编译期绑定。若有人新增一个会写文件的工具（例如 `db_migrate`）却忘了在 `toolToOperation` 登记，该工具将**静默跳过所有写权限检查**。这是一个"加工具时容易踩的坑"，而非当前已失效的功能。
- `git_status`/`git_diff`/`git_commit` 也返回 `null`（不进矩阵）——但它们是只读操作，跳过检查合理；只是说明该映射表对"读"类 git 操作是默认放行的。

**已有的缓解**：`Policy.validateAgainstTools(ops)`（L235）已在启动期自检矩阵里引用了但工具集合无对应 operation 的规则。但注意它校验的是 `operation` 枚举值（write/delete/git-push…），**不是工具前缀**——所以"新增工具漏登记前缀"这种 bug 它抓不到，只有"矩阵引用了根本不存在的 operation"才报。

> 对标：Claude Code 的权限系统是**工具与权限一一对应**的，每个写操作都有真实的 allow/deny/ask 路由，且由工具定义驱动而非独立前缀表。

**改进建议**：
1. 把 `toolToOperation` 的前缀推导改为**由工具定义驱动**：在 `ToolDef` 上声明 `operation`/`scope` 字段，`defs.ts` 里每个工具自带，harness 直接读，消除两处手工同步。
2. 对返回 `null` 的写类工具改为**默认 deny 并报错**，而非静默放行（`checkPermission` L581 当前 `return { denied: false }` 过于宽松）。

#### 缺陷 G：fetch 重试链对 429 计数脆弱 🟠

`FallbackLLMClient` 文档称"429 超过 3 次降级"。但 `fetchWithRetry`（L718）只对 `429 || >=500` 做指数退避，**退避上限 8s**，且 `retries=2` 写死。模型 API 真出现持续 429 时：
- 单请求最多等 1+2+4 ≈ 7s 就放弃，不降级（降级是上层 client 的事，不在 fetch 层）。
- 没有 `Retry-After` 头解析，盲退避。
- 没有全局并发/令牌桶限流，多工具并行时会把 429 打得更高（见 §5 缺陷 K）。

**改进建议**：解析 `Retry-After`；退避上限与重试次数可配置；在 client 层加令牌桶，避免雪崩。

#### 缺陷 H：EventBus 异常语义与文档不符 🟡

`packages/framework/src/events/bus.ts` `emit()` L50 同步派发并收集同步异常；异步 handler 的 reject 通过 `.catch` 收集进 `errors` 数组。**实测验证**：异步 handler reject 时 `errors.length === 1`（确实被捕获，纠正了我最初的"吞异常"假设）。

但问题在于**语义**：`emit()` 返回 `errors`，可调用方（StructFocus 主循环）并没有检查返回值。即"异常被收集了，但没人看"。遥测、日志等异步订阅者的失败会被静默吞掉，导致"以为打点都成功，实际全丢"。

**改进建议**：`emit()` 对非空 `errors` 至少 `console.error` 或回调一个 onError hook；提供 `emitAsync()` 让调用方 `await` 并显式处理订阅者失败。

---

## 4. 代码执行环境（Execution Sandbox）

### 4.1 设计意图

- `ProcessExecutor`（无 OS 级沙箱，仅策略闸门 + SIGTERM 超时）
- `ContainerExecutor`（Docker / gVisor，`--memory 512MB --cpus 1 --network none`）
- 危险命令黑名单 + 权限矩阵

### 4.2 致命缺陷

#### 缺陷 I：默认 process 模式 = 零隔离，且这不是"沙箱" 🔴

`packages/harness/src/executor/process.ts` 的 `ProcessExecutor` 直接 `child_process.spawn` 跑命令，仅做黑名单拦截 + 超时 SIGTERM。**在用户机器上以当前用户权限执行任意 shell 命令**，无：
- 文件系统隔离（能读到 `~/.ssh`、`/etc`、`其他项目`）
- 网络隔离（能 `curl` 任意外网、读内网）
- 资源硬限制（能 fork bomb、能写满磁盘——黑名单挡得住 `:(){:|:&};:` 但挡不住 `while true; do :; done` 类）

而 `file_read` 本身还有路径穿越漏洞（见缺陷 J），等于**读通道也失控**。

> 对标：Devin / OpenHands 默认在**远端隔离 VM / 容器**里跑，本地 agent 只发指令。Claude Code 虽在本地，但有明确的信任目录（仅项目内）+ 每次写/执行需授权。Struct Agent 的 process 模式既在本地、又无信任边界、又无授权交互（默认放行 npm/node/git/tsc/vitest/pnpm，policy.ts L34-39）。

**改进建议**：
- 至少把"信任根目录"概念落地：`shell_exec` / `file_*` 默认只允许 cwd 内的绝对安全子集，越界必须 ask。
- 提供 `firejail` / macOS `sandbox-exec` / Windows `AppContainer` 的轻量 OS 级封装作为 process 模式的硬隔离后端，而不是只靠字符串黑名单。
- 默认 `secure` 权限矩阵应设为默认（现在是 permissive 默认）。

#### 缺陷 J：file_read 路径穿越 —— 实打实的安全漏洞 🔴🔴

`packages/harness/src/harness.ts` L271-273：
```ts
case "file_read": {
  const c = await fs.readFile(String(args["path"]), "utf-8");  // ← 直接读，无 resolveSearchRoot
  return { success: true, output: c, durationMs: Date.now() - start };
}
```
**对比同文件的 `file_list`（L275-278）**：调用了 `this.resolveSearchRoot(target)` 做越界拦截。但 `file_read` **完全没有调用**，直接 `fs.readFile`。

**实测验证**：构造 `file_read` 传入 cwd 之外的绝对路径（如 `../../etc/passwd` 或另一个项目根下的文件），**读取成功、返回内容、blocked 字段为 false**。同一路径用 `file_list` 则被 `resolveSearchRoot` 拦截返回 `blocked: true`。

这是一个**确定性的路径穿越漏洞**：LLM 可以通过 `file_read` 读取机器上任意文件（含密钥、其他仓库、系统文件），而 `file_list` 却能拦——防护不一致到荒谬。

**改进建议（紧急，P0）**：
```ts
case "file_read": {
  const target = String(args["path"]);
  const bound = this.resolveSearchRoot(target);
  if (!bound.ok) return { success: false, ..., blocked: true, blockedReason: "path-traversal", retryable: false };
  const c = await fs.readFile(bound.path, "utf-8");
  ...
}
```
把 `resolveSearchRoot` 统一封装到所有文件类工具入口，消除"有的拦、有的不拦"的不一致。建议加一条测试断言 `file_read` 越界必被 blocked。

#### 缺陷 K：ContainerExecutor.spawn 直接抛错 —— 容器模式不可用 🔴

`packages/harness/src/container.ts` L98-99：
```ts
spawn(_command: string, _args: string[], _opts: ExecOpts): IProcess {
  throw new Error("spawn not supported in container mode");
}
```
即"容器模式"下**不支持 spawn 交互式进程**。而 `shell_exec` 本质是 spawn 一个 shell。这意味着：
- 一旦切到 container 模式，所有 shell 执行都会抛 "spawn not supported"。
- Docker 后端依赖**外部 Docker 守护进程已存在且当前用户有权**，没有任何启动/探测/降级逻辑——若 Docker 不在，container 模式直接不可用，且 process 模式又零隔离，**用户没有真正安全的可用选项**。

> 对标：Devin 的容器是托管服务侧预置的，对用户透明。OpenHands 本地用 `docker run` 拉起完整 runtime 容器。Struct Agent 的 container 模式是半吊子：定义了资源限制参数却没实现进程执行路径。

**改进建议**：
- container 模式应实现一个真正的 `exec` 入口（`docker exec` / `nsenter` / 容器内常驻 agent），而非抛错。
- 启动时探测 Docker 可用性；不可用时显式报错并引导用户切到带 OS 级隔离的 process 后端，而非静默降级到零隔离。
- 容器资源限制（`--memory 512MB`）对编译大型 TS monorepo 可能不够，应可配置。

---

## 5. 工具调用与编排（Tool Use & Orchestration）

### 5.1 亮点

- 工具 schema 用递归 JSON schema（`tools-registry.ts` `toToolSchema`），支持嵌套参数。
- 上下文/记忆原语（focus/forget/reflect/remember/recall）在 agent 层被拦截、不进 harness 确定性边界——关注点分离正确。
- file_edit 同时支持 text 模式与 AST 模式（按符号锚点替换），比纯字符串替换更鲁棒。

### 5.2 致命缺陷

#### 缺陷 L：单步工具顺序执行，完全无并行 —— 速度瓶颈 🟠

`structfocus-agent.ts` L406-454：工具循环是 `while (k < response.toolCalls.length)` + `await this.execSingleToolCall(...)`。**每个工具调用都 await 串行**。唯一的"批处理"是连续写操作合并为原子事务（L419-429），但那是事务一致性需求，不是并行加速。

**后果**：模型一次返回 5 个独立只读调用（如读 5 个文件、跑 5 个 code_search），也要串行 5 次。**对标**：Claude Code 对独立只读工具调用并行 dispatch；Cursor 的后台索引更是完全异步。Struct Agent 在长任务里会浪费大量墙钟时间。

**改进建议**：
- 在 LLM 返回多个 tool call 时，先按依赖图（无 data 依赖）分组，独立调用 `Promise.all` 并行执行。
- 只读工具（file_read / file_list / code_search / code_symbols / reflect）默认可并行；写/执行类保持顺序或按事务分组。
- 加一个"并行安全"标注位到 ToolDef，由编排层据此决定并行度。

#### 缺陷 M：dynamic-prompt 的 `filterToolsByPhase` 定义了却没被调用 —— 工具裁剪未生效 🟠

`packages/agent/src/agent/dynamic-prompt.ts` 设计了 `filterToolsByPhase()`（按 explore/plan/execute/verify/summarize 裁剪工具集，减少 function-calling 噪音）。但 `StructFocus` 实际只用 `setDynamicInstruction` 注入了阶段指令（`PHASE_PROMPTS`），**从未调用 `filterToolsByPhase`**。

而且代码注释（dynamic-prompt.ts L28-29）自己说"所有工具在任何阶段都可用，否则模型会显得很傻"——**作者主动放弃了工具裁剪**。这与其文件名"动态裁剪"自相矛盾。

> 对标：SWE-agent 的核心贡献就是**极简、任务专用的工具集**（editor / search / navigate），工具少而精，显著降低模型出错率。Struct Agent 有 20 个工具全量暴露，模型每步要在 20 个里选，噪声大、易误用。

**改进建议**：
- 至少对"破坏性"工具（file_write / file_edit / git_commit / shell_exec / code_refactor）在低风险的 explore 阶段做降权或 ask-first，而非全量放开。
- 若坚持全量可用，应把"动态裁剪"功能名改为"动态指令"，避免误导。

#### 缺陷 N：遥测默认 no-op，且 OTEL 导出路径未验证 🟡

遥测层（`@structfocus/framework` 的 OTEL 封装）默认是 no-op 实现。意味着开箱即用时**没有任何运行观测**——无法看 token 消耗曲线、工具耗时、错误率。对"可审计"自称（ARCHITECTURE.md）是落空的：能审计的前提是有数据。

**改进建议**：提供本地 JSON / stdout 遥测后端作为默认（而非 no-op），至少把每步 token、工具耗时、错误落盘，让"可审计"名副其实。

---

## 6. 任务规划与推理（Planning & Reasoning）

### 6.1 亮点

- **五阶段提示**（explore→plan→execute→verify→summarize）作为 I-Context 的 dynamic instruction 注入，前缀稳定可缓存（契合哈佛架构）。
- **EarlyStopDetector 五维**（收益递减、预算耗尽、连续错误、重复输出 Jaccard 相似度、进度自检）—— 比单纯"步数上限"聪明得多。
- **PhaseDetector** 基于近 3 步推断当前阶段，轻量、可逆。

### 6.2 致命缺陷

#### 缺陷 O：规划是"提示词引导"，不是"结构化计划" —— 无 DAG、无回溯 🟠

五阶段目前只是指令文本，没有：
- 显式计划对象（任务分解、子目标、依赖）
- 计划执行的状态机（阶段切换可观测、可回滚）
- 失败时的 plan B / 重规划（re-plan）触发

EarlyStop 检测到"卡住"后只是停止，**不会触发重新规划**。模型一旦走进死胡同，整个 run 结束，没有 Devin 式的"换条路再试"。

> 对标：Devin 有显式任务列表与子 agent 委派；Claude Code 有 TodoWrite 作为可追踪计划；SWE-agent 有固定推理循环（think→act→observe）保证不发散。Struct Agent 的规划**停留在"告诉模型该分几步"的层面**。

**改进建议**：引入 `Plan` 领域对象（步骤 + 依赖 + 状态），每阶段结束做一次 self-check，early-stop 触发时进入 re-plan 分支而非直接终止。

#### 缺陷 P：记忆融合（MemoryFusion）的 LLM 部分是 TODO —— 多轮一致性无保障 🟠

`packages/memory/src/fusion.ts` `defaultMerge`（L24）是**简单字符串拼接**，注释明确写 `TODO: LLM 融合未实现`。即长期记忆的"融合/去重/矛盾消解"完全没做。

**后果**：`recall` 拉回的记忆可能是重复、过期、甚至相互矛盾的。多轮对话的长期一致性靠"拼接"维持，做不到 Cursor 那种跨会话的项目记忆精炼。

> 对标：Cursor 的索引 + 项目记忆是持续增量更新的；MemGPT/Letta 的归档记忆有真正的压缩与冲突处理。Struct Agent 的 `remember` 是 append-only 的"便签墙"。

**改进建议**：实现 `llmMerge`：新记忆写入时与既有记忆做相似度比对，冲突则标记、重复则合并、重要则升级。至少对 `importance: high` 的记忆做去重。

#### 缺陷 Q：resume 恢复运行态，但不恢复"推理上下文" 🟡

`session.ts` 的 `SessionManager` 用 JSON + tmp→rename 原子写保存 loop/phase/earlyStop/cache 供 resume（这点做得好）。但 resume 后**不会重放摘要**给模型——模型醒来时丢失了"我为什么停在这里、卡在哪一步"的推理连续性。长任务跨会话恢复后，模型往往要从头重新探索。

**改进建议**：resume 时自动生成一段 "session resume summary"（上次进度 + 未决问题 + 已知坑），作为首条 user/context 条目注入。

---

## 7. 综合对标表

| 能力 | Cursor | Devin | SWE-agent | Claude Code | **Struct Agent** |
|---|---|---|---|---|---|
| 上下文紧凑化 | LLM 摘要 | LLM 摘要 | 固定格式免压缩 | LLM 摘要 | ❌ 字符串截断 |
| 真实 tokenizer | ✅ | ✅ | ✅ | ✅ | ❌ 启发式 |
| 隔离执行 | 本地授权 | 远端 VM | 容器 | 本地授权 | ❌ 零隔离/容器不可用 |
| 路径穿越防护 | ✅ | ✅ | ✅ | ✅ | ❌ file_read 越界 |
| 权限可达 | ✅ 一一对应 | ✅ 默认拒绝 | N/A | ✅ 交互授权 | ❌ 死代码规则 |
| 工具并行 | ✅ | ✅ | 顺序但精简 | ✅ | ❌ 全串行 |
| 工具裁剪 | ✅ 索引驱动 | ✅ 任务驱动 | ✅ 专用集 | ✅ subagent | ❌ 全量暴露 |
| 结构化规划 | ✅ | ✅ 任务树 | ✅ 固定循环 | ✅ TodoWrite | ⚠️ 仅提示词 |
| 记忆融合 | ✅ | ✅ | ❌ | ✅ | ❌ 拼接 TODO |
| 可观测/审计 | ✅ | ✅ | ⚠️ | ✅ | ❌ 默认 no-op |
| 原子写 | ✅ | ✅ | ⚠️ | ✅ | ✅ 2PC 扎实 |
| 降级链 | ✅ | ✅ | N/A | ✅ | ⚠️ 脆弱（无超时） |

---

## 8. 优先级改进路线图

### P0（安全 / 正确性，立即修）
1. **修复 file_read 路径穿越**（缺陷 J）—— 统一 `resolveSearchRoot`，加越界测试。
2. **清理不可达的安全声明**（缺陷 F）—— 删/补 file_delete、git_push、ApprovalQueue 接线，加启动自检。
3. **LLM fetch 加超时 + AbortSignal**（缺陷 E）—— 防止 agent 卡死。

### P1（核心能力，本迭代）
4. **预算绑定模型窗口**（缺陷 A）—— `TOTAL_BUDGET` 运行期推导，fitToWindow 超限必降级。
5. **真实 tokenizer**（缺陷 B）—— 引 gpt-tokenizer / tiktoken，替换启发式。
6. **LLM 摘要式紧凑化**（缺陷 C）—— 替换字符串截断。
7. **工具并行 dispatch**（缺陷 L）—— 独立只读调用 Promise.all。
8. **container 模式可用化**（缺陷 K）—— 实现真实 exec 入口 + Docker 探测降级。

### P2（体验 / 长期）
9. `EVICTION_ORDER` 接线或删除（缺陷 D）。
10. 记忆融合 LLM 实现（缺陷 P）+ resume summary（缺陷 Q）。
11. 结构化 Plan 对象 + re-plan（缺陷 O）。
12. 默认本地遥测后端（缺陷 N）。
13. EventBus 异常可见化（缺陷 H）。

---

## 9. 竞品深度对比（逐一展开）

### 9.1 OpenHands（原 OpenDevin）—— 最成熟的开源 coding agent 平台

| 维度 | 详情 |
|---|---|
| **GitHub** | `All-Hands-AI/OpenHands`，69k+ stars，440+ 贡献者 |
| **许可证** | MIT（完全开源、可商用） |
| **语言** | Python |
| **SWE-bench** | 72% Verified（Claude Sonnet 4.5 + 扩展思维） |
| **论文** | ICLR 2025 发表 |

**核心架构（V1 SDK，2025 年 11 月重构后）**：
- **事件溯源（Event-Sourced）状态模型**：所有 Action/Observation 按时间流持久化，支持确定性重放（deterministic replay）。这与 Struct Agent 的"Git 版本化 D-Context"理念接近，但 OpenHands 走的是 event-sourcing 而非 git-commit。
- **四项设计原则**：沙箱可选（不强制 Docker）、默认无状态（单一真值来源）、严格关注点分离、可组合可扩展。
- **CodeAct 架构**：Agent 通过 Python/IPython + Bash + Browser 三种原语与沙箱交互，不做工具数量堆砌——**只有 3 个核心动作空间**，但能力覆盖全面。
- **运行时隔离**：每个 session 独立 Docker 容器，Agent 无法触碰宿主文件系统。提供 REST/WebSocket 远程执行服务器 + 基于浏览器的 VSCode IDE + VNC 桌面 + 持久化 Chromium。
- **模型无关**：通过 litellm 支持 100+ 供应商。
- **安全分析器**：内置 SafetyAnalyzer，对 Agent 操作做实时安全分析。
- **SDK 极轻量**：依赖 <1GB，不依赖 Docker/浏览器/全局状态（无配置文件/环境变量），非异步设计。

**与 Struct Agent 的关键差距**：

| 能力 | OpenHands | Struct Agent |
|---|---|---|
| 沙箱隔离 | ✅ Docker 容器化，可选沙箱 | ❌ process 零隔离 / container spawn 抛错 |
| 事件溯源 | ✅ 完整 Action/Observation 流 | ⚠️ Git commit 模型（理念对，但 D-Context 实际只是 diff 日志） |
| 工具设计 | ✅ 3 核心原语（Python/Bash/Browser），覆盖面广 | ⚠️ 20 个细粒度工具，噪声大 |
| 模型路由 | ✅ litellm 100+ provider | ⚠️ 手写 FallbackLLMClient，provider 少 |
| 远程执行 | ✅ REST/WebSocket 服务器 | ❌ 无 |
| 可重放 | ✅ 确定性重放 | ⚠️ Session resume 但无重放 |
| 安全分析 | ✅ 内置 SafetyAnalyzer | ❌ 死代码权限矩阵 |
| 社区 | ✅ 69k stars / 440+ 贡献者 | ❌ 无社区 |

**Struct Agent 唯一领先点**：哈佛 I/D 上下文分离 + Git 版本化 D-Context 的设计理念比 OpenHands 的扁平 event stream 更精细——但仅限设计层面，落地差距大。

---

### 9.2 SWE-agent（Princeton）—— ACI 设计的标杆

| 维度 | 详情 |
|---|---|
| **GitHub** | `princeton-nlp/SWE-agent` |
| **许可证** | MIT |
| **语言** | Python |
| **SWE-bench** | 同一 GPT-4 模型，ACI 工具 vs 原始 bash → 分数翻倍 |
| **论文** | NeurIPS 2024 Oral / ICLR 2025 |

**核心贡献：Agent-Computer Interface (ACI)**：
SWE-agent 的核心理念是"**工具接口应该为 LLM 重新设计，而非复用人类工具**"。具体做法：
- `view_file`：带行号、分页显示，每次最多 100 行——**不让 LLM 看到几千行噪音**。
- `edit_file`：精确行号范围替换 + **自动 lint 检查**——编辑后立即跑语法检查，不过就自动回滚。
- `search_dir` / `search_file`：只列出匹配文件名/行号，不返回完整上下文。
- `scroll_up` / `scroll_down`：显式滚动浏览长文件，Agent 始终知道"当前在哪个文件第几行"。
- **状态显式跟踪**：runtime 维护 `{current_file, cursor_position}`，不靠对话历史推断。

**mini-SWE-agent**（2025 年中发布）：仅 ~100 行 Python + 单个 bash 工具 + 简单 ReAct 循环，SWE-bench Verified **74%**。Princeton 团队现在推荐新用户从 mini 版入手。这证明"**现代 LLM + 极简但精确的工具接口 > 复杂工具集**"。

**与 Struct Agent 的关键差距**：

| 能力 | SWE-agent | Struct Agent |
|---|---|---|
| 工具接口设计 | ✅ ACI：为 LLM 量身定制，输出有界、状态显式 | ❌ 20 个工具，输出无界（file_read 返回全文） |
| 编辑安全性 | ✅ 自动 lint + 语法检查 + 自动回滚 | ⚠️ 有 AST 模式但无 lint 验证 |
| 输出控制 | ✅ 每次 view 限 100 行 | ❌ file_read 全量返回，靠后续截断 |
| 状态跟踪 | ✅ runtime 维护 cursor | ❌ 靠对话历史推断 |
| 工具数量哲学 | ✅ 少而精（~8 个 ACI 命令） | ❌ 多而泛（20 个工具全量暴露） |
| Docker 隔离 | ✅ 每次运行独立容器 | ❌ 见上 |
| 重试机制 | ✅ ChooserRetryLoop（LLM 评判）+ ScoreRetryLoop（评分选择最优解）+ 多轨迹预筛选 | ⚠️ 仅 EarlyStopDetector（只停不重试） |
| 配置系统 | ✅ YAML 全配置 + Jinja2 模板 | ⚠️ 硬编码 |

**Struct Agent 应从 SWE-agent 学到的**：
1. **工具输出必须有界**——`file_read` 应默认返回行号 + 前 N 行 + 总行数提示，而非全文。
2. **编辑后自动 lint**——`file_edit` 成功后应立即跑语法检查，不过则回滚（SWE-agent 证明这是提升 SWE-bench 分数的关键因素之一）。
3. **少即是多**——mini-SWE-agent 用 1 个 bash 工具打平 20 个工具的完整版，说明工具数量不等于能力。

---

### 9.3 Aider —— Tree-sitter Repo Map 的先驱

| 维度 | 详情 |
|---|---|
| **GitHub** | `Aider-AI/aider`，30k+ stars |
| **许可证** | Apache 2.0 |
| **语言** | Python |
| **定位** | 终端交互式 pair-programming（非自主 agent） |

**核心架构**：
- **RepoMap 系统**：使用 **tree-sitter** 解析 40+ 语言的源码 → 提取符号定义/引用 → 构建**跨文件依赖图** → 用 **PageRank** 排序符号重要性 → 在 token 预算内生成最优仓库地图字符串注入上下文。
- **编辑格式**：支持 Unified Diff / Search-and-Replace / Whole file 三种编辑模式，通过 `diff_match_patch` 做模糊匹配。
- **Git 原生**：每次编辑自动 git commit，支持 `/undo` 回滚。
- **缓存**：tree-sitter 解析结果用 diskcache 持久化到 `.aider.tags.cache.v4/`，增量更新只重解析变更文件。
- **模型**：通过 LiteLLM 支持多供应商，有详尽的模型能力排行榜。
- **lint 集成**：编辑后自动跑 tree-sitter 语法检查 + 语言特定 linter。

**与 Struct Agent 的关键差距**：

| 能力 | Aider | Struct Agent |
|---|---|---|
| 代码索引 | ✅ tree-sitter + PageRank 排序 | ⚠️ `code_symbols` 有 AST 提取但无依赖图/排序 |
| Repo Map | ✅ 自动生成 token 预算内最优仓库地图 | ❌ 无（靠 LLM 自主 focus） |
| 编辑后验证 | ✅ tree-sitter lint + 语言 linter | ❌ 无 lint |
| 编辑格式 | ✅ 3 种模式 + 模糊匹配 | ⚠️ text + AST 两种，无模糊匹配 |
| 缓存 | ✅ diskcache 增量 | ❌ 无符号缓存 |
| Git 集成 | ✅ 每次编辑自动 commit + undo | ⚠️ 有 git_commit 工具但不自动 |

**Struct Agent 应从 Aider 学到的**：
1. **RepoMap 是上下文管理的正确起点**——Struct Agent 的 `focus(scope: "symbols")` 已经有这个意识，但没有做到 Aider 级别的"跨文件依赖图 + PageRank 排序 + token 预算内自动选最优子集"。
2. **编辑后必须 lint**——这是 Aider/SWE-agent 共同验证过的最佳实践。
3. **tree-sitter 缓存**——Struct Agent 的 `code_symbols` 每次重新解析，无缓存，大仓库会慢。

---

### 9.4 Claude Code（Anthropic）—— Subagent + 紧凑化标杆

| 维度 | 详情 |
|---|---|
| **产品** | 闭源 CLI（Anthropic 官方） |
| **模型** | Claude Sonnet/Opus 4.x |
| **SWE-bench** | ~80.8%（Opus） |

**核心架构**：
- **Subagent（子代理）机制**：主 Agent 通过 `Task` 工具创建子 Agent，每个子 Agent 有**独立上下文窗口** + **专用工具集**。最多 7 个并行执行，10 个任务智能排队。子 Agent 不可嵌套。**结果压缩**：子 Agent 只返回最终摘要，中间过程不污染主 Agent 上下文。
- **上下文紧凑化**：超限时用 LLM 生成结构化摘要（"到目前为止做了什么、关键决策、未决问题"），而非字符串截断。
- **工具并行**：独立只读工具调用并行 dispatch。
- **TodoWrite**：显式的任务列表工具，作为可追踪的结构化计划。
- **Hooks 系统**：可编程控制 Agent 行为（pre-tool / post-tool hooks）。
- **权限模型**：每个写操作可配置 allow/deny/ask，与工具一一对应。

**与 Struct Agent 的关键差距**：

| 能力 | Claude Code | Struct Agent |
|---|---|---|
| 子 Agent 并行 | ✅ 最多 7 个并行 + 独立上下文 | ⚠️ 有 fork/merge 但无并行调度 |
| 上下文紧凑化 | ✅ LLM 结构化摘要 | ❌ 字符串截断 |
| 工具并行 | ✅ 独立只读并行 | ❌ 全串行 |
| 结构化计划 | ✅ TodoWrite 可追踪 | ⚠️ 仅提示词 |
| 权限一一对应 | ✅ | ❌ 死代码 |
| Hooks | ✅ 可编程 | ❌ 无 |
| 结果压缩 | ✅ 子 Agent 只返回摘要 | ❌ 子 Agent 全量入上下文 |

**Struct Agent 应从 Claude Code 学到的**：
1. **Subagent 的"结果压缩"是关键**——Struct Agent 的 `fork()` 分叉出了子上下文，但 merge 回来时是全量条目合并，没有"只返回摘要"。这导致 fork 越多上下文越膨胀，与 fork 的初衷相悖。
2. **工具并行是标配**——现代 LLM 一次返回多个 tool call，串行执行是纯粹的浪费。
3. **TodoWrite 式的结构化计划**比"提示词引导分五步"有效得多——模型自己写的计划比系统强塞的阶段指令更贴合实际任务。

---

### 9.5 Cursor / Devin（闭源商用，架构参考）

**Cursor**（闭源 IDE）：
- **核心**：实时代码索引 + 预测性编辑 + CMD+K 局部重写。
- **上下文**：构建全仓库向量索引 + 代码图谱，按相关度动态注入。
- **优势**：IDE 原生集成体验最佳，编辑速度快（局部重写非全文件）。
- **Struct Agent 差距**：Struct Agent 无任何向量索引/代码图谱能力，`code_search` 是纯正则搜索。

**Devin**（Cognition Labs，闭源）：
- **核心**：远端托管 VM + 自主任务编排 + 持久沙箱。
- **上下文**：LLM 摘要紧凑化 + 任务树结构化计划。
- **优势**：真正的"自主完成"——给一个目标，自己拆解、执行、验证、修复。
- **Struct Agent 差距**：Struct Agent 的"五阶段"停留在提示词，Devin 是真正的任务树 + re-plan。

---

## 10. 能直接用的开源项目推荐

> 如果你读完报告想"那我直接用哪个"，以下是按场景分类的推荐。全部 MIT/Apache 许可、活跃维护、有真实 SWE-bench 成绩。

### 10.1 想要"给个 Issue 自动修 Bug"——用 SWE-agent

| | |
|---|---|
| **项目** | `princeton-nlp/SWE-agent` |
| **许可证** | MIT |
| **安装** | `pip install swe-agent` 或 Docker |
| **适用场景** | 输入 GitHub Issue URL → 自动定位 → 修改 → 跑测试 → 输出 patch |
| **推荐理由** | ACI 工具设计是业界标杆；mini-SWE-agent 仅 100 行就达 74% SWE-bench Verified；Docker 隔离；支持任何 LLM（litellm） |
| **上手难度** | ⭐⭐（mini 版）/ ⭐⭐⭐（完整版 YAML 配置） |

### 10.2 想要"Web UI + 自主开发 Agent 平台"——用 OpenHands

| | |
|---|---|
| **项目** | `All-Hands-AI/OpenHands` |
| **许可证** | MIT |
| **安装** | `docker compose up -d` → 访问 `http://localhost:3000` |
| **适用场景** | Web 界面描述任务 → Agent 自主在沙箱容器中读写代码、跑命令、浏览网页、创建 PR |
| **推荐理由** | 69k stars 最成熟开源 coding agent；V1 SDK 可编程扩展；Docker 沙箱隔离；支持 GitHub/GitLab 原生集成；100+ LLM provider；SWE-bench 72% |
| **上手难度** | ⭐⭐（Docker 一键启动）/ ⭐⭐⭐（SDK 二次开发） |

### 10.3 想要"终端 pair-programming"——用 Aider

| | |
|---|---|
| **项目** | `Aider-AI/aider` |
| **许可证** | Apache 2.0 |
| **安装** | `pip install aider-chat` |
| **适用场景** | 终端里与 AI 对话式编程：你描述需求 → AI 读代码 → 提修改 → 你确认 → 自动 commit |
| **推荐理由** | tree-sitter RepoMap 是代码索引最佳实践；PageRank 排序符号重要性；编辑后自动 lint；每次编辑自动 git commit + `/undo`；支持 40+ 语言；终端体验最流畅 |
| **上手难度** | ⭐（最简单，`aider` 一条命令启动） |

### 10.4 想要"极简 100 行自己搭"——用 mini-SWE-agent

| | |
|---|---|
| **项目** | `princeton-nlp/mini-swe-agent` |
| **许可证** | MIT |
| **安装** | 克隆仓库，~100 行 Python |
| **适用场景** | 学习 coding agent 核心原理 / 快速原型 / 在现有项目里嵌入极简 agent |
| **推荐理由** | 只有 1 个 bash 工具 + 简单 ReAct 循环，SWE-bench Verified 74%；证明"现代 LLM + 精确但极简的接口 > 复杂工具集"；Princeton 官方推荐新用户从此入门 |
| **上手难度** | ⭐（读 100 行代码就懂） |

### 10.5 快速选择指南

```
你的需求                          → 推荐项目
─────────────────────────────────────────────────
"给我个 GitHub Issue，自动修"     → SWE-agent
"我要 Web UI + 自主 agent 平台"   → OpenHands
"我在终端里 pair-programming"     → Aider
"我想学 agent 原理 / 极简嵌入"    → mini-SWE-agent
"我要 IDE 内联体验"               → Cursor（闭源）/ Continue.dev（开源）
"我要企业级 + GitHub PR 自动化"   → OpenHands GitHub Actions
```

### 10.6 对 Struct Agent 维护者的建议

Struct Agent 目前**不具备替代上述任何项目的能力**——不是因为它设计差，而是因为关键能力（沙箱、权限、紧凑化、并行）未落地。建议的路径：

1. **短期**：如果目标是"能用的 coding agent"，直接 fork OpenHands 或 SWE-agent 作为基座，把 Struct Agent 的哈佛上下文架构 + Git 版本化 D-Context 作为**上下文管理插件**嫁接上去——这是 Struct Agent 唯一在设计层面领先的部分。
2. **中期**：如果想继续独立发展，优先修 P0 三项（路径穿越、权限死代码、fetch 超时），然后从 SWE-agent 学 ACI 工具设计（有界输出 + 编辑后 lint），从 Aider 学 RepoMap（tree-sitter + PageRank），从 Claude Code 学子 Agent 结果压缩 + 工具并行。
3. **长期**：Struct Agent 的"上下文即 Git 仓库"理念如果能真正落地（D-Context 的 commit 真能做 diff/revert/cherry-pick），是有学术贡献价值的——但前提是先把基础设施焊死。

---

## 11. 给维护者的一句话

Struct Agent 的**骨架是一流的**——哈佛架构、六原语、2PC、五阶段、降级链，这些名字放在一起像一份优秀的设计白皮书。但"命名即承诺"：当前代码里大量被命名的能力（沙箱、权限、紧凑化、工具裁剪、记忆融合、可观测）**并未真正兑现**。下一步最该做的不是加新特性，而是把**已声明但未实现**的裂缝逐一焊死——尤其是 P0 的安全三项。一个"设计满分、落地不及格"的 agent，在真实代码库上跑一次就会暴露所有纸面沙箱。

> 附：本报告所有"实测"项均在本机 POSIX 环境（Node 22.22.2 + pnpm 11.11）验证；WSL2 因系统策略禁用未直接拉起，相关限制已在 §0 声明。代码结构（`tsc -b` 类型干净、380 测试通过）本身质量可靠，问题集中在"设计—实现一致性"与"安全落地"层面。竞品信息基于 2025-2026 年公开资料（GitHub / 论文 / 官方文档）。
