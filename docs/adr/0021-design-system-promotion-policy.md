# ADR 0021: Design-system promotion requires a second consumer

- **Status**: Accepted
- **Date**: 2026-08-25 (records the standing package policy)

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
