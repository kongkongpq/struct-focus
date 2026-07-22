# Contributing to StructFocus

First off — thank you for considering a contribution. Whether it's a bug report, a fix, a benchmark result, or a new integration, it all helps make FIFO-truncation-replacement better for everyone. **We welcome issues and pull requests.**

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development Setup

```bash
# Prerequisites: Node.js >= 22.6 (MCP Server runs TS via --experimental-strip-types), pnpm >= 9
git clone https://github.com/kongkongpq/struct-focus.git
cd struct-focus
pnpm install
pnpm build      # tsc -b (context → dist)
pnpm test       # vitest run (the contract — run before sharing anything)
```

> The full engine source lives under `packages/context/src` (`longcontext-engine.ts`, `manager.ts`, `content-store.ts`, `capsule.ts`, `builder.ts`). The MCP server is `packages/mcp/src/index.ts` (8 tools + JSON-RPC over stdio). `context` is the foundation; `mcp` depends on it.

## Continuous Integration

Pushing to `main` (or opening a PR against `main`) triggers GitHub Actions: `pnpm typecheck → lint → test`. **CI must be green before merge.** A red CI means the PR is not ready — please fix locally and push again.

```bash
# Run the same checks CI runs, locally:
pnpm typecheck
pnpm lint
pnpm test
```

## How to Contribute

### Issues — welcome

Bug reports and sharp critiques are the most valuable contributions.

1. **Search first** to avoid duplicates.
2. Open a new issue using the **Bug Report** or **Feature Request** template.
3. Include: reproduction steps, expected vs. actual behavior, environment (OS / Node / pnpm version).

If StructFocus *lost* to FIFO truncation in your scenario, that's the most useful issue you can file — it tells us exactly where to improve.

### Pull Requests — welcome

1. **Fork** the repo and create a branch from `main`:
   - `fix/<area>-<short>` (e.g. `fix/bm25-idf`)
   - `feat/<area>-<short>` (e.g. `feat/hybrid-retrieval`)
   - `bench/<name>` (e.g. `bench/locomo`)
2. **Make it small and focused** — one logical change per commit.
3. **Write/extend tests** for behavior you add or change. Keep disk state isolated (see below).
4. **Run the checks** (`pnpm typecheck && pnpm lint && pnpm test`) and make sure they pass.
5. **Open a PR** against `main` using the PR template. Link the related issue (`Closes #123`).
6. If your change affects a benchmark or public API, note it in `CHANGELOG.md` under `Unreleased`.

We review PRs on a best-effort basis. A clear description + green CI + a focused diff gets merged fastest.

### Unit Test Conventions

- Place tests under the owning package's `tests/` directory, named `*.test.ts`.
- Use `vitest` (already configured). Import from the package entry (`@structfocus/context`) or sibling `../src/*`.
- **Always isolate disk state**: construct `ContextManager` / `LongContextEngine` with a temp `storeRoot`/`capsuleRoot` (e.g. `mkdtempSync(join(tmpdir(), "sf-"))`) so the shared `process.cwd()/.structfocus` store is never polluted.
- Run the whole suite in a single fork to avoid esbuild OOM on limited-RAM machines:
  ```bash
  ./node_modules/.bin/vitest run --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism packages/context packages/mcp
  ```
- Prefer asserting behavior (toMessages role alternation, recall filtering) over internal counters.

### Code Style

- TypeScript strict mode; ESM only (`"type": "module"`).
- Public APIs should have JSDoc comments.
- No `any` without a comment explaining why.

## Good First Issues

Well-scoped starting points:

1. **Hybrid retrieval**: wire the reserved `SearchOptions.mode: "hybrid"` path to blend BM25 + a local embedding index (no LLM call).
2. **Synonym expansion**: add a small synonym dictionary to `ContentStore.search` so the fuzzy queries in the BM25 bench stop failing on zero-overlap synonyms.
3. **`context_search` richer output**: return snippet offsets / score in the MCP tool result so clients can render highlights.
4. **Windows CI smoke**: a 2-minute `pnpm bench:bm25` smoke step that needs no LLM key.
5. **Capsule quality eval**: a deterministic scoring harness comparing `summarizeToCapsule` output against gold decisions (extends `packages/context/tests/summarize.test.ts`).

## License

By contributing (including by opening issues or PRs), your work is understood to be under the [Apache-2.0 License](./LICENSE).
