# @ai-usage/usage-engine-runtime

## Owns

The deep write-side application service: collection, enrichment, source
policies and scheduling, provider quota refresh, source checkpoints/attempts,
machine/project-group/transfer mutations, publication, recovery, retention,
and sanitized engine wide events.

## Does not own

It does not own process arguments/signals/listening, browser or CLI rendering,
the transport protocol model, or read-only app queries. Those belong to the
usage-engine app, control package, and app read models respectively.

## Public interface

The root exposes the injected scoped runtime lifecycle. Focused subpaths expose
live composition, source adapters, and source control for the one engine app
and tests. `./recovery` is limited to bounded scavenging of verified legacy
filesystem artifacts; SQLite incomplete-revision cleanup belongs to live
writer retention/recovery.

## Dependency rules

It may import local collectors/machine primitives, report-data assembly,
report-core, control contracts, effect-runtime, `usage-merge`, and
`usage-store/writer`. Manual bundle parsing, preview, and confirmation belong
to `usage-merge`; the runtime only composes that service. It must not import
any app. Only `apps/usage-engine` may compose its live implementation.

## Runtime guarantees

One canonical-database writer lock precedes writer open/migration. Startup
publishes a compatible initial revision before cadence begins. The queue is
bounded, default concurrency and completion-relative cadence are preserved,
picked work owns cancellation, and all later durable phases stop after abort.
Publication is atomic and deduplicates unchanged semantic captures.

## Test strategy

Use injected clocks, adapters, control events, and isolated databases/homes.
Prove one writer, scheduler transition parity, command/mutation publication,
recovery, bounded/redacted events, and no collection after disposal.
