# StructAgent ContextManager Benchmark Report
> 2026-07-17T13:59:10.100Z

## 1. Needle-in-Haystack (gkamradt NIAH)
- Baseline: 12/12 (100%)
- ContextManager: 12/12 (100%)
- Wins (CM rescued): 0

## 2. LongMemEval (Cross-Session Memory)
- Sessions: 10
- Recalled facts: 9
- Baseline answer: 根据提供的会话记录，全面回答如下：

1. **项目 A 的生产数据库名称是什么？**  
　　`payroll_prod_v3`

2. **项目 A 的数据库从什么版本升级到什么版本？**  
　　从 **PostgreSQL 14** 升级到 **PostgreSQL 16**

3. **项目 A 的 CI/CD 平台是什么？**  
　　已从 **Jenkins** 迁移到 **GitHub Actions**

4. **安全审计发现了几处高危漏洞？**  
　　**3 处高危漏洞**（均为 SQL 注入）

5. **API key 轮换策略是什么？**  
　　所有 API k
- CM answer:       1. 项目 A 的生产数据库名称是 **payroll_prod_v3**。  
2. 项目 A 的数据库从 **PostgreSQL 14** 升级到 **PostgreSQL 16**。  
3. 项目 A 的 CI/CD 平台是 **GitHub Actions**（已从 Jenkins 迁移）。  
4. 安全审计最初发现了 **3 处高危漏洞**（SQL 注入），目前已全部修复。  
5. API key 轮换策略是：**每 90 天轮换一次**，轮换脚本位于 **scripts/rotate_keys.sh**。  
6. 项目 A 的 Redis 缓存策略是 **Write-Th

## 3. MemGPT Document QA (Over-Window Analysis)
- Evicted: 87 entries
- Window usage: 22%
- Baseline answer: ¥129,800
- CM answer:       你不知道。

## Cost Estimate
- ≈ 0.3860 CNY (est)

# Needle-in-Haystack Report (gkamradt NIAH aligned)

| Context Length | Depth | Baseline | ContextManager | Result |
| --- | --- | ---: | ---: | --- |
| 4K (~4K tokens) | Start (0%) | ✅ | ✅ | ✅ |
| 4K (~4K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 4K (~4K tokens) | End (100%) | ✅ | ✅ | ✅ |
| 16K (~16K tokens) | Start (0%) | ✅ | ✅ | ✅ |
| 16K (~16K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 16K (~16K tokens) | End (100%) | ✅ | ✅ | ✅ |
| 32K (~32K tokens) | Start (0%) | ✅ | ✅ | ✅ |
| 32K (~32K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 32K (~32K tokens) | End (100%) | ✅ | ✅ | ✅ |
| 64K (~64K tokens) | Start (0%) | ✅ | ✅ | ✅ |
| 64K (~64K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 64K (~64K tokens) | End (100%) | ✅ | ✅ | ✅ |

**Baseline**: 12/12 (100%)
**ContextManager**: 12/12 (100%)
**Wins** (baseline miss → CM hit): 0


## Token Usage
- Input:  192,634
- Output: 345
- Total:  192,979
- Cost:   ≈ 0.3860 CNY (est)
