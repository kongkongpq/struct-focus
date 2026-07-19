// debug-glm.mjs — 直接测 GLM-4 概括质量
const API_KEY = "***REMOVED***.***REMOVED***";
async function callGLM4(prompt, maxTokens = 2048) {
  const r = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: "glm-4-flash", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.2 }),
  });
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Short test: give 2 messages, see what GLM returns
const msgs = [
  "用户: 我们在做一个 OS 项目，主要用 Rust 写内核。目前进程调度器延迟飙升，从 2ms 涨到 80ms。",
  "助手: 排查三点：1) 调度器数据结构——你用链表还是红黑树？2) 抢占点——内核是否有长时间禁抢占的临界区？3) 负载特征——是否 CPU-bound 饥饿了 I/O-bound？"
];

const chunkText = msgs.join("\n\n");
const prompt = `你是一个上下文摘要引擎。请将以下内容概括为结构化记录。

类别: conversation
块 1/1

请按以下格式输出（不要输出额外内容）：

[目标]: 这一段的主题是什么？一句话。
[关键发现]: 最重要的发现或决策（最多 3 条）。
[决策]: 如果有任何明确决策，列出。无则写"无"。
[下一步]: 如果需要后续动作，列出。无则写"无"。

内容:
${chunkText}`;

console.log("=== GLM-4 OUTPUT (short, 2 msgs) ===");
const result = await callGLM4(prompt, 1024);
console.log(result);
console.log();

// Now full conversation
const fullConv = [
  "用户: 我们在做一个 OS 项目，主要用 Rust 写内核。目前的问题是进程调度器在高负载下延迟飙升，平均响应时间从 2ms 涨到 80ms。你有什么建议？",
  "助手: 调度延迟从 2ms 到 80ms 是 40 倍的退化。先排查三点：1) 调度器数据结构——你在用链表还是红黑树？2) 抢占点——内核是否有长时间禁抢占的临界区？3) 负载特征——是否 CPU-bound 进程饥饿了 I/O-bound 进程？需要看你的 scheduler.rs 具体实现。",
  "用户: 用的是链表遍历 O(n) 找最高优先级任务，进程数大概 200 个。抢占是关中断实现的，临界区最大约 15μs。",
  "助手: O(n) 遍历 200 进程是主因。每次调度都要扫描全部——200×比较=高开销。建议：换成二叉堆（BinaryHeap），O(log n) 插入/弹出。Linux 的 CFS 用红黑树，但你 200 进程的规模二叉堆足够了，实现也更简单。",
  "用户: 二叉堆方案写好了，现在延迟恢复到 ~5ms。但另一个问题：iowait 时 CPU 利用率只有 30%，感觉调度器在空转。",
  "助手: 这是个经典问题——没有可运行进程时调度器在 idle loop 里 spin。你需要 WFI/WFE 指令（ARM）或 HLT（x86），让 CPU 进低功耗态等中断唤醒。实现 idle 任务：当 runqueue 为空，调度器切换到 idle task，idle task 执行 hlt 指令，中断处理程序 enqueue 新进程后唤醒。",
  "用户: idle task 加好了，CPU 功耗降了 40%。现在想加多核支持——SMP 调度器怎么设计？",
  "助手: SMP 核心：1) Per-CPU runqueue（避免全局锁竞争）；2) 负载均衡——定期（每 tick 或 idle 时）把任务从忙核迁移到闲核；3) 亲和性——尽量保持同一进程在同一核上运行，利用 L1/L2 缓存热度；4) IPI（核间中断）——当 B 核需要抢占 A 核上运行的进程时发 IPI。建议先实现 per-CPU runqueue + 简单 push/pull 负载均衡。",
  "用户: per-CPU runqueue 写了一半，遇到死锁——CPU0 持有自己的 runqueue 锁，同时想 steal CPU1 的任务，但 CPU1 也在 steal CPU0 的任务。",
  "助手: 经典的 ABBA 死锁。标准解法：1) 按 CPU id 排序加锁——总是先锁编号小的 CPU 的 runqueue；2) 或者用 try_lock——steal 失败就跳过这个 CPU，下次再试；3) Linux 的做法是 work-stealing 只从一个方向拿（idle CPU 主动从 busiest CPU 拿），busy CPU 不会去 steal。方案 1 最直接，你试试？",
  "用户: 好了，死锁解决。现在在做内存管理——实现了 buddy allocator，但外部碎片严重，分配 64 页连续内存经常失败。",
  "助手: Buddy allocator 在 64 页（256KB）大块分配时碎片是主要痛点。两个方向：1) 避免大块分配——用分页 + MMU 映射，让进程看到连续虚拟地址，物理页不需要连续；2) 如果必须物理连续——加入 compaction（内存压缩），把已分配页移动到一端，在另一端腾出大块连续空间。但 compaction 需要暂停访问那些页的进程，复杂度高。建议先做方案 1：实现页表映射，让 buddy allocator 只分配 order 0-3 的小块。",
  "用户: 实现了页表映射，大块分配问题解决了。现在最后的问题：文件系统——想要一个简单的日志文件系统，类似 ext3 的思路。",
  "助手: 简化版 JFS 设计：1) 超级块（superblock）— 魔数、块大小、日志区域位置；2) 日志区域——循环缓冲，先写日志再写实际位置（write-ahead logging）；3) 三步：Journal Write → Journal Commit → Checkpoint。崩溃恢复：重放已提交但未 checkpoint 的日志条目。最小实现只需要三个数据结构：superblock、journal header、transaction block。先写 mkfs 工具初始化磁盘镜像。",
];

console.log("=== GLM-4 OUTPUT (full, 14 msgs) ===");
const fullPrompt = `你是一个上下文摘要引擎。请将以下内容概括为结构化记录。

类别: conversation
块 1/1

请按以下格式输出（不要输出额外内容）：

[目标]: 这一段的主题是什么？一句话。
[关键发现]: 最重要的发现或决策（最多 3 条）。
[决策]: 如果有任何明确决策，列出。无则写"无"。
[下一步]: 如果需要后续动作，列出。无则写"无"。

内容:
${fullConv.join("\n\n")}`;

const r2 = await callGLM4(fullPrompt, 2048);
console.log(r2);
