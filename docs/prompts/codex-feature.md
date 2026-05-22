# Repeatable Codex Feature Prompt

Use this when asking Codex to add or modify a Perry feature.

```text
Before implementing, read AGENTS.md, docs/architecture.md, and relevant docs/adr files.

Project constraints:
- Perry is a local-first VS Code extension.
- Do not add runtime network calls, telemetry, API keys, or remote AI dependencies.
- Keep activation lightweight and dormant; expensive work starts only after Perry: Start or Perry: Toggle.
- Require trusted workspaces before scanning files, opening workspace paths from command arguments, or running Git.
- Respect cancellation tokens and bounded scans.
- Preserve cache invalidation on refresh, stop, configuration changes, saves, and workspace file changes.

Task:
<describe the feature or bug fix here>

Implementation expectations:
- Explain which files you inspected before editing.
- Keep data collection in services/helpers or PerryProvider, not in extension.ts unless it is lifecycle or command wiring.
- Reuse or extend SymbolContext if multiple surfaces need the same data.
- Update CodeLens, hover, details, or README only when user-facing behavior changes.
- Add or update tests for deterministic parsing, matching, formatting, discovery, or cache-sensitive behavior.
- Run npm run compile and npm test.
- Summarize changed behavior, tests run, and any remaining risks.
```
