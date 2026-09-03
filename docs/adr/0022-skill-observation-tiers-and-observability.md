# ADR 0022: Skill observations carry a tier, and an unobservable harness is never a zero

- **Status**: Accepted
- **Date**: 2026-08-28
- **Amends**: none
- **Amended by**: [0037](0037-current-producers-and-durable-skill-invocations.md)
  (producer roster, completeness freshness, and tier-specific retention)
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
| OpenCode | `skill` tool part | name, status, session, timestamp, and the resolved directory from `state.metadata.dir` when present |
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
   part of the presented model, carried as an explicit marker rather than
   inferred from an empty list — `observed nothing` and `cannot observe` are the
   same array, and only the marker separates them. A harness with no collector —
   Cursor today — is `not-observable`. It is never rendered as `0`, and it is
   never included in a denominator that would make other harnesses look
   complete.

   The marker is derived from the harness, not from what a run produced, so a
   failed sweep of an observable harness stays observable.

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
- **And the presentation edge refuses one row, never the response.** The response
  schema is stricter than the store — a name carrying control characters cannot
  be rendered as text — so the read filters such rows out and counts them into
  `skipped`, the channel that already means "persisted rows the reader could not
  re-validate". Shipping one would make the schema reject everything, and a
  single malformed persisted row would take the whole observation surface down
  with it. The predicate is defined once, in `report-core`, so the producer that
  filters and the schema that enforces cannot drift apart.
- **Observations aggregate by skill *name*, not by installation.** Two
  installations sharing a name — a managed global skill and a project-local copy
  of `pr-review`, say — share one set of counts. This is forced by what the
  harnesses record: OpenCode normally discloses `state.metadata.dir`, but that
  field remains optional, and Claude Code discloses a resolved base directory
  for roughly 70% of invocations. A complete installation-level answer must
  therefore retain observations that have nothing safe to attribute. Per-install
  attribution would need an explicit *unattributable* bucket alongside the
  attributed ones, and is out of scope here.

  Two consequences follow, and both are requirements rather than notes. The
  name scope is **disclosed** wherever counts appear beside one selected
  installation — per-metric provenance, in words, next to the numbers. And a
  claim derived from the *inventory* rather than from the observations —
  managed-or-unmanaged, and the deletion candidacy that depends on it — must not
  be told about an installation it was not decided from: on a project-local
  install whose name is also managed, that verdict describes the other install,
  so the collision is named and the verdict withheld. A project-only name is
  unaffected: "this name is nowhere in the managed repository" is a property of
  the name, so the adoption verdict stays sound.
- Consumers cannot ask for "how many times was this skill used" without also
  choosing a tier and a harness. That friction is the point.
- Adding a harness means deciding, at design time, which tier it can support —
  and saying *not observable* is a legitimate answer that ships.
- Codex contributes both an `exposed` and an `inferred` stream from the same
  session. They are produced by two separate extractors and are never combined.
- The `inferred` tier claims the model *read* a skill, so the Codex matcher
  counts a path only where it is plausibly a read operand. A `rm`, a patch body,
  a redirect target (`… > …/SKILL.md`, a write), an in-place edit
  (`sed -i … …/SKILL.md`, which rewrites and displays nothing), and a search
  pattern (`rg …/SKILL.md transcript.txt`, which searches *for* the path) are
  each evidence of something other than use; counting them would be false rather
  than merely uncertain. Option-with-value forms are modelled — long, short,
  clustered, and glued — because a flag that swallows its value shifts every
  later operand and lands a pattern in file position. The command is decoded out
  of its tool-call envelope first — bounded by the executed call's own balanced
  argument, quote-aware, with no whole-blob fallback — and matched against whole
  shell tokens, so a stored path is a path and never a fragment of the command
  that named it.
- **Where the tier cannot be sure, it reports nothing.** This is the governing
  rule of the `inferred` matcher, and it is enforced by refusal rather than by
  guesswork at every point the input leaves the modelled grammar: only an
  allowlist of exec-shaped tool calls is inspected; a malformed, unterminated or
  type-mismatched call yields no command; a segment whose verb is not a modelled
  reader yields nothing; and a segment using a flag the verb's model does not
  know is abandoned entirely, because an unknown arity makes every operand
  position after it unknown too.

  The consequence is deliberate: constructing a false `inferred` observation
  requires input that the grammar does not model at all, and everything inside
  the grammar errs toward fewer observations. A missing inferred read is a gap;
  a fabricated one is a false claim about what the operator's model did, and the
  two are not equally bad. Measured against real history, refusing this much
  costs nothing — the modelled flag sets cover what real commands use.

- **Two limits are assumed rather than closed**, each because closing it would
  cost real observations to defend against a construction with no measured
  incidence:

  - a *quoted* dash-word is read as an operand rather than a flag, so
    `rg "--" …/SKILL.md f` can over-count. The corpus holds exactly three quoted
    dash-words, all genuine data operands that this behaviour handles correctly;
  - **compound shell constructs are not interpreted.** The matcher reads the
    grammar of a command line; it neither executes one nor reimplements the
    tools a command names. Text that looks like a read, inside a construct that
    would not perform one, is therefore still counted — a conditional chain that
    never runs (`false && cat X`), a heredoc body re-scanned as commands
    (`cat <<'EOF' … EOF`), a function body defined but never invoked
    (`f() { cat X }`), or a flag value the real tool would reject, since values
    are not domain-validated (`head --lines=bogus X`).

  Both admit a rare false observation on synthetic input, and every construct
  named above has zero incidence in the measured corpus. Closing them would mean
  interpreting shell execution or re-implementing each tool's argument
  validation; the cheap approximations that would exclude them — dropping
  post-`&&` segments, refusing anything after `<<` — cost common genuine reads
  such as `cd repo && cat …/SKILL.md`.

  This is the reason the tier is named `inferred` rather than treated as fact:
  it is reported separately, labelled, and never summed with `declared`. A tier
  whose errors are disclosed is usable; one presented as certain would not be.
- Every bound in this family reports itself. A read budget or per-session
  ceiling is detected one past the bound, never at it, because a list that stops
  exactly at the limit is indistinguishable from a complete one; the resulting
  count is presented as a lower bound rather than a number. This includes the
  per-skill resolved-path ceiling, which carries its own
  `resolvedPathsTruncated` marker: a silently short list of directories reads as
  a complete census of where a skill lives.
- **Producer bounds survive the collection cycle.** Extractor truncation and
  rejection are persisted as tier-group completeness beside the observations,
  in the same transaction and even for an empty batch. A warning alone is an
  operational event and cannot support a durable absence verdict after restart.
  Invocation incompleteness feeds `invocationLowerBound`; exposure-only
  incompleteness feeds only `lowerBound`. A semantic change in completeness
  advances the store generation even when every observation row is unchanged.
  A same-version migration seeds legacy observable machine/harness pairs as
  incomplete until their next successful sweep; missing historical producer
  state is never interpreted as proof of completeness.
- **The tiers do not share a read budget, and their bounds are reported
  separately.** They are not produced at comparable rates. A Codex session emits
  one `exposed` row per catalogue entry, so on the operator's real store exposure
  outnumbers actual invocations 78,442 to 1,481 — 53 to 1. A single pooled
  `ORDER BY observed_at DESC LIMIT n` therefore spends the entire budget on
  catalogue injections: measured, a 20,000-row read returned 539 of 1,481
  invocations and cut six months of invocation history down to three weeks, so
  skills with hundreds of recorded reads rendered as *offered but never
  invoked*. The read now takes the invocation tiers first, against the full
  budget, and fills the remainder with exposure.

  The two bounds are then distinct facts and are carried as two fields.
  `lowerBound` means some count is a floor. `invocationLowerBound` means the
  `declared`/`inferred` evidence was itself cut short — and **only that one makes
  an absence verdict provisional**. Keying provisionality on the pooled bound
  hedged every verdict on every real store, permanently, for a reason unrelated
  to what the verdicts claim; a hedge that can never come off is not a
  qualification, it is noise. A clamp that drops whole skill rows also sets
  `invocationLowerBound`, because the inventory join re-adds every managed skill
  it does not see — as a skill with no tallies, which reads as *never observed*.

  **The generalisable rule: a fact family whose members are produced at wildly
  different rates cannot share one recency-ordered budget.** The abundant member
  wins every time, and the scarce member — which is usually the one carrying the
  meaning — disappears silently while every bound-reporting mechanism says the
  system is behaving correctly.
- **A bound belongs to the harness whose evidence was lost, and a cross-harness
  claim keeps the global one.** This is decision 4 made structural. A count on
  this surface cannot exist without its harness, so a producer answer that names
  which harness it failed for scopes its own bound: one permanently-truncated
  Codex tool-call line on the operator's real store used to render Claude Code's
  47 fully-collected declared invocations as `≥47` and degrade "no signal
  recorded for Claude Code" to "no signal in loaded history". Both statements
  belong to one harness, and neither had lost anything.

  The two facts are therefore carried together — the global `lowerBound` /
  `invocationLowerBound` and a per-channel list of the harnesses each loss
  belongs to — and **which one a statement reads is decided by what the
  statement claims about**, not by which is more conservative:

  - a rendered count, and a per-harness absence phrase, read the harness's own
    entry;
  - `deletionCandidate`, `never-observed`, `offered-only` and every
    `verdictProvisional` read the **global** flag, because each asserts a skill
    was invoked in *no* observable harness. One harness's short evidence makes
    that unprovable however complete the others are, so scoping them would turn
    an unproven absence into a stated fact — the opposite of the correction
    above, and a worse error than the hedge it would remove.

  Attribution is only ever claimed where it is known. A loss that cannot name a
  harness — a recency-ordered read that stopped mid-history, a refusal count that
  records how many rows failed re-validation but not whose — sets an explicit
  *unattributed* marker that hedges every harness, and a producer reporting a
  loss without naming a harness is read the same way. Fail-closed is the default:
  a list that must be truncated to fit the response sets that marker too, because
  a silently short list of affected harnesses reads as proof that the omitted
  ones are clean. Clamps downstream *can* name their harnesses, since the rows
  they drop are in hand; they mark every harness that carried a dropped row, on
  the channel that was degraded, which over-hedges an exposure-only contributor
  to a dropped row rather than under-hedging anything.
- **The bound that has to hold is the one on the response.** The read is clamped
  before the inventory join, and the join then re-injects every managed skill,
  merges the store's harness keys into the catalogue roster, and widens each row,
  so a payload that passed the read's bound can still exceed the contract's. A
  cap exceeded is not a soft failure — the contract refuses the whole response
  and a valid store renders as *unavailable* — so the assembled response is
  clamped against the contract's published caps and every clamp sets
  `lowerBound`. A shorter honest answer beats a `503`.
- Observations are retained on the same discipline as the provider-quota family
  and pruned during engine startup recovery. Rescan-based collectors also pass
  the same cutoff to import, so the next sweep cannot resurrect rows that
  retention just removed. An auxiliary fact family with no retention caller or
  import cutoff grows for the life of the store.
- **An observation's identity is stable; its content is not.** The identity names
  one real event, but this product's *reading* of that event improves as the
  collectors do, so a re-import with different content overwrites and is reported
  as an update that advances the store generation. Freezing identity rows would
  make a bad extraction permanent, with no repair short of deletion. An unchanged
  re-import — the normal case on every sweep — changes nothing and advances
  nothing.

## Rejected alternative

A single `skillInvocations` counter per skill, with a footnote about coverage,
was rejected. A footnote is not a unit: the number would be compared across
skills whose harnesses observe them differently, and the comparison would be
wrong in a way no reader could detect. Rejected for the same reason ADR 0018
requires one canonical number per concept — "invocations" is three concepts.

## Evidence

- [Plan 111 — skill invocation observability](../../plans/111-skill-invocation-observability.md),
  whose "Measured current state" section records the per-harness sampling
- [`CONTEXT.md`](../../CONTEXT.md) — skill observation, observation tier, skill
  resolution, observability
- [`packages/report-core/src/skill-observation.ts`](../../packages/report-core/src/skill-observation.ts) —
  the shared fact and its permissive parser
- [`packages/usage-store/src/skill-observation-store.ts`](../../packages/usage-store/src/skill-observation-store.ts)
- [`packages/local-machine/src/codex-skill-observation.ts`](../../packages/local-machine/src/codex-skill-observation.ts) —
  the two Codex extractors that must never be merged
