# Changelog


## 0.1.7

- Added Java support for CodeLens, hover, symbol links, and details.
- Added bounded Java text-scan fallback for usage sites when language-server references are unavailable.
- Added Java related-test discovery for common `*Test.java`, `*Tests.java`, `*IT.java`, and `src/test/java` layouts.
- Documented Java prerequisites for local language-server support.

## 0.1.6

- Bumped the extension package version to `0.1.6` for release.
- No user-facing behavior changes from `0.1.3`.

## 0.1.5

- Added clickable usage-site links in hover cards and the details panel.
- Added structured usage-site tracking with source locations, deduping, and truncation when many call sites are found.
- Combined language-server references with Go and Python text-scan results for better `Used By` coverage.
- Improved call-site scanning to preserve character positions while ignoring strings and comments.
- Added usage-site navigation validation so Perry only opens files inside the current workspace.

## 0.1.4

- Simplified the details panel into a lighter summary-and-sections layout.
- Improved hover and reference behavior by using symbol selection ranges when available.
- Added Go and Python fallback call-site scanning when the language server cannot provide references.
- Improved `Used By` labels with file and line locations.
- Added symbol-analysis tests for call-site detection.

## 0.1.3

- Bumped the extension package version to `0.1.3` for release.
- No user-facing behavior changes from `0.1.2`.

## 0.1.2

- Changed `Perry: Start`, `Perry: Stop`, and `Perry: Toggle` to use session state only instead of writing `.vscode/settings.json`.
- Removed the generated workspace settings file and ignored future `.vscode/settings.json` files.

## 0.1.1

- Added Workspace Trust gating before Perry starts file scanning, Git context, and file watching.
- Hardened details webview command links with a command allowlist and strict CSP.
- Added stronger command argument validation for details, references, and related test file opening.
- Added test discovery size caps and debounced broad workspace watcher cache invalidation.

## 0.1.0

- Initial MVP of Perry.
- Added CodeLens context for symbols in TypeScript, JavaScript, TSX, JSX, and Python.
- Added local Git blame/log context, reference counts, related test discovery, CODEOWNERS matching, and a details webview.
- Added lightweight unit tests for pure helper logic.
- Added virtual comment-style inline context blocks above symbols.
- Replaced overlapping virtual blocks with non-overlapping CodeLens summaries plus rich hover details.
- Added command-only startup with `Perry: Start`, `Perry: Stop`, and `Perry: Toggle`.
- Added diagnostics for startup timing and extension-host memory.
- Refined the full details panel with a richer responsive layout.
