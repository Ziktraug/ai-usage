# apps/web

## Owns

Solid/TanStack SSR and UI, the browser served-session coordinator, read-only
report server functions, source-control command/status/event proxies, `/sync`,
web read observability, and the unrelated `/skills` filesystem control plane.

## Does not own

It does not collect, schedule, migrate/checkpoint SQLite, publish/retain
revisions, mutate usage/config domains, run source adapters, or compose the
engine runtime. Skills remains the deliberate field-scoped exception.

## Data and control boundaries

Report support, Overview, Breakdown, Sessions, campaign children, neighbors,
and detail anchors query durable revision-keyed projections via
`usage-store/reader`. Quota history separately queries bounded durable provider
observations without naming a served revision. Commands/status/bounded SSE use
`usage-engine-control`. There is no report data endpoint, copied revision
database, query lease, or per-query Bun subprocess.

The SSR route reads the current manifest plus bounded support bootstrap in one
transaction. Destination queries after hydration name that exact revision. The
bootstrap reports omission counts; omitted metadata is never presented as
complete. Browser coordination preserves supersession, atomic commit, and one
revision-expiry retry.

If the engine is unavailable after publication, compatible stored reads remain
available and usage-domain mutations are disabled explicitly; Web-owned Skills
reads/mutations remain independent. Protocol mismatch fails closed. On-demand
local Session detail first resolves a `local-observed` exact revision anchor,
then uses only `@ai-usage/local-machine/session-detail`.

## Runtime commands

From the repository root, `bun run dev` supervises Web with the persistent
engine and `bun run dev:once` starts standalone Web for diagnostics against an
existing store. After a production build, root `bun run start:web-only` runs
the built Web server without spawning an engine. Demo and ordinary browser E2E
use synthetic adapters and cannot import production reader/control modules;
production E2E uses an isolated real engine/store/runtime.

Development and production outputs are isolated in `.output-dev` and
`.output-build`; the production build lock never targets active dev output.

## Test strategy

Keep model tests near models and server adapter tests under `src/server`. Use
isolated synthetic homes/stores/ports for E2E. Cover engine available/stopped,
missing/incompatible store, mismatch, expired revision, demo import privacy,
and direct-query bounds.
