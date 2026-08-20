# Plan 079: Drive Cursor Import and Machine Renaming From the Web

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- apps/web/src/lib/features/sync/ apps/web/src/server/manual-merge-upload.server.ts apps/web/src/server/campaign-labels.server.ts packages/usage-engine-control/src/contracts.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: M (two S-sized halves)
- **Risk**: LOW–MED
- **Depends on**: none (plan 075 touches neighboring sync files — coordinate
  or execute sequentially)
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

Two engine capabilities are fully wired at the contract level but reachable
only from the CLI. (1) Cursor is one of four supported harnesses, yet its
usage-events CSV can only be ingested via `ai-usage cursor import <csv>` in a
terminal — while the `/sync` page already has a drop-zone speaking the exact
same staged-file command protocol. (2) Machine labels are the readable
identity across the fleet view, quota rail, and merged reports, and the web
reads `machineLabel` in half a dozen places but can never write it; a user
who never touches the CLI is stuck with raw machine IDs. Both are
"one button away" from shipped infrastructure.

## Current state

**Contracts — already done, do not modify:**

- `packages/usage-engine-control/src/contracts.ts`:
  - line 286: engine command `{ command: 'set-machine-label'; label: string }`
    (validated at lines 553–558).
  - lines 338–351: `WebUsageEngineCommand` **already includes**
    `{ command: 'import-cursor' | 'preview-merge'; input: UsageEngineInboxFileInput }`
    and inherits path-free commands via `UsageEngineCommandWithoutWebPaths`
    (verify `set-machine-label` is in that subset; it takes no filesystem
    path so it should be — if not, STOP).
  - line 823: `UsageEngineCursorImportOutput` (fields `alreadyImported`,
    `artifactName`, `kind: 'cursor-import'` — see
    `packages/usage-engine-runtime/src/live.ts:731–735`).

**Half A — Cursor import via /sync:**

- `apps/web/src/server/manual-merge-upload.server.ts` — the action seam:
  - line 106: `type ParsedManualMergeAction = { action: 'preview' } | ({ action: 'confirm' } & MergePreviewProof);`
  - lines 109–121: parses the `x-ai-usage-merge-action` header; anything but
    `preview`/`confirm` is rejected.
  - lines 152–158: `commandFor` maps action → `preview-merge` /
    `confirm-merge` with `staged.input`.
  - lines 211–212: `completionResponse` checks
    `expectedCommand = action === 'preview' ? 'preview-merge' : 'confirm-merge'`.
- `apps/web/src/lib/features/sync/manual-transfer-client.ts`:
  - lines 193–232: `upload(file, action, parseValue, ...)` sets the header
    and size bounds (`MAX_PORTABLE_USAGE_BYTES`).
  - lines 234–250: client methods `confirm` / `download` / `preview`.
- `apps/web/src/lib/features/sync/manual-transfer.svelte` — the drop zone
  (lines 193–223) and preview/confirm UI; `ManualTransferProgress` handles
  upload progress.
- CLI semantics to mirror: `apps/cli/src/cli.ts:153`
  (`cursor import <csv>  import a cursor.com usage-events CSV export`),
  `apps/cli/src/app.ts:340–344` (issues `import-cursor`, succeeds on
  completion `state === 'succeeded' && command === 'import-cursor'`).
  Note `runtime-command-policy.ts:21`: `import-cursor` is
  `interruptible: false` — the UI must not offer cancel mid-import.

**Half B — machine label editing:**

- `apps/web/src/server/campaign-labels.server.ts` — the exemplar for a
  web-issued engine mutation: builds the command via
  `parseWebUsageEngineCommand({ command: 'set-campaign-label-override', ...mutation })`
  (lines 18, 46–47) and executes it to completion. Mirror this file.
- `apps/web/src/lib/features/report/actions/campaign-label-editor.svelte` —
  the inline-edit UI pattern to copy (edit/save/cancel, pending state).
- `apps/web/src/lib/features/sync/machine-fleet.svelte` — the fleet list
  (`<h2>Machine fleet</h2>`, `fleetGrid`, bounded-view note at line 114).
  Labels render read-only today.
- CLI semantics: `apps/cli/src/app.ts:233–235` issues
  `{ command: 'set-machine-label', label }`.
- Find how the browser reaches server mutations: grep how
  `campaign-labels.server.ts` is exposed (`grep -rn "campaign-labels" apps/web/src/lib/server/rpc/`)
  and register the machine-label procedure the same way (oRPC contract in
  `packages/web-contract` if the campaign one lives there — follow the
  existing registration end to end).
- Mutation availability: `apps/web/src/lib/features/report/actions/report-mutation-availability.ts`
  gates mutations when the engine is unreachable; the fleet editor must use
  the same availability signal as the manual-transfer UI
  (`mutationAvailable` in `manual-transfer.svelte`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| Contract tests | `bun test packages/usage-engine-control packages/web-contract` | all pass |
| E2e | `bun run test:e2e` | all pass |

## Scope

**In scope**:
- `apps/web/src/server/manual-merge-upload.server.ts` (+ test)
- `apps/web/src/lib/features/sync/manual-transfer-client.ts` (+ test)
- `apps/web/src/lib/features/sync/manual-transfer.svelte`
- `apps/web/src/lib/features/sync/machine-fleet.svelte`
- New: `apps/web/src/server/machine-label.server.ts` (+ test), its oRPC
  registration files (mirroring the campaign-label registration), and a
  small fleet label editor component under `apps/web/src/lib/features/sync/`
- `packages/web-contract/src/*` only for the new machine-label procedure

**Out of scope** (do NOT touch):
- `packages/usage-engine-control/src/contracts.ts` and the engine runtime —
  both commands already exist end to end.
- The CLI.
- Merge preview/confirm semantics (plan 075's territory).
- Machine identity creation (`machine.json`) — labels only.

## Git workflow

- Commit per half: `feat(sync): import Cursor usage exports from the web`,
  then `feat(sync): rename machines from the fleet view`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend the upload action seam with `cursor`

In `manual-merge-upload.server.ts`: extend `ParsedManualMergeAction` with
`{ readonly action: 'cursor' }`; accept header value `cursor` (no proof);
`commandFor` maps it to `{ command: 'import-cursor', input: staged.input }`;
`completionResponse` expects completion command `import-cursor` and returns
the parsed `UsageEngineCursorImportOutput` as JSON. Extend the module's
test file with: header `cursor` → import-cursor command issued; success
response carries `alreadyImported`/`artifactName`; unknown header still 4xx.

**Verify**: the manual-merge-upload server test file passes.

### Step 2: Client method and UI action

- `manual-transfer-client.ts`: add
  `importCursor(file, signal?, onProgress?)` calling `upload(file, 'cursor', parseCursorImportOutput, ...)`
  (write the small parser against `UsageEngineCursorImportOutput`; reject
  unknown keys, matching `parseNone`/`parseUsageEngineMergePreviewOutput`
  style). Note the CSV file bound: reuse the existing size gate; if
  `MAX_PORTABLE_USAGE_BYTES` is JSON-specific, check what bound the CLI
  applies to cursor CSVs (`grep -rn "cursor" packages/usage-engine-control/src/handoff*` )
  and STOP if none exists.
- `manual-transfer.svelte`: add a second, clearly separated action:
  a "Import a Cursor usage CSV" file button (accept `.csv,text/csv`) with
  its own explanatory line ("From cursor.com → usage events export. Copied
  into local ignored storage, then collected like any other source."). On
  success, show `alreadyImported ? 'Already imported.' : 'Import staged as <artifactName>. Collection picks it up automatically.'`
  in the existing notice area. No cancel button while pending (the command
  is non-interruptible).

**Verify**: `bun run --cwd apps/web test` → all pass; `bun run typecheck` → exit 0.

### Step 3: Machine-label server procedure

Create `apps/web/src/server/machine-label.server.ts` mirroring
`campaign-labels.server.ts`: validate `{ label: string }` (trimmed,
non-empty, length-capped to the engine contract's bound — read the
`set-machine-label` validation at `contracts.ts:553–558` for the exact
limit), build via
`parseWebUsageEngineCommand({ command: 'set-machine-label', label })`,
execute to completion, return the completion state. Register it through the
same oRPC path as the campaign-label mutation (follow that registration file
for file placement, naming, and error mapping). Add a server test mirroring
the campaign-labels server test.

**Verify**: `bun run typecheck` → exit 0; new server test passes.

### Step 4: Inline label editor in the fleet view

In `machine-fleet.svelte`, render the local machine's row label with an edit
affordance modeled on `campaign-label-editor.svelte` (pencil → input +
Save/Cancel, pending state, error notice). Only the **local** machine is
editable — the engine command labels this machine; rows for other machines
from merge bundles stay read-only (their labels travel with their bundles).
Determine which fleet entry is local from the fleet data (grep the fleet
result shape for a `local` marker or compare against the support bootstrap's
machine id; if neither exists, STOP and report). After a successful rename,
refresh the fleet query so the new label renders (follow how the campaign
label editor invalidates its query).

**Verify**: `bun run --cwd apps/web test` → all pass.

### Step 5: Gates + e2e

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run test && bun run test:e2e` → all pass. The e2e sync spec (if one covers `/sync`) must still pass; add an assertion that the Cursor action renders with the merge drop-zone (the synthetic runtime cannot execute a real import — assert presence, not completion).

## Test plan

- Server: action `cursor` mapping + completion parsing; label validation
  (empty, overlong, whitespace-only rejected).
- Client: `importCursor` sets the right header and parses output; oversized
  file short-circuits before upload.
- UI: SSR/component render of the new action and the label editor states
  (view → editing → pending), following existing sync component tests.

## Done criteria

- [ ] `grep -n "'cursor'" apps/web/src/server/manual-merge-upload.server.ts` → action present
- [ ] `grep -rn "set-machine-label" apps/web/src/server | grep -v test` → 1 production module
- [ ] `bun run typecheck` exits 0
- [ ] `bun run --cwd apps/web test` exits 0 with the new cases
- [ ] `bun run test:e2e` exits 0
- [ ] `packages/usage-engine-control/src/contracts.ts` unmodified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- `set-machine-label` is not part of `UsageEngineCommandWithoutWebPaths`
  (the web command parser rejects it) — extending the *web* command union is
  an engine-contract decision; report instead of patching.
- The staged-inbox handoff enforces a JSON shape that rejects CSV bytes —
  cursor import may need its own staging bound; report what
  `stageUsageEngineHandoff` actually validates.
- The fleet view cannot identify the local machine from existing data.
- The request-policy layer (`request-policy-handler`) rejects the new action
  in a way that requires loosening a security gate — report; never widen a
  policy to make a feature fit.

## Maintenance notes

- Both halves reuse the engine's completion protocol; if command completion
  shapes change, the two new parsers are the web's only cursor/label
  coupling points.
- Reviewer should scrutinize: the non-interruptible import UX (no cancel),
  the local-machine-only edit gate, and that no policy/validation was
  weakened at the upload seam.
- Deferred: labeling *remote* machines locally (a presentation-only alias
  map) — a separate product decision; today labels travel with bundles.
