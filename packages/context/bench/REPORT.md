# 上下文引擎验收基准报告（Gap 6）

- 生成时间：2026-07-15T12:16:42.255Z
- A 组：朴素基线（仅追加 + 单条硬截断，无主动管理 / 无 focus / 无 recall）
- B 组：上下文引擎（每步 autoManage + 实例 taskContext，引擎主动接管）
- 阈值：Phase 0 要求 B 组峰值 token 相对 A 组下降 ≥ 15%

## 汇总

- 平均峰值 token 下降：**27.7%**
- 全部任务 B 组 focus 命中率 = 100%：✅
- 全部任务 B 组 recall 命中率 = 100%：✅
- Phase 0 验收（≥15% 下降）：✅ 通过

## 逐任务明细

| 任务 | A 峰值tok | B 峰值tok | 下降% | B focus命中 | B recall命中 | B 注意力浪费% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| focus-recall-manager | 6558 | 4926 | 24.9 | 1/1 | 1/1 | 100.0 |
| focus-recall-budget | 6964 | 5014 | 28.0 | 1/1 | 1/1 | 100.0 |
| focus-recall-explorer | 6227 | 4349 | 30.2 | 1/1 | 1/1 | 100.0 |

## 说明

- 峰值 token 取每步 D-Context token 的最大值；B 组在每步 autoManage 后计量（已驱逐/压缩），A 组在每步追加后计量（无管理）。
- focus 命中率比对 B 组最终 D-Context（focus 文件受保护，稳定保留）；recall 命中率判定 B 组在运行期间曾自动召回并注入该记忆（紧凑预算下该 observation 可能被后续驱逐，但「引擎主动 recall」已发生）。A 组无 focus/recall 故为 0。
- 噪声 observation 模拟调试日志，朴素基线全部保留，引擎按低价值评分驱逐，故 B 组峰值显著低于 A 组。
- 「任务成功率」在本基准中以 focus/recall 命中率作为代理指标；真实编码成功率需 Phase 3 接 LLM 驱动后另测。