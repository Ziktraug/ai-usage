# Plan 028: Ship a privacy-safe local demo

> **Status: DONE** — the deterministic privacy-safe demo and its regression coverage are complete.
>
> **Baseline**: re-read at commit `6135fe7` on 2026-07-21. If the named runtime
> boundaries changed, update this plan before implementing.

## Outcome

`bun run demo` opens a loopback-only, read-only version of the app backed by the
committed synthetic report. It looks and behaves like the real report, including
session detail, but cannot read local histories or invoke collection, sync, or
source-control mutations.

## Why this matters

The repository already contains convincing synthetic data for E2E tests, but
there is no public demo contract. Reusing the ordinary runtime and merely hiding
navigation would leave local server paths active. The portfolio value is a demo
that reviewers can start safely and understand immediately.

## Current evidence

- `apps/web/src/report-data.ts` owns the deterministic `demoReportPayload`.
- `apps/web/src/report-runtime.ts` switches only for `VITE_AI_USAGE_E2E`.
- `apps/web/src/source-control-context.tsx` starts the browser source-control
  client when the root mounts.
- `apps/web/server/plugins/source-control.ts` starts the server source runtime.
- `/sources`, `/sync`, Skills server functions, source-control API routes, and
  the Vite Sync middleware can reach local state or mutations.
- The architecture contract is loopback-only; preserve it.

## Scope

In scope:

- One explicit `live | e2e | demo` runtime-mode parser shared by thin browser
  and server adapters.
- A root `demo` script using `127.0.0.1`, a fixed port, and a temporary home.
- Synthetic report loading and a persistent “Demo data” label.
- Report navigation, filtering, session selection, and the session drawer.
- Inert browser source-control behavior in demo mode.
- Server guards that reject local-read and mutation routes before their live
  handlers/runtimes are constructed.
- A focused Playwright privacy test.

Out of scope: hosted deployment, provider calls, real histories, LAN serving,
new demo content, README artwork, and external publication.

## Implementation

1. Add a small typed runtime-mode owner. Default to `live`; reject conflicting
   E2E/demo flags. Add focused Bun tests.
2. Make report loading mode-explicit. Demo and E2E may share
   `demoReportPayload`, but only demo displays the label.
3. Inject an inert `SourceControlClient` in demo mode. It must not construct an
   `EventSource`, call `fetch`, or execute commands.
4. In demo mode, remove non-report destinations from navigation and redirect
   their direct UI routes to `/` before data loading.
5. Guard server functions, source-control API routes, the source-control Nitro
   plugin, and both Sync upload paths before live module/runtime construction.
   Return one non-disclosing `404` contract and test zero handler/factory calls,
   not only the status code.
6. Add `bun run demo` and `bun run test:e2e-demo`. The launcher must use a
   temporary home, bind only to `127.0.0.1`, forward shutdown, and remove only
   its own temporary directory.

## Verification

- Runtime unit tests cover default, demo, E2E, and conflicting flags.
- Boundary tests prove zero runtime construction, handler import, body read,
  local read, and mutation in demo mode.
- Playwright renders Overview, opens a synthetic session drawer, finds the demo
  label, and observes no business `fetch`, XHR, or EventSource request.
- Direct requests to guarded endpoints return `404`.
- Run:

  ```sh
  bun run check
  bun run lint
  bun run typecheck
  bun run test
  bun run build
  bun run test:e2e
  bun run test:e2e-demo
  bun run test:e2e-production
  ```

## Done

- [x] `bun run demo` is deterministic, synthetic, read-only, and loopback-only.
- [x] Overview and session detail remain fully usable.
- [x] Browser and server privacy assertions pass.
- [x] Existing live, E2E, and production behavior remains green.
- [x] Only this plan's runtime, test, and script files changed.

## STOP conditions

Stop if the demo requires real local data, a non-loopback listener, collector or
persistence changes, or weakening an existing security boundary. Do not commit,
push, host, or publish unless separately requested.

## Maintenance

Every new root provider, server function, API route, or Vite/Nitro middleware
must declare and test its demo behavior. Hidden navigation is never the privacy
boundary.
