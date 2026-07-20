# StructAgent ContextManager Benchmark Report
> 2026-07-20T08:02:07.261Z

## 1. Needle-in-Haystack (gkamradt NIAH)
- Baseline: 10/12 (83%)
- ContextManager: 12/12 (100%)
- Wins (CM rescued): 2

## 2. LongMemEval (Cross-Session Memory)
- Sessions: 10
- Recalled facts: 9
- Baseline answer: 1. 项目 A 的生产数据库名称是 'payroll_prod_v3'。

2. 项目 A 的数据库从 PostgreSQL 14 升级到 PostgreSQL 16。

3. 项目 A 的 CI/CD 平台是 Jenkins，但已经迁移到 GitHub Actions。

4. 安全审计发现了 3 处高危漏洞。

5. API key 轮换策略是每 90 天轮换一次，轮换脚本位于 scripts/rotate_keys.sh。

6. 项目 A 的 Redis 缓存策略是 Write-Through。
- CM answer:       1. 项目 A 的生产数据库名称是 'payroll_prod_v3'。
2. 项目 A 的数据库从 PostgreSQL 14 升级到 PostgreSQL 16。
3. 项目 A 的 CI/CD 平台从 Jenkins 迁移到了 GitHub Actions。
4. 安全审计发现了 3 处高危漏洞。
5. API key 轮换策略是所有 API key 需每 90 天轮换一次，轮换脚本位于 scripts/rotate_keys.sh。
6. 项目 A 的 Redis 缓存策略是 Write-Through。

## 3. MemGPT Document QA (Over-Window Analysis)
- downgraded: 111 entries
- Window usage: 4%
- Baseline answer: Enterprise Edition 的年费调整后是 ¥129,800。
- CM answer:       我不知道。文档中没有提供关于 Enterprise Edition 年费调整后的具体金额信息。

## Cost Estimate
- ≈ 0.3395 CNY (est)

# Needle-in-Haystack Report (gkamradt NIAH aligned)

| Context Length | Depth | Baseline | ContextManager | Result |
| --- | --- | ---: | ---: | --- |
| 4K (~4K tokens) | Start (0%) | ✅ | ✅ | ✅ |
| 4K (~4K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 4K (~4K tokens) | End (100%) | ✅ | ✅ | ✅ |
| 16K (~16K tokens) | Start (0%) | ❌ | ✅ | 🏆 WIN |
| 16K (~16K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 16K (~16K tokens) | End (100%) | ✅ | ✅ | ✅ |
| 32K (~32K tokens) | Start (0%) | ❌ | ✅ | 🏆 WIN |
| 32K (~32K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 32K (~32K tokens) | End (100%) | ✅ | ✅ | ✅ |
| 64K (~64K tokens) | Start (0%) | ✅ | ✅ | ✅ |
| 64K (~64K tokens) | Middle (50%) | ✅ | ✅ | ✅ |
| 64K (~64K tokens) | End (100%) | ✅ | ✅ | ✅ |

**Baseline**: 10/12 (83%)
**ContextManager**: 12/12 (100%)
**Wins** (baseline miss → CM hit): 2


## Token Usage
- Input:  169,412
- Output: 327
- Total:  169,739
- Cost:   ≈ 0.3395 CNY (est)
