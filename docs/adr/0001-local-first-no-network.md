# ADR 0001: Local-First Runtime With No Network Calls

## Status

Accepted

## Context

Perry reads code, symbols, file paths, Git history, tests, and ownership information from a user's workspace. That data can be sensitive. The extension should be useful without accounts, API keys, connectivity, or remote services.

## Decision

Perry runtime behavior remains local-first:

- No runtime network calls.
- No telemetry.
- No remote AI service dependencies.
- No API keys required.
- All context is derived from VS Code APIs, local files, local language servers, and local Git.

## Consequences

- Features that require external services are out of scope unless explicitly redesigned behind a separate opt-in architecture decision.
- Context quality depends on local language servers, local Git history, and local workspace files.
- Errors should degrade to unavailable context instead of blocking the UI.
