# `@ai-usage/effect-runtime`

Domain-free wide-event primitives for Effect program executions.

- `.` — model, boundary runner, hop measurement, sanitization, capture/no-op sinks
- `./node` — Node-only console and bounded NDJSON file sinks

This package must not import other `@ai-usage/*` packages. Application adapters
own boundary names and annotation allowlists; this package owns emission,
sanitize-on-emit, and best-effort sink delivery.
