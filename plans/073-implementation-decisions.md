# Plan 073 implementation decisions

This is the review ledger for implementation choices made while executing
Plan 073. It records decisions and trade-offs; measured results and completion
evidence remain authoritative in the plan's Execution log.

## D001 — Use the corrected implementation branch

- **Decision**: implement on `refactor/report-decision-first-ui-ux` at clean
  start SHA `edf7704c`.
- **Reason**: the originally supplied `agent/report-decision-first-ui-ux`
  branch does not exist. Commit `edf7704c` changes the committed plan to name
  the existing `refactor/` branch, while the code still matches base
  `1868b108` exactly.
- **Consequence**: no branch rename or history rewrite.

## D002 — Treat two omitted Report token files as trivial scope corrections

- **Decision**: allow `report-warnings.svelte` and `report-status.svelte` to be
  corrected during the final visual-language pass.
- **Reason**: both active Report files already contained
  `token(colors.border)` at the planned base, but the plan listed only three
  occurrences. `report-warnings.svelte` also used interaction copper for an
  anomaly. The operator explicitly authorized continuing through trivial STOP
  conditions and resolving the border issue at the end.
- **Consequence**: remove all five invalid Report token references and restore
  semantic warning colors before the final gate; do not broaden this exception
  beyond these two Report files.

## D003 — Keep the plan's public test seams

- **Decision**: test through focused-result validation, memory/SQLite parity,
  pure presentation models, composition props, the existing Drawer API, and
  browser-observable DOM/network behavior.
- **Reason**: these are the seams agreed in Plan 073 and required by the TDD
  workflow. Tests must not couple to private helpers or reproduce production
  formulas as their expected values.
- **Consequence**: each behavior slice starts red and becomes green in the same
  wave; database and browser boundaries are the only mocked or synthetic edges.

## D004 — Enforce exclusive multi-agent file ownership

- **Decision**: the contracts agent exclusively owns the six report-core/store
  analytics and focused-query files; the UI agent exclusively owns
  design-system, Analysis, navigation-label, and Session-drawer files; the
  principal agent owns plan/docs, URL/range, composition, Overview, fixtures,
  timeline Web models, and cross-cutting E2E. QA remains read-only.
- **Reason**: prevent concurrent edits to the same file while retaining
  independent review and smoke coverage.
- **Consequence**: agents do not modify plan status, make commits, or launch
  shared browser servers without coordination.

## D005 — Use the plan's named editorial style interface

- **Decision**: expose `executiveGrid`, `editorialSection`, `sectionDivider`,
  `metricStrip`, `containedInteractive`, and `numericDisplay` from the Report
  design-system entrypoint, adding narrow caption/label styles only when the
  composition needs them.
- **Reason**: these names are locked by Step 4 and provide a narrow interface
  between the design-system and Overview composition owners.
- **Consequence**: do not change global `panel` behavior or create wrapper-only
  components.

## D006 — Run server-owning gates outside the filesystem sandbox

- **Decision**: run production builds and Playwright commands with the normal
  host permissions when required.
- **Reason**: Panda stalled before generating output inside the restricted
  sandbox, and loopback Playwright servers could not start there. The exact
  commands completed successfully outside it.
- **Consequence**: command lines, fixtures, assertions, budgets, and reporters
  remain unchanged; this is execution-environment handling, not a relaxed gate.
