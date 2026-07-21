# Plan 032: Simplify frontend ownership and document decisions

> **Status: DONE** — frontend ownership is simplified and the implemented
> architecture is documented.

## Outcome

The main frontend seams have clear owners, route loading follows the Router
lifecycle, repeated styles live at the appropriate design-system boundary, and
the repository records the decisions that future changes need to preserve.

## Current evidence

- `apps/web/src/dashboard.tsx` still coordinates report lifecycle, filters,
  selection, quotas, layout, and child views.
- `apps/web/src/time-range-control.tsx` mixes interaction wiring with rendering,
  despite the existing pure state owner in `time-range-control-state.ts`.
- `apps/web/src/routes/index.tsx` owns post-mount loading/retry behavior that
  should be expressed consistently with the TanStack Router route lifecycle.
- Skills routes contain many local `css()` declarations; only repeated,
  semantically stable patterns belong in the design system.
- The repository lacks concise decision records and contribution/security
  guidance for these boundaries.

## Scope

- Extract cohesive Dashboard owners for report lifecycle, session selection,
  and provider/source status while keeping Dashboard as the readable composition
  root.
- Make `time-range-control-state.ts` the interaction authority and leave the
  component responsible for DOM measurement, events, and rendering.
- Move the report route's load/retry behavior into the idiomatic TanStack Router
  loader/query lifecycle without changing privacy, deep links, or demo behavior.
- Promote only repeated, semantically named Skills/layout styles to the design
  system; keep one-off route styles local.
- Add short ADRs for decisions already implemented and protected by
  tests. Each ADR links to current code/tests and records context, decision,
  consequences, and rejected alternative—no custom validator.
- Add an MIT `LICENSE` using `2026 Nathan Laprie`, plus concise
  `CONTRIBUTING.md` and `SECURITY.md` (private reports through GitHub Security
  Advisories; no invented SLA).
- Update the README and architecture documentation only where behavior or
  development commands changed.

Out of scope: Storybook, SSR expansion, a general design-system rewrite, new
product metrics, promotional material, repository metadata, commit, push, or PR.

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
6. Add license and concise contribution/security guidance.
7. Update README and architecture references to match the shipped behavior.

## Verification

- Characterization tests pass before and after the refactor; existing deep-link,
  retry, demo, keyboard, and session-detail E2E tests remain green.
- `git diff --stat` shows fewer orchestration responsibilities in Dashboard and
  TimeRange without a larger public abstraction surface.
- Every ADR describes shipped behavior and cites a regression test.
- README links and commands resolve.
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

- [x] Dashboard, TimeRange, Router loading, and repeated Skills styles have clear
  owners with behavior preserved.
- [x] Concise, evidence-backed ADRs record the durable decisions.
- [x] License, contributing, and security documents are accurate.
- [x] README and architecture documentation match the product and development
  workflow.
- [x] Full gates pass and the demo server is stopped.

## STOP conditions

Stop if cleanup expands into a framework/design-system rewrite, changes product
behavior without characterization, or requires an external write. If
`Nathan Laprie` is not the desired MIT holder, change that literal before
implementation; it is the only identity assumption in this sequence.

## Maintenance

Keep ADRs historical and short; supersede rather than rewrite decisions that
have shipped outside the current branch.
