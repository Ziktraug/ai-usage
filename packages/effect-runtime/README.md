# `@ai-usage/effect-runtime`

Domain-free schema-v2 wide-event primitives for Effect program executions.

- `.` — model, required process resource layer, boundary runner, hop
  measurement, sanitization, classification, and capture/no-op sinks
- `./node` — Node-only severity-aware console projection and bounded NDJSON
  file sinks

This package must not import other `@ai-usage/*` packages. Application adapters
own boundary names and annotation allowlists; this package owns emission,
sanitize-on-emit, and best-effort sink delivery.

Every new event carries a bounded `resource` identifying the process instance,
runtime mode, `ai-usage` version, and `web`/`cli` surface. The application
composition root supplies that resource once; the package does not read
environment or package configuration. Historical schema-v1 NDJSON remains
append-only and has no resource field.

`makeWideEventSinkLayer` provides only the sink service and never invents
producer identity. Tests that need the deterministic fixture resource use the
explicit `makeTestWideEventSinkLayer` helper; application runtimes must provide
their web or CLI resource at the composition root.

The canonical event and terminal view are separate products. NDJSON and JSON
console output remain one object per physical line. Pretty TTY output uses an
injectable, total projector, outcome severity, `LOG_LEVEL` filtering, and
multi-line hop/anomaly detail. Web supplies its domain projector; CLI remains
file-only. File warnings are typed, bounded, rate-limited, and routed directly
to the web console. Diagnostics distinguish logical submissions from file and
console transport delivery.
