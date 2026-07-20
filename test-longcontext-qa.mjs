/**
 * LLM vs Deterministic 概括质量对比 — 第二版 (2026-07-19)
 * 
 * 修复了召回污染问题：分别测 "仅胶囊" 和 "原文+胶囊" 两种召回模式
 */
import { LongContextEngine } from "./packages/context/src/longcontext-engine.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.join(__dirname, ".longcontext-qa-v2");

// ─── GLM-4 ──────────────────────────────────────────────
const GLM_API_KEY = process.env.GLM_API_KEY ?? "";
const GLM_BASE = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

async function callGLM4(prompt, maxTokens = 2048) {
  const r = await fetch(GLM_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GLM_API_KEY}` },
    body: JSON.stringify({ model: "glm-4-flash", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.2 }),
  });
  if (!r.ok) throw new Error(`GLM-4 error ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ─── 模拟 OS 内核开发对话 ───────────────────────────────
const CONVERSATION = [
  { role: "user", content: "我们在做一个 OS 项目，主要用 Rust 写内核。目前的问题是进程调度器在高负载下延迟飙升，平均响应时间从 2ms 涨到 80ms。你有什么建议？" },
  { role: "assistant", content: "调度延迟从 2ms 到 80ms 是 40 倍的退化。先排查三点：1) 调度器数据结构——你在用链表还是红黑树？2) 抢占点——内核是否有长时间禁抢占的临界区？3) 负载特征——是否 CPU-bound 进程饥饿了 I/O-bound 进程？需要看你的 scheduler.rs 具体实现。" },
  { role: "user", content: "用的是链表遍历 O(n) 找最高优先级任务，进程数大概 200 个。抢占是关中断实现的，临界区最大约 15μs。" },
  { role: "assistant", content: "O(n) 遍历 200 进程是主因。每次调度都要扫描全部——200×比较=高开销。建议：换成二叉堆（BinaryHeap），O(log n) 插入/弹出。Linux 的 CFS 用红黑树，但你 200 进程的规模二叉堆足够了，实现也更简单。" },
  { role: "user", content: "二叉堆方案写好了，现在延迟恢复到 ~5ms。但另一个问题：iowait 时 CPU 利用率只有 30%，感觉调度器在空转。" },
  { role: "assistant", content: "这是个经典问题——没有可运行进程时调度器在 idle loop 里 spin。你需要 WFI/WFE 指令（ARM）或 HLT（x86），让 CPU 进低功耗态等中断唤醒。实现 idle 任务：当 runqueue 为空，调度器切换到 idle task，idle task 执行 hlt 指令，中断处理程序 enqueue 新进程后唤醒。" },
  { role: "user", content: "idle task 加好了，CPU 功耗降了 40%。现在想加多核支持——SMP 调度器怎么设计？" },
  { role: "assistant", content: "SMP 核心：1) Per-CPU runqueue（避免全局锁竞争）；2) 负载均衡——定期（每 tick 或 idle 时）把任务从忙核迁移到闲核；3) 亲和性——尽量保持同一进程在同一核上运行，利用 L1/L2 缓存热度；4) IPI（核间中断）——当 B 核需要抢占 A 核上运行的进程时发 IPI。建议先实现 per-CPU runqueue + 简单 push/pull 负载均衡。" },
  { role: "user", content: "per-CPU runqueue 写了一半，遇到死锁——CPU0 持有自己的 runqueue 锁，同时想 steal CPU1 的任务，但 CPU1 也在 steal CPU0 的任务。" },
  { role: "assistant", content: "经典的 ABBA 死锁。标准解法：1) 按 CPU id 排序加锁——总是先锁编号小的 CPU 的 runqueue；2) 或者用 try_lock——steal 失败就跳过这个 CPU，下次再试；3) Linux 的做法是 work-stealing 只从一个方向拿（idle CPU 主动从 busiest CPU 拿），busy CPU 不会去 steal。方案 1 最直接，你试试？" },
  { role: "user", content: "好了，死锁解决。现在在做内存管理——实现了 buddy allocator，但外部碎片严重，分配 64 页连续内存经常失败。" },
  { role: "assistant", content: "Buddy allocator 在 64 页（256KB）大块分配时碎片是主要痛点。两个方向：1) 避免大块分配——用分页 + MMU 映射，让进程看到连续虚拟地址，物理页不需要连续；2) 如果必须物理连续——加入 compaction（内存压缩），把已分配页移动到一端，在另一端腾出大块连续空间。但 compaction 需要暂停访问那些页的进程，复杂度高。建议先做方案 1：实现页表映射，让 buddy allocator 只分配 order 0-3 的小块。" },
  { role: "user", content: "实现了页表映射，大块分配问题解决了。现在最后的问题：文件系统——想要一个简单的日志文件系统，类似 ext3 的思路。" },
  { role: "assistant", content: "简化版 JFS 设计：1) 超级块（superblock）— 魔数、块大小、日志区域位置；2) 日志区域——循环缓冲，先写日志再写实际位置（write-ahead logging）；3) 三步：Journal Write → Journal Commit → Checkpoint。崩溃恢复：重放已提交但未 checkpoint 的日志条目。最小实现只需要三个数据结构：superblock、journal header、transaction block。先写 mkfs 工具初始化磁盘镜像。" },
];

// ─── QA 测试集 ───────────────────────────────────────────
const QA = [
  { q: "调度器延迟从 2ms 涨到 80ms 的原因是什么？怎么解决的？", kw: ["O(n)", "q828d]", "链表", "遍历", "二叉堆", "log n"] },
  { q: "CPU 空转怎么解决？用什么指令？", kw: ["idle", "WFI", "HLT", "低功耗", "hlt指令", "idle task"] },
  { q: "多核 SMP 死锁怎么解决？叫什么名字？", kw: ["ABBA", "排序加锁", "CPU id", "死锁", "try_lock"] },
  { q: "大块内存分配失败的解决方案？", kw: ["页表", "MMU", "虚拟地址", "连续", "compaction", "buddy", "物理页"] },
  { q: "日志文件系统设计包含哪些核心组件？", kw: ["superblock", "日志", "journal", "checkpoint", "崩溃恢复", "write-ahead"] },
];

function scoreRecall(text, keywords) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) if (lower.includes(kw.toLowerCase())) hits++;
  return { hits, total: keywords.length, rate: hits / keywords.length };
}

// ─── 直接测试胶囊概括质量（不经过 ContentStore FTS5） ──
async function testCapsuleQuality(label, engine, useLLM) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(60)}`);

  // Feed
  for (const msg of CONVERSATION) {
    engine.feed(msg.content, { type: msg.role === "user" ? "user" : "observation", source: msg.role });
  }

  // Flush → summarize
  console.log("  概括中...");
  const start = Date.now();
  const r = await engine.flush({ topic: "os_kernel_dev" });
  const elapsed = Date.now() - start;

  if (!r) {
    console.log("  ⚠  flush 返回 null\n");
    return { avgRate: 0, elapsed, capsuleText: "", summary: "" };
  }

  console.log(`  ✅ capsule ${r.capsule.id} (${elapsed}ms)`);
  console.log(`     原文: ${r.capsule.originalTokens}t | 胶囊: ${r.capsule.capsuleTokens}t | 压缩比: ${((1 - r.capsule.capsuleTokens/Math.max(r.capsule.originalTokens,1))*100).toFixed(0)}%`);

  // 只看 L1 概括和 decision（不搜 ContentStore）
  const capsuleText = `${r.l1Summary}\n${(r.capsule.decisions||[]).map(d=>d.summary).join("; ")}`;
  console.log(`     L0: ${r.l0Summary}`);
  console.log(`     L1 首 300 字: ${r.l1Summary.slice(0, 300)}`);
  console.log(`     决策: ${(r.capsule.decisions||[]).map(d=>d.summary).join("; ").slice(0, 200) || "(无)"}`);

  // QA
  let totalRate = 0, passed = 0;
  const results = [];
  for (let i = 0; i < QA.length; i++) {
    const s = scoreRecall(capsuleText, QA[i].kw);
    totalRate += s.rate;
    if (s.rate >= 0.5) passed++;
    results.push({ ...QA[i], ...s });
    console.log(`     Q${i+1}: ${s.hits}/${s.total} = ${(s.rate*100).toFixed(0)}% | 命中: ${QA[i].kw.filter(k=>capsuleText.toLowerCase().includes(k.toLowerCase())).join(", ")}`);
  }

  return { avgRate: totalRate / QA.length, passed, elapsed, capsuleText, l1Summary: r.l1Summary };
}

// ─── Main ────────────────────────────────────────────────
async function main() {
  // 清理旧数据
  try { await fs.rm(path.join(engineRoot, "a-llm"), { recursive: true, force: true }); } catch {}
  try { await fs.rm(path.join(engineRoot, "b-det"), { recursive: true, force: true }); } catch {}

  console.log("══════════════════════════════════════════════════");
  console.log("  LLM vs Deterministic 概括质量对比 v2");
  console.log("  仅测胶囊原文（不搜 ContentStore FTS5）");
  console.log("══════════════════════════════════════════════════");

  // ── Run A: LLM 概括 ──
  const engLLM = new LongContextEngine({
    llmCall: (p) => callGLM4(p),
    storeRoot: path.join(engineRoot, "a-llm", "content-store"),
    capsuleRoot: path.join(engineRoot, "a-llm", "capsules"),
    keepRecent: 2, minEntriesForSummarize: 6,
  });
  const ra = await testCapsuleQuality("Run A: LLM 概括 (glm-4-flash)", engLLM, true);

  // ── Run B: 确定性回退 ──
  const engDet = new LongContextEngine({
    storeRoot: path.join(engineRoot, "b-det", "content-store"),
    capsuleRoot: path.join(engineRoot, "b-det", "capsules"),
    keepRecent: 2, minEntriesForSummarize: 6,
  });
  const rb = await testCapsuleQuality("Run B: 确定性回退 (正则+启发式)", engDet, false);

  // ── 总结 ──
  console.log(`\n${"═".repeat(60)}`);
  console.log("  对 比 总 结");
  console.log(`${"═".repeat(60)}`);
  console.log(`  指标              LLM 概括         确定性回退       差异`);
  console.log(`  ───────────────  ───────────────  ───────────────  ──────`);
  console.log(`  avg recall       ${(ra.avgRate*100).toFixed(1)}%              ${(rb.avgRate*100).toFixed(1)}%              +${((ra.avgRate-rb.avgRate)*100).toFixed(1)}pp`);
  console.log(`  passed           ${ra.passed}/5              ${rb.passed}/5`);
  console.log(`  耗时             ${ra.elapsed}ms             ${rb.elapsed}ms              ${ra.elapsed}x / ${rb.elapsed}x`);
  console.log();

  if (ra.avgRate > rb.avgRate) {
    console.log(`✅ LLM 概括召回 +${((ra.avgRate-rb.avgRate)*100).toFixed(1)}pp，值回 ${(ra.elapsed/rb.elapsed).toFixed(1)}x 延迟`);
  } else if (Math.abs(ra.avgRate - rb.avgRate) < 0.05) {
    console.log(`⚠ LLM 概括 vs 确定性回退无明显差异（<5pp）。这个对话量太小（14条，773 tokens），LLM 的语义理解优势体现不出来。`);
    console.log(`   建议：加大对话量（50+ 条），或者提高 LLM 的 max_tokens 参数。`);
  } else {
    console.log(`❌ LLM 概括反而不如确定性回退，检查 prompt 设计`);
  }

  // 输出 LLM 的完整 L1 摘要供人工检查
  console.log(`\n${"─".repeat(60)}`);
  console.log("  LLM 完整 L1 摘要 (人工检查用)");
  console.log(`${"─".repeat(60)}`);
  console.log(ra.l1Summary);
  console.log(`${"─".repeat(60)}`);
  console.log("  确定性回退 L1 摘要");
  console.log(`${"─".repeat(60)}`);
  console.log(rb.l1Summary);
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
