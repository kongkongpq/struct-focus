# Contributing to StructFocus

Thanks for your interest! This is a **solo, transitional project** (a 9-day sprint from zero to a working benchmark). The contribution model is deliberately minimal — read on.

## Development Setup

```bash
# Prerequisites: Node.js >= 22.6 (MCP Server uses --experimental-strip-types), pnpm >= 9
git clone https://github.com/structfocus/structfocus.git
cd structfocus
pnpm install
```

## Common Commands

```bash
pnpm test           # Run tests (vitest)
pnpm build          # Build all packages
```

> Note: there is no CI. `pnpm test` is the contract. Run it before you share anything.

## Project Structure

```
structfocus/
├── packages/
│   ├── context/                # @structfocus/context — the core engine (import standalone)
│   │   ├── src/
│   │   │   ├── longcontext-engine.ts   # LongContextEngine (feed / recall / autoManage)
│   │   │   ├── manager.ts              # ContextManager (four-layer hot/cold runtime)
│   │   │   ├── content-store.ts        # ContentStore (disk BM25 full-text)
│   │   │   ├── capsule.ts              # CapsuleStore (semantic summaries)
│   │   │   ├── builder.ts              # buildContext (six-layer assembly → LLMMessage[])
│   │   │   ├── summarize.ts            # chunkBySemantic + summarizeToCapsule
│   │   │   └── ...
│   │   ├── tests/               # vitest unit tests (xxx.test.ts)
│   │   └── bench/               # local benchmarks (search-precision.mjs, locomo/, ...)
│   └── mcp/                     # @structfocus/mcp — MCP Server (JSON-RPC 2.0 over stdio)
│       └── src/index.ts         # 8 MCP tools + JSON-RPC handler
├── docs/
│   ├── ARCHITECTURE.md         # full design writeup
│   ├── ROADMAP-TO-10.md        # 7.5 → 10 score improvement plan
│   └── benchmarks/             # benchmark reports (bm25-precision.md, README.md index)
├── README.md                   # Chinese README (primary)
├── README_EN.md                # English README
└── CONTRIBUTING.md
```

`context` is the foundation; `mcp` depends on it. No circular dependencies.

## Local Development

```bash
# Prerequisites: Node.js >= 22.6 (MCP Server uses --experimental-strip-types), pnpm >= 9
git clone https://github.com/structfocus/structfocus.git
cd structfocus
pnpm install
pnpm build      # tsc -b (context → dist)
pnpm test       # vitest run (the contract — run before sharing anything)
```

## Unit Test Conventions

- Place tests under the owning package's `tests/` directory, named `*.test.ts`.
- Use `vitest` (already configured). Import from the package entry (`@structfocus/context`) or sibling `../src/*`.
- **Always isolate disk state**: construct `ContextManager` / `LongContextEngine` with a temp `storeRoot`/`capsuleRoot` (e.g. `mkdtempSync(join(tmpdir(), "sf-"))`) so the shared `process.cwd()/.structfocus` store is never polluted.
- Run the whole suite in a single fork to avoid esbuild OOM on limited-RAM machines:
  ```bash
  ./node_modules/.bin/vitest run --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism packages/context packages/mcp
  ```
- Prefer asserting behavior (toMessages role alternation, recall filtering) over internal counters.

## How to Contribute

### Issues: yes

Bug reports and sharp critiques are welcome.

1. Search existing issues to avoid duplicates.
2. Open a new issue with: reproduction steps, expected vs. actual behavior, environment (OS / Node / pnpm version).

If StructFocus *lost* to FIFO truncation in your scenario, that's the most useful issue you can file.

### Pull Requests: no (for now)

We do **not** maintain a PR queue. This keeps a solo project honest and maintainable.

- **Fork it.** Hack on your own variant — that's the intended path.
- **If your fork proves something** (a fix, a new integration mode, a benchmark result), open an **Issue** linking to it. That's the fastest way for it to surface here.
- Don't manufacture commit history. The real 9-day arc is the point.

### Fork workflow conventions (when you publish a variant)

Even though we don't merge PRs, consistent hygiene helps others build on your fork:

- **Branch naming**: `fix/<area>-<short>` (e.g. `fix/bm25-idf`), `feat/<area>-<short>`, `bench/<name>`.
- **Commit messages**: imperative, short subject line (`fix(context): cap BM25 IDF at 0`), optionally a body explaining *why*.
- Keep each commit focused; one logical change per commit.

### Code Style

- TypeScript strict mode; ESM only (`"type": "module"`).
- Public APIs should have JSDoc comments.
- No `any` without a comment explaining why.

## Good First Issues

Ideas for first contributions (fork-friendly, well-scoped):

1. **Hybrid retrieval**: wire the reserved `SearchOptions.mode: "hybrid"` path to blend BM25 + a local embedding index (no LLM call) — direct follow-up to `docs/benchmarks/bm25-precision.md`.
2. **Synonym expansion**: add a small synonym dictionary to `ContentStore.search` so the 4 fuzzy queries in the BM25 bench stop failing on zero-overlap synonyms.
3. **`context_search` richer output**: return snippet offsets / score in the MCP tool result so clients can render highlights.
4. **Windows CI smoke**: a 2-minute `pnpm bench:bm25` smoke step that needs no LLM key (see roadmap 4.2).
5. **Capsule quality eval**: a deterministic scoring harness comparing `summarizeToCapsule` output against gold decisions (extends `packages/context/tests/summarize.test.ts`).

## License

By contributing (including by opening issues or publishing a fork), your work is understood to be under the [Apache-2.0 License](./LICENSE).
