# Plan 075: Show Bundle Identity, Age, and Warnings in the /sync Import Preview

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- packages/usage-merge/src/index.ts packages/usage-engine-runtime/src/live.ts packages/usage-engine-control/src/contracts.ts apps/web/src/lib/features/sync/manual-transfer.svelte`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

The `/sync` import preview is the highest-consequence confirm dialog in the
product: it authorizes a mutation of the sole-writer usage store. Today it
shows row/byte counts and insert/update/supersede/delete effects, but not
**which machine the bundle came from**, **when it was generated**, or **what
its warnings say** — the three facts that determine whether `superseded: 40`
is expected (an old snapshot from my MacBook) or alarming (the wrong file).
The data already exists at the service layer and is dropped at the command
boundary; this plan transports it to the UI. It is the top "Manual Transfer"
item in `docs/future-work.md` ("Improve `/sync` file import review with
clearer bundle identity, generated-at, row-count, and conflict summaries
before the user confirms a bounded import").

## Current state

Data flow: web upload → engine command `preview-merge` → merge service →
`UsageEngineMergePreviewOutput` → strict browser parse → preview panel.

- `packages/usage-merge/src/index.ts` — the merge service **already returns
  everything we need**:
  - lines 17–24: `ManualMergePreviewResult extends ImportResult, MergePreviewProof`
    with `bytes`, `generatedAt`, `machine: UsageMachine`, `rows`,
    `warningCount`, `warningItems: string[]`.
  - lines 60–61: bounds already enforced —
    `MAX_MANUAL_MERGE_PREVIEW_WARNINGS = 20`,
    `MAX_PREVIEW_WARNING_CHARACTERS = 512`.
  - lines 177–192: the preview populates `generatedAt: bundle.generatedAt`,
    `machine: bundle.machine`, and whitespace-normalized, truncated
    `warningItems`.
- `packages/usage-engine-runtime/src/live.ts` lines 739–767 — `previewMerge`
  builds the command output and **drops** `generatedAt`, `machine`, and
  `warningItems`: the returned object has exactly
  `bytes, confirmationToken, documentDigest, kind, result{deleted, fleetChanged, inserted, superseded, unchanged, updated, warnings}, rows, warningCount`.
- `packages/usage-engine-control/src/contracts.ts`:
  - lines 805–821: `UsageEngineMergeImportResult` (numbers only; `warnings`
    is a count) and
    `UsageEngineMergePreviewOutput extends MergePreviewProof { bytes; kind: 'merge-preview'; result; rows; warningCount; }`.
  - line 954: `parseUsageEngineMergePreviewOutput` validates with
    `hasExactKeys(value, ['bytes', 'confirmationToken', 'documentDigest', 'kind', 'result', 'rows', 'warningCount'])`
    — any new field must be added here or the browser rejects the response.
- `packages/report-core/src/merge-proof.ts` lines 39–54:
  `parseMergePreviewProof` requires **exactly** `confirmationToken` +
  `documentDigest` (keys.length !== 2 → throw). The proof object stays
  2-key; the new fields ride on the preview output, never on the proof.
- `apps/web/src/lib/features/sync/manual-transfer-client.ts` line 249: the
  preview upload parses with `parseUsageEngineMergePreviewOutput`; line 218:
  confirm sends only the proof headers
  (`x-ai-usage-merge-confirmation`, `x-ai-usage-merge-digest`).
- `apps/web/src/lib/features/sync/manual-transfer.svelte` lines 224–253 — the
  preview panel renders `preview.file.name`, `preview.data.rows`, bytes, the
  six counters, and `preview.data.warningCount` as a bare number, then
  Confirm/Cancel.
- `packages/usage-engine-runtime/src/runtime.test.ts` line 158: a
  `mergePreview: UsageEngineMergePreviewOutput` literal that must gain the
  new fields to keep typechecking.
- Vocabulary (`CONTEXT.md`): **Merge bundle** = "a portable, versioned file
  of normalized machine-scoped usage facts"; **Manual transfer** = "an
  explicit export, out-of-band file copy, and import". Use "merge bundle" in
  copy, never "snapshot".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Package tests | `bun test packages/usage-engine-control packages/usage-engine-runtime packages/usage-merge` | all pass |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| Full gate | `bun run test` | all pass |

## Scope

**In scope**:
- `packages/usage-engine-control/src/contracts.ts` (+ its test file)
- `packages/usage-engine-runtime/src/live.ts`
- `packages/usage-engine-runtime/src/runtime.test.ts`
- `apps/web/src/lib/features/sync/manual-transfer.svelte`
- `apps/web/src/lib/features/sync/manual-transfer-client.test.ts` (if it
  asserts the parsed preview shape)

**Out of scope** (do NOT touch):
- `packages/report-core/src/merge-proof.ts` — the 2-key proof and the
  preview→confirm token binding are a security seam; adding fields there
  breaks `parseMergePreviewProof` on purpose.
- `packages/usage-merge/src/index.ts` — it already returns the data; no
  change needed.
- `packages/usage-store/**` — the store-side preview/confirm transaction
  (plan 040 territory) is untouched.
- The confirm path payload/headers — confirmation semantics do not change.

## Git workflow

- Commit style: `fix(sync): show bundle identity before merge confirmation`
  (matches `b74a91ad fix(sync): make manual transfers usable and truthful`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend the command contract

In `packages/usage-engine-control/src/contracts.ts`:

- Extend `UsageEngineMergePreviewOutput` (line 815) with:
  ```ts
  readonly bundle: {
    readonly generatedAt: string;
    readonly machineId: string;
    readonly machineLabel: string;
  };
  readonly warningItems: readonly string[];
  ```
- Update `parseUsageEngineMergePreviewOutput` (line 954): add `bundle` and
  `warningItems` to the `hasExactKeys` list; validate `bundle` has exactly
  `generatedAt`/`machineId`/`machineLabel`, each a non-empty string, with
  `generatedAt` parseable by `Date.parse` and `machineLabel` length-capped
  (≤ 120 chars — reject longer, matching the strict-parse style of the
  surrounding validators); validate `warningItems` is an array of ≤ 20
  strings each ≤ 512 chars (mirror the bounds from
  `packages/usage-merge/src/index.ts:60–61`). Follow the exact
  fail-with-message style of the existing parser branches.

**Verify**: `bun test packages/usage-engine-control` → existing contract tests fail only where the fixture lacks the new fields (fix those fixtures in the same commit), then all pass.

### Step 2: Populate the fields at the engine boundary

In `packages/usage-engine-runtime/src/live.ts` (previewMerge, lines
739–767): add to the returned object

```ts
bundle: {
  generatedAt: preview.generatedAt,
  machineId: preview.machine.id,
  machineLabel: preview.machine.label,
},
warningItems: preview.warningItems,
```

(Check the `UsageMachine` field names in
`packages/report-core` before writing — if they are not `id`/`label`, STOP
and report.) Update the `mergePreview` literal in
`packages/usage-engine-runtime/src/runtime.test.ts:158` accordingly.

**Verify**: `bun run typecheck` → exit 0; `bun test packages/usage-engine-runtime` → all pass.

### Step 3: Render identity, age, and warnings in the preview panel

In `apps/web/src/lib/features/sync/manual-transfer.svelte` (preview block,
lines 224–253):

- Above the counters line, add a bundle-identity line:
  `From {machineLabel} · generated {formatted generatedAt}` — format the
  timestamp with the date formatting already used in this feature area (grep
  `Intl.DateTimeFormat` under `apps/web/src/lib/features/sync/`; if none,
  use the formatter pattern from
  `apps/web/src/provider-status-model.ts:94–100`). Keep the machine label as
  plain text interpolation (Svelte escapes it; do not use `{@html}`).
- Replace the bare `{preview.data.warningCount} warnings` with: when
  `warningCount === 0`, keep "0 warnings"; otherwise render a
  `<details>` whose `<summary>` is `{warningCount} warnings` and whose body
  lists `warningItems`, appending "and N more" when
  `warningCount > warningItems.length`.
- Match the existing Panda class usage in the file (`panelSub`, `strongCell`,
  `operationPanel`) — no new css() blocks unless a list style is genuinely
  missing.

**Verify**: `bun run --cwd apps/web test` → all pass; `bun run typecheck` → exit 0.

### Step 4: Full gates

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run test` → all pass. If `apps/web/e2e/` has a sync spec exercising the preview (check `grep -rln "Review merge import" apps/web/e2e/`), run it: `cd apps/web && bun run test:e2e -- <spec>` → passes.

## Test plan

- Contract: new cases in the `usage-engine-control` contract tests —
  valid output with `bundle` + `warningItems` parses; missing `bundle`,
  oversized label, > 20 warning items, > 512-char item each rejected.
  Pattern: the existing `parseUsageEngineMergePreviewOutput` rejection tests
  in that package.
- Runtime: the updated `runtime.test.ts` fixture proves the executor threads
  the fields through.
- UI: if `manual-transfer` has a component/SSR test asserting the preview
  panel, extend it with the identity line and the warnings disclosure;
  otherwise add assertions to the closest existing sync test file.

## Done criteria

- [ ] `grep -n "warningItems" packages/usage-engine-control/src/contracts.ts packages/usage-engine-runtime/src/live.ts apps/web/src/lib/features/sync/manual-transfer.svelte` → one hit in each
- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0, including the new contract rejection cases
- [ ] The preview panel source renders machine label + generatedAt before the Confirm button
- [ ] `packages/report-core/src/merge-proof.ts` is unmodified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- `UsageMachine` does not expose `id`/`label` as assumed in Step 2.
- `parseUsageEngineMergePreviewOutput`'s `hasExactKeys` helper cannot express
  a nested object without new helper machinery — report rather than
  hand-rolling a divergent validation style.
- Any change appears to be needed to the confirm path, the proof shape, or
  `usage-store` — that is out of scope by design.
- A sync e2e spec pins the current preview panel text in a way that suggests
  the panel layout is load-bearing for another plan's assertions.

## Maintenance notes

- The 20/512 warning bounds are duplicated as literals in the contract
  validator (Step 1) and in `usage-merge` (source of truth). If
  `MAX_MANUAL_MERGE_PREVIEW_WARNINGS` changes, both must move — a reviewer
  should ask whether to export the constants from `usage-merge` instead
  (kept out of scope here to avoid a new cross-package dependency edge;
  check `docs/public-package-interfaces.md` before adding one).
- Follow-up deliberately deferred: a per-machine conflict summary (which
  existing machine rows each `superseded` count touches) — needs a
  store-side query, not just transport.
