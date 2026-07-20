# Plan 028: Measure and implement session scroll architecture

> **Status: BLOCKED** until the parallel session-analysis work is merged into main, the portfolio worktree is recreated/rebased, cited code is re-read, and `<NEW_MAIN_SHA>` is replaced. Then set TODO. Execute sequentially after plan 027.
>
> **Drift check**: `git diff --stat <NEW_MAIN_SHA>..HEAD -- README.md package.json bun.lock .github apps/web packages/design-system docs plans`

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: 027
- **Category**: frontend portfolio program
- **Planned at**: pending merged-main SHA, 2026-07-20

## Why this matters

This is one required, separately reviewable slice of the public frontend signal. It must produce evidence an agent can verify without changing product semantics or using real user data.

## Current state to revalidate after merge

The 2026-07-19 audit confirmed this slice in the current Solid/TanStack/Panda web app. Before TODO, replace this paragraph with exact post-merge paths, symbols, line references, and short excerpts. If evidence moved or disappeared, STOP and revise rather than guessing.

## Scope

- **In scope**: deterministic 5k benchmark; decision table; full-query or corrected transparent prefetch; transitive gzip/DOM budgets.
- **Out of scope**: provider credentials/APIs, real histories, non-loopback serving, HTML export, LAN sync, framework migration, unlisted product behavior, external publication.

## Steps

1. Add characterization or a failing regression test for every behavior named in Scope. **Verify**: each test fails for the intended reason before implementation.
2. Implement the smallest behavior-preserving change matching repository patterns and AGENTS.md. **Verify**: focused unit/type/browser commands exit 0.
3. Run the slice-specific gates: exact 5k reachability; desktop DOM <=300; mobile <=600; no duplicate/drop; static gzip <= min baseline+10%,235KB. **Expected**: every named invariant is machine-checked and passes.
4. Run `bun run check && bun run lint && bun run typecheck && bun run test && bun run build && bun run test:web-production && bun run test:setup-loopback && bun run test:e2e && bun run test:e2e-production`. **Expected**: all exit 0.
5. Confirm `git status --short` contains only the post-merge in-scope file list recorded before execution; update this plan/index status and commit this slice before the next agent.

## Test plan

Use existing colocated Bun model tests and role-based Playwright tests as structural patterns. Add deterministic synthetic fixtures only. Required oracle: exact 5k reachability; desktop DOM <=300; mobile <=600; no duplicate/drop; static gzip <= min baseline+10%,235KB.

## Done criteria

- [ ] Post-merge SHA, excerpts and exact file scope are filled in.
- [ ] Characterization/regression tests prove the intended failure and fix.
- [ ] Slice-specific and full gates pass.
- [ ] No real data, unsupported claim, external mutation or out-of-scope file enters the diff.
- [ ] Index status accurately reflects completion.

## STOP conditions

Stop on unmerged parallel work, placeholder SHA/evidence, source drift, missing deterministic fixture, need for an out-of-scope contract, inconclusive measurement, any external write, or the same gate failing twice.

## Maintenance notes

Review future changes against the named oracle. Do not weaken a gate to make CI green; update evidence and thresholds only with a measured, reviewed reason.
