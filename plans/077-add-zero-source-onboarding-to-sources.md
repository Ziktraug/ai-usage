# Plan 077: Give /sources a First-Run Answer When Nothing Is Detected

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- apps/web/src/lib/features/sources/ packages/report-core/src/source-control.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

The first-run journey is half-built. The Overview empty state is polished and
tested (heading "No local usage yet", CTA linking to `/sources` — asserted in
`apps/web/e2e/dashboard-presentation.spec.ts`), but `/sources` itself has no
zero-detection branch: a new user on a machine where no harness history is
found lands on "Healthy sources (0)" plus deviation cards saying input is
missing, with no answer to "what do I install, and where does ai-usage
look?". This plan adds a first-run guidance panel to `/sources` that appears
exactly when no session source has detected input, listing the four
supported harnesses, their expected local history locations, and the
alternative path for data that lives on another machine (`/sync` import).

## Current state

- `apps/web/src/lib/features/sources/sources-page.svelte`:
  - lines 28–30: `liveSources` / `healthy = healthySources(liveSources)` /
    `deviations = deviationSources(liveSources)`.
  - lines 144–239: the `{#if snapshot}` branch renders the publication
    pipeline panel, the collapsed "Healthy sources" `<details>`, then one
    section per deviation group (`{#if grouped.length > 0}`). The only
    `{:else}` (line 237–238) covers *no snapshot yet* ("Connecting to the
    source control plane…"), not *nothing detected*.
  - lines 43–48: `groupOrder = ['sessions', 'provider-usage', 'enrichments']`
    with `groupLabels`.
- `apps/web/src/lib/features/sources/model.ts` lines 28–40: pure helpers
  `healthySources`, `deviationSources`, `sourceGroup`, `sourcesInGroup`
  (filter by `collectionSourceDefinitions` group). New pure logic belongs
  here, next to these.
- `packages/report-core/src/source-control.ts`:
  - lines 41–57+: `collectionSourceDefinitions` — the catalogue (`id`,
    `group`, `label`, `kind`, `cadenceMs`, `defaultEnabled`); session-group
    ids include `claude.sessions`, `codex.sessions` (read the full array for
    the exact list — there are four session sources).
  - lines 238–239: detection outcomes include `'input-missing'` and
    `'input-unreadable'`. Find the field on `SourceControlEntryView` that
    carries this (read the interface around line 277; `inputCount` is at
    line 277/289).
- Supported harness history locations (from `README.md` lines 9–14 — keep
  this copy in sync with that table):
  - Claude Code: `~/.claude/projects/**/*.jsonl` (+ `~/.claude.json`)
  - Codex: `~/.codex/sessions/**/*.jsonl`
  - OpenCode: `~/.local/share/opencode/opencode.db`
  - Cursor: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Precedent for "render absence, don't hide it": the quota rail labels
  (`apps/web/src/lib/features/shell/provider-quota-rail.ts`) and the
  per-metric provenance rule from `docs/future-work.md` ("carry data
  limitations per-metric").
- The e2e suite runs against the synthetic runtime; check
  `apps/web/e2e/sources.spec.ts` (or grep `Healthy sources` under
  `apps/web/e2e/`) for existing assertions on this page before changing
  markup.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| E2e | `bun run test:e2e` | all pass |

## Scope

**In scope**:
- `apps/web/src/lib/features/sources/model.ts` (+ its test file
  `presentation-model.test.ts` or the model test that covers these helpers —
  check where `healthySources` is tested)
- `apps/web/src/lib/features/sources/sources-page.svelte`
- `apps/web/src/lib/features/sources/styles.ts` (only if an existing style
  slot is genuinely missing)
- The relevant e2e spec under `apps/web/e2e/` (add assertions)

**Out of scope** (do NOT touch):
- `packages/report-core/src/source-control.ts` and every engine/collector
  layer — detection semantics do not change; this is presentation only.
- The CLI `setup` HTML server (`apps/cli/src/setup.ts`) — consolidating it
  into the web app is a separate spike, deliberately not this plan.
- The Overview empty state — already correct.

## Git workflow

- Commit style: `fix(sources): guide the first run when nothing is detected`
  (matches `71b9c3fa fix(sources): sanitize published warning details`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pure predicate in the model

In `apps/web/src/lib/features/sources/model.ts`, add:

```ts
export const noSessionInputDetected = (sources: readonly SourceControlEntryView[]): boolean => {
  const sessionSources = sourcesInGroup(sources, 'sessions');
  return (
    sessionSources.length > 0 &&
    sessionSources.every((source) => /* detection is input-missing/input-unreadable AND no inputCount > 0 */)
  );
};
```

Fill the predicate from the actual `SourceControlEntryView` detection field
(read the interface in `packages/report-core/src/source-control.ts` near
line 277 first). The intent: true only when **every** session source
reports its input as missing or unreadable and none has counted input.
Sources merely *disabled* do not count as "missing" — a user who disabled
sources on purpose must not see onboarding copy (express this as: a
disabled-but-previously-detected source makes the predicate false; check
which field distinguishes policy from detection — `CONTEXT.md`: "Policy is
independent from whether input is detected").

Add unit tests beside the existing model helper tests: all-missing → true;
one source with detected input → false; empty source list → false; one
disabled + rest missing → per the rule above.

**Verify**: the sources model test file passes with the new cases.

### Step 2: Render the guidance panel

In `sources-page.svelte`, inside the `{#if snapshot}` branch, immediately
after the publication pipeline section, add:

```svelte
{#if noSessionInputDetected(liveSources)}
  <section class={cx(panel, sourceCard)} data-first-run-guidance>
    <h2 class={groupTitle}>No local history detected yet</h2>
    <p class={meta}>
      ai-usage reads the session history that installed coding tools write on
      this machine. Use one of these tools once, then collection picks it up
      automatically:
    </p>
    <!-- one row per harness: label + expected location in a <code> -->
    <p class={meta}>
      Usage from another machine? Export a merge bundle there and import it
      on the <a href="/sync">Sync</a> page.
    </p>
  </section>
{/if}
```

Harness rows use the four locations from "Current state" (render paths in
`<code>`; plain text, no links to the filesystem). Reuse `panel`,
`sourceCard`, `groupTitle`, `meta`, and the `axes`/`axis` grid classes
already defined in this file (lines 63–82); add no new css() block unless a
list row style is genuinely missing. Note the Cursor path is macOS-shaped —
label it "(macOS)" rather than inventing a Linux path; the deviation card
for Cursor already communicates per-machine detection.

**Verify**: `bun run typecheck` → exit 0; `bun run --cwd apps/web test` → all pass.

### Step 3: E2e assertion in the synthetic runtime

Find the e2e spec covering `/sources` (grep `data-healthy-source-summary`
or `Healthy sources` under `apps/web/e2e/`). Determine whether the synthetic
runtime presents session sources as input-missing (the demo/e2e runtime
"disables local reads" per `README.md`). Then:

- If the synthetic snapshot yields `noSessionInputDetected === true`, assert
  `[data-first-run-guidance]` is visible and names all four harnesses.
- If it yields detected input, assert the panel is **absent** — and add a
  component-level render test for the visible case instead (pattern:
  `source-components.test.ts`).

**Verify**: `bun run test:e2e` (or the single spec) → all pass.

### Step 4: Gates

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run --cwd apps/web test` → all pass.

## Test plan

- Model: the Step 1 predicate cases.
- Component/e2e: Step 3 — exactly one of the two assertions depending on the
  synthetic snapshot, plus a render test for the other branch.
- Copy check: paths in the panel match `README.md` lines 9–14 verbatim.

## Done criteria

- [ ] `grep -n "data-first-run-guidance" apps/web/src/lib/features/sources/sources-page.svelte` → 1 hit
- [ ] `grep -n "noSessionInputDetected" apps/web/src/lib/features/sources/model.ts` → definition present, with tests
- [ ] `bun run typecheck` exits 0
- [ ] `bun run --cwd apps/web test` exits 0 with the new cases
- [ ] `bun run test:e2e` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- `SourceControlEntryView` does not expose a detection outcome the predicate
  can read (would mean detection state is not transported to the browser —
  report what the view actually carries).
- The synthetic runtime cannot represent either predicate branch
  deterministically (report; do not add a new fixture mode to force it).
- An existing e2e spec pins the exact child order of the `/sources` page
  stack in a way the new panel breaks.

## Maintenance notes

- The four history locations are intentionally static presentation copy;
  when a harness path changes, update this panel together with the
  `README.md` table and `docs/session-analysis-sources.md`.
- Reviewer should scrutinize: the disabled-vs-missing distinction in the
  predicate (policy is not detection), and that the panel never renders
  while any session source has real input.
- Deferred: folding the CLI `setup` loopback HTML app into the web UI
  (separate spike — it has its own security validations that must not be
  weakened in a move).
