# apps/web

## Owns

SvelteKit SSR and UI, the browser served-session coordinator, read-only report
procedures through the explicit `/rpc/[...rest]` oRPC endpoint, source-control
command/status/event proxies, `/sync`, web read observability, and the unrelated
`/skills` filesystem control plane.

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

SvelteKit check, development, and production intermediates are isolated in
`.svelte-kit/{check,dev,build}`. The selected Bun adapter writes the production
server to `.output-build/sveltekit`; the production build lock never targets
active development output. `bun run --cwd apps/web check:svelte`, `build`,
`dev`, and `preview` are the canonical framework commands.

The route tree lives under `src/routes`. `src/routes/rpc/[...rest]/+server.ts`
is the single oRPC HTTP entrypoint, while source-control SSE and manual-transfer
file routes remain explicit SvelteKit `+server.ts` leaves. `src/hooks.server.ts`
owns per-request runtime mode and the single web-observability lifecycle.

## Test strategy

Keep model tests near models and server adapter tests under `src/server`. Use
isolated synthetic homes/stores/ports for E2E. Cover engine available/stopped,
missing/incompatible store, mismatch, expired revision, synthetic demo isolation,
and direct-query bounds.

The permanent browser boundary gate is `bun run test:web-client-manifest`; it
rejects server-only capabilities in the emitted client graph. Request-policy
tests cover every live RPC path plus explicit file/SSE/command routes. The demo
suite proves synthetic-runtime isolation, while the production suite keeps
explicit secret sentinels out of SSR HTML without forbidding useful bounded
initial report data.
The dev/build isolation gate is `bun run test:web-dev-build-isolation`; the
5,000-session budget is `bun run --cwd apps/web benchmark:session-scroll`.
