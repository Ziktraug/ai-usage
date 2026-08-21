# Plan 083: Design "Adopt Unmanaged Skill Into Source" (Spike, Then Gated Build)

> **Executor instructions**: This is a **design/spike plan** — its first
> deliverable is a written design, not code. Follow it step by step; the
> build phase is gated behind explicit maintainer approval. If anything in
> the "STOP conditions" section occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- packages/skills/src/ apps/web/src/lib/features/skills/management/ apps/web/src/lib/server/rpc/skills.ts packages/web-contract/src/skills.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P1 (the feature area's #1 product gap)
- **Effort**: L (design M, build M–L)
- **Risk**: HIGH — first workflow that writes *into* runtime target
  directories rather than only managing links it owns; a bug destroys
  user-authored skills the tool promises never to touch
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

The `/skills` page's stated job — consolidate scattered runtime skill
folders into one source repository — stops one step short of the outcome.
The consolidate panel itself promises the flow:
`apps/web/src/lib/features/skills/management/skills-consolidate.svelte:56–57`
renders *"Adopting them means moving them into the source repo and
symlinking back. Nothing is ever deleted automatically."* — but the only
per-entry control, `Review consolidation`
(`skills-consolidate.svelte:80`), calls `reviewConsolidation` which is
`goto('/skills/matrix')` (`skills-health-slot.svelte:369–371`): the same
destination for every entry, carrying no entry identity. Adoption has been
deferred across five plans (003 → 004 → 005 → 006 → `docs/future-work.md:23`).
Users get an accurate inventory of the mess plus a button that navigates
away, then must do the move/symlink by hand — bypassing managed projection
for exactly the skills that most need it.

## Current state (verified)

- **No adoption exists anywhere.**
  - `apps/web/src/lib/server/rpc/skills.ts` — the whole server surface:
    `createTargetDirectory`, `projectInventories`, `knownProjectPaths`,
    `managedMarkdown`, `previewReconcileAll`, `projectMarkdown`,
    `reconcileAll`, `reconcileOne`, `refreshSnapshot`, plus save/toggle
    procedures. No adopt/import/move.
  - `packages/web-contract/src/skills.ts` — the contract has none either.
  - `packages/skills/src/projections.ts:298,318,353,385` — every unmanaged
    encounter terminates in a `refuse-unmanaged-mutation` action.
  - `packages/skills/src/workflows.ts:211–218` — `applyPlannedActions`
    applies only `create-symlink | repair-symlink | unlink-managed-symlink`.
- **The seam is already shaped for adoption.**
  - `packages/skills/src/contracts.ts:129–144` — `UnmanagedEntry` carries
    `entryName`, `expectedPath`, `actualPath?`, `targetId`,
    `state: 'unmanaged-copy' | 'unmanaged-symlink'`, `diagnostics`, and an
    optional `targetIdentity: { canonicalPath, dev, ino }`.
  - `packages/skills/src/workflows.ts:274` — mutations already run under
    `withSkillProjectionLock(privateStatePath, lockIdentity, …)` with
    dev/ino target revalidation (see `projection-lock.ts` and the
    `createSkillTargetDirectory` workflow). This is the established
    protocol any adopt mutation must reuse.
  - The preview→apply reconcile flow (`previewReconcileAll` →
    `reconcileAll`) is the trust pattern to extend, including its explicit
    "skipped — unmanaged content is never touched" refusals.
- **Two UI dead-ends are the same missing capability**: the consolidate
  entry button above, and the read-only project-skill Actions panel
  (`skills-health-slot.svelte:593–597`, "Read-only runtime observation.",
  matching `docs/skills-management-spec.md:42`).
- Vocabulary (`CONTEXT.md`): **Unmanaged runtime entry** — "reported for
  consolidation but never overwritten automatically"; **Projection** — "a
  managed exposure of a source skill in a configured runtime target,
  normally a verified symbolic link. A plan captures target identity;
  application revalidates it under a cooperating-process lock before
  mutation." The design must keep both sentences true.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Skills package tests | `bun test packages/skills` | all pass |
| Web tests | `bun run --cwd apps/web test` | all pass |
| Skills e2e | `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` | all pass |

## Scope

**In scope (design phase)**:
- A design document at `plans/083-adopt-design.md` (new file)
- Read-only investigation of `packages/skills/src/*` and the runtime
  target directories' real content shapes (via the snapshot, not by
  listing the user's directories yourself)

**In scope (build phase, only after approval)**:
- `packages/skills/src/workflows.ts`, `projections.ts`, `contracts.ts`
  (+ tests)
- `packages/web-contract/src/skills.ts`, `apps/web/src/lib/server/rpc/skills.ts`
- `apps/web/src/lib/features/skills/management/skills-consolidate.svelte`,
  `skills-health-slot.svelte` (+ tests), `apps/web/e2e/skills.spec.ts`

**Out of scope (both phases)**:
- Deleting or rewriting anything in a runtime target other than replacing
  the *adopted entry itself* with a managed symlink after a verified copy.
- Editing non-`SKILL.md` files (future-work defers it behind a safety
  model).
- Skill creation from scratch (natural sibling — record as follow-up; it
  reuses the same "write into source repo, then project" primitive).
- Git operations in `packages/skills` (the package is pure filesystem).

## Steps — Phase A: design

### Step A1: Inventory the real shapes of unmanaged entries

From a fresh snapshot (`refreshSnapshot` RPC or `loadSkillManagementSnapshot`
in a scratch script under the scratchpad, never mutating), catalogue what
unmanaged entries actually look like on this machine: single `SKILL.md`
files vs. directories with references/scripts, `unmanaged-copy` vs.
`unmanaged-symlink` (where does the symlink point — another repo? a
sibling target?), name collisions with existing source skills, and entries
whose content is identical across targets (the same skill copied into
Codex and Claude folders). Write the distribution into the design doc —
the adoption flow's complexity budget follows from it.

### Step A2: Answer the open questions, with a recommendation each

The design doc must decide (recommendation → rationale → alternative):

1. **Move or copy?** Recommended: copy into source, verify content hash,
   then convert the runtime entry to a managed symlink under the
   projection lock. Note the swap **cannot be a single atomic rename**:
   POSIX `rename()` cannot replace a non-empty directory (the normal
   `unmanaged-copy` shape) with a symlink. Design a recoverable two-step
   protocol instead — e.g. rename the original entry into an
   ai-usage-owned quarantine/backup directory on the same filesystem
   (rename of the directory itself is atomic), then create the symlink at
   the vacated path; a crash between the two steps must be detectable and
   re-runnable, and the quarantined original is never auto-deleted
   ("nothing is ever deleted automatically" in its strictest reading).
   The design doc must specify the quarantine location, its collision
   naming, and the recovery scan.
2. **Name collisions** with an existing source skill: adopt-as-new-name,
   merge, or refuse with diagnostics? Recommended: refuse with an explicit
   `adopt-blocked: name-collision` diagnostic in v1; merging is a
   different feature.
3. **Validation gate**: must adopted content pass skill validation before
   adoption? Recommended: parse/validate first; invalid content is
   adoptable only into a quarantined state or refused (pick one from the
   validation severities the package already has).
4. **Identical-content duplicates across targets**: adopt once + convert
   every matching entry to a symlink, or adopt per entry? Recommended:
   detect by content hash and offer the batch conversion in the same
   preview.
5. **Unmanaged symlinks** (`state: 'unmanaged-symlink'`): adopting the
   *link target* vs. refusing? They already live elsewhere — recommended:
   v1 refuses with a diagnostic naming the target path.
6. **Source repo dirtiness**: does adoption require a clean source state?
   The package has no git; recommended: out of scope, document that
   adoption writes files and the user reviews them with their own VCS.
7. **API shape**: `previewAdoptEntries(input) → AdoptPlan` and
   `applyAdoptPlan(plan) → AdoptResult`, mirroring
   `previewReconcileAll`/`reconcileAll`, executed under
   `withSkillProjectionLock` with `targetIdentity` revalidation. Define
   the exact `AdoptPlan` action union in the doc.
8. **UI entry points**: the consolidate entry rows (per-entry and
   per-group "Adopt…") and the project-skill Actions panel; both open the
   same preview dialog. Sketch states: preview list (what will be copied,
   what refused and why) → confirm → per-entry outcome.


### Step A2b: Two safety invariants the design doc must state explicitly

These are not open questions with a recommendation each — they are
properties the adoption protocol has to hold however questions 1-8 are
answered. State both in `plans/083-adopt-design.md` and carry both into
the Phase B test plan.

**Invariant Q — the quarantine root is never followed on trust.**
`.ai-usage-skill-quarantine/` lives inside a directory the user can write
to, so its presence proves nothing about what it is. Before *any* use of
it — creating it, renaming an entry into it, or scanning it for recovery:

1. Acquire the projection lock first; every check below is meaningless if
   another writer can act between the check and the rename.
2. `lstat` the path — never `stat`, which resolves the final symlink and
   reports the target's type.
3. Refuse a symlink outright, whatever it points at. Adoption must never
   move a user's skill into a path someone else chose.
4. Refuse any type that is not a directory (regular file, socket, FIFO,
   device).
5. Verify the resolved path is the expected child of the expected parent —
   resolve the parent, join the fixed segment, and compare against the
   canonicalized candidate; do not compare the string the caller passed.
6. A pre-existing quarantine root that fails any check is **never silently
   replaced, deleted, or adopted**. Fail the adoption with an explicit
   `adopt-blocked: quarantine-root-unsafe` diagnostic naming what was
   found (symlink → target, or the actual file type), and leave the
   runtime entry untouched.
7. Document the benign-collision behaviour separately from the unsafe
   one: an existing, verified quarantine *directory* is reused, and a name
   collision *inside* it is resolved by the collision naming that question
   1 already requires — never by overwrite.

Phase B test plan must include an adversarial case where
`.ai-usage-skill-quarantine` already exists as a symlink pointing outside
the projection root, and assert the adoption refuses with the diagnostic
above while the original entry is still present and unmodified. A second
case covers the path existing as a regular file.

**Invariant T — no stale copy is published after quarantine.**
Hashing the entry immediately before the rename does not close the
window: the rename moves the *original*, and a writer can change it
between that last hash and the rename completing. Publishing the symlink
then points the user at a copy that silently lost their edit. The design
must therefore sequence:

1. Digest the runtime entry.
2. Copy it into the source repo as the adoption candidate.
3. Validate the copy (question 3's gate) and digest the copy.
4. Rename the original entry into the verified quarantine root
   (Invariant Q) — this is the claim, and it is the point after which no
   further writer can reach the original path.
5. Re-digest the entry **now that it is quarantined** and can no longer
   change.
6. Compare that digest against the one from step 1, which is what the
   copy in step 2 was made from.
7. On divergence, do **not** create the symlink. Restore the quarantined
   entry to its original path, discard the candidate copy, and return an
   explicit `adopt-conflict: entry-changed-during-adoption` outcome so the
   caller can re-run against the new content.

The invariant to state and test: a concurrent mutation is never lost and
is never temporarily replaced by a stale copy. Phase B must include a
test that mutates a child file between the pre-copy digest and the
rename, and asserts the symlink was not created, the entry is back at its
original path, and its content is the mutated content — not the copy.

### Step A3: STOP — present the design

Present `plans/083-adopt-design.md` to the maintainer and stop. Do not
begin Phase B in the same run unless the operator explicitly approved the
design in writing.

## Steps — Phase B: build (only after approval; summary-level by design)

1. Domain: `AdoptPlan`/`AdoptResult` contracts + `planAdoptEntries` (pure)
   + `applyAdoptPlan` (locked, revalidated, hash-verified copy → the
   quarantine-then-symlink protocol from question 1 — not a single
   rename; see the A2 note on directories) in `packages/skills`, with
   tests using the package's existing temp-home test harness (see how
   `createSkillTargetDirectory` and reconcile are tested — model those).
   Properties to test explicitly: a crash between copy and quarantine, and
   between quarantine and symlink creation, each leaves a recoverable
   state (idempotent re-run), and the quarantined original survives every
   path.
2. Contract + RPC: preview/apply procedures beside
   `previewReconcileAll`/`reconcileAll` in `packages/web-contract` and
   `apps/web/src/lib/server/rpc/skills.ts`.
3. UI: wire the two dead-ends to the preview dialog; per-entry outcomes
   reuse the reconcile result presentation; the "Review consolidation"
   button is replaced by "Adopt…" carrying entry identity.
4. E2e: extend `apps/web/e2e/skills.spec.ts` with a fixture unmanaged
   entry adopted end to end in the synthetic runtime.

## Done criteria

**Phase A (this plan's primary gate):**
- [ ] `plans/083-adopt-design.md` states Invariants Q and T from Step A2b
      verbatim, including the refusal diagnostics and the digest ordering
- [ ] `plans/083-adopt-design.md` exists, answers all eight questions with
      recommendations, and includes the entry-shape inventory
- [ ] No source file modified (`git status` shows only the new design doc)
- [ ] `plans/README.md` row updated to `DESIGN READY — awaiting approval`

**Phase B (after approval):**
- [ ] `bun test packages/skills` passes including crash-window tests, the
      symlink and regular-file quarantine-root refusals (Invariant Q), and
      the mutate-between-digest-and-rename conflict case (Invariant T)
- [ ] Preview-first adopt reachable from both former dead-ends
- [ ] `grep -rn "goto('/skills/matrix')" apps/web/src/lib/features/skills/management/skills-health-slot.svelte` no longer the consolidate entry action
- [ ] `bun run typecheck && bun run test && bun run test:e2e` exit 0

## STOP conditions

- Phase A→B without explicit maintainer approval (hard gate).
- The snapshot inventory reveals entry shapes the design did not cover
  (e.g. nested skill directories with executable scripts) — extend the
  design first.
- The quarantine root cannot be verified under the lock as a real
  directory at its expected path (Invariant Q) — refuse the adoption and
  report; never repair or replace it automatically.
- A design or implementation that publishes the managed symlink without
  re-digesting the entry after quarantine (Invariant T) — the stale-copy
  window is a data-loss bug, not a rare race to accept.
- Any implementation step would delete or rewrite runtime bytes outside
  the atomic entry→symlink swap.
- `withSkillProjectionLock` / `targetIdentity` revalidation cannot cover
  the source-repo side of the write — the lock protocol may need a design
  extension; report rather than writing unlocked.

## Maintenance notes

- Skill *creation* in the app should reuse this plan's "write into source
  repo, then project" primitive (anticipated by plan 006's log) — keep the
  domain function shaped for both callers.
- The two UI dead-ends are the adoption feature's acceptance test: when
  both lead somewhere real, the consolidation backlog finally has an exit.
