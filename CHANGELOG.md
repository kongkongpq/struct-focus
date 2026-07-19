# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Harvard architecture context management (I-Context + D-Context with Git versioning)
- AST/LSP-level code editing via TypeScript LanguageService (rename, refactor, symbol extraction)
- Five-layer memory system with vector hybrid search (sqlite-vec + FTS5)
- 2PC atomic multi-file transactions with checkpoint/rollback
- N-dimensional permission matrix with approval queue
- LLM fallback chain with cooldown and exponential backoff
- Task granularity controller with contract-based decomposition
- Early stop detector (5 dimensions: diminishing returns, budget, errors, repetition, progress)
- Dynamic phase-based prompt pruning (explore → plan → execute → verify → summarize)
- Structured tool output compression
- Docker/gVisor sandbox execution
- PTY manager with expect-style auto-responder
- MCP server (JSON-RPC 2.0 over stdio)
- Agent-as-Judge evaluation framework with SWE-bench lite adapter
- Plugin SDK with 4 example plugins (git-guard, cost-limiter, code-review, todo-tracker)
- Electron desktop shell with chat UI
- CLI with resume mode, slash commands, and spinner
- GitHub Actions CI + eval regression workflows

## [0.1.0] - 2026-07-14

### Added
- Initial public release.
- 6 packages: framework, memory, harness, context, agent, app
- 367 tests passing
