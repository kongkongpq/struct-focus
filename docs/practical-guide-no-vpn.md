# 翻墙/上传/网速 — 实战解决方案

> 现状：无 VPN、GitHub 传不上去、npm 慢。
> 三个问题拆开，每条都是成熟方案，不依赖翻墙。

---

## 问题 1：传不上 GitHub

### 根因

```
$ git remote -v
(空 — 根本没设置 remote)

$ git log --oneline -3
5910c01 init: monorepo framework/harness/memory/context/agent
(只有 1 条 commit，所有代码都没提交)

未提交文件: 110 个
```

你**还没建 GitHub 仓库也没设 remote**，所以 push 一定报错。不是网络问题——是根本没目标地址。

### 方案：用 Gitee（码云）替代 GitHub

**Gitee 是国内服务器，不需要翻墙，速度飞快。**

步骤：

```bash
# 1. 先在 Gitee 网页上创建仓库
#    打开 https://gitee.com → 右上角 + → 新建仓库
#    仓库名: structfocus-agent，选择"公开"，不要勾选"初始化仓库"

# 2. 回到命令行，设置 remote
cd E:\Develop\SrcuctAgent
git remote add origin https://gitee.com/你的用户名/structfocus-agent.git

# 3. 先把改动提交了
git add -A
git commit -m "feat: full context engine with benchmark pipeline"

# 4. 推送
git push -u origin feat/web-ui
```

**GitHub vs Gitee 区别**：

| | GitHub | Gitee |
|--|--------|-------|
| 需要翻墙 | ✅ 需要 | ❌ 不需要 |
| 国外开发者能看到 | ✅ | ⚠ 需要主动去 GitHub 同步 |
| Star / Issue / PR | 全球社区 | 中文社区为主 |
| 镜像同步 | 可以 Gitee→GitHub 自动同步 | 内置功能 |

**后续如果想让 GitHub 的人也看到**：Gitee 有"镜像同步到 GitHub"功能，你不需要翻墙——Gitee 服务器帮你同步过去。

### 如果 Gitee 也不行（极少情况）

终极方案：用 `dev-sidecar` 或 `Steam++`（Watt Toolkit）— 这两个是免费的网络加速工具，能加速 GitHub 访问但不属于翻墙。下载地址百度搜就行。

---

## 问题 2：npm/pnpm 安装慢

### 根因

npm 官方源在境外，没翻墙就慢。

### 方案：换淘宝镜像（5 秒搞定）

```bash
# 一行命令，永久生效
pnpm config set registry https://registry.npmmirror.com
```

或者全局配置 `.npmrc`：

```ini
# %USERPROFILE%\.npmrc
registry=https://registry.npmmirror.com
```

**验证**：
```bash
pnpm install  # 现在应该飞快
```

如果你的项目用了 `node_modules/.pnpm` 里的 workspace 协议（`@structfocus/context` 等），确保根目录 `.npmrc` 也有镜像配置：

```ini
# E:\Develop\SrcuctAgent\.npmrc
registry=https://registry.npmmirror.com
```

---

## 问题 3：不会宣传

### 不需要翻墙的宣传渠道

| 渠道 | 可行性 | 操作 |
|------|:------:|------|
| **Gitee 首页推荐** | ✅ 高 | 仓库 README 写好，Gitee 编辑推荐会自然推流。中文社区，不需要翻墙 |
| **掘金 (juejin.cn)** | ✅ 高 | 发一篇技术文章："FIFO 截断 160 轮后召回只剩 33%，我写了个东西修了"。国内最大的前端/技术社区 |
| **V2EX** | ✅ 中 | 发到"分享创造"节点。纯文本+benchmark 截图 |
| **知乎** | ✅ 中 | 回答"如何解决 LLM 上下文窗口限制？"类问题，附 benchmark 图 |
| **B站** | ⚠️ 低 | 录个 3 分钟 demo 视频——但视频制作投入产出比不高 |
| **小红书** | ⚠️ 低 | 不适合技术工具类项目 |
| **即刻 (Jike)** | ✅ 中 | 发一条带 benchmark 截图的状态，技术圈传播快 |

**优先级排序**：

1. **Gitee 仓库自传播**（零成本，自运转）
2. **掘金发一篇文**（一次投入，长期流量）
3. **V2EX "分享创造"**（发布当天爆流量，后续衰减）

### 掘金文章提纲（不需要翻墙，不需要 fancy 配图）

```markdown
# 标题：FIFO 截断在 160 轮后丢失 67% 知识 — 我写了个 9 天项目修复了

## TL;DR
LLM 上下文超限时，FIFO 截断把旧消息直接扔掉。160 轮对话后，关于第一个话题的召回率只剩 33%。
StructFocus 用"概括→胶囊→语义召回"保留 100%，token 消耗降低 76%。

## 问题
- 所有 Agent 框架都在干同一件事：消息太长就扔旧的
- 扔掉的消息里有决策、bug 根因、架构约定
- LLM 上下文窗口从 4K→128K→2M，但注意力衰减从 30K 就开始了

## 解法
三个关键概念：概括（把对话总结成结构化记录）→ 胶囊（打包成可检索的单元）→ 语义召回（需要时搜回来）

## 结果（贴 benchmark 表）
| 160 轮 | A 裸跑 | B FIFO | C StructFocus |
|---------|--------|--------|---------------|
| 召回率  | 100%   | 33%    | 100%          |

## 代码
https://gitee.com/xxx/structfocus-agent （MIT，不接受 PR）
```

### 一句话版本（发即刻/V2EX）

> "所有的 LLM Agent 都在用 FIFO 截断管理上下文——旧消息直接扔掉。160 轮后第一个话题的召回率只剩 33%。写了个 9 天项目修了这个：概括→胶囊→语义召回，100% 保留。https://gitee.com/xxx/structfocus-agent"

---

## 总结：现在立刻能做的三件事

```bash
# 1. 换镜像（30 秒）
pnpm config set registry https://registry.npmmirror.com

# 2. 在 Gitee 创建仓库 + 提交推送（5 分钟）
git add -A
git commit -m "feat: context engine with capsule recall, benchmark pipeline"
git remote add origin https://gitee.com/你的用户名/structfocus-agent.git
git push -u origin feat/web-ui

# 3. 去掘金发文章（30 分钟）
#    标题用上面那个，正文贴 benchmark 结果表 + 一段代码
#    不需要翻墙，不需要好看，只需要数据
```
