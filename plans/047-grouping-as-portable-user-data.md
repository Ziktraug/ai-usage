# Plan 047: Make grouping portable user data, for projects and campaigns

> **Status: DRAFT.** The merge model was settled with the maintainer on 2026-07-26
> and is recorded in *The merge model* below; this plan is no longer blocked. It
> still depends on plan 045 wave 4 for the derived label.
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

**Settled 2026-07-26. This section is the authority; the options table below is
retained only as rationale.**

Two rules, and one constraint inherited from plan 040.

**Rule 1 — scalar fields use last-write-wins with a per-field timestamp.** Renaming
a group on one machine while adding a member on the other merges with no prompt. A
conflict is raised only when the **same scalar field** was edited on both sides.

**Rule 2 — `members` is a set with a per-membership timestamp, not a scalar.** Each
membership carries its own add-or-remove timestamp. Two different additions merge;
two different removals merge; a conflict is raised only when the **same member** was
added on one side and removed on the other, and it is scoped to that member — the
rest of the set still merges. Removals are retained as tombstones, otherwise a
removal cannot propagate.

**Constraint — the store owns the semantics.** Plan 040's confirmed design amendment
states that `usage-store` owns "state fingerprinting, token construction and
interpretation, write serialization, and stale detection", and that callers
"never decode store state". Grouping follows the same rule: the store decides what
is a conflict and hands the UI a described conflict, for example
`{ group, field: 'name', local, incoming }` or
`{ group, member, localOp: 'add', incomingOp: 'remove' }`. The route and the browser
never compare timestamps and never decode a version.

Consequences to carry into the steps:

- A conflict is always scoped: one scalar field, or one membership. There is no
  whole-group conflict, and no whole-import conflict.
- Anything the two rules can settle is settled silently. A prompt appears only where
  it carries information — that is the property the model was chosen for, and a
  later change that widens conflicts violates it.
- Tombstone growth is bounded by the number of memberships ever created, which is
  small. Do **not** add a retention sweep for them; plan 037 removed steady-state
  retention work deliberately. If tombstones ever need pruning, that is its own
  plan.

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

**Recommendation**: per-field last-write-wins with per-field timestamps, and a
conflict prompt reserved for the one case it cannot settle — the same field edited
on both machines. That gives the maintainer's requested interface where it carries
information, and silence where a prompt would be noise. It also means adding a
member on one machine while renaming on the other simply works.

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

### Step 1: Model the grouping contribution

1. Define it: a generated stable id, a kind (`project` | `campaign`), a
   user-authored name, and a member set — with a timestamp per scalar field and a
   timestamp per membership, per *The merge model*.
2. Members are keys, not rows: project members are project sources, campaign members
   are `campaignKeyFor` values. Rows stay facts.
3. Removals are tombstoned memberships, not deletions.
4. Conflict detection lives in `usage-store` and returns a described conflict. No
   caller compares timestamps.

**Verify**: `bun test packages/usage-store/src` — a contribution survives a base-row
re-import, matching the RTK guarantee; a rename on one side and a member addition on
the other merge with no conflict; the same member added on one side and removed on
the other yields exactly one conflict scoped to that member, with the rest of the set
merged.

### Step 2: Migrate project groups without losing any

1. Read existing `projectGroups` from `config.json` and write them as contributions.
2. Decide and document whether `config.json` remains a read-only input or is
   retired. If it remains, the precedence rule must be explicit.
3. The migration is idempotent and never produces duplicate groups on repeated runs.

**Verify**: `bun test packages/local-collectors/src && bun test packages/report-core/src`
— a config with existing project groups yields identical report grouping before and
after migration.

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

### Step 5: Resolve conflicts on `/sync`

1. Surface each unresolved conflict from an import with both sides, their origin
   machine, and their timestamps.
2. Resolution is explicit: keep local, take incoming, or keep both as separate
   groups. Never resolve silently in the case the merge model cannot settle.
3. An import must not be partially applied and then abandoned: either the
   non-conflicting part applies and conflicts remain queued, or nothing applies.
   Decide which, and state it.

**Verify**: `bun run test:e2e` — an import with one same-field conflict presents a
choice, applies the chosen side, and leaves the rest of the import intact.

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

- The merge model is recorded in this plan before Step 1 lands.
- A grouping contribution survives a base-row re-import (the RTK guarantee).
- Migration is idempotent and grouping-equivalent before and after.
- A bundle round-trip preserves groupings; malformed or oversized names are rejected
  at the boundary.
- The conflict surface is exercised for every case the merge model does not settle.
- No document still describes grouping as local-only.
- `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e` all pass.

## Done criteria

- [x] The merge model is decided and written down (*The merge model*, 2026-07-26).
- [ ] Conflicts are scoped to one scalar field or one membership, never wider.
- [ ] Anything the two rules can settle is settled with no prompt.
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
  model deliberately rather than adding an ad-hoc branch to the UI;
- plan 045 has already introduced any storage for campaign labels. It is sequenced
  not to; if it did, reconcile before proceeding rather than migrating twice.

## Maintenance

Grouping has one owner: the user. Nothing in the collectors, the report projection,
or the merge deduplication may create, rename, or infer a group. The next feature
tempted to guess that two things are the same should add a *suggestion* the user
accepts, never a group.
