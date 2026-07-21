# StructFocus Context — 通用上下文中间层

你运行在一个有上下文窗口限制的环境中。StructFocus 帮你管理注意力：
**不丢信息，只是不一直放在眼前。**

## 四层冷热架构

| 层 | 内容 | 流动 |
|----|------|------|
| **L1 永久** | 用户习惯、项目方向、胶囊指针、工具描述 | 永远不丢，旧了压缩归档（保留指针） |
| **L2 工作** | 当前 LLM 可见的对话 + 聚焦内容 | 默认停留层 |
| **L3 压缩** | LLM 概括后的旧对话（胶囊正文） | L2→L3 自动降级（非活跃 >20% 标记，>50% 执行） |
| **L4 深存** | 完整原文，磁盘 ContentStore | L3→L4 自动降级（总 token >85% 时） |

## 核心机制

### 降级，不是驱逐

StructFocus **从不删除信息**。四层之间只有降级流动：

```
L2 工作 ──≥20% 非活跃──→ L3 压缩（保留指针 + 摘要）
L3 压缩 ──≥85% 总token──→ L4 深存（磁盘，保留审计轨迹）
```

任何从 L3/L4 召回的内容通过语义搜索直接回到 L2。

### 胶囊系统

连续对话自动打包为知识胶囊（指针 + LLM 摘要 + chunk 分块摘要），
召回时按语义搜索，**不按 ID 盲捞**。

### LongContextEngine

独立于任何 Agent 框架的长上下文引擎。三行接入：

```ts
const engine = new LongContextEngine({ llmCall });
engine.feed("user: 这个 bug 怎么修？");
const result = await engine.recall("Redis OOM 问题"); // 语义召回
```

## autoManage：框架自动守护

每步 Agent loop 自动执行（不占 LLM token）：

| 行为 | 触发条件 |
|------|----------|
| 降级 L2→L3 | 非活跃内容 ≥20% 窗口（标记评估），≥50%（执行概括归档） |
| 降级 L3→L4 | 总 token ≥85% 预算（最冷条目深存） |
| 去噪预处理 | 每次工具输出（截断日志/JSON/HTML，保留信号） |
| 任务相关性加权 | 驱逐时 favor 当前任务文件 |
| 注意力浪费度量 | 每轮记录未被引用的 token 占比 |
| 自动回忆 | 匹配记忆自动注入 |

## MCP 工具清单

通过 `@structfocus/mcp` 暴露为标准 MCP Server（stdio），**任何 MCP 兼容 Agent 零侵入接入**。底层仍是四层冷热 + 胶囊系统，但对外只暴露 5 个工具：

### 注入 / 召回
- `context_inject` — 注入一条上下文（对话 / 工具输出 / 日志），type 可选 user/tool/observation
- `context_recall` — 按自然语言语义召回历史上下文（胶囊摘要 + 相关原文片段）

### 聚焦 / 卸载
- `context_focus` — 聚焦指定文件/目录到工作上下文（L0 元数据 / L1 符号大纲 / L2 全文）
- `context_forget` — 忘记（卸载）指定上下文，target 为文件路径或条目 ID

### 状态
- `context_status` — 引擎状态：累计注入/概括 token、胶囊数、活跃/归档条目数、最后概括时间

## 一条信息的完整生命周期

```
Step 1: LLM 读入 auth.ts (15K)
  → 去噪后保留在 L2 工作层

Step 5: LLM 5 轮不碰 auth.ts
  → 非活跃占比 ≥20% → 标记待降级
  → ≥50% → 概括归档到 L3 压缩（胶囊摘要 ~100 tokens，原文保留）

Step 12: 子任务完成
  → pack:subtask("fix_token") → 打包胶囊（决策+文件+结果）

Step 15: 总 token ≥85%
  → 最冷 L3 胶囊原文 → L4 深存（ContentStore 磁盘）

Step 20: LLM 需要回顾之前的 Redis 方案
  → recall("Redis OOM") → 语义搜索 L3+L4
  → 匹配胶囊展开注入 L2 工作层
```

## 接入方式

```json
// Claude Desktop / 任意 MCP 宿主
{
  "mcpServers": {
    "structfocus": {
      "command": "npx",
      "args": ["-y", "@structfocus/mcp"],
      "env": {
        "STRUCT_LLM_API_KEY": "sk-xxx",
        "STRUCT_LLM_BASE_URL": "https://api.deepseek.com/v1",
        "STRUCT_LLM_MODEL": "deepseek-chat"
      }
    }
  }
}
```

### LLM 压缩（可选）

引擎概括旧上下文时用 LLM 做语义摘要。不配 Key 也能跑 —— 走确定性回退（头尾截取，免费但粗略）。

三条环境变量，适配任何 OpenAI 兼容 API：

- `STRUCT_LLM_API_KEY` — API Key（必填）
- `STRUCT_LLM_BASE_URL` — API 地址，默认 `https://api.openai.com/v1`
- `STRUCT_LLM_MODEL` — 模型名，默认 `gpt-4o-mini`

常见：DeepSeek（¥1/1M token）、智谱 GLM-4-Flash（免费）、Ollama 本地模型。

## 原则

1. **不丢信息** — 降级≠删除。一切可召回。
2. **框架兜底** — autoManage 自动运行，LLM 无需手动管上下文。
3. **框架无关** — 通过 MCP 协议接入任何 Agent，不绑定框架。
4. **可逆召回** — 语义搜索从 L3/L4 找回原文，不是模糊摘要。
5. **Benchmark 驱动** — NIAH 100% 召回（12/12，基线 83%）。
