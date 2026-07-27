# Plan 047: Make grouping portable user data, for projects and campaigns

> **Status: DRAFT — unblocked.** Execution correctly stopped on 2026-07-27 because
> the timestamp model recorded on 2026-07-26 could not distinguish causal succession
> from concurrency, nor preserve the exclusive-membership invariant. The maintainer
> **accepted the implementation audit's amendment on 2026-07-27**; *The merge model*
> now records the causal design and is executable authority. No production code has
> been written yet.
>
> **Baseline**: written at `96b3dff`, rebased onto `3406147` (PR #21). That merge
> reworked the peer-confirmation protocol this plan builds on — see *Current state*.
>
> **This plan supersedes two adopted decisions** in
> `docs/project-grouping-plan.md`. That is deliberate, and the rationale is below.
>
> **Related**: plan 045 owns dimensions and the report's reading model, and depends
> on this plan for campaign renaming. Plan 045 must not anticipate this plan's
> storage model.

## Outcome

Grouping and naming are **user data**: portable, versioned, and mergeable, for
projects and campaigns alike. A name set on one machine survives a snapshot
transfer, and an import that finds two conflicting groupings can be resolved rather
than silently resolved for you.

## Why this reverses an adopted decision

`docs/project-grouping-plan.md` states, and the code implements:

> ### Usage rows remain facts
> Rows should not carry: `projectAlias`; `projectGroup`; dashboard grouping labels;
> **user-local grouping preferences**.
>
> ### Multi-machine merge remains session merge
> `usage-store`, snapshots, and merge bundles own session transport and
> deduplication. They should not decide which projects are equivalent.

That architecture is coherent and was followed: `projectGroups` lives in
`~/.config/ai-usage/config.json` (`packages/local-collectors/src/machine-config.ts`
lines 305, 416-417) and `report-core` consumes it at report time
(`packages/report-core/src/report-data.ts:44,107-108,121`). `CONTEXT.md` records the
vocabulary: a **Project group** is "an explicit **local** configuration that
presents multiple project sources as one named project in reports".

Two things changed the requirement.

**First, campaigns need the same shape and cannot be solved by widening a key.**
`campaignKeyFor` is `[machineId, harnessKey, rootSourceSessionId]`
(`apps/web/src/dashboard-model.ts:98`), and a campaign is derived from its root
session id. A session on one machine and a session on another have different root
ids, so the same logical piece of work performed from two machines can never be one
derived campaign. Representing "the same effort, continued elsewhere" therefore
requires an explicit grouping with **its own identity** — exactly what a project
group already is for projects.

**Second, the maintainer wants that identity preserved across machines.** A
grouping the user built by hand is irreplaceable work. Keeping it in a local config
file means it is lost, or silently divergent, the moment the report is read
elsewhere.

Rather than give campaigns a portable model while projects keep a local one — two
architectures for one concept, needing an ADR to excuse the asymmetry — the
principle is revised for both.

**What is preserved from the superseded plan**: usage rows remain facts. Grouping
does **not** become a field on a row. It becomes a separate, owned contribution,
which is the same separation the old plan was protecting, relocated rather than
abandoned.

## The revised principle

> Grouping and naming are user-authored data. They are stored separately from
> collector-owned rows, they travel with snapshots, they carry enough version
> information to detect divergence, and conflicts are surfaced to the user rather
> than resolved silently.

## Current state

**The store already has the right shape.** `packages/usage-store/src/index.ts`
models owner-separated contributions: `RtkSavingsContribution`,
`UpsertRtkSavingsContributionsInput`, `StoredUsageRowStatus`, and
`StoredSourceAuthority: 'local-observed' | 'portable-opaque'`. The README describes
the guarantee this buys: RTK savings "are persisted as an RTK-owned contribution
separate from the collector-owned base row, so later base re-imports, no-match runs,
disablement, and restarts preserve the last durable enrichment." A user-owned
grouping contribution is the same problem.

**Enrichment already travels.** `packages/report-core/src/merge-bundle.ts:347-350`
serialises `rtkSavedTokens`, `rtkInputTokens`, `rtkOutputTokens` and
`rtkCommandCount` into bundle rows. Portability of a non-collector contribution is
therefore precedented, not novel.

**A known pitfall constrains the shape.** `queryReportRows` re-validates every
stored row on read, so hardening or extending the base row schema can retroactively
invalidate already-persisted data — this has previously produced a 500. A separate
contribution table sidesteps it; adding fields to base rows does not.

**Prior art that must not be broken.** Plan 011 made machine identity atomic, plan
014 enforced symmetric portable-transfer limits and a safe import preview, plan 015
made portable source paths opaque provenance, and **plan 040 made peer confirmation
an atomic usage-store capability**. This plan adds user-authored text to a transport
that previously carried only machine-observed facts, so all four need re-reading
before the bundle changes — plan 040 most of all, because it owns the preview and
confirmation boundary this plan's conflict resolution sits on.

## The merge model

**Settled. The maintainer accepted the implementation audit's amendment on
2026-07-27. This section is the executable authority. The timestamp model recorded
on 2026-07-26 is superseded and survives only as rationale in
*Rationale: the options considered*.**

The intended *granularity* was right and is preserved: a conflict is scoped to one
field or one membership, and anything the model can settle is settled with no
prompt. What changed is the *representation* — wall-clock timestamps cannot support
that granularity, for the reasons in *Implementation audit* below.

### Rule 1 — a causal version register per field, not a timestamp

Each scalar field carries a causal register recording how much of every other
machine's history the writer had incorporated when it wrote. Wall-clock timestamps
and origin machine labels are retained as **display metadata only**; they never
decide a merge.

This is the rule that makes the model correct. A timestamp answers *when*; it never
answers *whether the writer had seen the other side*. The distinction is not an edge
case — importing and then continuing to work is the normal flow:

| | Genuine concurrency | Causal succession |
| --- | --- | --- |
| A writes | rename at 10:00 | rename at 10:00 |
| B imports | — | at 10:30, sees A's value |
| B writes | rename at 11:00, unaware of A | rename at 11:00, deliberately replacing A |
| Under timestamps | `A@10:00` vs `B@11:00` | `A@10:00` vs `B@11:00` — **identical** |
| Under causal registers | neither includes the other → conflict | B includes A → B wins, silently |

### Rule 2 — membership is an exclusive assignment, not a per-group set

Model membership as one record per member: `(kind, member) -> groupId | ungrouped`,
each carrying its own causal register. **Not** an independent set per group.

The current project model rejects overlapping selectors, and moving a member removes
it from its previous group. Independent per-group sets cannot preserve that
invariant across a merge:

```
A moves X from group 1 to group 2
B moves X from group 1 to group 3

merging per-group sets, group by group:
  group 1: X removed on both sides   ✓
  group 2: X added                   ✓
  group 3: X added                   ✓
→ X is now in two groups, and nothing detected it, because each
  set merged cleanly in isolation.
```

With one record per member, both machines edit the **same** record, so the conflict
is representable and detectable. Model the constraint, not the collection.

### Rule 3 — a group's existence is itself versioned

Each group carries an `active | deleted` causal register, and deletions are
retained. Without it, an older portable copy resurrects a group another machine
deleted — membership tombstones alone do not cover the group's own existence.

### Rule 4 — resolve in preview, then write once

Every conflict is resolved during preview. The confirmation step then revalidates
the opaque confirmation token, the grouping state, and the recorded resolutions, and
writes the entire import in **one** transaction.

There is no partial application and no queue of pending conflicts. Plan 040 already
makes peer confirmation a single `BEGIN IMMEDIATE` transaction; a partially applied
import would need a separate durable queue and lifecycle that this plan does not
define and should not invent.

### Rule 5 — `keep both` is conditional

Offer `keep both` only when the resulting assignments are disjoint. When they are
not — the same member claimed by two groups — the user must choose one, or
explicitly repartition the conflicting membership. A resolution that produces an
invalid state is not a resolution.

### Constraint — the store owns the semantics

Plan 040's confirmed design amendment states that `usage-store` owns "state
fingerprinting, token construction and interpretation, write serialization, and
stale detection", and that callers "never decode store state". Grouping follows the
same rule: the store decides what is a conflict and hands the UI a described
conflict, for example `{ group, field: 'name', local, incoming }` or
`{ kind, member, local: groupId, incoming: groupId }`. The route and the browser
never compare registers, never compare timestamps, and never decode a version.

### Consequences to carry into the steps

- A conflict is always scoped: one field, or one membership. There is no whole-group
  conflict and no whole-import conflict.
- Anything the rules can settle is settled silently. A prompt appears only where it
  carries information, and a later change that widens conflicts violates the
  property the granularity was chosen for.
- Migration must preserve canonical project selectors and their overlap semantics.
  Resolving broad or unmatched selectors to current paths is **not** equivalent and
  loses the invariant.
- Register and tombstone growth is bounded by machine count and by memberships ever
  created, which are both small. Do **not** add a retention sweep; plan 037 removed
  steady-state retention work deliberately. If pruning is ever needed — for instance
  when a machine is retired — that is its own plan.

### Rationale: the options considered

Plain last-write-wins on a single record timestamp was ruled out immediately: it
resolves silently and therefore contradicts the maintainer's explicit request for a
conflict interface.

| Model | Detects | Cost | Failure mode |
| --- | --- | --- | --- |
| Last-write-wins on a timestamp | Nothing. Newest wins. | Trivial. One `updatedAt`. | Silent loss. Two machines edited the same group; the older edit vanishes with no prompt. Contradicts the maintainer's explicit request for a conflict interface. |
| Per-record version counter plus origin machine | A concurrent edit, but not what changed | Small. `version`, `originMachineId`. | Cannot distinguish "you renamed it" from "you added a member", so every concurrent edit becomes one coarse conflict. |
| Per-field last-write-wins with per-field timestamps | Field-level divergence | Moderate. Timestamp per field. | A rename on A and a member addition on B merge cleanly with no prompt at all — which may be desirable, or may be surprising. |
| Version vector per record | True causality: concurrent vs superseded | Highest. A vector per record, pruned per machine. | Over-engineered for a two-machine single-user setup, and the vector grows with machine count. |

**Superseded recommendation (2026-07-26), kept as the record of a wrong turn.** The
original recommendation was per-field last-write-wins with per-field timestamps, with a
prompt reserved for the same field edited on both machines.

It was wrong, and the reason is worth keeping: the table above dismissed the version
vector as "over-engineered for a two-machine single-user setup", judging the causality
problem to be an edge case. It is not — *import, then keep working* is the normal flow,
so the timestamp model fails on the **common** case. Machine count was the wrong axis to
judge on; what matters is whether writes can observe each other, and here they routinely
do.

The accepted design is in *The merge model*, which adopts the causal register this table
had rejected.

**Precedent added by plan 040** (`Make peer confirmation an atomic usage-store
capability`, merged in #21). The store now derives a single `confirmationToken` of
the form `v1.<64 hex>` from the bundle digest, the store `generation`, and a
`storeStateFingerprint`, replacing the previous `storeGeneration` +
`storeStateToken` pair, and raises `previewStaleError` when a confirmation no longer
matches the state it previewed. Two consequences:

- The repository already has a versioning idiom — a **content fingerprint plus a
  monotonic generation**, compared at the confirmation boundary. Prefer extending
  that idiom to inventing a second one. Read
  `packages/usage-store/src/index.ts` (`confirmationTokenFor`,
  `storeStateFingerprint`, `readUsageStoreGeneration`) before choosing.
- That mechanism guards **whole-store staleness at import time**, not per-record
  divergence. It answers "has the store moved under this preview", not "did two
  machines edit the same group". It is a floor to build on, not the answer.

Recorded: **per-field last-write-wins, plus a per-membership set** (see *The merge
model*).

## Implementation audit — STOP triggered

Execution reached the plan's explicit “recorded merge model cannot express this
case” condition before Step 1 changed production code. Four cases exceed the
current model:

1. **Causality.** A machine can import a rename and then rename the same field
   again. That causally newer value is indistinguishable from two genuinely
   concurrent renames when records carry only values and wall-clock timestamps.
   A timestamp orders events; it does not prove that one edit observed the other.
2. **Exclusive membership.** The current project model rejects overlapping
   selectors and a move removes the old membership. Two independent per-group
   sets would silently merge concurrent assignments of one member to two groups
   into an invalid double membership.
3. **Group deletion.** Membership removals have tombstones, but deleting the group
   itself has no versioned state. An older portable copy can therefore resurrect a
   group that another machine deleted.
4. **Confirmation atomicity.** Step 5 leaves non-conflicting partial application
   versus no write undecided. Plan 040 already makes peer confirmation one atomic
   `BEGIN IMMEDIATE` transaction; partially applied conflicts need another durable
   queue and lifecycle that this plan does not define.

The smallest coherent amendment recommended by the execution audit is:

- use a causal version register per scalar field and membership, keeping wall-clock
  timestamps and origin machines as display metadata only;
- model membership as one exclusive assignment `(kind, member) -> groupId | ungrouped`
  rather than independent sets whose cross-group invariants cannot be merged;
- preserve canonical project selectors and their overlap semantics during
  migration; resolving broad or unmatched selectors to current paths is not equivalent;
- add an `active | deleted` causal register to each group and retain deletions;
- resolve every conflict in preview, then revalidate the opaque confirmation token,
  grouping state, and resolutions and write the whole import in one transaction;
- offer `keep both` only when the resulting assignments are disjoint; otherwise the
  user must choose or explicitly repartition the conflicting membership.

**Accepted by the maintainer on 2026-07-27.** The amendment is now part of *The merge
model* above, which is the executable authority; this section is retained as the
record of how the defect was found and why the design changed.

The stop was correct and the plan worked as intended: its STOP condition said to halt
if a conflict case appeared that the recorded model could not express, and execution
halted before Step 1 touched production code. A plan that cannot be refuted by its own
executor is a worse plan.

## Scope

In scope:

- A user-owned grouping contribution in `usage-store`, covering **campaign groups**
  (new) and **project groups** (migrated).
- Campaign labels as an override: `label = override ?? derived`, where the derived
  side is plan 045 Wave 4's cleaned prefix.
- Portability through the merge bundle, within plan 014's symmetric limits.
- A conflict-resolution surface at import, on `/sync`, which plan 045 Wave 6 leaves
  room for.
- Migration of existing `projectGroups` from `config.json`, and a decision on
  whether that file remains a read-only input.
- Superseding the two named clauses of `docs/project-grouping-plan.md`, and updating
  `CONTEXT.md`'s **Project group** entry, which currently says "local
  configuration".

Out of scope:

- Changing what a derived campaign is, or widening `campaignKeyFor`.
- The derived label itself (plan 045 Wave 4).
- Any grouping inferred automatically. Every group in this plan is user-authored.
- Sharing between different users, or any network transport. Snapshots remain the
  only channel.
- Branch or commit as a grouping key (plan 045 Wave 0 gates that entirely).

## Vocabulary

Add to `CONTEXT.md`, and keep the existing *Avoid* discipline:

- **Campaign group**: an explicit user-authored grouping that presents multiple
  derived campaigns as one named effort, possibly spanning machines and harnesses.
  _Avoid_: campaign, super-campaign, inferred campaign.
- **Project group**: amend the existing entry — it is no longer "local
  configuration" but portable user data with the same lifecycle as a campaign group.
- **Grouping contribution**: the user-owned store record carrying a group's
  identity, name, members, and version information, separate from collector-owned
  rows. _Avoid_: enrichment contribution, grouping row, alias.

`CONTEXT.md` already defines **Enrichment contribution** as "a versioned, validated
value owned by one enricher and **keyed to a stable base usage-row identity**",
composed at read time, where "neither writer replaces the other's durable data".
A grouping contribution deliberately borrows that ownership and composition
discipline but is **not** one of them: it is keyed to a **group identity the user
creates**, not to a base usage row, and one grouping references many rows rather
than annotating one. Keep the two terms distinct — conflating them would make the
existing *Avoid: enriched base row* rule ambiguous, and would invite exactly the
row-level grouping field this plan forbids.

## Steps

### Step 1: Model the grouping contribution and its causal registers

1. Define the group: a generated stable id, a kind (`project` | `campaign`), a
   user-authored name, and an `active | deleted` state. Each scalar field and the
   state each carry a **causal version register** (Rules 1 and 3). Wall-clock time
   and origin machine are stored for display only.
2. Define membership separately as an **exclusive assignment**:
   `(kind, member) -> groupId | ungrouped`, one record per member, each with its own
   causal register (Rule 2). Do not store a member set on the group.
3. Members are keys, not rows: project members are project sources, campaign members
   are `campaignKeyFor` values. Rows stay facts.
4. Retain deleted groups and `ungrouped` assignments; they are how a removal
   propagates.
5. Conflict detection lives in `usage-store` and returns a described conflict. No
   caller compares registers or timestamps.

**Verify**: `bun test packages/usage-store/src`

Expected, as distinct cases:

- a contribution survives a base-row re-import, matching the RTK guarantee;
- **causal succession**: a side that incorporated the other's write wins with no
  conflict — this is the case wall-clock timestamps could not express;
- **genuine concurrency**: neither register includes the other, so exactly one
  conflict is raised, scoped to that field;
- a rename on one side and a membership change on the other merge with no conflict;
- **exclusive membership**: the same member assigned to two different groups yields
  one conflict on that member, and never a double membership;
- **deletion**: importing an older copy of a deleted group does not resurrect it.

### Step 2: Migrate project groups without losing any

1. Read existing `projectGroups` from `config.json` and write them as contributions.
2. **Preserve the canonical selectors and their overlap semantics.** Resolving a
   broad or currently-unmatched selector to the paths it happens to match today is
   **not** equivalent: it silently narrows the group and discards the invariant that
   made overlap detectable. Migrate the selector, not its current expansion.
3. Decide and document whether `config.json` remains a read-only input or is
   retired. If it remains, the precedence rule must be explicit.
4. The migration is idempotent and never produces duplicate groups on repeated runs.

**Verify**: `bun test packages/local-collectors/src && bun test packages/report-core/src`

Expected: a config with existing project groups yields identical report grouping
before and after migration; a selector that currently matches nothing survives
migration and still matches nothing rather than disappearing; an overlapping selector
is still rejected after migration.

### Step 3: Add campaign groups and the label override

1. Campaign groups group derived campaigns, including across machines and harnesses.
2. `label = override ?? derived`, with plan 045 Wave 4 owning `derived`.
3. A campaign group is itself nameable and becomes the top-level row when present,
   above the campaigns it contains.

**Verify**: `bun test packages/report-core/src && bun run test:e2e` — a group
spanning two machines renders as one row with its own name and its members
expandable underneath.

### Step 4: Carry groupings in the bundle

1. Extend the merge bundle to carry grouping contributions, following the RTK
   serialisation precedent.
2. Bound the text: a user-authored name is free text entering a transport that
   previously carried only observed facts. Apply plan 014's symmetric limits and
   sanitise on read, and keep plan 015's rule that portable paths stay opaque.
3. Export includes groupings; import applies the recorded merge model.

**Verify**: `bun test packages/report-core/src && bun test packages/usage-store/src`
— a round-trip preserves groupings; an oversized or malformed name is rejected at the
boundary, not stored.

### Step 5: Resolve conflicts in preview, then write once

1. Surface each unresolved conflict during **preview**, with both sides and their
   origin machine and wall-clock time shown as human context. The store describes the
   conflict; the browser does not decode registers.
2. Resolution is explicit: keep local, take incoming, or keep both. Offer
   `keep both` **only when the resulting assignments are disjoint** (Rule 5); when the
   same member is claimed twice the user must choose one or explicitly repartition.
3. **Every conflict must be resolved before confirmation.** There is no partial
   application and no pending-conflict queue.
4. On confirmation, revalidate the opaque confirmation token, the grouping state, and
   the recorded resolutions, then write the whole import in **one** transaction
   (Rule 4). A resolution recorded against state that has since moved must fail stale,
   exactly as plan 040 already does for rows.

**Verify**: `bun run test:e2e && bun test packages/usage-store/src`

Expected: an import with one field conflict cannot be confirmed until it is resolved;
the chosen side and every non-conflicting change land in the same transaction; a
resolution confirmed after the store moved fails stale and writes nothing;
`keep both` is unavailable on an overlapping membership conflict.

### Step 6: Supersede the documents

1. Amend `docs/project-grouping-plan.md`: mark the two superseded clauses, cite this
   plan, and preserve everything else it decided.
2. Update `CONTEXT.md` per *Vocabulary*.
3. Record an ADR for the reversal if the repository's ADR set covers grouping.

**Verify**: `bun run lint && bun run check` — and no document still claims grouping
is local-only.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Store tests | `bun test packages/usage-store/src` | all pass |
| Report core tests | `bun test packages/report-core/src` | all pass |
| Collector tests | `bun test packages/local-collectors/src` | all pass |
| Typecheck | `bun run typecheck` | all tasks pass |
| Lint and boundaries | `bun run lint` | exit 0 |
| Formatting | `bun run check` | Ultracite exits 0 |
| Full tests | `bun run test` | all pass |
| Browser tests | `bun run test:e2e` | all pass |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run `bun install`. Do not hand-edit a real `~/.config/ai-usage/config.json`
or a real store during development; use synthetic fixtures, per the repository's
standing rule on real, local, and private data.

## Git workflow

- One branch for this plan; do not share plan 045's branch.
- One commit per step, only after its verification passes.
- Imperative commit style, for example `Store project groups as user contributions`.
- Step 2 touches user data. Do not run the migration against a real config until its
  idempotence test passes.
- Do not push or open a pull request unless the operator explicitly asks.

## Verification

- Causal succession and genuine concurrency are covered as **separate** tests. This is
  the pair the superseded timestamp model could not tell apart; if only one exists, the
  amendment has not really been implemented.
- Exclusive membership holds across a merge: no input produces a member in two groups.
- A deleted group is not resurrected by importing an older copy.
- A grouping contribution survives a base-row re-import (the RTK guarantee).
- Migration is idempotent and grouping-equivalent, and preserves selectors rather than
  their current expansion.
- A bundle round-trip preserves groupings; malformed or oversized names are rejected
  at the boundary.
- Every conflict must be resolved before confirmation, and confirmation writes once or
  fails stale.
- No document still describes grouping as local-only.
- `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e` all pass.

## Done criteria

- [x] A causally complete merge model is decided and written down (*The merge model*,
      accepted 2026-07-27).
- [ ] Causal succession merges silently; genuine concurrency raises exactly one
      conflict. Both are tested separately.
- [ ] Membership is an exclusive assignment; no merge can produce a double membership.
- [ ] A group's existence is versioned, and deletions are not resurrected.
- [ ] Conflicts are scoped to one field or one membership, never wider.
- [ ] Anything the rules can settle is settled with no prompt.
- [ ] `keep both` is offered only when the resulting assignments are disjoint.
- [ ] Grouping is a user-owned contribution, separate from collector-owned rows.
- [ ] Usage rows still carry no grouping field.
- [ ] Existing project groups are migrated with identical report output.
- [ ] Campaign groups exist, can span machines and harnesses, and can be named.
- [ ] `label = override ?? derived` works with plan 045 Wave 4's derived label.
- [ ] Groupings survive a snapshot round-trip within plan 014's limits.
- [ ] Every conflict the model cannot settle is presented, never silently resolved.
- [ ] `docs/project-grouping-plan.md` and `CONTEXT.md` reflect the revised principle.

## STOP conditions

Stop and report if:

- a conflict would have to be raised wider than one scalar field or one membership.
  That means the model is being widened, and widening it removes the property it was
  chosen for: a prompt only where it carries information;
- a caller outside `usage-store` needs to compare timestamps or decode version state
  to render a conflict. Plan 040's amendment forbids it; make the store describe the
  conflict instead;
- migrating `projectGroups` would change any existing report's grouping output;
- carrying names in the bundle cannot satisfy plan 014's symmetric limits without
  weakening them;
- making grouping portable would require a grouping field on a usage row. That is
  the one clause of `docs/project-grouping-plan.md` this plan explicitly preserves;
- a conflict case appears that the recorded merge model cannot express — extend the
  model deliberately rather than adding an ad-hoc branch to the UI. This condition
  already fired once, on 2026-07-27, and it was right to: it caught a model that could
  not distinguish causal succession from concurrency before any production code was
  written. Treat a second firing the same way;
- a shortcut replaces a causal register with a wall-clock comparison "just for this
  field". That is the exact defect the amendment corrected, and it reappears silently
  because the wrong behaviour only shows up after an import-then-edit cycle;
- migrating a project selector requires resolving it to the paths it matches today.
  That loses the overlap invariant and is not an equivalent migration;
- plan 045 has already introduced any storage for campaign labels. It is sequenced
  not to; if it did, reconcile before proceeding rather than migrating twice.

## Maintenance

Grouping has one owner: the user. Nothing in the collectors, the report projection,
or the merge deduplication may create, rename, or infer a group. The next feature
tempted to guess that two things are the same should add a *suggestion* the user
accepts, never a group.
