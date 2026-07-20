# 三方对比：腾讯 Agent Memory vs Manus vs StructFocus

> 日期：2026-07-16
> 目的：评估 StructFocus 是否在重复造轮子

## 结论

**不是重复造轮子。** 三者解决不同层次的问题，可以叠加使用。

## 三方定位

| 维度 | 腾讯 Agent Memory | Manus | StructFocus |
|---|---|---|---|
| 定位 | 记忆层（长期+短期） | 完整 Agent 产品 | 上下文调度中间层 |
| 核心创新 | Context Offloading + Mermaid 画布 + L0-L3 金字塔 | CodeAct + 文件系统外部记忆 + KV cache 纪律 | 哈佛架构 + 六原语 + 注意力审计 + PointerRegistry |
| 与 LLM 关系 | 插件（前后拦截） | 直接驱动 | 中间层 SDK |
| 开源 | MIT | 闭源 | Apache 2.0（计划） |

## 我们独有的

1. **哈佛架构（I/D 分离）**：架构级保证 prompt cache 稳定性，而非靠经验约束
2. **六原语注意力调度**：focus/forget/reflect/remember/recall/verify 作为一等公民接口
3. **注意力审计**：条目级未引用 token 量化，每 5 步自动报告
4. **D-Context Git 版本化**：commit/branch/merge/checkout，支持子任务 fork 和回滚
5. **PointerRegistry 愿景**：双向可逆指针（如实现，优于腾讯的单向卸载）

## 他们的优势（需正视）

| 能力 | 腾讯 | Manus | 我们 |
|---|---|---|---|
| Mermaid 任务画布 | ✅ | ❌ | ❌ |
| 上下文卸载到文件 | ✅ refs/*.md | ✅ 文件系统 | ❌ forget 是删除 |
| L0-L3 记忆分层 | ✅ | ✅ Working/Hot/Cold | ⚠️ 扁平存储 |
| 实测数据 | ✅ -61% token | ✅ -80% 上下文 | ⚠️ -27.7% |
| 工具 logits 屏蔽 | ❌ | ✅ | ❌ |
| 生态适配 | ✅ OpenClaw+Hermes | ✅ 完整产品 | ❌ MCP 有但无真实接入 |

## 重叠区域（诚实面对）

- `structuredCompress` ≈ 腾讯 Context Offloading 的劣化版（裁剪非卸载）
- `remember/recall` ≈ 腾讯 L1-L3 的极简版（扁平非分层）
- PointerRegistry 如落地 > 腾讯 Context Offloading（双向可逆+语义元数据）

## 战略建议

1. **Context Offloading 取代 structuredCompress**：forget 时写外部文件+留指针（PointerRegistry 正好用武之地）
2. **任务状态符号化**：D-Context commit log → Mermaid 图
3. **长期记忆分层**：MemoryBackend 升级为 L0-L3
4. **KV cache 纪律**：补充工具定义固化+仅追加约束
5. **实测基准**：SWE-bench lite + WideSearch，对标 61% token 缩减

## 核心判断

我们造的是不同层次的轮子。但腾讯的 Context Offloading 和 Mermaid 画布应该吸收——PointerRegistry 如果落地，正好是实现 Context Offloading 的更好方式。
