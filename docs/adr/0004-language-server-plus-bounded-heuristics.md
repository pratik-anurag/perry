# ADR 0004: Language Server First, Bounded Heuristics Second

## Status

Accepted

## Context

Perry needs symbol and reference context across languages. VS Code language servers provide the best available source of document symbols and references, but support can be incomplete or unavailable. Some languages also benefit from practical local heuristics.

## Decision

Perry uses VS Code language-server commands first:

- `vscode.executeDocumentSymbolProvider` for supported document symbols.
- `vscode.executeReferenceProvider` for references and usage sites.

When reference data is unavailable or incomplete, Perry may use bounded heuristics:

- Text-scan usage fallback currently applies to Python and Go.
- Workspace scan file count is capped.
- Results are deduplicated and truncated.
- Scans ignore common generated/dependency folders.
- Calls and usage matches strip comments and strings where practical.

## Consequences

- Reference accuracy depends on the active language server.
- Heuristics should be conservative, bounded, and tested.
- New language fallbacks need explicit caps, ignore rules, cancellation handling, and tests.
