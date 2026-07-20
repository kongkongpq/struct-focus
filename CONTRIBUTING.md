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
packages/
  context/   — @structfocus/context: the context engine (LongContextEngine, ContextManager,
               ContentStore, CapsuleStore, ContextMiddleware). Core library, import standalone.
  app/       — structfocus-app: Electron desktop shell (chat UI + context engine).
  mcp/       — @structfocus/mcp: MCP Server (JSON-RPC 2.0 over stdio).
```

`context` is the foundation; `app` and `mcp` both depend on it. No circular dependencies.

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

### Code Style

- TypeScript strict mode; ESM only (`"type": "module"`).
- Public APIs should have JSDoc comments.
- No `any` without a comment explaining why.

## License

By contributing (including by opening issues or publishing a fork), your work is understood to be under the [Apache-2.0 License](./LICENSE).
