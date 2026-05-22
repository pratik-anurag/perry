# ADR 0002: Dormant Activation And Manual Start

## Status

Accepted

## Context

VS Code extensions share an extension host. Expensive activation can slow startup and affect unrelated extensions. Perry may scan files, run Git, watch the workspace, and invoke language server commands, so it should avoid doing that work automatically.

## Decision

Perry activation registers only the command layer and lightweight services. The extension remains dormant until the user runs `Perry: Start` or `Perry: Toggle`.

Starting Perry:

- Requires a trusted workspace.
- Registers CodeLens, hover, document-link providers, and file watchers.
- Enables workspace scanning and Git calls.

Stopping Perry:

- Disposes active runtime subscriptions.
- Clears caches.
- Returns Perry to dormant state.

## Consequences

- Features that need providers or watchers must be registered in the start path, not activation.
- Heavy work must not be added to `activate`.
- User-facing docs should explain that Perry starts only after explicit action.
