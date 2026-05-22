# Agent Guide

This file gives coding agents the project context needed before changing Perry.
Read it before implementing a feature, then read [docs/architecture.md](docs/architecture.md) and any relevant ADRs.

## Project

Perry Code Context is a local-first VS Code extension that shows code intelligence for meaningful symbols. It surfaces usage sites, calls, Git history, related tests, and CODEOWNERS ownership through CodeLens, hovers, clickable symbol links, and a details webview.

The runtime must remain local-only. Perry does not call external services, send telemetry, or require API keys at runtime.

## Core Invariants

- Keep Perry dormant after extension activation. Expensive providers, file watchers, Git calls, and file scans start only after `Perry: Start` or `Perry: Toggle`.
- Require trusted workspaces before scanning files, opening workspace files from command arguments, or running Git.
- Do not add runtime network calls, telemetry, or remote AI dependencies.
- Keep command arguments validated before using file paths, URIs, or symbol context supplied through command URIs.
- Respect VS Code cancellation tokens in provider paths and file scans.
- Avoid blocking extension activation. Activation should only register commands and initialize lightweight services.
- Preserve cache invalidation on refresh, stop, configuration changes, saves, and workspace file changes.
- Prefer bounded scans and concurrency limits for workspace operations.

## Architecture Map

- `src/extension.ts` owns activation, command registration, start/stop lifecycle, runtime state, diagnostics, file watchers, details webview commands, and workspace-bound command validation.
- `src/perryProvider.ts` is the core context builder and CodeLens provider. It discovers document symbols, builds `SymbolContext`, caches document results, asks VS Code for references, performs bounded text-scan fallback for Go/Python, and coordinates Git, tests, and owners.
- `src/perryHoverProvider.ts` renders hover cards and document links using contexts from `PerryProvider`.
- `src/perryBlock.ts` formats the comment-style context block shown in hover markdown.
- `src/gitService.ts` runs local Git commands with timeouts and caches discovered Git roots.
- `src/testDiscovery.ts` builds a bounded local test-file index and matches related tests heuristically.
- `src/codeowners.ts` loads and matches a practical subset of CODEOWNERS rules.
- `src/symbolAnalysis.ts` extracts called symbols and call-site matches from source text.
- `src/usageSites.ts` normalizes, deduplicates, and labels usage sites.
- `src/types.ts` defines the shared DTOs, especially `SymbolContext`.

## Data Flow

1. VS Code activates Perry's command layer.
2. `Perry: Start` checks workspace trust, constructs `PerryProvider`, registers CodeLens, hover, document-link providers, and file watchers.
3. `PerryProvider` receives a document request and gets supported document symbols.
4. For each symbol, it builds one `SymbolContext` by collecting references/usage, calls, Git line context, related tests, and owner data.
5. CodeLens, hover, symbol links, and the details panel render the same `SymbolContext` shape.

## Feature Rules

- Add new context signals to `SymbolContext` only when the same shape can serve CodeLens, hover, details, and tests consistently.
- Keep context collection in services or small helpers. Avoid adding unrelated provider logic to `extension.ts`.
- Bound all workspace-wide work by file count, byte count, timeout, cancellation token, or concurrency limit.
- Add tests for pure parsing, matching, formatting, and discovery behavior. Prefer small unit tests under `src/test`.
- If a feature needs a new design constraint, add an ADR under `docs/adr`.
- Update README only for user-facing behavior. Update architecture docs for internal flow or invariants.

## Commands

```sh
npm install
npm run compile
npm test
```

Use `npm run compile` before `npm test`; `npm test` already compiles and then runs Node tests from `out/test/*.test.js`.
