# ADR 0021: Design-system promotion requires a second consumer

- **Status**: Retired 2026-10-24 (ADR review of plan 120); no replacement
- **Date**: 2026-08-25 (records the standing package policy)

> Retired because the rule describes a package shape that does not exist and a
> trigger that cannot fire. The root entry has exported only the Panda preset
> (`aiUsagePreset`) since the SvelteKit migration; reusable components live in
> `./svelte` and report slots in `./report`, so nothing is promoted "to the root
> API". `apps/web` is the only application consumer, before and after the
> connected server's removal (it had no UI), and ADR 0074 makes the product
> single-application. The package stays as the Panda build seam. Not
> generalizing for a single consumer remains ordinary review practice and
> needs no record of its own.

## Context

`@ai-usage/design-system` exposes a root API of genuinely reusable primitives
and a `./report` entry of report-specific style slots. With one application in
the workspace, every abstraction has exactly one consumer, which makes
premature generalization cheap to commit and expensive to unwind.

## Decision

- Report-specific style slots live in `@ai-usage/design-system/report`, not in
  the root API; the root API must not become app-specific.
- A primitive is promoted from `./report` to the root API only when a concrete
  second consumer exists — another app or a second report surface — never
  speculatively.
- The `./report` entry is audited for promotion candidates when that second
  consumer appears, not before.

## Consequences

- Single-consumer components stay colocated with their consumer's vocabulary
  and can change without a compatibility argument.
- The root API stays small enough to review as a whole.

## Rejected alternative

Promoting primitives at authoring time ("it looks generic") was rejected: a
generic-looking API with one consumer encodes that consumer's assumptions and
must be re-reviewed anyway when the second one arrives.

## Evidence

- [Design-system root entry](../../packages/design-system/src/index.ts)
- [Report entry](../../packages/design-system/src/report.ts)
- [Future-work guardrails](../future-work.md)
