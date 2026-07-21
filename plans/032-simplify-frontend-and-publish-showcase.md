# Plan 032: Simplify the frontend and prepare the public showcase

> **Status: BLOCKED** — ready after plan 031 is DONE.
>
> This is the final frontend step-up plan. It combines the remaining internal
> cleanup with truthful public documentation so the screenshot reflects the
> final UI, not an intermediate state.

## Outcome

The main frontend seams have clear owners, the public README explains the app's
value with one synthetic hero image showing Overview and session detail, and the
repository contains concise evidence for the important technical decisions.

## Current evidence

- `apps/web/src/dashboard.tsx` still coordinates report lifecycle, filters,
  selection, quotas, layout, and child views.
- `apps/web/src/time-range-control.tsx` mixes interaction wiring with rendering,
  despite the existing pure state owner in `time-range-control-state.ts`.
- `apps/web/src/routes/index.tsx` owns post-mount loading/retry behavior that
  should be expressed consistently with the TanStack Router route lifecycle.
- Skills routes contain many local `css()` declarations; only repeated,
  semantically stable patterns belong in the design system.
- The repository lacks a focused frontend case study, evidence-backed ADR set,
  license/public contribution guidance, and a single strong README image.

## Scope

### Internal cleanup

- Extract cohesive Dashboard owners for report lifecycle, session selection,
  and provider/source status while keeping Dashboard as the readable composition
  root.
- Make `time-range-control-state.ts` the interaction authority and leave the
  component responsible for DOM measurement, events, and rendering.
- Move the report route's load/retry behavior into the idiomatic TanStack Router
  loader/query lifecycle without changing privacy, deep links, or demo behavior.
- Promote only repeated, semantically named Skills/layout styles to the design
  system; keep one-off route styles local.

### Evidence and publication material

- Add at most six short ADRs for decisions already implemented and protected by
  tests. Each ADR links to current code/tests and records context, decision,
  consequences, and rejected alternative—no custom validator.
- Add an MIT `LICENSE` using `2026 Nathan Laprie`, plus concise
  `CONTRIBUTING.md` and `SECURITY.md` (private reports through GitHub Security
  Advisories; no invented SLA).
- Add `docs/frontend-case-study.md` covering problem, constraints, architecture,
  accessibility, performance, testing, and honest trade-offs.
- Add one 1600×900, sub-1 MiB synthetic hero image. It must be a single app
  frame showing both the Overview value proposition and an open detailed session
  drawer. Use the default light theme, fixed synthetic data, timezone, viewport,
  and disabled animation. No montage, GIF, real data, external image tool, or
  byte-identical cross-platform requirement.
- Rewrite the README opening around product value, the hero, a privacy-safe demo
  command, core frontend choices, test commands, case study, and license.
- Add `docs/publication-checklist.md` with the exact proposed GitHub description,
  topics, optional homepage candidate, README claim review, and manual release
  checklist. Do not execute external changes.

Out of scope: Storybook, a hosted demo, SSR expansion, a general design-system
rewrite, new product metrics, GIF/video, `gh repo edit`, commit, push, PR, or
publication.

## Implementation

1. Add characterization tests around Dashboard loading/retry, selection, URL
   state, and time-range keyboard/pointer behavior.
2. Extract the smallest cohesive owners. Avoid generic hooks or context layers
   with one consumer; the composition root should become shorter and easier to
   trace.
3. Migrate route loading to the Router's supported lifecycle and retain the
   existing synthetic/live privacy boundaries and error recovery.
4. Inventory Skills/layout styles. Promote only patterns with a semantic name
   and at least two consumers; remove local duplicates.
5. Write up to six ADRs from the final code and passing tests. Do not document
   planned architecture as if it already existed.
6. Add license, contribution/security guidance, and the case study.
7. Capture the hero from `bun run demo` with a small Playwright capture script.
   Assert Overview and the selected session heading are visible before writing
   the PNG. Close the server in `finally`.
8. Update README and publication checklist. Claims must link to a test, ADR, or
   source path and avoid unverifiable superlatives.

## Verification

- Characterization tests pass before and after the refactor; existing deep-link,
  retry, demo, keyboard, and session-detail E2E tests remain green.
- `git diff --stat` shows fewer orchestration responsibilities in Dashboard and
  TimeRange without a larger public abstraction surface.
- Every ADR describes shipped behavior and cites a regression test.
- The PNG is 1600×900, below 1 MiB, synthetic, legible at README width, and
  contains Overview plus an open session drawer.
- README links and commands resolve; publication checklist contains no completed
  external action.
- Run the complete repository gates:

  ```sh
  bun run check
  bun run lint
  bun run typecheck
  bun run test
  bun run build
  bun run test:web-production
  bun run test:setup-loopback
  bun run test:e2e
  bun run test:e2e-demo
  bun run test:e2e-production
  ```

## Done

- [ ] Dashboard, TimeRange, Router loading, and repeated Skills styles have clear
  owners with behavior preserved.
- [ ] No more than six concise, evidence-backed ADRs exist.
- [ ] License, contributing, security, and case-study documents are accurate.
- [ ] One synthetic hero communicates Overview and session-detail value.
- [ ] README is useful to a recruiter before implementation details.
- [ ] Exact publication copy is prepared but nothing external was changed.
- [ ] Full gates pass and the demo server is stopped.

## STOP conditions

Stop if cleanup expands into a framework/design-system rewrite, a public claim
lacks evidence, the hero needs real data or compositing, or an external write is
required. If `Nathan Laprie` is not the desired MIT holder, change that literal
before implementation; it is the only identity assumption in this sequence.

## Maintenance

Keep ADRs historical and short; supersede rather than rewrite old decisions.
Recapture the hero only after an intentional visible change and review it like
source. Publication metadata remains a manual repository-owner action.
