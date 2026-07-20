# Plan 026: Unify the Session Drawer and Make Chronology Readable

> **Coordinator instructions**: this master plan contains four deliverable work
> packages. Every agent must read the complete plan and then implement only the
> assigned package. Only the coordinator may update the status in
> `plans/README.md`. Every agent must run all checks for their package and hand
> back the commit, results, and any deviations. Do not push or open a PR unless
> the user explicitly requests it.
>
> **Run this drift check first**:
>
> `git diff --stat b24f6a2..HEAD -- apps/web/src/session-analysis-model.ts apps/web/src/session-analysis.tsx apps/web/src/session-analysis-presentation.ts apps/web/src/session-analysis.test.ts apps/web/src/session-analysis.render.test.tsx apps/web/src/session-drawer.tsx apps/web/e2e/production-report.spec.ts docs/session-analysis-sources.md`
>
> If an in-scope file changed after `b24f6a2`, compare the Current State below
> with the live code. If the `SessionDetail` contract, presentation items, or
> E2E selectors changed, STOP and update this plan before writing code.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M, delivered in four sequential packages
- **Risk**: MEDIUM — UI-only, but it rewrites a component covered by a
  production E2E smoke and thirteen SSR rendering tests
- **Depends on**: plan 025 DONE (`SessionDetailResponse`, consistency,
  presentation items, and `data-session-analysis-item` selectors)
- **Category**: UX, tests, docs
- **Planned at**: commit `b24f6a2`, 2026-07-20
- **Suggested integration branch**: create `feat/026-unified-session-drawer`
  from `b24f6a2` (or the tip of `agent/improve-session-analysis`); do not push
  without explicit instruction

## Why This Matters

User feedback from 2026-07-20 on the “Analyze root” view identified four
problems:

1. **Two views for one session.** “Analyze” replaced the whole drawer body and
   changed its width. The useful summary—title, token anatomy, cost, and median
   ratios—disappeared precisely when chronology needed that context. Analysis
   opened on a UUID and four jargon-heavy duration tiles.
2. **The same dimension appeared three times.** “Model and effort phases,”
   “Task timeline,” and “Prompts” were all chronological lists on the same
   wall-clock axis. The phase band added nothing for the overwhelmingly common
   single-model case, while Prompts repeated nearly every timeline event.
3. **Time was the only encoded dimension.** A 42-minute, 2.5M-token task looked
   half as important as a 1h40, 46.3M-token task. Tokens—the product’s central
   quantity—were relegated to tiny metadata.
4. **Wall-clock time flattened useful detail.** In an 18-hour session with 12
   hours between tasks, bars became unreadable. A `minW: 4px` made a two-second
   task visible but visually dishonest.

The delivered design uses one progressive view, joins turns and prompts into a
single timeline with an aligned token column, makes the phase band conditional,
and introduces an honest gap-compressed scale with marked breaks and an
available wall-clock toggle.

## Normative UX Decisions

Target drawer structure—one view and one scroll:

~~~text
[drawerTop: harness badge · count · ↑ ↓ · Analyze/Hide · ✕]
[Title: sessionLabel · provider/model]
[Token anatomy SegmentBar + legend]
[≈ n× median cost · n× median duration]
[optional campaign block]
[detail grid (Started, Tokens, API value, …)]
[Filter project / Filter model actions]
──────────── chronology section (loaded on demand) ────────────
[Session analysis · dates → · session id]
[consistency metadata / scope / consistency warning]
[Unified timeline]
   caption: Task-open time ≥ 6h 08m · Session span 18h 14m ·
            Between tasks ≤ 12h 06m · Task blocks 10
   axis:    14:10 ──⫽ 5h 12m──────⫽ 3h 40m── 08:24 [Show real gaps]
   row = one task: prompt preview label (expandable),
         time track (phase color), token mini-bar on the right
[phases: dedicated band only for 2+ phases; otherwise one legend row]
[Detail observed … from local history.]
~~~

Firm decisions:

1. The summary always remains visible. Analysis is an additional section in
   the same scroll, never a replacement. The expanded 960px width remains while
   chronology is open.
2. Chronology loads only after an explicit “Analyze” or “Analyze root” action.
   Opening the drawer alone must not read local prompts; plan 025’s “sentinel
   absent before request” invariant remains true.
3. Turns and prompts become one timeline row per task, with the prompt as its
   label. A prompt belongs to the first task that references its id in
   `promptIds`. An orphan prompt becomes a point-marker row. A task without a
   prompt keeps the fallback `Task N` label.
4. The four duration tiles become a bounded caption above the timeline, keeping
   the same ≥/≤ bounds and “At least”/“At most” screen-reader wording.
5. “Model and effort phases” renders as a band only with at least two distinct
   phases. A single phase becomes a legend such as
   `gpt-5.6-sol · ultra · 100% tokens · ≈ $115.38`. Multi-phase task bars use
   their phase color.
6. At `md` and above, an aligned token column shows a mini-bar normalized to
   the largest task plus a compact value. Below `md`, the value remains in row
   metadata.
7. The default scale compresses inter-block gaps over 15 minutes into fixed,
   visibly broken segments whose title contains the real duration. An
   `aria-pressed` button switches to wall-clock. The button is hidden when no
   gap can be compressed.
8. Vocabulary comes from `SessionDurationSemantics.rowNoun`: `Task N` for
   Codex; `Turn N` for OpenCode and the generic fallback. “Turn” must no longer
   describe a Codex task.
9. Required detail fixes: correct singular/plural wording, phase cost at two
   decimals for values at least $1 and four below $1, and repeat model/effort
   on a row only when it differs from the dominant session phase.

## Non-Negotiable Invariants

1. No protocol changes. `loadSessionDetail({ revision, rowId })`,
   `SessionDetailResponse`, the server, and plan 025’s exact-revision runner are
   out of scope. Only client rendering and pure client functions may change.
2. Detailed prompts remain local and on demand.
   `HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL` must never appear in initial HTML.
3. Preserve `data-session-analysis-item="<kind>"` and
   `data-tone="neutral|warning"` for every item from
   `buildSessionAnalysisPresentation`. Only warning-tone items get
   `role="status"`; there is no global quality flag.
4. Harness duration semantics in `session-analysis-model.ts` remain the single
   wording owner. JSX must not hard-code harness-specific strings.
5. Gap compression changes display scale, never data. Labels, captions, and
   accessible values remain real durations, and every break is visible.
6. Every track keeps `role="img"` with a complete label covering prompt,
   duration, tokens, tools, and bounds. Disclosures remain native
   `<details>/<summary>`. The scale toggle is a button with `aria-pressed`, and
   heading hierarchy remains valid.
7. Do not modify `@ai-usage/design-system` while local `css()` and existing
   report styles suffice. If shared styling becomes essential, STOP and request
   a scope expansion.
8. Ultracite must stay green. Avoid nested ternaries and excessive cognitive
   complexity; extract subcomponents instead of stacking conditions.

## Current State at `b24f6a2`

### The drawer switched between mutually exclusive views

- `session-drawer.tsx` widened the drawer when analysis was open.
- `toggleAnalysis` cleared state and toggled `analysisOpen`.
- Button copy switched among “Analyze,” “Analyze root,” and “Summary.”
- Two mutually exclusive `<Show>` blocks rendered either `SessionAnalysis` or
  the complete summary.

### Analysis repeated the time axis three times

- `session-analysis.tsx` rendered four active/elapsed/idle/bursts metric tiles.
- The phase section rendered even for one phase.
- Turns and prompts rendered as separate chronological sections.
- `TurnRow` always used “Turn,” had a pluralization bug, and colored every task
  with the same accent rather than its phase.
- Timeline bars had `minW: '4px'`, and phase cost always allowed four decimal
  places.

### Existing pure model and presentation contracts

- `SessionDurationSemantics` had Codex, OpenCode, and generic definitions but
  no row noun.
- `positionOnTimeline` projected intervals onto one linear axis.
- `countActivityBursts` already merged intervals into blocks and could underpin
  the compressed scale.
- `SessionDetailTurn` already carried prompt ids, intervals, tokens, tools,
  model, and effort, while `SessionDetail.prompts` carried prompt id, text,
  timestamp, and truncation state. The join could therefore remain local and
  pure.
- `session-analysis-presentation.ts` exposed seven stable kinds:
  `consistency-meta`, `consistency-warning`, `scope`, `privacy`,
  `partial-duration`, `partial-turns`, and `prompt-truncation`.
- Thirteen SSR tests and the production E2E smoke covered the existing
  presentation and prompt-sentinel invariants.

## Target Pure Contracts

The public names and discriminants below were prescriptive; private
implementation details could vary.

~~~ts
export interface SessionDurationSemantics {
  // Existing fields remain unchanged, plus:
  rowNoun: string; // 'Task' for Codex; 'Turn' for OpenCode/generic
}

export interface SessionTimelinePromptRef {
  id: string;
  text: string;
  timestamp: string;
  truncated: boolean;
}

export type SessionTimelineRow =
  | {
      durationMs: number;
      effort: string | null;
      effortKind: SessionDetailEffortKind;
      index: number;
      intervals: SessionDetailInterval[];
      kind: 'task';
      model: string;
      prompts: SessionTimelinePromptRef[];
      tokenShareOfMax: number;
      tokens: SessionDetailTokenCounts;
      tools: number;
    }
  | { kind: 'orphan-prompt'; prompt: SessionTimelinePromptRef };

export const buildSessionTimelineRows = (detail: SessionDetail): SessionTimelineRow[];

export type TimelineScaleMode = 'compressed' | 'wall-clock';

export interface TimelineScaleBreak {
  atPercent: number;
  gapMs: number;
}

export interface TimelineScale {
  breaks: TimelineScaleBreak[];
  mode: TimelineScaleMode;
}

export const GAP_COMPRESSION_THRESHOLD_MS = 15 * 60 * 1000;

export const buildTimelineScale = (detail: SessionDetail, mode: TimelineScaleMode): TimelineScale;
export const positionOnScale = (scale: TimelineScale, startAt: string, endAt: string): TimelinePosition;
export const timelineHasCompressibleGaps = (detail: SessionDetail): boolean;

export interface SessionDurationCaptionPart {
  bound: 'lower' | 'upper' | null;
  key: 'active' | 'blocks' | 'gap' | 'span';
  label: string;
  value: string;
}

export const sessionDurationCaption = (
  detail: SessionDetail,
  semantics: SessionDurationSemantics,
  burstCount: number,
): SessionDurationCaptionPart[];

export const countLabel = (count: number, noun: string): string;
~~~

Normative rules:

- Sort timeline rows chronologically by task `startAt` or orphan prompt
  `timestamp`, using source index as the tie-breaker. Render each prompt exactly
  once. Ignore a missing referenced prompt without error.
- `tokenShareOfMax = tokens.total / max task tokens`; return zero for every row
  when the maximum is zero, and never produce `NaN`.
- Wall-clock mode must match `positionOnTimeline` exactly.
- Compressed mode merges task intervals into blocks. Every gap strictly over 15
  minutes receives a fixed 2% width and a `breaks` entry; blocks and smaller
  gaps share remaining width in proportion to real duration. With no
  compressible gap, it is identical to wall-clock. Clamp positions to
  `[0, 100]` and preserve monotonicity.
- `sessionDurationCaption` returns `active`, `span`, `gap`, and `blocks` in that
  order. Partial duration applies a lower bound to active and an upper bound to
  gap; otherwise bounds are null. Labels and hints come from existing semantics.

## Target Components

### `session-analysis.tsx`

- Render header, unified timeline, phase legend/band, presentation notices, and
  “Detail observed…” in that order.
- Use one `session-timeline` section instead of separate turn and prompt
  sections. Its header owns the heading, duration caption, description,
  privacy item, and scale toggle.
- A task row uses a `<details>` label with the main prompt preview or the
  row-noun fallback. Its track uses `positionOnScale` and phase color when
  multi-phase. Its token column uses `tokenShareOfMax` and `fmtTokens`.
- An orphan prompt uses the same disclosure with a point marker and an empty
  token value (`—`).
- Render one `⫽` axis marker per scale break, titled with the real gap duration.
- Format phase cost with two decimals at or above $1 and four below $1.

### `session-drawer.tsx`

- Always render the summary, then render `SessionAnalysis` beneath it when
  `analysisOpen()` is true. Preserve `SESSION_ANALYSIS_PANEL_ID` and existing
  `aria-controls`/`aria-expanded` wiring.
- Closed button: “Analyze” or “Analyze root.” Open button: “Hide analysis” with
  aria label “Hide session chronology.”
- Keep the 960px drawer while chronology is open. Previous/next navigation
  closes the section as before.

## Rejected Alternatives

- Summary/Analysis tabs: still hide context while reading chronology.
- Loading analysis on drawer open: violates on-demand local prompt privacy.
- Encoding tokens in temporal-bar height or opacity: conflates two quantities.
- Toggling the timeline between time and tokens: unnecessary for roughly ten
  rows when aligned columns can show both.
- Log scale or unmarked active-time axis: harder to read or visually dishonest.
- External Gantt/dataviz library: unnecessary bundle and accessibility risk.
- Removing phases entirely: multi-phase sessions still need token share and
  phase cost.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install | `bun install --frozen-lockfile` | exit 0, unchanged lockfile |
| Model | `bun test apps/web/src/session-analysis.test.ts` | pass |
| Presentation | `bun test apps/web/src/session-analysis-presentation.test.ts` | pass |
| SSR | `bun test apps/web/src/session-analysis.render.test.tsx` | pass |
| Check | `bun run check` | exit 0 |
| Boundaries | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | exit 0 |
| Build | `bun run build` | exit 0 |
| Dev E2E | `bun run test:e2e` | pass |
| Production E2E | `bun run test:e2e-production` | pass |
| Whitespace | `git diff --check b24f6a2...HEAD` | no output |

Use targeted Ultracite fixes during each package. The coordinator runs a global
fix only after checking the worktree.

## Scope

In scope:

- session analysis model, component, drawer, and their tests;
- the existing production report smoke selectors;
- `docs/session-analysis-sources.md`;
- the plan 026 log and plan index.

Out of scope:

- server, runner, collector, report-core, and protocol changes;
- changes to presentation kinds, text, or tones;
- session target/client/dashboard architecture beyond strictly necessary props;
- Sessions table, j/k navigation, and the campaign summary block;
- design-system changes;
- persistence of scale preference;
- Claude/Cursor detail support.

## Package Ownership and Integration Order

| Package | Subject | Exclusive ownership | Depends on | Parallel? |
| --- | --- | --- | --- | --- |
| A | Unified pure timeline model | model + tests | baseline | no, first |
| B | SessionAnalysis rendering | component + SSR tests | A | no |
| C | Single-view drawer + E2E | drawer + production smoke | B | no |
| D | Docs, gates, closure | docs + log/index | A–C | no |

Suggested commits:

1. `Add unified session timeline model`
2. `Render one session chronology with tokens`
3. `Fold session analysis into a single drawer view`
4. `Document the unified session drawer`

Each owner hands back the SHA, modified files, exact commands and results, and
any deviations or STOP conditions. Preserve unrelated user changes.

## Work Package 0: Baseline and Execution Log

1. Check `git status --short --branch` and `git rev-parse --short HEAD`.
2. Create the plan log with the starting SHA, an A–D status table, and one entry
   per package containing commit, commands, and results.
3. Run the three focused model/presentation/SSR suites and workspace typecheck.
   If the baseline fails, record it and STOP rather than attributing it to this
   plan.

## Work Package 1: Unified Pure Timeline Model

### Step 1.1: row noun, count labels, and duration caption

- Add `rowNoun` to all three semantics: `Task` for Codex and `Turn` for
  OpenCode/generic.
- Add simple English singular/plural `countLabel` behavior.
- Add the four ordered caption parts with partial bounds and existing semantic
  labels/hints.
- Test every harness, recorded/partial states, and singular/plural counts.

### Step 1.2: `buildSessionTimelineRows`

Test nominal task/prompt joins, a task without a prompt, orphan prompts,
double-referenced prompts, missing prompt ids, zero-token shares, and a session
with prompts but no turns.

### Step 1.3: compressed scale

Test wall-clock parity, a dense no-gap session, an 18-hour session with two
large gaps, monotonic clamping, and a zero-duration session. Keep all existing
model exports intact until package B consumes the new ones.

## Work Package 2: Rebuild `SessionAnalysis`

### Step 2.1: restructure sections

- Replace the four metric tiles with inline duration-caption parts.
- Merge turns and prompts into `session-timeline`; keep presentation ownership
  unchanged.
- Render a multi-phase band only for 2+ phases, otherwise a compact legend.
- Preserve the existing empty-history behavior.

### Step 2.2: unified rows and token column

- At `md`, use a label/time/token grid; stack it below that breakpoint.
- Use prompt previews as task labels, with row-noun fallback.
- Position intervals on the selected scale and apply phase colors only when
  multiple phases exist.
- Give orphan prompts a point marker and no invented token value.
- Default to compressed mode, show the toggle only when useful, and render a
  titled break marker for each compressed gap.
- Keep complete accessible row labels and fix plural/cost formatting.

### Step 2.3: rendering tests

Adapt all existing tone/role tests and add cases for single/multi-phase output,
prompt and fallback labels, orphan prompts, singular wording, caption bounds,
compressed and dense scales, neutral privacy/truncation items, and absence of
`Turn undefined`, `NaN`, or “may be newer.” Confirm the old section ids no
longer exist.

## Work Package 3: Single-View Drawer and E2E

### Step 3.1: merge the drawer bodies

- Render the summary unconditionally and append analysis in the same body.
- Preserve button aria wiring and state reset on row changes.
- Scroll the panel into view after explicit loading.
- Keep the expanded drawer width while analysis is open.

### Step 3.2: update the production smoke

- Assert token anatomy and Session Analysis are visible together.
- Use the unified timeline section for sentinel/privacy checks.
- Assert active `≥` and gap `≤` caption bounds.
- Assert “Hide analysis” closes only chronology, not the drawer or summary.
- Check compressed mode only when the fixture truly has a compressible gap.
- Do not add another spec file or full scenario.

## Work Package 4: Documentation and Final Gates

Document the one-view drawer, on-demand unified timeline, aligned token column,
conditional phase band, marked compressed scale, and `Task`/`Turn` semantics in
`docs/session-analysis-sources.md`. Remove language describing a separate
Summary mode.

Run install, check, lint, typecheck, tests, build, both E2E suites, diff check,
and worktree check. Keep the lockfile unchanged, update the execution log, and
mark plan 026 DONE only after every command succeeds.

## Consolidated Test Plan

Pure model:

- every turn/prompt join edge case;
- exact and zero token shares;
- wall-clock parity, 2% compression, breaks, monotonicity, and zero duration;
- ordered captions, partial bounds, harness labels, count labels, and row nouns.

SSR:

- all existing tone/role/kind cases;
- single-phase legend and multi-phase band/colors;
- prompt, fallback, and orphan labels;
- caption bounds, default scale, break markers, and conditional toggle;
- correct phase-cost precision and no stale/invalid wording.

Browser:

- summary and chronology visible together;
- local-only prompt sentinel preserved;
- neutral consistency/privacy semantics;
- bounded metric selectors and chronology open/close behavior;
- no drawer/navigation regressions.

## Done Criteria

- [x] The drawer has one view: the summary remains visible while chronology is
      open in the same scroll.
- [x] Chronology loads only after explicit action; the prompt sentinel is absent
      from initial HTML and appears only on demand.
- [x] Turns and prompts form one timeline; each prompt appears once, and tasks
      without prompts and orphan prompts render without invented association.
- [x] An aligned token column makes row volume comparable.
- [x] The phase band appears only for 2+ phases; single-phase uses a legend and
      multi-phase tracks use phase colors.
- [x] The four tiles are replaced by a bounded, accessible caption above the
      timeline.
- [x] Compressed scale is the default for gaps over 15 minutes; breaks are
      marked and titled, wall-clock toggle works, and displayed values do not
      change with the mode.
- [x] `Task N` for Codex and `Turn N` for OpenCode come from `rowNoun`.
- [x] Plurals and cost precision are correct; row model/effort appears only for
      multi-phase sessions.
- [x] Presentation kinds and tones remain unchanged and covered by rendering
      tests; scope and privacy are never warnings.
- [x] Check, lint, typecheck, tests, build, both E2E suites, and diff checks pass.
- [x] The log contains all four commits and the plan index marks 026 DONE.

## STOP Conditions

STOP without improvising if:

- in-scope files materially drift from `b24f6a2`;
- the work requires changing SessionDetail, consistency, the detail client,
  server, or packages outside the web app;
- prompt privacy requires implicit loading;
- compression cannot remain a display-only transformation;
- essential styling requires design-system changes;
- the production smoke fails twice after a reasonable correction;
- component complexity requires disabling an Ultracite rule;
- an owner must edit files assigned to an unintegrated package.

## Maintenance Notes

- Every new detail-supported harness must define its row noun and wording in
  `SessionDurationSemantics`; JSX must never own harness vocabulary.
- `GAP_COMPRESSION_THRESHOLD_MS` is a product constant. If it changes, update
  dense-session identity tests and documentation.
- Token bars normalize to the largest task in the session. Cross-session
  normalization would be a new design, not another parameter here.
- Reviews should focus on simultaneous summary/chronology, exactly-once prompt
  rendering, absence of false prompt/task association, honest scale breaks, and
  unchanged `data-session-analysis-item`/`data-tone` contracts.
