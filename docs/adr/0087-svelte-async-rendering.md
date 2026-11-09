# ADR 0087: Defer Svelte async rendering over TanStack Query

- **Status**: Deferred
- **Date**: 2026-11-04
- **Preserves**: [ADR 0076](0076-browser-boundary-orpc-contract-and-tanstack-query.md),
  consolidating [ADR 0010](0010-sveltekit-contract-first-browser-boundary.md) and
  [ADR 0012](0012-tanstack-query-browser-server-state-ownership.md)

## Context

The operator requested an evidence-based trial of Svelte 5.57.2 `await` in
markup/`$derived` and `<svelte:boundary>` pending snippets for initial data
loading. These require the global `compilerOptions.experimental.async` flag;
they are not a route-local compiler choice. SvelteKit is 3.1.0 and TanStack
Svelte Query is 6.3.5.

SPA navigation already retains the document QueryClient. Intent prefetch warms
the same named queries with a 250 ms navigation budget, without cancelling a
late cache fill. Report regions already retain content during refresh and have
local pending/recovery semantics. This trial does not establish a new measured
navigation-latency benefit over those features.

## Options

- **A — No async rendering:** retain ordinary Query observers, current SSR
  hydration and region-level pending/error UI. No compiler flag change.
- **B — Scoped async boundaries over TanStack-owned promises:** suspend only
  initial acquisition using the existing named options and QueryClient. Keep
  observers authoritative for live results, retained content and refetches.
  The syntax is scoped, but the compiler flag affects the whole app.
- **C — Replace TanStack with SvelteKit remote functions/async loading:** rejected.
  This changes the transport and state owner and conflicts with ADR 0010/0012,
  whose current statement is ADR 0076. Remote functions are not needed to use B.

## Trial evidence

The 2026-11-04 trial used the existing dirty worktree, not an isolated mainline
checkout. It did not open or modify real stores or start an engine. Browser
checks used the configured E2E and synthetic demo runtimes, not the running
real-data development server.

The app config is inline in `apps/web/vite.config.ts` (`sveltekit({...})`), not
`svelte.config.js`. The trial also enabled the same flag in all 26 standalone
Vite/Svelte SSR test harnesses and the delegation runes-module test compiler.

Before enabling the flag, `cd apps/web && bun run build` passed. Vite's rounded
client entry/layout measurements, raw then gzip, were:

- `entry/payload`: 0.06 / 0.07 kB before and after.
- `entry/start`: 0.62 / 0.35 kB before and after.
- `entry/app`: 6.19 / 2.06 kB before; 6.19 / 2.05 kB with async.
- Layout `nodes/0`: 57.53 / 19.47 kB before; 57.54 / 19.50 kB with async
  (+0.01 / +0.03 kB at the reported precision).

With the flag enabled, before any route pilot:

- `cd apps/web && bun run check:svelte`: zero errors, zero warnings.
- `cd apps/web && bun run test`: 1,901 passed, zero failed, 9,666 assertions
  across 264 files (38.11 s), including the existing SSR parity tests.
- `bun run typecheck`: 31 successful workspace tasks, zero failed.
- `cd apps/web && bun run build`: passed. Existing Panda dynamic-extraction
  warnings remained; no new Svelte diagnostics were reported.
- `bun run check` and targeted Ultracite fix: passed, no fixes required.
- `cd apps/web && bun run test:e2e-demo`: three passed (25.7 s).

The full `cd apps/web && bun run test:e2e` trial finished with **355 passed,
10 failed (4.2 min)**. Four campaign timeline checks could not reach targets by
scrolling; both desktop and mobile Session anchor checks lost the expected row
after insertion. These six behavioral failures are not trivial
compiler-setting fixes. Four additional trace-close `ENOENT` failures in Atelier
management coincided with running the demo suite against Playwright's shared
default artifact directory; those are trial-harness contamination, not evidence
against Svelte. The final browser and demo suites ran sequentially.

No controlled effect-ordering or batching measurement was made. No
`hydration_mismatch`, `hydration_attribute_changed`, `effect_update_depth_exceeded`
or `state_unsafe_mutation` diagnostic was found in the inspected browser log.
Static/SSR parity and absence of those diagnostics do not establish lifecycle
equivalence or establish the precise cause of the scrolling/anchor failures.
The Session anchor implementation uses `$effect.pre` followed by `tick()` to
capture and restore DOM geometry and focus; it is a timing-sensitive seam to
investigate on re-evaluation, not a proven compiler defect. All six behavioral
checks passed after rollback, but the contaminated async run was not repeated
in isolation, so attribution remains provisional.

### Final state: flag removed, no pilot

The app and all 27 standalone test-compilation changes were reversed exactly,
preserving the pre-existing dirty worktree. Final acceptance results:

- Targeted `bun x ultracite fix` was invoked on the two retained Markdown paths;
  Biome reports zero supported files there. Before rollback it checked all 28
  trial TypeScript paths successfully, with no fixes.
- `bun run check`: passed (1,608 supported files).
- `bun run typecheck`: passed (31 successful tasks, all cached).
- `cd apps/web && bun run test`: 1,901 passed, zero failed, 9,666 assertions
  across 264 files (29.74 s).
- `cd apps/web && bun run check:svelte`: zero errors, zero warnings (fresh run).
- `cd apps/web && bun run build`: passed; the entry/layout sizes and hashes
  returned to the pre-trial baseline above.
- Full `cd apps/web && bun run test:e2e`: **365 passed (4.0 min)**.
- `cd apps/web && bun run test:e2e-demo`: **three passed (11.1 s)**.
- ADR index entry and all 15 relative links resolve; `git diff --check` passed.

Command logs and preserved browser artifacts were captured in
`/tmp/opencode/async-trial/` during execution; these are ephemeral local evidence,
not required repository inputs. The aggregate results above remain the durable
record. No new pilot tests were added because the global gate did not pass.

### Pilot suitability

`sources` is marked browser-only in `src/lib/query/composition.ts`, but its
Query is a disabled, initially seeded EventSource bridge. `ensureQueryData`
would immediately return the seeded stopped state; resetting it invokes a
deliberately rejecting query function. A real loading pilot there would change
the single stream's lifecycle, not merely render a Query-owned fetch.

The authorized alternative `/delegation` renders the SSR-awaited
`delegation-settings` family. Browser-only `delegation-jobs` is actually consumed
by Work's `work-delegations.svelte`, not by that route. The authorized fallback
`/sync` has a normal query-owned fleet fetch and is the appropriate future
candidate, provided the global gate first passes. Its hydrated fleet HTML must
remain server-rendered: a boundary with a pending snippet renders that snippet
on the server, so blindly wrapping the existing SSR content would regress it.

## Decision

Choose A for now; defer B. Do not replace TanStack ownership with C. No route
pilot is accepted without a clean global browser gate and pending → content,
failed → retry, retained-content refetch, SSR and hydration evidence.

Revert the compiler flag in the app, all standalone SSR harnesses and the runes
test compiler. Do not introduce the Sync pilot after a non-green global gate.
Only this evidence record and its index entry remain from the trial.

Re-evaluate on a clean baseline when the browser failures are understood, or
when a Svelte upgrade stabilizes/removes the experimental gate. Any new trial
must use consistent compiler options in the app and standalone test compilers,
run browser suites sequentially (their default artifact directory is shared),
and compare entry/layout output and the same acceptance gates.

If B is later accepted, only cold initial query acquisition may suspend. Use
one named Query policy/key, no second cache, no direct fetch or remote functions,
and retain the existing observer for updates. Retry must reset the exact Query
and boundary without reloading the document; subsequent refetches must not
replace retained content with pending UI. SSR data, privacy, status announcements
and keyboard/focus behavior must remain intact. Remove the experimental flag
when the compiler makes the feature stable/default, after the same regressions
pass; remove the pilot and flag earlier if global lifecycle regressions appear.

## Consequences

The existing state and rendering owners remain unchanged. The trial measures a
small entry/layout bundle difference, not a proven user-visible improvement.
Deferral avoids enabling a global experimental mode on incomplete evidence.

## Evidence

- [Query ownership table](../../apps/web/src/lib/query/composition.ts)
- [Sources Query options](../../apps/web/src/lib/query/options/source-control.ts)
- [Sources lifecycle](../../apps/web/src/lib/features/sources/INTEGRATION.md)
- [Delegation page](../../apps/web/src/lib/features/delegation/delegation-page.svelte)
- [Work delegation jobs](../../apps/web/src/lib/features/work/work-delegations.svelte)
- [Sync query](../../apps/web/src/lib/features/sync/sync-query.svelte.ts)
- [Sync SSR parity](../../apps/web/src/lib/features/sync/sync-render.test.ts)
- [Intent prefetch budget](../../apps/web/src/lib/features/shell/intent-prefetch.ts)
- [Region pending/recovery](../../apps/web/src/lib/features/report/core/report-region.svelte)
- [App compiler configuration](../../apps/web/vite.config.ts)
- [Session anchor regression](../../apps/web/e2e/session-anchor.spec.ts)
- [Session anchor effect](../../apps/web/src/lib/features/sessions/table/session-table.svelte)
