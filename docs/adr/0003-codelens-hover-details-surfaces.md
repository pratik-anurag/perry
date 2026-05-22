# ADR 0003: CodeLens, Hover, Links, And Details As Rendering Surfaces

## Status

Accepted

## Context

Perry originally needs to show context close to code without obscuring the editor. VS Code decoration blocks do not reserve editor space and can overlap source text. Different users also need different levels of detail: quick summary in the editor, richer hover content, and a full details panel.

## Decision

Perry renders the same `SymbolContext` through multiple VS Code-native surfaces:

- CodeLens for the compact, non-overlapping editor summary.
- Hover for rich inline context and quick actions.
- Document links for Ctrl/Cmd-click access on symbol names.
- Details webview for the full context view and navigation actions.

Inline decoration blocks remain deprecated because they do not reserve editor space.

## Consequences

- New context signals should be designed once and rendered consistently across the relevant surfaces.
- CodeLens text must stay compact.
- Hover and details can show richer usage-site and test information.
- Rendering logic should not become the source of truth for data collection.
