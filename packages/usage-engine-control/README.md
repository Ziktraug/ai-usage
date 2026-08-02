# @ai-usage/usage-engine-control

## Owns

The strict versioned operational protocol between local apps and the usage
engine: command/status/event/error contracts, authenticated loopback client,
completion tracking, opaque upload handoffs, rendezvous parsing, and in-memory
test adapters.

## Does not own

It does not own collection, SQLite, report assembly, report rows, focused or
Session queries, quota history, document parsing/import, engine-side inbox
consumption, or app UI/CLI rendering.

## Transport boundary

Production origins are fixed numeric loopback. Rendezvous files are owner-only,
regular, single-link, no-follow files. Clients validate protocol and target
identity while resolving rendezvous; HTTP requests enforce loopback peer/host,
protocol header, bearer auth, methods/media types, byte/count budgets, runtime
parsing, timeouts, aborts, and stable redacted failures. SSE reconnect obtains
a fresh status snapshot before incremental events.

The web command subset cannot carry operator paths. `./handoff` owns bounded
byte staging, fsync, owner-only no-follow inbox files, opaque server-generated
handoff IDs, and cleanup. The engine independently revalidates and consumes the
staged file; this package never interprets or imports its document.

## Dependency rules

Protocol contracts may depend only on pure report-core contracts. The Node
handoff/rendezvous adapters additionally use platform filesystem primitives but
must not import runtime, collectors, report-data, usage-store, or apps.

## Test strategy

Cover unknown fields, budgets, auth/token redaction, loopback rejection,
protocol/target mismatch, deadlines, abort, completion, SSE reconnect/instance
rotation, rendezvous safety, and opaque handoff parsing.
