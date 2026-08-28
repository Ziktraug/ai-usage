# ADR 0022: Skill observations carry a tier, and an unobservable harness is never a zero

- **Status**: Accepted
- **Date**: 2026-08-28
- **Amends**: none
- **Related**: [0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md)
  (two planes), [0016](0016-collect-everything-present-faithfully.md),
  [0017](0017-absence-is-a-gap-not-a-category.md),
  [0018](0018-one-canonical-number-per-concept.md)

## Context

The skills surface is an inventory: it answers *what exists* on this machine —
scope, invocation, origin, state, exposure. It cannot answer the question that
turns an inventory into a decision: **which of these skills actually does
anything?** Two verdicts depend on it — a projected skill that is never observed
is a deletion candidate, and an observed skill that is not in the managed source
repository is an adoption candidate.

The obstacle is that the four harnesses do not observe skills equally, and the
gap is structural rather than incidental. Measured against real local history on
2026-08-27 and re-measured on execution:

| Harness | Signal | What is recoverable |
| --- | --- | --- |
| Claude Code | `Skill` tool call | name, timestamp, cwd, session, success, and a resolved base directory for ~72% of invocations |
| OpenCode | `skill` tool part | name, status, session, timestamp; **no** resolved path |
| Codex | none | a catalogue injected into every system prompt, plus `exec` commands that read a `SKILL.md` |
| Cursor | none | nothing — zero `skill` tool keys in its state database |

A single "invocations" number aggregated across these four would be actively
false in two independent ways: it would equate a declared tool call with a
guess made from a shell string, and it would count a harness that cannot report
as a harness that reported nothing.

## Decision

Four rules, binding on every producer and every consumer of skill observations.

1. **Every skill observation carries an observation tier, stored explicitly.**
   The tier has three values — `declared`, `inferred`, `exposed` — defined in
   `CONTEXT.md`. The tier is part of the fact, is persisted alongside it, and
   travels with every count derived from it. Tiers are never silently merged;
   a total that sums `declared` and `inferred` without saying so is a defect.

2. **Unresolvable is a state, not a drop.** An observation whose skill name
   resolves to no inventory entry is retained and labelled unresolved.
   Harness-bundled and plugin-provided skills are exactly the population that
   fails to resolve, and they are exactly the "invoked but unmanaged" verdict
   this family exists to produce.

3. **Absence of observation is not zero usage.** Per-harness observability is
   part of the presented model. A harness with no collector — Cursor today —
   renders as *not observable*. It is never rendered as `0`, and it is never
   included in a denominator that would make other harnesses look complete.

4. **Provenance is per metric, not global.** Each rendered count carries its own
   tier and harness coverage. No page-level data-quality banner is introduced;
   this family follows the same rule as the rest of the product.

The inventory↔observation join happens in the web server layer. `@ai-usage/skills`
is a filesystem-projection domain and does not gain a usage-store dependency;
observations are read through the read-only data plane per ADR 0009, which is
also why they are an auxiliary fact family with their own tables rather than
new columns on `usage_rows`.

## Consequences

- The store must accept a permissive shape: nullable resolved path,
  open-vocabulary skill name. This store re-validates persisted rows on read, so
  tightening the schema later would retroactively invalidate stored history.
  Validation belongs at the presentation edge.
- Consumers cannot ask for "how many times was this skill used" without also
  choosing a tier and a harness. That friction is the point.
- Adding a harness means deciding, at design time, which tier it can support —
  and saying *not observable* is a legitimate answer that ships.
- Codex contributes both an `exposed` and an `inferred` stream from the same
  session. They are produced by two separate extractors and are never combined.

## Rejected alternative

A single `skillInvocations` counter per skill, with a footnote about coverage,
was rejected. A footnote is not a unit: the number would be compared across
skills whose harnesses observe them differently, and the comparison would be
wrong in a way no reader could detect. Rejected for the same reason ADR 0018
requires one canonical number per concept — "invocations" is three concepts.

## Evidence

- [Plan 099 — skill invocation observability](../../plans/099-skill-invocation-observability.md),
  whose "Measured current state" section records the per-harness sampling
- [`CONTEXT.md`](../../CONTEXT.md) — skill observation, observation tier, skill
  resolution, observability
- [`packages/report-core/src/skill-observation.ts`](../../packages/report-core/src/skill-observation.ts) —
  the shared fact and its permissive parser
- [`packages/usage-store/src/skill-observation-store.ts`](../../packages/usage-store/src/skill-observation-store.ts)
- [`packages/local-machine/src/codex-skill-observation.ts`](../../packages/local-machine/src/codex-skill-observation.ts) —
  the two Codex extractors that must never be merged
