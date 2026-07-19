// 验收基准：类型定义（Gap 6）
//
// 离线 A/B 基准：A 组=朴素基线（仅追加 + 单条硬截断，无主动管理/无 focus/无 recall）；
// B 组=上下文引擎（每步 autoManage + 实例 taskContext，引擎主动接管）。
// 用确定性 mock 工作负载驱动，量化 Phase 0/1 验收指标。

export interface BenchTask {
  /** 任务 id */
  id: string;
  /** 任务描述（作为 user 种子消息） */
  description: string;
  /** 真实存在的语料文件（用于 focus 与模拟 tool 输出） */
  corpusFile: string;
  /** 引擎应自动 focus 的文件（ground truth，用于 focus 命中率） */
  expectedFocusFiles: string[];
  /** 引擎应自动 recall 的记忆内容（ground truth，用于 recall 命中率） */
  expectedMemory: string;
  /** 每步的 currentSymbols（驱动 auto-recall 查询） */
  currentSymbols: string[];
  /** 模拟的 agent 循环步数 */
  steps: number;
  /** 单条 tool 输出大致字符数（模拟读文件/搜索结果） */
  toolChunkSize: number;
  /** 每步注入的低价值噪声 observation 条数（朴素基线会全部保留，引擎会驱逐） */
  noisePerStep: number;
}

export interface GroupMetrics {
  /** D-Context 峰值 token（每步取 max，验收核心指标） */
  peakDataTokens: number;
  /** 结束时 D-Context token */
  endDataTokens: number;
  /** focus 命中数 */
  focusHits: number;
  /** focus 期望总数 */
  focusTotal: number;
  /** focus 命中率 0..1 */
  focusHitRate: number;
  /** recall 命中数 */
  recallHits: number;
  /** recall 期望总数 */
  recallTotal: number;
  /** recall 命中率 0..1 */
  recallHitRate: number;
  /** 结束时注意力浪费率 0..1（仅 B 组有意义） */
  attentionWasteRatio: number;
}

export interface BenchResult {
  taskId: string;
  groupA: GroupMetrics;
  groupB: GroupMetrics;
  /** 峰值 token 下降百分比 (A-B)/A * 100 */
  peakReductionPct: number;
  /** B 组「有效动作 / 千 token」效率代理 */
  successPerKTokenB: number;
}
