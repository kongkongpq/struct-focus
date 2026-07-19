// 验收基准：报告格式化（Gap 6）
import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchResult } from "./types.js";

export function formatReport(results: BenchResult[]): string {
  const lines: string[] = [];
  lines.push("# 上下文引擎验收基准报告（Gap 6）");
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- A 组：朴素基线（仅追加 + 单条硬截断，无主动管理 / 无 focus / 无 recall）`);
  lines.push(`- B 组：上下文引擎（每步 autoManage + 实例 taskContext，引擎主动接管）`);
  lines.push(`- 阈值：Phase 0 要求 B 组峰值 token 相对 A 组下降 ≥ 15%`);
  lines.push("");

  const avgReduction = results.reduce((s, r) => s + r.peakReductionPct, 0) / Math.max(1, results.length);
  const allFocus = results.every((r) => r.groupB.focusHitRate === 1);
  const allRecall = results.every((r) => r.groupB.recallHitRate === 1);
  lines.push(`## 汇总`);
  lines.push("");
  lines.push(`- 平均峰值 token 下降：**${avgReduction.toFixed(1)}%**`);
  lines.push(`- 全部任务 B 组 focus 命中率 = 100%：${allFocus ? "✅" : "❌"}`);
  lines.push(`- 全部任务 B 组 recall 命中率 = 100%：${allRecall ? "✅" : "❌"}`);
  lines.push(`- Phase 0 验收（≥15% 下降）：${avgReduction >= 15 ? "✅ 通过" : "❌ 未达标"}`);
  lines.push("");

  lines.push("## 逐任务明细");
  lines.push("");
  lines.push("| 任务 | A 峰值tok | B 峰值tok | 下降% | B focus命中 | B recall命中 | B 注意力浪费% |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of results) {
    const waste = (r.groupB.attentionWasteRatio * 100).toFixed(1);
    lines.push(
      `| ${r.taskId} | ${r.groupA.peakDataTokens} | ${r.groupB.peakDataTokens} | ${r.peakReductionPct.toFixed(1)} | ` +
        `${r.groupB.focusHits}/${r.groupB.focusTotal} | ${r.groupB.recallHits}/${r.groupB.recallTotal} | ${waste} |`,
    );
  }
  lines.push("");
  lines.push("## 说明");
  lines.push("");
  lines.push(
    "- 峰值 token 取每步 D-Context token 的最大值；B 组在每步 autoManage 后计量（已驱逐/压缩），A 组在每步追加后计量（无管理）。",
  );
  lines.push(
    "- focus 命中率比对 B 组最终 D-Context（focus 文件受保护，稳定保留）；recall 命中率判定 B 组在运行期间曾自动召回并注入该记忆（紧凑预算下该 observation 可能被后续驱逐，但「引擎主动 recall」已发生）。A 组无 focus/recall 故为 0。",
  );
  lines.push(
    "- 噪声 observation 模拟调试日志，朴素基线全部保留，引擎按低价值评分驱逐，故 B 组峰值显著低于 A 组。",
  );
  lines.push(
    "- 「任务成功率」在本基准中以 focus/recall 命中率作为代理指标；真实编码成功率需 Phase 3 接 LLM 驱动后另测。",
  );
  return lines.join("\n");
}

/** 将报告写入指定路径（若父目录不存在则创建） */
export function writeReport(results: BenchResult[], outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, formatReport(results), "utf-8");
}
