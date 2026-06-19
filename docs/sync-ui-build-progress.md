# Sync UI Build Progress

This log tracks the implementation of `docs/sync-ui-build-plan.md`.

## 2026-06-19

### Phase 0: Setup And Codebase Reading

Status: completed.

Intent:

- read the LAN sync UI build plan and the existing report/sync code;
- keep a slice-by-slice implementation journal separate from the previous decoupling log;
- preserve user and generated work already present in the repository.

Decisions:

- use this file as the build tracker for route/UI/server lifecycle work;
- treat `docs/sync-ui-build-plan.md` as existing user-provided planning work because it is currently untracked;
- start with slice 1 because it creates the visible route and navigation surface needed by later slices.

Difficulties:

- `rg` is not installed in the environment, so repository searches use `find`/`grep`.

Checks:

- `bun --filter @ai-usage/report check` passed after slice 1 changes.

Commit:

- included with phase 1 route/navigation commit.

### Phase 1: Route And Navigation

Status: completed.

Intent:

- add a visible dashboard navigation control to `/sync`;
- add a dedicated TanStack Router `/sync` file route;
- render a static operational shell that later slices can connect to sync state and mutations.

Decisions:

- added report-specific `headerActions` and `navButton` styles in the design-system report exports;
- kept the initial `/sync` page dense and operational: serve status, sync summary, remotes, and discovery sections;
- generated `apps/report/src/routeTree.gen.ts` through `@tanstack/router-generator` instead of editing it by hand;
- preserved the existing TanStack Start route tree footer during generation.

Difficulties:

- the first check failed because `/sync` was not yet in the TanStack route type registry;
- the dashboard return link from `/sync` must pass dashboard search defaults because the index route has typed search parameters.

Checks:

- `bun --filter @ai-usage/report check` passed.

Commit:

- this phase commit records the initial `/sync` route and dashboard navigation.

### Phase 2: Read-Only Sync State

Status: completed.

Intent:

- load `getSyncState` from the `/sync` route;
- render local machine identity, configured remotes, stored snapshot summaries, and sync warnings;
- add focused model coverage for summary counts and display labels.

Decisions:

- introduced `apps/report/src/sync-page-model.ts` for pure summary and formatting helpers;
- kept start/remote mutation controls non-functional until their dedicated slices;
- added an explicit refresh action for the sync state instead of polling.

Difficulties:

- route state is returned as `{ ok, data/error }`, so the component narrows the result before rendering the success and error branches;
- the static shell had grown large enough that replacing the route content was clearer than patching the placeholder markup in place.

Checks:

- `bun test apps/report/src/sync-page-model.test.ts` passed.
- `bun --filter @ai-usage/report check` passed.

Commit:

- this phase commit records the read-only sync state page.

### Phase 3: Remote Mutations

Status: completed.

Intent:

- add and edit persistent snapshot remotes from `/sync`;
- validate endpoints with an optional one-time token that is not persisted;
- enable, disable, pull, and remove configured remotes from the table;
- render workflow and transport errors without exposing Effect internals to UI components.

Decisions:

- kept the edit form from renaming remotes by disabling the name field while editing;
- used server function `{ data }` calls for all POST mutations;
- kept operation feedback process-local in component state and refreshed `SyncState` from mutation results;
- mapped known workflow reasons to short recovery hints in `sync-page-model.ts`.

Difficulties:

- the server function signatures were only exercised through typechecking because there were no existing UI callers;
- remove uses browser confirmation, so the handler guards `window` for SSR safety.

Checks:

- `bun test apps/report/src/sync-page-model.test.ts` passed.
- `bun --filter @ai-usage/report check` passed.
- `bun test packages/sync/src/workflow.test.ts` passed.

Commit:

- this phase commit records remote management mutations on `/sync`.
