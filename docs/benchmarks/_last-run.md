# StructFocus 基准运行报告

> 由 `bench/run.mjs` 生成。统一结果格式见 roadmap 三.1。

| Suite | 状态 | Model | BL | CM | 备注 |
|---|---|---|---|---|---|
| bm25 | ✅ OK | bm25 (deterministic, no LLM) | {"precisionAt5Exact":1,"recallAt5Exact":1,"precisionAt5All":0.8,"recallAt5All":0.8} | {"precisionAt5Exact":1,"recallAt5Exact":1,"precisionAt5All":0.9,"recallAt5All":0.9,"recallAt10ScenarioB":1} | BM25 不劣于 includes（精确 P@5 1 ≥ 1）PASS；场景B 忠实实现 Recall@10≥0.7 = 1.000 PASS。（roadmap 字面 Recall@5≥0.7 在 topK=5/10相关 下数学不可达，已披露） |
| niah | ✅ OK | glm-4-flash | {"accuracy":0} | {"accuracy":1,"recallAt1":1,"recallAt3":1,"recallAt5":1} | BL(朴素截断) 准确率=0，CM(StructFocus 压缩+召回) 准确率=1；recall@1/3/5=1/1/1。GLM=glm-4-flash。 |
| multihop | ✅ OK | glm-4-flash | {"accuracy":0} | {"accuracy":0.75,"recallAt1":1,"recallAt3":1,"recallAt5":1} | BL(朴素截断) 多跳准确率=0，CM(StructFocus 压缩+召回)=0.75；recall@1/3/5=1/1/1。GLM=glm-4-flash。 |
| docqa | ✅ OK | glm-4-flash | {"accuracy":0} | {"accuracy":1,"recallAt1":1,"recallAt3":1,"recallAt5":1} | BL(朴素截断) 长文档准确率=0，CM(StructFocus 压缩+召回)=1；recall@1/3/5=1/1/1。GLM=glm-4-flash。 |

## bm25 — bm25 (deterministic, no LLM)

### Baseline (includes substring)

```json
{
  "method": "100 条模拟被驱逐条目（20 主题簇×5）+ 20 查询（16 精确 + 4 同义模糊）；对比 BM25 与 includes 子串匹配。",
  "rows": [
    {
      "q": "协程调度框架",
      "fuzzy": true,
      "gold": "rust_async",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    },
    {
      "q": "K8sHPA Kubernetes 自动扩缩容",
      "fuzzy": false,
      "gold": "k8s_hpa",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "PgPartition PostgreSQL 分区表",
      "fuzzy": false,
      "gold": "pg_partition",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "主从复制拓扑",
      "fuzzy": true,
      "gold": "redis_cluster",
      "bm25": {
        "p": 0,
        "r": 0
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    },
    {
      "q": "GrpcStream gRPC 流式",
      "fuzzy": false,
      "gold": "grpc_stream",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "VecDBHNSW 向量数据库 HNSW",
      "fuzzy": false,
      "gold": "vec_hnsw",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "外部知识库问答",
      "fuzzy": true,
      "gold": "rag_embed",
      "bm25": {
        "p": 0,
        "r": 0
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    },
    {
      "q": "OpenTelTrace 可观测链路追踪",
      "fuzzy": false,
      "gold": "otel_trace",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "EdgeCache 边缘 CDN 缓存",
      "fuzzy": false,
      "gold": "edge_cdn",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "KafkaStream Kafka 流处理",
      "fuzzy": false,
      "gold": "kafka_stream",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "WasmEdge WebAssembly 边缘",
      "fuzzy": false,
      "gold": "wasm_edge",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "GraphQLFed GraphQL 联邦",
      "fuzzy": false,
      "gold": "graphql_fed",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "SQLiteFTS SQLite 全文检索",
      "fuzzy": false,
      "gold": "sqlite_fts",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "JwtAuth JWT 鉴权",
      "fuzzy": false,
      "gold": "jwt_auth",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "BloomFilter 布隆过滤器",
      "fuzzy": false,
      "gold": "bloom_filter",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "CrcChecksum CRC 校验",
      "fuzzy": false,
      "gold": "crc_checksum",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "QuicTp QUIC 传输",
      "fuzzy": false,
      "gold": "quic_tp",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "CAPTradeoff CAP 定理权衡",
      "fuzzy": false,
      "gold": "cap_tradeoff",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "SnowflakeId 雪花算法 ID",
      "fuzzy": false,
      "gold": "snowflake_id",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "缓存淘汰策略",
      "fuzzy": true,
      "gold": "lru_evict",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    }
  ],
  "aggregate": {
    "exactN": 16,
    "bm25": {
      "pExact": 1,
      "rExact": 1
    },
    "includes": {
      "pExact": 1,
      "rExact": 1
    }
  },
  "scenarioB": {
    "relCount": 10,
    "bm25": {
      "r5": 1,
      "r10": 1
    },
    "includes": {
      "r5": 1,
      "r10": 1
    },
    "passRecallAt10": true
  },
  "passRecallAt5Exact": true,
  "passPrecisionAt5ExactVsIncludes": true
}
```

### StructFocus (StructFocus BM25)

```json
{
  "method": "100 条模拟被驱逐条目（20 主题簇×5）+ 20 查询（16 精确 + 4 同义模糊）；对比 BM25 与 includes 子串匹配。",
  "rows": [
    {
      "q": "协程调度框架",
      "fuzzy": true,
      "gold": "rust_async",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    },
    {
      "q": "K8sHPA Kubernetes 自动扩缩容",
      "fuzzy": false,
      "gold": "k8s_hpa",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "PgPartition PostgreSQL 分区表",
      "fuzzy": false,
      "gold": "pg_partition",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "主从复制拓扑",
      "fuzzy": true,
      "gold": "redis_cluster",
      "bm25": {
        "p": 0,
        "r": 0
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    },
    {
      "q": "GrpcStream gRPC 流式",
      "fuzzy": false,
      "gold": "grpc_stream",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "VecDBHNSW 向量数据库 HNSW",
      "fuzzy": false,
      "gold": "vec_hnsw",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "外部知识库问答",
      "fuzzy": true,
      "gold": "rag_embed",
      "bm25": {
        "p": 0,
        "r": 0
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    },
    {
      "q": "OpenTelTrace 可观测链路追踪",
      "fuzzy": false,
      "gold": "otel_trace",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "EdgeCache 边缘 CDN 缓存",
      "fuzzy": false,
      "gold": "edge_cdn",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "KafkaStream Kafka 流处理",
      "fuzzy": false,
      "gold": "kafka_stream",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "WasmEdge WebAssembly 边缘",
      "fuzzy": false,
      "gold": "wasm_edge",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "GraphQLFed GraphQL 联邦",
      "fuzzy": false,
      "gold": "graphql_fed",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "SQLiteFTS SQLite 全文检索",
      "fuzzy": false,
      "gold": "sqlite_fts",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "JwtAuth JWT 鉴权",
      "fuzzy": false,
      "gold": "jwt_auth",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "BloomFilter 布隆过滤器",
      "fuzzy": false,
      "gold": "bloom_filter",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "CrcChecksum CRC 校验",
      "fuzzy": false,
      "gold": "crc_checksum",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "QuicTp QUIC 传输",
      "fuzzy": false,
      "gold": "quic_tp",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "CAPTradeoff CAP 定理权衡",
      "fuzzy": false,
      "gold": "cap_tradeoff",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "SnowflakeId 雪花算法 ID",
      "fuzzy": false,
      "gold": "snowflake_id",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 1,
        "r": 1
      }
    },
    {
      "q": "缓存淘汰策略",
      "fuzzy": true,
      "gold": "lru_evict",
      "bm25": {
        "p": 1,
        "r": 1
      },
      "includes": {
        "p": 0,
        "r": 0
      }
    }
  ],
  "aggregate": {
    "exactN": 16,
    "bm25": {
      "pExact": 1,
      "rExact": 1
    },
    "includes": {
      "pExact": 1,
      "rExact": 1
    }
  },
  "scenarioB": {
    "relCount": 10,
    "bm25": {
      "r5": 1,
      "r10": 1
    },
    "includes": {
      "r5": 1,
      "r10": 1
    },
    "passRecallAt10": true
  },
  "passRecallAt5Exact": true,
  "passPrecisionAt5ExactVsIncludes": true
}
```

> BM25 不劣于 includes（精确 P@5 1 ≥ 1）PASS；场景B 忠实实现 Recall@10≥0.7 = 1.000 PASS。（roadmap 字面 Recall@5≥0.7 在 topK=5/10相关 下数学不可达，已披露）

## niah — glm-4-flash

### Baseline (naive FIFO truncation)

```
{"code":"GLF-7734","correct":false,"answer":"无法提供访问授权码，未提供相关信息。"}
{"code":"X9-OMEGA-22","correct":false,"answer":"无明确代号"}
{"code":"TKN-5510-B","correct":false,"answer":"无法提供内部票据 ID，信息不足。"}
```

### StructFocus (StructFocus compress+recall)

```
{"code":"GLF-7734","correct":true,"recall":{"total":1,"hit1":true,"hit3":true,"hit5":true},"answer":"GLF-7734"}
{"code":"X9-OMEGA-22","correct":true,"recall":{"total":5,"hit1":true,"hit3":true,"hit5":true},"answer":"X9-OMEGA-22"}
{"code":"TKN-5510-B","correct":true,"recall":{"total":5,"hit1":true,"hit3":true,"hit5":true},"answer":"TKN-5510-B"}
```

> BL(朴素截断) 准确率=0，CM(StructFocus 压缩+召回) 准确率=1；recall@1/3/5=1/1/1。GLM=glm-4-flash。

## multihop — glm-4-flash

### Baseline (naive FIFO truncation)

```
{"q":"Apollo 团队的技术负责人还负责哪个组？","correct":false,"answer":"无法确定。"}
{"q":"数据平台组本季度的延迟目标是多少？","correct":false,"answer":"未提供具体延迟目标数据。"}
{"q":"支付网关由哪个团队负责？其技术负责人是谁？","correct":false,"answer":"无法确定。"}
{"q":"张明担任架构师的组，本季度目标是什么？","correct":false,"answer":"本季度目标是提升可观测性。"}
```

### StructFocus (StructFocus compress+recall)

```
{"q":"Apollo 团队的技术负责人还负责哪个组？","correct":false,"recall":{"total":1,"hit1":true,"hit3":true,"hit5":true},"answer":"无相关信息。"}
{"q":"数据平台组本季度的延迟目标是多少？","correct":true,"recall":{"total":5,"hit1":true,"hit3":true,"hit5":true},"answer":"200ms以内"}
{"q":"支付网关由哪个团队负责？其技术负责人是谁？","correct":true,"recall":{"total":1,"hit1":true,"hit3":true,"hit5":true},"answer":"支付网关由团队 Apollo 负责，技术负责人是张明。"}
{"q":"张明担任架构师的组，本季度目标是什么？","correct":true,"recall":{"total":5,"hit1":true,"hit3":true,"hit5":true},"answer":"降低实时 pipeline 的端到端延迟至 200ms 以内。"}
```

> BL(朴素截断) 多跳准确率=0，CM(StructFocus 压缩+召回)=0.75；recall@1/3/5=1/1/1。GLM=glm-4-flash。

## docqa — glm-4-flash

### Baseline (naive FIFO truncation)

```
{"q":"网关层的全局限流阈值是多少？","correct":false,"answer":"未提供相关信息。"}
{"q":"订单表按什么维度分库？一共分了多少库？","correct":false,"answer":"未提供订单表分库维度及库数量信息。"}
{"q":"交易系统双活机房部署在哪两个城市？","correct":false,"answer":"无法确定。"}
{"q":"核心交易链路的 P99 目标延迟是多少？","correct":false,"answer":"未提供相关信息。"}
```

### StructFocus (StructFocus compress+recall)

```
{"q":"网关层的全局限流阈值是多少？","correct":true,"recall":{"total":1,"hit1":true,"hit3":true,"hit5":true},"answer":"5000 QPS"}
{"q":"订单表按什么维度分库？一共分了多少库？","correct":true,"recall":{"total":1,"hit1":true,"hit3":true,"hit5":true},"answer":"按 user_id 哈希分库，共分 64 库。"}
{"q":"交易系统双活机房部署在哪两个城市？","correct":true,"recall":{"total":1,"hit1":true,"hit3":true,"hit5":true},"answer":"上海与深圳。"}
{"q":"核心交易链路的 P99 目标延迟是多少？","correct":true,"recall":{"total":1,"hit1":true,"hit3":true,"hit5":true},"answer":"150毫秒"}
```

> BL(朴素截断) 长文档准确率=0，CM(StructFocus 压缩+召回)=1；recall@1/3/5=1/1/1。GLM=glm-4-flash。
