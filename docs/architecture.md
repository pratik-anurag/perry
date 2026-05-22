# Architecture

## Overview

Perry Code Context is a local-first VS Code extension. It adds code-context surfaces for supported source files without sending project data outside the local machine.

The extension is intentionally split into a lightweight command layer and an opt-in runtime. Activation registers commands and creates service objects. Workspace scanning, Git commands, file watchers, providers, hovers, and links are registered only after the user starts Perry.

## System Context

Perry runs inside the VS Code extension host and depends on local capabilities:

- VS Code APIs for commands, CodeLens, hover, document links, webviews, document symbols, references, workspace trust, file watching, and file reads.
- Local language servers through VS Code commands such as `vscode.executeDocumentSymbolProvider` and `vscode.executeReferenceProvider`.
- Local Git through `git` CLI commands.
- Local workspace files for test discovery and CODEOWNERS matching.

Perry does not depend on runtime network calls, API keys, telemetry, or remote services.

## Runtime Lifecycle

`src/extension.ts` owns the lifecycle.

On activation:

- Create the `Perry` output channel.
- Resolve workspace roots.
- Construct lightweight services: `GitService`, `TestDiscovery`, and `CodeownersService`.
- Register commands such as `perry.start`, `perry.stop`, `perry.refresh`, `perry.showDetails`, and diagnostics.
- Record activation diagnostics.

On `Perry: Start`:

- Return early when already started or starting.
- Require `vscode.workspace.isTrusted`.
- Construct `PerryProvider` and `PerryHoverProvider`.
- Register CodeLens, hover, and document-link providers.
- Register save and file-system watcher invalidation.
- Record start diagnostics.

On `Perry: Stop`:

- Dispose active provider/watch subscriptions.
- Clear provider and service caches.
- Return Perry to dormant state.

## Component Responsibilities

`src/extension.ts`

- Command registration and command-layer activation.
- Runtime state machine.
- Trusted-workspace checks.
- Command argument validation.
- Details webview rendering and command URI allowlist.
- Cache clearing across services.
- Diagnostics output.

`src/perryProvider.ts`

- Core `SymbolContext` orchestration.
- CodeLens provider implementation.
- Document-symbol lookup.
- Per-document versioned context cache.
- Reference lookup through the language server.
- Bounded text-scan fallback for Python and Go usage sites.
- Calls extraction through `symbolAnalysis`.
- Coordination with Git, test discovery, and CODEOWNERS services.

`src/perryHoverProvider.ts`

- Hover rendering.
- Clickable document links for supported symbols.
- Trusted command URIs for details, references, related tests, and usage sites.

`src/perryBlock.ts`

- Comment-style context block formatting shared by hover content.

`src/gitService.ts`

- Local Git root discovery.
- `git blame` line context with `git log` fallback.
- Git command timeouts.
- Git root cache.

`src/testDiscovery.ts`

- Bounded local test-file discovery.
- Test content indexing with per-file and total byte limits.
- Heuristic related-test matching by file stem or symbol name.

`src/codeowners.ts`

- CODEOWNERS file discovery.
- Practical local parser and matcher.
- Workspace-root scoped rule cache.

`src/symbolAnalysis.ts`

- Call extraction from a symbol range.
- Text-call matching for fallback usage scans.
- Comment and string stripping for heuristic scans.

`src/usageSites.ts`

- Usage-site labels.
- Deduplication and truncation.
- Range containment helpers.

`src/types.ts`

- Shared DTOs used across providers, services, tests, hovers, and webviews.

## Core Data Model

`SymbolContext` is the central data object. It contains:

- `symbol`: name, kind, file path, URI, line, and ranges.
- `references`: availability and count.
- `usedBy`: usage labels and optional concrete usage sites.
- `calls`: detected called symbols.
- `git`: local Git author and relative date.
- `tests`: related test files.
- `owner`: CODEOWNERS result.

New feature work should usually extend or derive from this model instead of creating a second parallel context shape.

## Context Build Flow

1. VS Code requests CodeLens, hover, or links for a document.
2. `PerryProvider.getDocumentContexts` checks the cache key `${document.uri}@${document.version}`.
3. `buildContexts` reads `perry` settings and asks VS Code for document symbols.
4. Symbols are limited by `perry.maxSymbolsPerFile`.
5. Test index and owner lookup are started once per document when enabled.
6. Symbols are processed with bounded concurrency.
7. For each symbol, Perry collects:
   - language-server references and usage containers where available;
   - text-scan usage fallback for Python and Go;
   - called symbols from the symbol body;
   - local Git line context;
   - related tests;
   - owner data.
8. The resulting contexts feed CodeLens, hover markdown, document links, and details webview rendering.

## Caching And Invalidation

Provider cache:

- `PerryProvider` caches contexts by document URI and version.
- Older cache entries for the same document are deleted when a new version is cached.
- Text-scan file lists are cached by language ID.

Service caches:

- `GitService` caches Git root lookups by directory.
- `TestDiscovery` caches the test index promise.
- `CodeownersService` caches parsed rules by workspace root.

Invalidation happens when:

- `Perry: Refresh` is run.
- Perry stops.
- Relevant `perry` configuration changes.
- A document is saved.
- A workspace file is created, changed, or deleted. Watcher invalidation is debounced.

## Security And Privacy Model

Perry's default posture is local-first and workspace-bound.

- Runtime scanning and Git calls require trusted workspaces.
- File-opening commands verify that paths stay inside the current workspace.
- `SymbolContext` and `UsageSite` command arguments are validated before use.
- The details webview uses a restrictive content security policy and an explicit command URI allowlist.
- Runtime behavior should not introduce external network calls or telemetry.

## Performance Model

Perry must avoid making the extension host feel heavy.

- Activation is lightweight and dormant.
- Workspace-wide work starts only after explicit user action.
- Symbol processing uses bounded concurrency.
- Workspace scans are capped by file count and byte limits.
- Git commands have timeouts.
- Provider paths should honor cancellation tokens and return partial/unavailable context rather than block indefinitely.

## Testing Strategy

Current tests focus on pure or mostly pure behavior:

- CODEOWNERS parsing and matching.
- Git date formatting and fallback behavior.
- Context block formatting.
- Symbol analysis and usage-site behavior.
- Test discovery matching and indexing limits.

Prefer adding tests around deterministic helpers and services. VS Code integration behavior can be covered indirectly by testing transformation functions and service boundaries.

Run:

```sh
npm run compile
npm test
```

## Adding A Feature

Use this checklist:

1. Identify whether the feature is a new signal, a new rendering surface, a command, or a service behavior.
2. Keep the source of truth in `SymbolContext` if multiple surfaces need the same data.
3. Put workspace scans, Git calls, or parsing logic in a service/helper instead of `extension.ts`.
4. Add settings only when users need control over runtime cost or visible behavior.
5. Respect workspace trust, command argument validation, cancellation, and bounded scanning.
6. Update tests for parsing, matching, formatting, and cache-sensitive behavior.
7. Update README for user-facing changes and this doc or ADRs for architecture changes.
