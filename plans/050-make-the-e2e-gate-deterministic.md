# Plan 050: Make the E2E gate deterministic

> **Status: DONE.** Implemented and verified on 2026-07-27. Five consecutive
> unchanged-code full-suite runs passed with four workers and no retries.
>
> **Baseline**: `a65906c` on `feat/implement-plans-045-046`, measured on
> 2026-07-27 with no code changes between runs.

## Outcome

`bun run test:e2e` is one honest gate locally and in CI: both environments use the
same bounded concurrency, DOM-order assertions interpret browser bitmasks correctly,
and layout assertions retry the exact invariant while a viewport change settles.
Retries remain disabled, assertion thresholds remain unchanged, and no test is skipped
or slowed.

## Measured evidence

Three supplied consecutive full-suite runs at `a65906c`, on the same 20-core machine,
failed with a changing set:

| Run | Result |
| --- | --- |
| 1 | accessibility narrow-overflow failure |
| 2 | accessibility narrow-overflow and Skills mobile-order failures |
| 3 | Skills mobile-order failure |

That is 3/3 failed suite runs and 4/231 failed test executions. The accessibility
file alone passed 52/52 repetitions, and manual CDP reproduction at 390x844 measured
zero overflow. The changing failure set and focused green run make a deterministic
layout regression an unsupported explanation.

The unchanged-code baseline rerun for this plan produced:

| Run | Workers | Result |
| --- | ---: | --- |
| 1 | 10 | Skills unsaved-draft state timed out at line 193; 76/77 passed |
| 2 | 10 | 77/77 passed |
| 3 | 10 | 77/77 passed |

That is 1/3 failed suite runs and 1/231 failed test executions. Together, the six
recorded runs have a 4/6 suite failure rate and a 5/462 test failure rate. The new
line-193 timeout is treated as a concurrency hypothesis probe, not silently added to
scope: it must disappear at the shared worker count or trigger a STOP.

Two code facts explain the requested failures:

1. `apps/web/playwright.config.ts` selects four workers only when `CI` is present.
   Locally Playwright selected ten workers, 2.5 times CI concurrency, while both use
   the same five-second expectation timeout.
2. Both `compareDocumentPosition` checks in `e2e/skills.spec.ts` compare the complete
   result to `Node.DOCUMENT_POSITION_FOLLOWING`. The API returns a bitmask, so a
   correct following-and-contained relationship can return
   `FOLLOWING | CONTAINED_BY` (20), not only `FOLLOWING` (4).

`git diff --name-only 2eb3b96..HEAD` confirms plan 048 changed no Skills or
design-system file.

## Steps

### Step 1: Give local and CI the same concurrency

Set `workers: 4` unconditionally. Four is the already-reviewed CI capacity and avoids
making CI more aggressive merely to match a 20-core developer machine. Keep retries
unset and keep the five-second expectation timeout unchanged.

Run the full suite once and confirm its reporter states that it is using four workers.
Stress the newly observed unsaved-draft test at the shared worker count. If it still
fails, stop: that would falsify the concurrency explanation for the additional
symptom.

**Files**: `apps/web/playwright.config.ts`.

**Verify**:

```sh
bunx playwright test e2e/skills.spec.ts --grep "protects an unsaved" --repeat-each=10 --reporter=list
bun run test:e2e
```

Expected: 10/10 focused repetitions and 77/77 full-suite tests pass; the full-suite
header reports four workers.

### Step 2: Test document-position bits, not the complete mask

Change every `compareDocumentPosition` use in the E2E suite to test whether the
`DOCUMENT_POSITION_FOLLOWING` bit is present. Preserve the strict semantic claim:
the editor must precede both the inspector and its actions.

**Files**: `apps/web/e2e/skills.spec.ts`.

**Verify**:

```sh
bunx playwright test e2e/skills.spec.ts --grep "prioritizes the editor" --repeat-each=10 --reporter=list
```

Expected: 10/10 pass, and no complete-mask equality remains in the E2E suite.

### Step 3: Retry post-viewport layout invariants

Replace one-shot overflow reads made after viewport setup or resizing with
`expect.poll` over the same zero-overflow invariant. Do not change the threshold or
remove any desktop/mobile assertion. Locator assertions that already retry remain
unchanged.

**Files**: `apps/web/e2e/accessibility.spec.ts`,
`apps/web/e2e/skills.spec.ts`.

**Verify**:

```sh
bunx playwright test e2e/accessibility.spec.ts --repeat-each=4 --reporter=list
bunx playwright test e2e/skills.spec.ts --grep "bounded desktop workspace|prioritizes the editor" --repeat-each=10 --reporter=list
```

Expected: every repetition passes with the original zero-overflow requirement.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Format and static checks | `bun run check` | exit 0 |
| Lint and boundaries | `bun run lint` | exit 0 |
| Type safety | `bun run typecheck` | all tasks pass |
| Unit/integration tests | `bun run test` | all pass |
| Diff hygiene | `git diff --check` | no output |
| Browser gate | `bun run test:e2e` | 77/77 pass using four workers |
| Focused browser repetitions | commands in each step | all repetitions pass |

Do not run `bun install`. Do not add Playwright retries.

## Done criteria

- [x] Local and CI both use exactly four Playwright workers.
- [x] Retries remain unset and the expectation timeout remains 5000 ms.
- [x] Every E2E `compareDocumentPosition` assertion tests the required bit.
- [x] Post-viewport overflow assertions retry the exact zero-overflow invariant.
- [x] The line-193 unsaved-draft probe passes 10/10 at four workers.
- [x] `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`, and
      `git diff --check` pass.
- [x] Five consecutive unchanged-code `bun run test:e2e` runs pass.
- [x] Before and after failure rates are recorded in the Execution log.

## STOP conditions

Stop and report if:

- the line-193 unsaved-draft failure reproduces at four workers, because that would
  establish a cause beyond the two authorized root causes;
- the narrow overflow failure persists after shared concurrency and retrying the
  exact post-resize invariant;
- any fix appears to require retries, a higher overflow threshold, a skipped/fixed/
  slow test, or a higher expectation timeout;
- another `compareDocumentPosition` assertion has semantics other than testing a
  relationship bit and cannot be corrected without changing the asserted behavior;
- five consecutive full-suite runs do not pass without code changes.

## Execution log

### Before

At `a65906c`, supplied runs: 3/3 suites failed (100%); 4/231 tests failed (1.73%).
Plan-050 reruns: 1/3 suites failed (33.3%); 1/231 tests failed (0.43%). Combined:
4/6 suites failed (66.7%); 5/462 tests failed (1.08%).

Failure artifacts from the plan-050 baseline run are preserved at
`/tmp/ai-usage-e2e-baseline-run-1`.

### After

At `b022975`, five consecutive unchanged-code full-suite runs passed: 5/5 suites
(100%) and 385/385 test executions, for a 0% suite failure rate and a 0% test
failure rate. Every run reported four workers. Retries remained unset and
`expect.timeout` remained 5000 ms.

Focused verification also passed:

| Probe | Result |
| --- | ---: |
| Unsaved-draft state at four workers | 10/10 |
| Mobile editor DOM order | 10/10 |
| Accessibility file repeated four times | 52/52 |
| Desktop/mobile Skills layout repeated ten times each | 20/20 |

`bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`, and
`git diff --check` passed before the final five-run sequence. The complete E2E
suite contains two `compareDocumentPosition` uses; both were the known full-mask
equality bug and both now test `DOCUMENT_POSITION_FOLLOWING` with `&`. No additional
wrong assertion was found beyond those two instances of the reported bitmask bug.

Root cause 1 accounts for the load-dependent failures: local execution was using ten
workers while CI used four, and the newly observed line-193 timeout passed 10/10 after
the environments were aligned. Root cause 2 independently accounts for the false DOM
order result: containment can add bits to the correct `FOLLOWING` relationship. The
post-viewport polling change removes one-shot observation of intermediate overflow
without weakening the zero-overflow requirement.

A second, independent mechanism was identified after this measurement: the
`Codex sessions` policy mutation in `sources.spec.ts` was restored only on the happy
path. The 5/5 determinism result above measured runs that never failed, so it could not
expose state leakage into a reused local server; this was outside plan 050's
load-timing and bitmask scope. The follow-up closes the leak with unconditional
`test.afterEach` restoration and a deliberately failing negative control that confirmed
the server returned to an enabled, scheduled policy.

### API restore hardening follow-up

On 2026-07-27, the unconditional restore moved from page navigation and a
checkbox interaction to an idempotent `set-enabled` command through Playwright's
request fixture. Two deliberate failures ran against one explicitly owned synthetic
server:

| Negative control | Observed failure | Post-hook source state |
| --- | --- | --- |
| Broken assertion after the disable mutation | Failed only at the injected assertion; the hook added no error | `enabled`, `scheduled` |
| `await page.close()` after the disable mutation | Failed on the next page locator; the hook added no error | `enabled`, `scheduled` |

Each post-hook state came from a fresh source-control SSE snapshot, not from a
subsequent passing suite. The temporary failures were then removed and the original
assertions restored. An initial diagnostic also confirmed that Nitro maps
`server/routes/api/source-control.post.ts` to `/api/source-control/command`; a POST
to `/api/source-control` returned 404, so the live command route was used for both
successful controls.
