# Plan 030: Add durable frontend regression gates

> **Status: DONE** — the shared browser, axe, visual, and package-test gates pass after each failure mode was proven.
>
> **Baseline**: commit `6135fe7`. Baselines must be created from the accessible
> state delivered by plan 029.

## Outcome

CI catches broken user flows, serious accessibility violations, unexpected
browser errors, and meaningful visual regressions with a small, conventional
Playwright suite.

## Current evidence

- Playwright already covers dashboard, time range, Skills, Sources, and the
  production report.
- There is no axe gate and no screenshot baseline.
- `apps/web/src/css-bundle.test.ts` checks the web CSS entry but does not wire a
  design-system package test into Turbo.
- `packages/design-system/package.json` has no `test` script.
- `.github/workflows/pr-checks.yml` runs `bun run test`, whose root script
  already includes tool tests, then runs `bun run test:tools` again.

## Scope

- Add `@axe-core/playwright` as the only new test dependency.
- Add shared Playwright assertions that fail on uncaught page errors, unexpected
  console errors, and failed critical document/API requests.
- Run axe on the stable states of Overview, an open session drawer, Skills, and
  Sources/Sync; document only narrow, evidence-backed exclusions.
- Add three or four screenshots at stable product boundaries, not one snapshot
  per component.
- Wire design-system tests into its package and therefore `turbo run test`.
- Remove the duplicate CI tool-test step while keeping root test coverage.

Out of scope: Storybook, a second component-test stack, Nix/browser fingerprint
infrastructure, pixel hashes across operating systems, GIF capture, and custom
snapshot manifests.

## Implementation

1. Add a Playwright helper that starts error/request collection before
   navigation. Allow-list only errors proven intentional by an existing test.
2. Add axe scans to stable routes/states. Keep keyboard/focus assertions in
   Playwright rather than adding Solid Testing Library or a DOM emulator.
3. Add snapshots for:
   - Overview desktop;
   - Overview with a session drawer open;
   - Overview narrow viewport;
   - Skills or Sources, whichever best catches shared shell regression.
4. Freeze only the inputs needed for stability: synthetic fixture, viewport,
   timezone, theme, disabled animation, and completed loading. Use Playwright's
   normal snapshot tolerance; do not build a second baseline system.
5. Add/rename the design-system CSS/token tests so
   `bun --filter @ai-usage/design-system test` is real and automatically
   included by the root suite.
6. Delete the redundant standalone Tool tests CI step. Keep browser installation
   and existing E2E commands conventional.

## Verification

- Demonstrate each new gate once: inject a temporary axe issue, console error,
  request failure, and visual change; confirm the intended test fails, then
  revert the injection.
- Run:

  ```sh
  bun --filter @ai-usage/design-system test
  bun run test
  bun run test:e2e
  bun run test:e2e-demo
  bun run check
  bun run lint
  bun run typecheck
  bun run build
  ```

- Re-run the screenshot suite from a clean worktree; it must produce no diff.

## Done

- [x] Axe, console/page error, critical-request, and visual gates run in CI.
- [x] The suite contains no broad accessibility or console suppression.
- [x] Three or four stable snapshots cover high-value states.
- [x] Design-system tests are part of the root test graph.
- [x] Tool tests execute once, not twice.

## STOP conditions

Stop if stability appears to require machine fingerprints, broad masks, disabled
assertions, or a new test framework. Fix deterministic product/test inputs
instead; keep timing-only performance claims out of this plan.

## Maintenance

Update a baseline only with an intentional UI change and visual review. New
top-level routes should adopt the shared error/request helper and one axe scan
when they introduce a distinct interaction surface.
