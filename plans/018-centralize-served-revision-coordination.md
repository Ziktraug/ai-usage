# Plan 018: Give Served Revision Coordination One Browser-Side Owner

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 016 and 017
- **Category**: browser architecture / concurrency / refresh performance
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `refactor/018-served-report-session`

## Executor instructions

Read this plan completely and compare current client code with `17bcf28` after
plans 016/017. Characterize current races before extracting them. The new module
owns protocol and concurrency, not rendering; Dashboard remains responsible for
URL-derived intent and presentation.

Use deterministic memory adapters and deferred promises for unit tests. Do not
test races with real sleeps.

## Why this matters

`dashboard.tsx` currently assembles a focused store, focused source, Session
coordinator, multiple expiry loops, destination snapshots, and three different
exact-revision commit branches. Each branch must independently avoid stale
destination/filter commits and coordinate focused support with Session pages.
The protocol is difficult to audit and easy to break while editing UI code.

Plan 017 can return the same active revision for an unchanged refresh. Without a
single client coordinator, the browser may still reload Overview, Breakdown, or
Sessions and reset caches despite the server-side no-op.

## Target outcome

1. One deep browser module owns bootstrap acquisition, destination loading,
   exact-revision retry, supersession, and atomic commit.
2. Dashboard supplies a destination/scope snapshot and renders a typed outcome;
   it no longer contains three revision commit protocols.
3. Overview, Breakdown, and Session data committed together always belong to one
   revision and the still-current destination/filter scope.
4. Revision expiry retries at most once through a fresh manifest/bootstrap.
5. Older async work can never overwrite a newer request.
6. Receiving the already-active revision is a no-op only when the canonical
   destination/scope request fingerprint also matches; a navigation/filter
   change under the same revision still loads its new destination.
7. Errors preserve the previous visible report until a complete replacement is
   ready.

## Current-state evidence

- `apps/web/src/dashboard.tsx` constructs served focused/Session collaborators
  near component setup and implements multiple exact-revision commit paths.
- Overview and Breakdown have separate expiry/retry loops; Sessions has its own
  prepare/commit coordination.
- `focused-report-client.ts` and `session-query-client.ts` expose lower-level
  query/source primitives but no owner of a complete destination transition.
- Plan 016 centralizes server execution, not browser state.
- Plan 017 adds a stable capture fingerprint and may return the same revision.

## Scope

### In scope

- a new `apps/web/src/served-report-session.ts` and pure tests;
- focused/Session client adapters needed by that module;
- Dashboard orchestration simplification;
- exact-revision same/no-op, expiry, supersession, and atomic commit tests;
- minimal instrumentation to prove query suppression.

### Out of scope

- changing URL/filter/destination semantics or visual components;
- changing server query contracts, SQL, byte budgets, or revision TTL;
- replacing TanStack Query/router;
- moving pure report projections out of report-core;
- importing `*.server.*` or `bun:sqlite` into browser code;
- static/HTML mode, which no longer exists.

## Commands and characterization

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- apps/web/src apps/web/e2e
git status --short -- apps/web/src apps/web/e2e
bun test apps/web/src/focused-report-client.test.ts \
  apps/web/src/session-query-client.test.ts \
  apps/web/src/dashboard-model.test.ts \
  apps/web/src/dashboard-search.test.ts
```

If either scoped drift command contains work beyond completed plans 016-017,
STOP, preserve it, and re-characterize Dashboard/client ownership after rebasing
before extraction.

Before extraction, document:

- the canonical destination/scope snapshot for Overview, each Breakdown, and
  Sessions;
- when support/store state commits;
- when a Session page prepares and commits;
- every expiry retry and max retry count;
- supersession/request-ID checks;
- which prior visible state survives each error;
- query count when refresh returns the current revision.

## Target module boundary

Create a deep module with an interface conceptually like:

```text
refresh(destinationSnapshot) ->
  no-change | committed | superseded | failed-preserving-previous
```

It owns:

- current committed revision/capture fingerprint;
- current canonical destination/scope request fingerprint;
- manifest/bootstrap acquisition;
- immutable destination and filter snapshot;
- focused and Session source calls;
- one retry after typed revision expiry;
- monotonic request/supersession identity;
- prepare then atomic commit across related stores;
- same-revision no-op detection.

It does not own Solid components, router mutation, filter derivation, chart
projections, or server functions directly. Inject narrow client adapters.

## Implementation steps

### Step 1 - Freeze concurrency invariants with a memory model

Create `served-report-session.test.ts` using deferred adapter promises. Cover:

1. destination changes while old load is pending: old result does not commit;
2. filter/scope changes within the same destination: old result does not commit;
3. older refresh resolves after newer: older never wins;
4. first revision expiry: reacquire once and commit the new exact revision;
5. second expiry: typed failure, no loop;
6. Sessions prepares focused support/store plus page, then commits atomically;
7. one half fails: neither half commits;
8. same active revision/capture fingerprint **and same canonical destination
   request fingerprint**: zero Overview/Breakdown/Session calls;
9. same revision/capture but different destination or scope: the new exact
   destination query executes and commits;
10. error/supersession keeps previous visible state;
11. abort/cancellation performs no late commit.

Make these tests fail against an adapter that omits the corresponding guard.

### Step 2 - Implement the served report session

1. Define explicit destination/scope discriminants using existing canonical
   request types; do not create ad hoc fingerprints.
2. Snapshot intent at refresh start. Never re-read mutable signals midway and
   assume they still describe the request.
3. Acquire/validate bootstrap through the existing focused source.
4. Return `no-change` before any destination query/reset only when revision,
   semantic capture fingerprint, and canonical destination/scope request
   fingerprint all match the committed session.
5. Otherwise load only the active destination against that exact revision.
6. On typed expiry, reacquire once and restart from a new immutable snapshot;
   propagate a second expiry.
7. Prepare all state off to the side. Re-check request identity and current
   destination immediately before one commit.
8. Keep previous committed state until the replacement commit succeeds.
9. Return typed outcomes/errors suitable for Dashboard status UI.

### Step 3 - Adapt existing focused and Session clients

Keep low-level request parsing, canonical fingerprints, caches, and result
validation in their existing modules. Add only narrow adapters the session needs.

Remove duplicated expiry/retry/supersession logic from those clients if and only
if the new owner covers it and parity tests pass. Do not create circular
ownership where both layers retry independently.

### Step 4 - Simplify Dashboard to intent and rendering

In `dashboard.tsx`:

1. retain URL/signal derivation of active destination and filters;
2. construct one served report session from injected clients/stores;
3. replace the three exact-revision commit branches with one call using an
   immutable destination snapshot;
4. map typed outcomes to refresh status/errors;
5. remove local expiry loops, supersession flags, and prepare/commit glue now
   owned by the module;
6. retain demo/initial-payload mode as a separate simple path;
7. ensure cleanup aborts outstanding session work on unmount.

No rendering component should learn lease, revision retry, or child-query
details.

### Step 5 - Prove same-revision and transition behavior in browser tests

Add focused integration/E2E assertions:

- a forced server refresh with unchanged capture retains visible revision and
  performs no destination network request;
- a changed capture commits one complete destination state;
- rapid destination/filter changes show only the latest result;
- a revision-expired response recovers once without blanking the old report;
- Session page/drawer data never crosses revisions.

Use request counters/interception rather than timing assumptions.

## Test plan

```sh
bun test apps/web/src/served-report-session.test.ts \
  apps/web/src/focused-report-client.test.ts \
  apps/web/src/session-query-client.test.ts \
  apps/web/src/dashboard-model.test.ts \
  apps/web/src/dashboard-search.test.ts
bun run --cwd apps/web test
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e-production
```

## Done criteria

- One module owns the complete served destination transition.
- Dashboard contains no per-destination revision retry/commit protocol.
- Stale destination, scope, or refresh results cannot commit.
- Expiry retries exactly once.
- Session/focused state commits atomically for one revision.
- Same active revision/capture/destination fingerprint causes no destination
  query or cache reset; a changed destination/scope on that revision does query.
- Previous visible state survives failed replacement.
- Demo/initial payload and URL behavior remain unchanged.

## STOP conditions

- The extraction changes URL/filter semantics or public query shapes.
- A browser module imports server-only code or `bun:sqlite`.
- Canonical request fingerprints are replaced by custom object/string equality.
- Both old and new layers retain independent retry/commit ownership.
- Previous state is cleared before a complete replacement is ready.
- Same-revision detection ignores semantic/manifest or canonical
  destination/scope fingerprint validation.
- Tests require real sleeps instead of deterministic deferred work.

## Maintenance note

Every future served destination must implement a typed destination codec for this
one session owner. UI components express intent and render outcomes; they do not
reimplement revision, expiry, supersession, or atomic commit protocols.
