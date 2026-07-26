# Plan 039: Return post-reconcile Skills state

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 96b3dff..HEAD -- packages/skills/src/workflows.ts packages/skills/src/snapshot.test.ts apps/web/src/server/skills.server.test.ts`
> If an in-scope file changed, compare the current-state excerpts below with the
> live code. Any semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `96b3dff`, 2026-07-26

## Why this matters

Skills reconciliation applies filesystem mutations and then returns the
snapshot captured before those mutations. The web route installs that result in
its signal and query cache, so a successful create, repair, or unlink can still
look unhealthy until another refresh. Reconciliation results should describe
the state that exists after their reported actions.

## Current state

- `packages/skills/src/workflows.ts:203-218` computes actions from `snapshot`,
  applies safe actions, and returns `{ actions, snapshot }` without rereading.
- `packages/skills/src/workflows.ts:221-235` uses that helper for
  `reconcileSkill` and `reconcileAllActiveSkills`.
- `packages/skills/src/workflows.ts:238-242` implements
  `previewReconcileAllActiveSkills`; its pre-mutation snapshot is intentional
  and must not change.
- `packages/skills/src/application.ts:214-222` routes reconcile-one,
  reconcile-all, and toggle-disable through the stale-result path. Toggle-enable
  already rereads and is not defective.
- `packages/skills/src/snapshot.test.ts:94-142`, `:261-324`, and `:326-377`
  assert actions/filesystem effects but not the health of the returned
  snapshot.
- The domain terms in `CONTEXT.md` distinguish a **projection** (a verified
  managed exposure) from an **unmanaged runtime entry**; keep those states
  distinct in assertions.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Package tests | `bun test packages/skills/src/snapshot.test.ts` | exit 0 |
| Server tests | `bun test apps/web/src/server/skills.server.test.ts` | exit 0 |
| Format check | `bun run check` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Full tests | `bun run test` | exit 0 |
| Diff safety | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- `packages/skills/src/workflows.ts`
- `packages/skills/src/snapshot.test.ts`
- `apps/web/src/server/skills.server.test.ts`

**Out of scope**:

- changing the `SkillReconcileResult` public shape;
- changing projection planning, refusal, lock, or mutation safety semantics;
- UI presentation or cache ownership changes;
- making preview operations mutate or return hypothetical post-action state.

## Git workflow

- Branch: `fix/039-fresh-skills-reconcile-state`
- Use one focused commit, for example
  `Return fresh state after Skills reconciliation`.
- Do not push or open a pull request unless explicitly requested.

## Steps

### Step 1: Add failing post-mutation snapshot assertions

Extend the existing reconcile-all and reconcile-one tests in
`packages/skills/src/snapshot.test.ts`:

- after `create-symlink`, assert the returned projection is `linked` and the
  summary no longer counts it as missing/broken;
- in the mixed safe/unmanaged case, assert the safe projection is `linked`
  while the unmanaged directory remains represented as unmanaged;
- add or extend a disable/unlink case so the returned snapshot no longer
  reports the removed managed projection as linked.

Add one server-boundary assertion in
`apps/web/src/server/skills.server.test.ts` proving the reconcile response
contains that post-action state. Match the existing temporary-home/config test
style; do not mock the workflow result.

**Verify**: before the implementation change, the targeted tests fail only on
the new returned-snapshot assertions.

### Step 2: Reload the snapshot after applying actions

Refactor `applyPlannedActions` in `packages/skills/src/workflows.ts` so it has
the original load input needed to call `loadSkillManagementSnapshot` after all
safe actions finish. Preserve the original `actions` array exactly, including
refused unmanaged actions, but return the fresh snapshot.

Both `reconcileSkill` and `reconcileAllActiveSkills` must use the fresh result.
Do not route `previewReconcileAllActiveSkills` through the applying helper:
preview must continue to return current state plus planned actions without
filesystem mutation.

If rereading fails after actions were applied, propagate the existing typed
workflow error; do not manufacture a snapshot or claim rollback.

**Verify**:

```sh
bun test packages/skills/src/snapshot.test.ts
bun test apps/web/src/server/skills.server.test.ts
```

Both commands exit 0.

### Step 3: Verify the unchanged contract end to end

Confirm there is still one `SkillReconcileResult` shape and that no app route or
component needed a special refresh workaround.

**Verify**:

```sh
grep -En "return \\{ actions, snapshot \\}" packages/skills/src/workflows.ts
bun run check
bun run typecheck
bun run test
git diff --check
```

The `rg` command may match only the preview function; all other commands exit
0.

## Test plan

- Reuse `packages/skills/src/snapshot.test.ts` temporary filesystem fixtures.
- Cover reconcile-all, reconcile-one, mixed safe/refused actions, and
  disable/unlink.
- Keep one server test so the JSON-safe boundary cannot regress independently.
- Assert both action history and resulting projection/summary state.

## Done criteria

- [ ] Applying reconcile operations return a freshly loaded snapshot.
- [ ] Preview remains read-only and retains current-state semantics.
- [ ] Refused unmanaged entries remain visible and untouched.
- [ ] Package, server, full tests, formatting, and typechecking pass.
- [ ] No public result shape or UI code changed.
- [ ] This plan's row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- the result contract or workflow ownership has moved since `96b3dff`;
- a fresh snapshot would require replaying actions or weakening mutation locks;
- tests reveal that callers depend on stale state;
- the fix requires changing preview semantics or UI cache ownership;
- a verification command fails twice after one reasonable correction.

## Maintenance notes

Any new mutation workflow returning `SkillReconcileResult` must follow the same
rule: `actions` describe what was attempted, while `snapshot` describes the
state observed after completion. Reviewers should ensure the extra read happens
after all actions and outside no preview path.
