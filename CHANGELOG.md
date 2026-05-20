# Changelog

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
