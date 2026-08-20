# Plan 084: Spike — a Session-Intent Signal From First Prompts, Within the Privacy Boundary

> **Executor instructions**: This is a **design/spike plan** — its
> deliverable is a written design plus offline prototype results, not
> production code. Follow it step by step; if anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. When
> done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- packages/report-core/src/usage-row.ts packages/report-core/src/types.ts packages/report-core/src/merge-bundle.ts packages/local-collectors/src/`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P3 (highest-ceiling unbuilt differentiator, but gated on a
  privacy decision)
- **Effort**: L (spike M; any build is a separate follow-up plan)
- **Risk**: HIGH if done wrong — prompt text is the most sensitive data the
  app touches
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

Users can see *how much* work each session was, but not *what kind* of work.
`docs/future-work.md:72–74` names the direction: "Session intention via
`firstPrompt` + parent linking: propagate `firstPrompt` into `UsageRow`,
then cluster sessions by intent." Today's titles are a lossy proxy: Codex
collapses the first user message into the display name
(`packages/local-collectors/src/codex-history.ts:438–442`:
`session.firstUser || 'codex <id>'`), Cursor uses `firstPrompt` only to
pick a `titleSource` (`packages/local-collectors/src/collectors/cursor.ts:27–33`),
and the prompt itself is discarded. Every intent feature (clustering, "40%
of this month was refactoring", campaign intent labels) is blocked on a
stable signal — but the naive fix collides with a standing privacy
boundary, which is why this is a spike, not a build plan.

## Current state (verified)

- `packages/report-core/src/usage-row.ts:20+` — `UsageRowInput` has no
  prompt/intent field; `packages/report-core/src/types.ts:10` models only
  the *provenance* of prompt-derived titles
  (`TitleSource = 'ai' | 'first-prompt' | 'agent-role' | 'id'`), with
  `titleSource?` on the row (`types.ts:78`).
- Collectors hold first-prompt text at collection time and drop it:
  `codex-history.ts:337` (`firstUser`), `:442` (name fallback), `:459`
  (`titleSource`); `collectors/cursor.ts:27–33`.
- `packages/report-core/src/merge-bundle.ts:21–23` — portable schema is
  version 3; any new portable field is a version-4 conversation.
- **The standing privacy boundary** (`README.md:236`): "Detailed prompt
  bodies are read only on demand from the source machine's local history…
  that separate prompt collection is **not added to report revisions,
  snapshots, sync payloads, or exports**." Also
  `docs/session-analysis-sources.md` treats prompt truncation as a neutral
  fact and prompt reads as drawer-scoped. Propagating raw `firstPrompt`
  into `UsageRow` would put prompt text into revisions, snapshots, `/sync`
  bundles, and CSV — a contract change only the maintainer can make.
- Related settled decision (plans/README.md "Product directions explicitly
  deferred"): "Campaigns grouped by user intention require a separate
  privacy and domain-model decision; no heuristic classification is added"
  — this spike **is** the vehicle for that decision, not a license to
  bypass it.
- Lineage is already done: `packages/report-core/src/session-lineage.ts`
  derives `rootSourceSessionId`; campaign grouping is shipped. The missing
  piece is only the intent signal.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (scratch scripts excluded) | `bun run typecheck` | exit 0 |
| Run a scratch script | `bun <scratchpad>/intent-spike.ts` | prints prototype results |

The prototype runs **read-only** against local history / the stored
database, writes only into the session scratchpad directory, and sends
nothing over the network (local-only is non-negotiable).

## Scope

**In scope**:
- A design document at `plans/084-intent-design.md` (new file)
- Read-only prototype scripts in the scratchpad (not committed)

**Out of scope**:
- Any production code change, schema change, or bundle version bump.
- Any network call, embedding API, or model inference service — candidate
  techniques must run locally.
- Heuristic classification shipped to users (deferred decision above).

## Steps

### Step 1: Decide where the signal may live (the privacy fork)

Write up the three architectures with a recommendation:

- **A. Portable truncated prompt**: `firstPrompt` (e.g. first 200 chars,
  opt-out flag) on `UsageRowInput`/`UsageRowSource`, bundle v4, in CSV.
  Maximum utility; changes the README privacy contract; prompt text
  travels in `/sync` files.
- **B. Local-only derived label**: collectors (or an enricher, following
  the RTK enrichment-contribution pattern in `CONTEXT.md`) persist a
  *derived intent label* (a few words, never the prompt) + a content hash;
  the raw prompt still never enters rows. Portable only if the label is
  judged non-sensitive; weaker signal.
- **C. On-demand analysis**: intent computed when the user asks (like
  prompt bodies in the drawer today), never persisted. No contract change;
  no aggregate views ("40% refactoring") possible.

Recommended framing to evaluate: B, because it preserves the boundary's
letter ("prompt bodies" stay local) while enabling aggregates — but the
maintainer decides whether a derived label is itself too revealing for
portable payloads.

### Step 2: Prototype the clustering offline

Against this machine's real store (read-only), extract first
prompts/titles for the last ~500 sessions and prototype 2–3 local
techniques (e.g. normalized keyword/verb extraction; TF-IDF + k-means;
embedding-free lexical clustering). For each: cluster coherence on real
data, cost, and — the decisive question from `docs/future-work.md` — **do
clusters beat the existing titles?** If clusters merely restate titles,
the honest recommendation is "not worth building"; record it.

### Step 3: Design the minimal end-to-end slice

For the recommended architecture, specify in the design doc: the exact
field(s) and their bounds, which collectors can supply the signal (Codex
`firstUser`, Cursor `firstPrompt`, OpenCode `session.title` source, Claude
first user message — note Claude reads are budgeted), redaction/truncation
policy, opt-out configuration surface, serialization/validation touch
points (`serialized-usage-validation.ts`), bundle-version implications,
and the first UI consumer (recommended: an intent facet on the Sessions
filter bar, not a new chart — "hierarchize ruthlessly").

### Step 4: STOP — present the design

Present `plans/084-intent-design.md` (architecture recommendation,
prototype numbers, the not-worth-building verdict if reached) and stop.
Any build is a new plan written after the maintainer picks an architecture.

## Done criteria

- [ ] `plans/084-intent-design.md` exists with: the three architectures +
      recommendation, prototype coherence results on real local data, the
      minimal-slice spec, and explicit privacy analysis per architecture
- [ ] No production file modified (`git status` clean except the doc)
- [ ] No prompt text is quoted in the design doc beyond 3-word fragments
      needed to illustrate a cluster label
- [ ] `plans/README.md` row updated to `DESIGN READY — awaiting decision`

## STOP conditions

- Any step would require sending prompt text off this machine.
- The store/local history cannot yield first prompts without exceeding the
  documented read budgets (Claude 1 GiB/100k-record bounds) — report the
  measured cost instead of raising budgets.
- Prototype results are indistinguishable from grouping by existing titles
  — that is a finding, not a failure; write the "not worth building"
  verdict and stop early.

## Maintenance notes

- If architecture B is chosen, the enricher pattern
  (`CONTEXT.md` "Enrichment contribution") is the right seam: one owner,
  versioned, keyed to stable row identity, never rewriting collector rows.
- Plan 076 (inherited child titles) already treats
  `titleSource: 'first-prompt'` as a real title — any new prompt-derived
  labels must keep that provenance honest.
