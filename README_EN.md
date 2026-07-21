# StructFocus

> **Context-as-a-Tool MCP server** — long-context attention management for any agent host (Claude Code / Cursor / Cline) in three lines of `mcp.json`.
>
> LLM context attention management. ≈ the context half of MemGPT/Letta, minus the agent framework, plus community-standard benchmarks.

In long conversations most agents silently drop the earliest messages (FIFO truncation). StructFocus takes a different path: **don't drop — just don't keep it in front of you all the time** — summarize → capsule → pointer → recall.

## Why

FIFO truncation loses information permanently. On a 160-turn conversation, plain FIFO keeps only ~33% of injected topics in context; StructFocus keeps **100%** by compressing idle context into capsules and recalling it on demand.

Long-context recall rate (whether an injected topic survives in context):

| Turn | FIFO | StructFocus |
|:---:|:---:|:---:|
| 20–80 | 100% | 100% |
| 160 | 33% | **100%** |

NIAH ("needle in a haystack"): see `packages/context/bench/hardcore.ts` — a 20×20 hard grid with semantic distractors, reproducible locally.

## 30-Second Quickstart

Any MCP-capable client can register it in `mcp.json` — no framework source changes:

```json
{
  "mcpServers": {
    "structfocus": {
      "command": "npx",
      "args": ["-y", "@structfocus/mcp"],
      "env": {
        "STRUCT_LLM_API_KEY": "sk-xxx",
        "STRUCT_LLM_BASE_URL": "https://api.deepseek.com/v1",
        "STRUCT_LLM_MODEL": "deepseek-chat"
      }
    }
  }
}
```

Once connected, the agent can call 8 context tools (see below). LLM compression is **optional** — without a key it runs a deterministic fallback (head/tail truncation, free but coarse).

Configure any OpenAI-compatible API with three env vars:

| Env var | Description | Default |
|:---|:---|:---|
| `STRUCT_LLM_API_KEY` | API key (required for LLM summaries) | — |
| `STRUCT_LLM_BASE_URL` | API base URL | `https://api.openai.com/v1` |
| `STRUCT_LLM_MODEL` | Model name | `gpt-4o-mini` |

## Architecture

Four-layer hot/cold pipeline. Active conversation stays hot; idle context is progressively compressed and pushed to disk, recalled only when queried.

```
                         ┌─────────────────────────────────────────┐
                         │            LLM Input Window              │
                         │  ┌───────────────────────────────────┐  │
   user/assistant  ─────▶ │  │ L1 System · L2 Task/Focus · L3 Hist│  │
                         │  └───────────────────────────────────┘  │
                         └───────────────┬───────────────┬──────────┘
                                         │ evict/compress│ recall
                                         ▼               ▲
        ┌────────────────────────────────────────┐   ┌─────────────────────────┐
        │ L4 Capsule (semantic summary)           │   │ ContentStore (BM25 disk) │
        │  - chunkBySemantic → summarize → capsule│   │  - evicted/truncated text │
        │  - expand:context("<id>") to restore    │   │  - recall by keyword/semantic│
        └────────────────────────────────────────┘   └─────────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────────┐
                              │ L5 Pointer (lightweight)  │
                              │  - "[已打包至胶囊 x]"      │
                              └──────────────────────────┘
```

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full design.

## MCP Tools

| Tool | Purpose |
|:---|:---|
| `context_inject` | Inject a context item (dialogue / tool output / log) |
| `context_recall` | Semantically recall historical context by natural language |
| `context_status` | Full engine status (tokens / capsules / active entries / disk / LLM health / policy) |
| `context_forget` | Forget (unload) a specified context |
| `context_focus` | Pin a file/directory into the working context |
| `context_set_policy` | Hot-update management policy (e.g. `{ "conservative": true }`) |
| `context_stats` | Compact status snapshot (for a quick glance after each call) |
| `context_search` | Full-text keyword search over historical content (ContentStore) |

## Benchmarks

| Benchmark | What it proves | Key needed? | Report |
|:---|:---|:---:|:---|
| NIAH (hardcore grid) | Needle-in-haystack over long context | optional | `bench/LOCOMO_REPORT.md` |
| BM25 search precision | BM25 vs simple `includes` (P@5/R@5) | **no** | [docs/benchmarks/bm25-precision.md](./docs/benchmarks/bm25-precision.md) |
| LoCoMo long-dialog | Multi-turn recall + temporal (Cat2) reasoning | yes | `bench/LOCOMO_REPORT.md` |
| Multi-hop QA (1.3) | Cross-document reasoning | yes | pending |
| DocQA 750K (1.4) | Long-document Q&A | yes | pending |

Run the local (no-key) BM25 benchmark:

```bash
pnpm bench:bm25
```

## Install & Build

```bash
pnpm install
pnpm build      # tsc -b (context → dist)
pnpm test       # vitest run (context 167 + mcp 16 = 183 cases)
pnpm lint       # eslint packages/context/src packages/mcp/src
```

Requirements:

- **Node >= 22.6.0** (the MCP server runs TypeScript directly via `node --experimental-strip-types`; earlier versions cannot start `@structfocus/mcp`)
- pnpm >= 9 (for development)

Local MCP server (stdio):

```bash
cd packages/mcp
node --experimental-strip-types ./src/index.ts
```

## License

[Apache-2.0](./LICENSE)
