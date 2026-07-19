# Hardcore v2 Benchmark Report
> glm-4-flash @ https://open.bigmodel.cn/api/paas/v4 | 2026-07-18T09:15:25.187Z

## 1. NIAH (20 cells, 10 needles, 3 semantic distractors)
- Baseline: 13/20
- ContextManager: 20/20
- Wins: 7

## 2. DocQA (750K chars, answer at 35%)
- Answer in BL window: NO (test valid ✅)
- BL: 根据您提供的信息，以下是对这次安全事件的初步分析：

**根本原因**：

*   **Apache Log4j 2.x 远程代码执行漏洞 (CVE-2021-44228)**: 这是导致此次安全事件的主要原因。Apache Log4j 是一个广泛使用的开源日志记录框架，该漏洞允许攻击者通过精心构造的日志消息执行远程代码。

**CVE 编号**：

*   CVE-2021-44228

**受影响系统**：

*   **Apache Log4j 2.x**：所有版本都受影响，包括 2.0-beta9 到 2.15.0。
*   **使用 Apache Log4j 2.x 的系统**：由于 Log4j 的广泛应用，几乎任何使用该库的系统都可能受到影响，包括服务器、应用程序和云服务。

**其他信息**：

*   **攻击者可以利用此漏洞执行任意代码，窃取敏感信息，甚至控制受影响系统*
- CM: 根据文档中的信息，这次安全事件的根本原因是：

- **根本原因**：SSH MaxAuthTries 设置为默认值 30，允许暴力破解。
- **CVE编号**：CVE-2026-88421。
- **受影响系统**：jump-prod-01 (10.240.3.17)。

文档中提到的受影响系统是 jump-prod-01，但没有列出其他具体受影响的系统。

## 3. Multi-hop (30 sessions × 80 noise, temporal contradictions)
- Total chars: 290K
- Recalled: undefined
- BL: 1. **最终消息队列**：Pulsar v3.2。项目初期计划使用 RabbitMQ，但在后续讨论中改为使用 Pulsar，因为它更适合 Atlas 的 SaaS 多客户模式。

2. **推理框架和模型**：推理框架为 vLLM v0.6.3，模型为 Qwen2.5-72B-GPTQ-Int4。最初考虑使用 TGI，但最终选择了 vLLM，因为它在性能测试中表现更优。

3. **最终预算金额（¥）**：¥8,200,000。这个预算包括了 GPU、云服务、人力成本等。

4. **出现过的安全漏洞**：项目记录了两个安全漏洞，分别是 7 月 3 日发现的 1 个 XSS（反射型）和 1 个 SSRF，CVSS 评分分别为 6.5 和 7.8。这两个漏洞在 48 小时内得到了修复，CISO 确认没有数据泄露。

5. **GA 日期**：2027-01-15。项目计划在 2027 年 1 月 15 日正式发布。

6. **数据库栈包含的产品**：
   - **主数据库**：PostgreSQL 16（OLTP）
   - **分析数据库**：ClickHouse 24.3（OL
- CM: 1. **最终消息队列**：Pulsar v3.2。之前项目讨论中曾考虑使用 RabbitMQ 和 Kafka，但最终选择了 Pulsar，因为它更适合 Atlas 的 SaaS 多客户模式。

2. **推理框架和模型**：推理框架为 vLLM v0.6.3，模型为 Qwen2.5-72B-GPTQ-Int4。

3. **最终预算金额（¥）**：¥8,200,000。这个预算包括了 GPU、云服务、人力成本等。

4. **出现过的安全漏洞**：项目记录中提到了两个安全漏洞，分别是 7 月 3 日发现的 1 个 XSS（反射型）和 1 个 SSRF，CVSS 评分分别为 6.5 和 7.8。

5. **GA 日期**：2027-01-15。

6. **数据库栈包含的产品**：最终确定的数据库栈包括 PostgreSQL 16（OLTP）、ClickHouse 24.3（OLAP）、Redis 7.2（Cache/Session）和 Elasticsearch 8.14（Search）。MongoDB 在最终确认时已被完全移除。

## Cost
- In: 495,944 Out: 679
- Total: 496,623 tokens, ≈ 0.9932 CNY (est)