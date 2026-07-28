# Plan 051: Allow local campaign label overrides

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report; do not widen this into portable
> grouping. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 45aee4f..HEAD -- packages/report-core/src/session-query.ts packages/report-core/src/project-alias.ts packages/local-collectors/src/machine-config.ts apps/web/src/dashboard.tsx apps/web/src/dashboard-model.ts apps/web/src/overview.tsx apps/web/src/overview-model.ts apps/web/src/time-range-control.tsx apps/web/src/session-analysis-target.ts apps/web/src/session-drawer.tsx apps/web/src/server/report-payload.ts apps/web/src/server/report-payload.server.ts`
> If these campaign identity, presentation, config, or mutation seams changed,
> compare the current state below with live code before proceeding. A semantic
> mismatch is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plan 045
- **Category**: direction
- **Planned at**: commit `45aee4f`, 2026-07-27

## Why this matters

Plan 045 now derives readable campaign labels, so manual naming is an occasional
escape hatch rather than a prerequisite. Project groups already support local
creation and renaming in `ProjectGroupEditor`; do not duplicate that feature.
The only missing low-cost capability is to replace one derived campaign label on
this machine and restore the derived label later.

This plan is deliberately not the rejected plan 047. A label override does not
join campaigns, change campaign identity, travel with sessions, or require merge
semantics. It is local presentation state with one rule:

```ts
const label = localOverride ?? derivedLabel;
```

## Current state

- Campaign identity is already stable and machine-scoped in
  `packages/report-core/src/session-query.ts:980-999`:

  ```ts
  export const sessionCampaignKeyFor = (row, rootSourceSessionId) =>
    [row.source?.machineId ?? 'local', row.source?.harnessKey ?? row.harness, rootSourceSessionId].join(':');
  ```

  Use this opaque `campaignKey` unchanged. Do not parse it or invent another id.

- Campaign presentation still reads the root label directly. The focused
  timeline uses `campaign.root.sessionLabel` in
  `packages/report-core/src/session-query.ts:1118-1129`; the web fallback writes
  it into the display row in `apps/web/src/dashboard-model.ts:317-365`; Overview
  reads it in `apps/web/src/overview-model.ts:610-625`.

- Local project-group renaming already exists in
  `apps/web/src/project-group-editor.tsx:249-258,333-351` and is written atomically
  to the home config by `saveProjectGroupsForServer` in
  `apps/web/src/server/report-payload.server.ts:93-102`. Project naming is not a
  gap for this plan.

- `readMergedAiUsageConfigFrom` overlays repo config on home config in
  `packages/local-collectors/src/machine-config.ts:411-478`. The same file rejects
  repo-level `sourcePolicies` at `:454-465`. Campaign label overrides must follow
  that home-only restriction, not the two-scope `projectGroups` behavior.

- `TimeRangeControl` already applies a client-side display mapping for machine
  series in `apps/web/src/time-range-control.tsx:455-470`. Campaign labels should
  use the same presentation-only pattern. Campaign timeline series use the
  `campaign:${campaignKey}` prefix from
  `packages/report-core/src/session-query.ts:1118-1129`; strip only that known
  prefix and keep the opaque campaign key and filter values unchanged.

- `Dashboard` in `apps/web/src/dashboard.tsx` is the composition owner. It builds
  local campaign views at `:481-500`, chooses local versus served table rows at
  `:501-503`, and passes data to Overview, `TimeRangeControl`, and
  `SessionDrawer`. It must own one campaign-label controller and pass narrow
  presentation callbacks to those consumers; no leaf component should fetch
  config independently.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Core tests | `bun test packages/report-core/src/campaign-label.test.ts` | all pass |
| Config tests | `bun test packages/local-collectors/src/machine-config.test.ts` | all pass |
| Web unit tests | `bun test apps/web/src/campaign-label-overrides.test.ts apps/web/src/dashboard-model.test.ts apps/web/src/overview-model.test.ts apps/web/src/time-range-control.test.ts` | all pass |
| Server tests | `bun test apps/web/src/server/campaign-labels.server.test.ts apps/web/src/server/demo-boundary.server.test.ts` | all pass |
| Drawer render tests | `bun test apps/web/src/session-drawer.render.test.tsx` | all pass |
| Focused browser test | `bun run --cwd apps/web test:e2e -- e2e/campaign-label-overrides.spec.ts` | scenario passes |
| Check | `bun run check` | Ultracite exits 0 |
| Boundaries | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | all tasks pass |
| Full tests | `bun run test` | all pass |
| Browser | `bun run test:e2e` | all pass |
| Demo privacy | `bun run test:e2e-demo` | all pass |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run `bun install`. Before browser tests, check for an attributable stray
Vite server as documented in the repository handoff. Use only temporary homes and
synthetic fixtures; never read or modify the maintainer's real config or history.

## Scope

**In scope**:

- A small validated `CampaignLabelOverride { campaignKey, label }` domain and
  parser under `packages/report-core/src/`, exported as a specific package
  subpath.
- A bounded, duplicate-free `campaignLabelOverrides` list in the home
  `AiUsageConfig`.
- Home-only read, rename, and reset server functions.
- One `createCampaignLabelController` owned by `Dashboard`, with an injected API
  seam for synthetic browser coverage.
- Client-side presentation of the override in Sessions, Overview, the campaign
  timeline, and the campaign drawer.
- Unit, config, render, and synthetic E2E coverage for those paths.

**Out of scope**:

- Campaign groups, membership, or combining campaigns across machines.
- Any change to `sessionCampaignKeyFor`, collector-derived labels, usage rows,
  exact revision fingerprints, or filter keys.
- `usage-store`, snapshots, merge bundles, `/sync`, causal versions, conflicts,
  or portability of names.
- Project-group types, matching, persistence, output, or repo-config precedence.
- CLI, CSV, JSON, and export presentation; campaigns are the web reading unit.
- `apps/web/playwright.config.ts`, its worker count, retries, and timeouts.

## Git workflow

- Use a separate branch after the multidimensional-reporting PR merges:
  `feat/local-campaign-labels`.
- Prefer one implementation commit, with an imperative message such as
  `Allow local campaign label overrides`.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Define and validate the home-only override

1. Add `packages/report-core/src/campaign-label.ts` and its test. Model an
   override as `{ campaignKey: string; label: string }`. The mutation parser
   trims labels; the stored-list parser accepts only that canonical form. Reject
   empty values and use these exact limits:
   `MAX_CAMPAIGN_LABEL_OVERRIDES = 5_000`,
   `MAX_CAMPAIGN_LABEL_LENGTH = 256`,
   `MAX_CAMPAIGN_KEY_BYTES = 64 * 1024`, and
   `MAX_CAMPAIGN_LABEL_OVERRIDES_BYTES = MAX_SESSION_QUERY_RESULT_BYTES`.
   A key is an opaque derived identity: do not trim or normalize it; reject only
   the empty string, a UTF-8 byte length over `MAX_CAMPAIGN_KEY_BYTES`, or an
   exact duplicate. The POST input trims labels before checking emptiness and
   `String.length`; the stored config representation is canonical and rejects a
   label when `label !== label.trim()`. The same label may be used by different
   campaigns. Apply the aggregate byte limit to
   `TextEncoder().encode(JSON.stringify(validatedList)).byteLength`, after
   canonical validation. Test both exact per-field boundaries and a list that
   exceeds the aggregate limit.
2. Export the module from `packages/report-core/package.json` and add
   `campaignLabelOverrides?: CampaignLabelOverride[]` to `AiUsageConfig` in
   `packages/report-core/src/project-alias.ts`.
3. Validate the canonical field in `machine-config.ts`; do not silently
   normalize hand-edited home config during reads. In `readRepoAiUsageConfig`,
   reject any repo config that declares it, just as repo-level `sourcePolicies`
   is rejected. Preserve it during unrelated home-config updates.
4. Add tests for valid home values, empty/oversized/duplicate rejection, home
   preservation, and explicit repo-level rejection.

**Verify**:
`bun test packages/report-core/src/campaign-label.test.ts packages/local-collectors/src/machine-config.test.ts`
→ all cases pass.

### Step 2: Add a narrow local read/write boundary

1. In `apps/web/src/server/report-payload.ts`, export
   `getCampaignLabelOverrides` (GET) and `setCampaignLabelOverride` (POST). Put
   their implementations in `report-payload.server.ts` as
   `getCampaignLabelOverridesForServer` and
   `setCampaignLabelOverrideForServer`. Both return exactly
   `{ campaignLabelOverrides: CampaignLabelOverride[] }`.
2. The GET implementation reads `readAiUsageConfig`, never
   `readMergedAiUsageConfig`, and returns the validated list. The POST validator
   accepts exactly `{ campaignKey, label: string | null }`; a string upserts and
   `null` resets/removes. Parse at the server boundary, then use
   `updateAiUsageConfig` so unrelated config fields survive and writes remain
   atomic. Replace an existing key in place, append a new key, and preserve all
   other ordering. Reset removes the matching entry; when it removes the final
   entry, omit the optional config field rather than writing `[]` (the response
   still returns an empty list).
3. Keep this state outside report revisions. A successful mutation returns the
   complete next override list so the client can update immediately; it must not
   schedule collection, publication, or a report refresh.
4. Give each `*ForServer` function an optional
   `LocalHistoryStorageService = createLocalHistoryStorage()` parameter, matching
   the existing server seams, and use it for every `readAiUsageConfig` and
   `updateAiUsageConfig` Effect. Add
   `apps/web/src/server/campaign-labels.server.test.ts` with a temporary storage
   for GET, rename, reset, ordering, bounds, final-field omission, fresh-GET
   persistence, and unrelated-field preservation.
5. Wrap both public server functions in the existing private
   `runLiveServerFunction`. Do not expose a new demo seam:
   `apps/web/src/server/demo-boundary.server.test.ts` already proves every
   `/_serverFn` request is rejected before a live adapter loads, while the
   controller tests below prove demo/E2E never initiate these calls.

**Verify**:
`bun test apps/web/src/server/campaign-labels.server.test.ts apps/web/src/server/demo-boundary.server.test.ts`
→ all tests pass and prove rename, reset, persistence, unrelated-field
preservation, and the shared demo boundary.

### Step 3: Give campaign presentation one local label owner

1. Add pure lookup/presentation helpers in
   `apps/web/src/campaign-label-overrides.ts`. They index the validated list,
   return `override ?? derived`, clone a served campaign display row only when its
   `campaignKey` has an override, and map only `campaign:` timeline series. For a
   focused Overview item whose `kind` is `campaign`, derive the existing opaque
   key with `sessionCampaignIdentityForRow(item.row).campaignKey`; do not widen
   `FocusedOverviewSessionItem` or any served payload. Never mutate a focused
   result or parse the campaign key itself.
2. Add `apps/web/src/campaign-label-controller.ts`. Its explicit state is
   a `loadStatus` of `idle | loading | ready | error`, a separate
   `mutationStatus` of `idle | saving | error`, and the last valid override list.
   It exposes `load`, `skipLoad`, `retryLoad`, `rename`, `reset`, `overrideFor`,
   and `labelFor`. `Dashboard` creates exactly one controller. Live mode loads
   the production API; E2E loads only its injected in-memory API; demo calls
   `skipLoad`, reaches `ready` with an empty list, makes no request, and hides the
   editor. A load failure and a mutation failure never erase the last valid list.
3. Add a Dashboard-owned `CampaignLabelContext` with exactly
   `{ campaignKey, derivedLabel }` to `createDashboardSessionSelection`. Populate
   it from raw data before any presentation clone:
   - local table campaigns use `campaign.campaignKey` and
     `campaign.root.sessionLabel`;
   - served table campaigns use the matching raw `SessionPageItem.campaignKey`
     and `item.row.sessionLabel`;
   - Overview campaign clicks pass a context built from the raw item, using the
     focused derivation in item 1 when necessary.
   Clear the context when selecting a child or ordinary session. Expose it as
   `selectedCampaignLabelContext` even when `selectedCampaign` is `null`, so a
   served campaign drawer keeps the editor and reset always uses the original
   derived label rather than a relabelled display row.
4. `Dashboard` keeps the controller last-valid list after each complete server
   response and wires presentation as follows:
   - pass `labelFor` into `buildCampaignViews`, add `label` to `CampaignView`, and
     have `campaignDisplayRow` use `campaign.label` for local rows;
   - derive served display rows with the pure clone helper before passing them to
     the table, while selection resolves label context from the raw page items;
   - pass `labelFor` to `Overview`, which presents local and focused campaign
     items without rewriting the focused result and passes raw label context on
     click;
   - pass a campaign-series presenter to `TimeRangeControl`, alongside its
     existing machine presenter;
   - combine `selectedCampaignLabelContext` with the controller and pass the
     effective label, override presence, status, and rename/reset/retry callbacks
     to `SessionDrawer`; the drawer must not infer them from a display row.
5. A load error leaves the last valid list (or the empty list) active and offers
   `Retry labels`, which calls `retryLoad`. A mutation error leaves the previous
   effective label active and is retried only by submitting Rename or Reset
   again. Disable both mutations while `mutationStatus` is `saving`, but do not
   block report navigation or presentation during either kind of error.
6. Do not relabel child sessions, change campaign/filter keys, or change server
   aggregates. Reset removes the entry and reveals the current derived root label
   immediately.

**Verify**: web unit tests show identical campaign keys/totals before and after a
rename, override priority on all four surfaces, and derived fallback after reset.

### Step 4: Add the drawer editor and regression coverage

1. In the campaign drawer, add one labelled input plus `Rename` and `Reset`
   buttons. Initialize the draft from the effective label whenever the selected
   campaign changes. `Rename` is disabled when the trimmed draft is empty or
   equals the current effective label. `Reset` is disabled when no override
   exists. A label already used by another campaign is valid. After rename/reset,
   replace the draft with the returned effective label, preserve keyboard
   operation, and keep the drawer open. Add a new `aria-live="polite"` operation
   status immediately below the editor controls; it shows load errors with
   `Retry labels`, mutation errors, and the pending state. Do not reuse or imply
   an existing drawer status area.
2. Add an optional `campaignLabelApi` dependency to `Dashboard`. Production live
   mode uses the two server functions. Add
   `apps/web/src/campaign-label-e2e-fixture.ts` with
   `createCampaignLabelE2EApi()`, returning a fresh closure-owned list for each
   call. `LoadedReport` in `apps/web/src/routes/index.tsx` creates one API per
   rendered E2E page and passes it to `Dashboard`; it passes none in demo or live
   mode. Do not use module-level mutable state or `globalThis`, so parallel
   workers and pages cannot share labels. The E2E API performs no network or
   local-config request, preserving plan 028 boundaries.
3. Put the colliding-root identity regression in pure unit coverage, using two
   campaign rows with the same root id and different machine or harness values;
   prove only the exact `campaignKey` is relabelled. Do not alter the shared demo
   report fixture merely to create this collision.
4. Add `apps/web/e2e/campaign-label-overrides.spec.ts` against the existing
   synthetic campaign. Rename it, close/reopen its drawer to prove page-local
   state, reset it, and prove the derived label returns. Server unit tests, not
   E2E, prove persistence across a fresh GET.
5. Assert the renamed label appears in Sessions, Overview, and the campaign
   timeline while the URL campaign filter continues to carry the unchanged key.

**Verify**:
`bun run --cwd apps/web test:e2e -- e2e/campaign-label-overrides.spec.ts` → the
focused scenario passes. Then run `bun run test:e2e` three consecutive times. All
three runs pass without retries or edits to Playwright configuration.

## Test plan

- Domain: bounds, trimming, duplicate keys, deterministic lookup.
- Config: home-only scope, repo rejection, unrelated-field preservation.
- Controller: production live API, per-page in-memory E2E API, skipped demo load,
  separate load/mutation errors, last-valid-state preservation, rename, and
  reset.
- Presentation: override/fallback parity for local and served display rows; same
  root id on different machine/harness remains isolated; served table and
  focused Overview selection retain raw `{ campaignKey, derivedLabel }` context.
- Mutation: rename and reset are atomic and return the full next list.
- Browser: fresh API per page, accessible controls and status, all campaign
  surfaces, unchanged campaign filter key, and no local-config request. Fresh-GET
  persistence is a server unit test.

## Done criteria

- [ ] A local override renders as `override ?? derived` everywhere a campaign
      label is shown in the web app.
- [ ] Reset removes the entry and restores the current derived label.
- [ ] Overrides are validated, bounded, duplicate-free, home-only, and preserved
      by unrelated config writes.
- [ ] Campaign identity, membership, totals, filters, and report revisions are
      unchanged.
- [ ] Project-group behavior and output are unchanged.
- [ ] No change touches `usage-store`, snapshots, merge bundles, `/sync`, or
      portable schemas.
- [ ] `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
      `bun run test:e2e`, and `bun run test:e2e-demo` pass.
- [ ] Three consecutive full `bun run test:e2e` runs pass.
- [ ] `git diff --check` is clean and `plans/README.md` is updated to `DONE` only
      after every criterion passes.

## STOP conditions

Stop and report instead of widening scope if:

- the same `campaignKey` is not stable across republication;
- an override would need to live on a usage row or alter a stored exact-revision
  artifact to render consistently;
- a requirement appears for the label to survive export/import or transfer;
- any implementation needs `usage-store`, snapshots, merge bundles, `/sync`, or
  conflict resolution;
- project-group scope, matching, precedence, or report output would change;
- repo config can supply or override `campaignLabelOverrides`;
- Overview, Sessions, timeline, and drawer cannot share the same presentation
  helper without changing server aggregation semantics;
- browser coverage would require changing Playwright workers, retries, or
  timeouts.

## Maintenance notes

Campaign identity remains a collected/derived fact; the override is local
presentation only. Reviewers should reject any future shortcut that copies the
label onto rows or portable data. If the maintainer later asks to combine campaigns
or transfer labels, that is a new product decision and must not revive plan 047's
distributed merge model implicitly.
