# ADR 0014: `@ai-usage/effect-runtime` owns wide-event primitives

- **Status**: Accepted
- **Date**: 2026-07-21
- **Formerly**: numbered ADR 0002; renumbered 2026-08-25 to resolve the
  collision with the immutable-focused-report-revisions ADR. References to
  "ADR 0002" in ADR 0008 and plans 036/037 mean this record.
- **Amended by**: [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
- **Superseded in part by**: [ADR 0008](0008-wide-event-presentation-provenance-and-delivery.md)
  (TTY presentation, producer resource context, delivery diagnostics,
  tagged-error policy ownership)

## Context

Wide-event logging is shared infrastructure for control-plane jobs, web
adapters, CLI commands, and later Effect boundaries. Putting it in
`@ai-usage/report-data` would couple generic observability to report
orchestration and encourage separate web and CLI implementations.

The engine, web process, and CLI may write concurrently. Logging must remain
best-effort, bounded, private, and unable to change product results or terminal
output.

## Decision

Create a thin, domain-free `@ai-usage/effect-runtime` package. It owns the event
model, boundary runner, hop measurement, sanitization, sink interface, and Node
sink implementations. It must not import another `@ai-usage/*` package. The
package-boundary checker enforces that inverse dependency rule, while the
existing `report-core` rule continues to keep Effect runtime code out of the
pure domain package.

The public `WideEventService` can annotate the current root or hop and open
measured child hops. It cannot emit. A boundary-private controller owns final
classification, canonical sanitization, and exactly-once submission to sinks.
The returned snapshot is already safe; every sink serializes it defensively
again.

Node-specific file and console composition is exposed separately from the
runtime-neutral model so browser-visible modules cannot accidentally import
filesystem code.

Under ADR 0009, `apps/usage-engine` owns the process-scoped sink/resource for
source and publication work and drains it during engine shutdown. `apps/web`
owns a separate process-scoped read-observability sink/resource for finite
direct SQLite server adapters and drains it during Nitro shutdown. Engine/Web
TTY logging uses compact context-rich projected output; non-TTY output, or
`LOG_FORMAT=json`, uses one-line JSON.

`apps/cli` uses the same boundary and sink primitives but composes only the file
sink. It never prints wide events or file-sink diagnostics to stdout or stderr.
The CLI Effect scope drains the appender before the existing explicit
`process.exit` path can run.

File logs live in the workspace `logs/` directory unless the absolute
`AI_USAGE_LOG_DIR` override is set. Resolution walks upward from the runtime
package location and parses the workspace `package.json`; it never depends on
`process.cwd()`. If no valid directory can be resolved, the file sink is
disabled without failing the product.

The log directory is ai-usage-owned and `0700` on POSIX; files and the
cooperative writer lock are regular, single-link, non-symlink `0600` files.
Selection, append, rotation, and sweep run under a bounded interprocess lock so
engine, web, and CLI cannot race each other. The appender uses a bounded in-memory queue,
an append timeout and circuit breaker, and a scoped drain deadline. Queue-full,
lock, filesystem, and serialization failures drop observability records but
never fail business work.

Files use `wide-events-YYYY-MM-DD[.N].ndjson`, rotate before the next bounded
record would cross 50 MiB, and retain the 30 newest files. Sweep and rotation
ignore unrelated files. No compression is added in v1.

## Consequences

- `apps/usage-engine`, `apps/web`, and `apps/cli` consume one foundation and
  differ only at their composition roots.
- Engine source/publication work and Web direct reads each have one sink
  lifecycle instead of one appender per job or route.
- Tests use injected capture or no-op sinks; production event state is never a
  mutable process global.
- File delivery is explicitly best-effort. "Emit exactly once" means one
  boundary submission to each configured sink, not a durability guarantee.
- `docs/public-package-interfaces.md`, package exports, workspace dependencies,
  and the persistent web-runtime package list must be updated with the package.

## Rejected Alternatives

- A logging package inside `report-data`: rejected because engine, Web, and CLI
  have Effect boundaries outside report orchestration.
- Fire-and-forget `appendFile` without a scoped queue: rejected because CLI
  failures can call `process.exit` before the write settles.
- Per-process files without coordination: rejected because they weaken the
  locked naming and global retention contract.
