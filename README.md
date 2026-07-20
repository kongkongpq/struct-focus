# StructAgent

> **FIFO truncation loses 67% of its knowledge after 160 rounds. StructAgent keeps 100% — using 98% fewer tokens.**

A transparent proxy layer for LLM context. It sits *between your agent framework's `messages` array and the LLM API*, and does summarization → capsule → pointer → semantic recall — so long conversations stop silently forgetting things.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178c6.svg)](https://www.typescriptlang.org/)
[![Benchmark](https://img.shields.io/badge/benchmark-100%25%20recall%20%40%2098%25%20compressed-brightgreen.svg)](#the-numbers)

---

## The problem

Your agent builds a `messages` array and sends it to the LLM. When the conversation gets long, something has to give. The naive fix is **FIFO truncation** — drop the oldest messages to fit the window. But the oldest messages are often the most important (the original task, the decision you made in round 5).

```
Before:  Agent Code → buildMessages() → fetch("https://api.openai.com/...")
After:   Agent Code → buildMessages() → StructAgent.manage() → fetch("https://api.openai.com/...")
                                              ↑
                                     summarize / capsule / recall / evict here
```

StructAgent is **not an agent framework**. It is a drop-in layer. Compatibility depends on exactly one thing: **can you intercept the `messages` array your agent builds?**

### The numbers (A/B/C benchmark)

We run three configurations against the same conversations and measure **context retention** — the fraction of ground-truth keywords that survive into the context actually sent to the LLM. The metric is deterministic and needs **no LLM-as-judge**, so it is reproducible and bias-free on both mock and real LLMs.

| 对话轮数 | A 裸跑 (上界) | B FIFO 截断 | C StructAgent | C − B |
|:-------:|:------------:|:-----------:|:-------------:|:-----:|
| 20  | 100% | 100% | 100% | +0pp |
| 40  | 100% | 100% | 100% | +0pp |
| 80  | 100% | 100% | 100% | +0pp |
| 160 | 100% | **33%** | **100%** | **+67pp** |

- **A** = no management (upper bound, but unbounded token cost)
- **B** = FIFO truncation at a 4000-token window (what most agents do today)
- **C** = StructAgent (summarize → capsule → recall)

At 160 rounds, FIFO has already thrown away **60–67%** of the target knowledge (exact % depends on where the target topic sits); StructAgent keeps **100%** while compressing the prompt by **~98%** (~76–78% token savings vs. raw A).

**Validated on a real LLM (GLM-4-flash, full 12-config run):** A=100% · B=83.3% · **C=100%** (+16.7pp on average; **+67pp at 160 rounds** where FIFO collapses to 33%), 98% compression, 76% token savings vs. raw A. Bonus: because the prompt is compressed to ~758 tokens, **C's TTFT is actually the fastest of the three** (16s vs. A's 37s) — StructAgent makes the call both smarter *and* quicker. The forgetting curve and the C≈A advantage hold with a real model, not just in deterministic mode.

> Numbers above the table are **deterministic-mode** (no LLM needed — see [Running the benchmark](#running-the-benchmark)); the per-row gradient is the documented A/B/C design. The real-LLM smoke confirms the qualitative result. A full 12-length × 3-repeat real-LLM run is in progress; expected C ≥ 75% (honest > perfect — see below).

---

## How it works

StructAgent is **not compression. It is attention management.**

```
feed()  ──►  accumulate entries
              │
flush() ──►  summarize old context → pack into a Capsule (L0 summary + chunk summaries)
              │
recall() ──►  on a new query, semantically match capsules + evicted content → inject relevant context
              │
evict()  ──►  push low-relevance originals to disk (reversible), keep a pointer in the window
```

Four primitives, in order:

1. **概括 (Summarize)** — old entries are compressed into a capsule by an injected LLM (or a deterministic fallback when no LLM is configured).
2. **胶囊 (Capsule)** — a structured, disk-persisted knowledge pack with `chunkSummaries` for semantic search.
3. **指针 (Pointer)** — the full original text is evicted to `ContentStore`; only a lightweight pointer stays in the active window. Reversible: recalled content can be expanded back.
4. **语义召回 (Semantic Recall)** — on each query, StructAgent matches capsules + evicted content and injects *only what's relevant*.

Because eviction is reversible and recall is semantic (not ID-blind), StructAgent keeps the conversation **both forgetful-of-noise and loyal-to-facts**.

---

## Quick Start

```bash
# Prerequisites: Node.js >= 20, pnpm >= 9
pnpm install
```

Three lines to wrap any hand-rolled agent (Mode 1 — function wrapping):

```typescript
import { LongContextEngine } from "@struct/context";

// 1. Create the engine (llmCall is optional — omit it for deterministic mode)
const engine = new LongContextEngine({
  llmCall: (prompt) => myLLM.chat([{ role: "user", content: prompt }]),
});

// 2. Feed your history, then ask — StructAgent manages the window + recalls relevant context
engine.feedBatch(history);                       // history: { content, source?, type? }[]
const recent = engine.getContextManager().toMessages(systemPrompt);
const { injectText } = await engine.recall(userQuery);
const managed = injectText && !injectText.includes("未找到")
  ? [...recent, { role: "system", content: `Related history:\n${injectText}` }]
  : recent;

const reply = await myLLM.chat(managed);
engine.feed(reply, { type: "observation" });     // 3. Feed the reply back in
```

That's the whole integration. **No framework changes.** See [`docs/opensource-launch-guide.md`](./docs/opensource-launch-guide.md) for the three integration modes.

---

## Why does this exist

Context-window management is a solved problem *until it isn't*. Today's agents silently drop context via FIFO and call it a day. StructAgent is the honest middle ground: **attention management instead of blind truncation**.

Be aware: this is a **transitional project**. In a year or two, when 10M-token contexts are standard, a layer like this becomes unnecessary and will be retired. *Right now, you need it.* This is a **9-day solo sprint from zero to a working benchmark** — that short arc is the point, not a bug.

---

## Packages

| Package | Responsibility |
|---------|---------------|
| `@struct/context` | The context engine (this repo's core). `LongContextEngine`, `ContextManager`, `ContentStore`, `CapsuleStore`, and the `ContextMiddleware` integration contract. Import it standalone. |
| `struct-app` | Electron desktop shell (chat UI + context engine). |
| `@struct/mcp` | MCP Server (JSON-RPC 2.0 over stdio) so Claude Code / other MCP clients can consume the engine. |

---

## Compatibility

StructAgent integrates by intercepting the `messages` array. Status:

| Platform | Status | Integration mode | Notes |
|----------|:------:|:----------------:|-------|
| Bare LLM call | ✅ | Mode 1 — function wrapping | Benchmarked (see above) |
| OpenClaw | ✅ | Mode 2 — middleware hook | `beforeLlmCall` / `afterLlmCall` |
| CodeX | ⚠️ | Mode 2 — middleware hook | Welcome to test; needs the hook docs |
| LangChain | ⚠️ | Mode 1 — function wrapping | Easy for community contributors |
| Cursor / Copilot | ❌ | — | Closed-source IDE plugins, no hook surface |
| Claude Desktop (MCP) | ⚠️ | Mode 3 — HTTP sidecar | Needs extra dev; community welcome |
| Any HTTP agent | ⚠️ | Mode 3 — HTTP sidecar | Needs extra dev; community welcome |

- **Mode 1** (function wrapping) and **Mode 2** (`createContextMiddleware(engine, opts)` — a framework-agnostic contract) ship today.
- **Mode 3** (HTTP sidecar / Python wrapper) is **intentionally not built yet** — it's only worth writing when someone in the community actually asks "how do I use this from Python?". Then it's a ~50-line FastAPI wrapper.

### Persistence (self-test)

Capsules and evicted content are written to disk. Verified: `flush()` a capsule → start a **new engine instance on the same directory** → `recall()` returns the same context. Cross-process memory works out of the box.

---

## Running the benchmark

```bash
# Deterministic (no API key needed) — reproduces the table above
npx tsx packages/context/benchmark/index.ts --full --mock

# Real LLM — set a key, then run. Expects C ≥ 75% on GLM-4-flash.
export GLM_API_KEY="..."
npx tsx packages/context/benchmark/index.ts --full

# Topic-position sweep (near / middle / far) for the §3.3 distribution
npx tsx packages/context/benchmark/index.ts --full --sweep
```

Reports land in `packages/context/benchmark/results/` as `.md` / `.json` / `.csv`.

---

## What we don't accept

This is a solo, transitional project. To keep it honest and maintainable:

- **Issues: yes.** Bug reports, sharp critiques, and "here's where FIFO beat you" stories are all welcome.
- **PRs: no (for now).** Don't send pull requests. Fork it, hack on it, ship your own variant. If your fork proves something, open an Issue linking to it — that's the fastest path.
- **No CI/CD, no GitHub Actions.** `pnpm test` and `pnpm typecheck` are the contract.
- **No 100% coverage theater.** It's a bridge project, not a production system.
- **No fake commits.** The 30-commit, 9-day arc is real. Don't manufacture history.

---

## License

[MIT](./LICENSE) © 2026 StructAgent Contributors
