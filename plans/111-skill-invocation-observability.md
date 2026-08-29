# Plan 111: Skill Invocation Observability — Declared, Inferred, and Exposed Signals Across Claude Code, OpenCode, and Codex

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat dc9717a5..HEAD -- packages/local-machine/src/opencode-schema.ts packages/local-machine/src/claude-session-facts.ts packages/local-machine/src/codex-session-analysis.ts packages/local-collectors/src/collectors/claude.ts packages/local-collectors/src/collectors/opencode.ts packages/local-collectors/src/collectors/codex.ts packages/local-collectors/src/codex-quota-history.ts packages/usage-store/src/provider-quota-store.ts packages/usage-store/src/quota-reader.ts packages/usage-store/src/writer.ts packages/usage-store/src/reader.ts apps/web/src/server/usage-read-model.server.ts apps/web/src/server/skills.server.ts packages/web-contract/src/skills.ts packages/skills/src/projections.ts`
> If any in-scope file changed since this plan was written, compare the
> "Measured current state" excerpts against the live code before proceeding.
> A changed *transcript shape* (see STOP conditions) is a hard stop; a changed
> *neighbouring module* is not, as long as the named seams still exist.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (new durable fact family and a new collector pass over full local history; no change to existing report numbers)
- **Depends on**: none. Touches the skills surface delivered by plans 001/083/096 and the auxiliary-fact machinery delivered by the provider-quota work.
- **Category**: feature (new observation family + presentation)
- **Planned at**: commit `dc9717a5`, 2026-08-27
- **Origin**: operator question — "would it be possible to see which skills were read/invoked, and show that in the skills surface?" Feasibility was measured against real local history before this plan was written; the numbers below are observations, not estimates.

## Why this matters

`/skills` is the maintainer's inventory of every Agent Skill on the machine:
scope, invocation, origin, state, exposure. It answers *what exists*. It cannot
answer the only question that turns the inventory into a decision:
**which of these skills actually does anything?**

Two verdicts are currently impossible to produce:

- a skill that is managed, projected to every target, and **never invoked** is a
  deletion candidate;
- a skill that is **invoked but unmanaged** — the harness-bundled ones, and
  plugin-provided ones — is an adoption candidate, i.e. a gap in the managed
  source repo.

Both are the consolidation backlog the surface already claims to serve. Usage is
the missing axis.

The catch, and the reason this plan is mostly about honesty rather than
plumbing: **the four harnesses do not observe skills equally.** Two declare
invocations as first-class tool calls, one leaves only a shell-command trace, and
one records nothing. A single "invocations" counter aggregated across harnesses
would be actively false. This plan therefore introduces provenance *tiers* as a
domain concept, not a footnote.

## Measured current state (evidence, 2026-08-27)

All figures below were measured against the operator's real local history on the
planning date. Re-measure before trusting them; the point is the *shape*, not
the counts.

### A. Claude Code — declared, with resolved scope

`~/.claude/projects/**/*.jsonl`. An invocation is a `tool_use` block named
`Skill`, immediately followed by a `tool_result` and then an injected text block
carrying the resolved directory:

```jsonc
// assistant message
{"type":"tool_use","id":"toolu_…","name":"Skill",
 "input":{"skill":"improve","args":"Pre-release audit: …"}}
// next line, user message
{"type":"tool_result","tool_use_id":"toolu_…","content":"Launching skill: improve"}
// same message envelope
"toolUseResult":{"success":true,"commandName":"improve"}
// following line, injected text block
"Base directory for this skill: /home/…/.claude/skills/improve"
```

Available per invocation: skill name, arguments, `timestamp`, `cwd`,
`sessionId`, success flag, and — when present — the **resolved base directory**,
which yields the scope with no guessing.

Measured: **40 invocations, 28 with a resolved base directory** (16 user-global,
12 project-local). The 12 without a base directory are harness-bundled skills
(`artifact-design` ×8, `claude-in-chrome` ×2, `update-config`, `review`). That
absence is a **signal, not a gap**: those skills are real, invoked, and correctly
outside the managed inventory.

### B. OpenCode — declared, with a resolved directory when disclosed

`~/.local/share/opencode/opencode.db`, table `part`:

```jsonc
{"type":"tool","tool":"skill","callID":"call_…",
 "state":{"status":"completed","input":{"name":"write-a-skill"},
          "output":"<skill_content name=\"write-a-skill\">…"}}
```

Available: skill name, status, `session_id`, `time_created`, and the resolved
skill directory in `state.metadata.dir` when present. The metadata is optional,
so an observation may still legitimately remain unresolved.

Measured: **140 skill-tool parts.**

Existing machinery to reuse: `OPENCODE_TOOL_PART_PREDICATE` in
`packages/local-machine/src/opencode-schema.ts` already selects
`json_extract(data,'$.type') = 'tool'`. This is a narrowing of an existing read,
not a new one.

### C. Codex — exposed is declared; invoked is only inferred

Codex has **no skill tool**. Its function calls are `exec`, `wait`,
`spawn_agent`, `wait_agent`, `list_agents`, `send_message`. Two different
signals exist and must not be conflated:

1. **Exposure (high confidence).** The full skill catalogue — name, description,
   and absolute path, including `~/.codex/skills/.system/*` and
   `~/.codex/plugins/cache/**` — is injected into the system prompt of *every*
   session. This is an excellent record of *what was offered to the model*.
2. **Invocation (low confidence).** Only inferable from an `exec` call whose
   command reads a SKILL.md, e.g. `cat /home/…/skills/code-review/SKILL.md`.

Measured for August 2026: **31 inferred reads** (`code-review` ×12, `improve`
×9, `yeet` ×4, `design-taste-frontend` ×3, plus singletons). This is a heuristic
over a shell string. It is worth collecting — it is the operator's second-most
used harness — but it must never be presented as equivalent to a declared call.

### D. Cursor — out of scope, and that is a finding

`~/.config/Cursor/User/globalStorage/state.vscdb` contains 65 incidental
`SKILL.md` mentions in `cursorDiskKV` and **zero** `"skill"` tool keys.
`~/.cursor/ai-tracking/ai-code-tracking.db` has no relevant table. Skills are
*projected* to `~/.cursor/skills` by this product, but Cursor records no usage.

Cursor must therefore render as **not observable**, never as zero. A zero would
assert that projected skills go unused, which the data does not support.

### E. The seam already exists

`apps/web/src/server/skills.server.ts` already imports `usageStorePath` and
`createSqliteUsageReadModel`, and builds `knownProjectPaths` carrying a
`sessions` count sourced from the usage store. The skills surface already reads
usage data, read-only, in the correct direction. This plan reuses that seam and
must not open a second one.

## Design decisions (binding on the executor)

1. **A skill observation is an auxiliary fact family, not a usage-row column.**
   Observations are n-per-session. Model them on `provider_quota_*`
   (`packages/usage-store/src/provider-quota-store.ts`,
   `packages/usage-store/src/quota-reader.ts`,
   `packages/local-collectors/src/codex-quota-history.ts`), which is the
   established pattern for a fact family with its own collector, its own tables,
   and a read path that bypasses the report bootstrap. Do **not** widen
   `usage_rows`.

2. **Three tiers, stored explicitly, never silently merged.**
   - `declared` — the harness recorded a skill invocation as such (Claude Code,
     OpenCode).
   - `inferred` — reconstructed from a weaker trace (Codex `exec` reading a
     SKILL.md).
   - `exposed` — the skill was offered to the model in that session, with no
     evidence it was used (Codex catalogue; Claude Code's injected skill list if
     cheaply available).

   The tier is part of the fact. Any presented count carries its tier. A total
   that sums `declared` and `inferred` without saying so is a defect.

3. **`@ai-usage/skills` must not gain a usage-store dependency.** It is a
   filesystem-projection domain. The inventory↔usage join happens in the web
   server layer at the existing `skills.server.ts` ↔ `UsageReadModel` seam.

4. **Unresolvable is a state, not a drop.** An observation whose name does not
   resolve to any inventory entry (bundled skills, plugin skills, deleted
   skills) is retained and labelled. Dropping it would erase exactly the
   "invoked but unmanaged" verdict this feature exists to produce.

5. **Absence of observation ≠ zero usage.** Per-harness observability is part of
   the presented model. Cursor, and any harness with no collector, render as
   *not observable*. This follows the standing rule that a filter default must
   never exclude the unknown.

6. **Provenance is per metric, not global.** No page-level "data quality"
   banner. Each rendered number carries its own tier and harness coverage, as
   the rest of the product already does.

7. **Read honestly at every scale.** Invocation observations are relatively
   scarce, but catalogue exposure is not: the execution corpus reached 78,442
   exposed rows against 1,481 invocations. Use separate bounded tier-group reads
   and design the surface to remain legible at n=1. No dense histograms.

## Steps

### Step 1 — Name the concepts, then record the decision

Add to `CONTEXT.md`: **skill observation**, **observation tier**
(`declared` / `inferred` / `exposed`), **skill resolution** (observation name →
inventory entry, possibly unresolved), **observability** (whether a harness can
report at all). Add to the Avoid list: "skill usage" unqualified, and any
phrasing that treats an unobserved harness as a zero.

Write an ADR under `docs/adr/` recording decisions 2, 4, 5, and 6 above — the
tiering and the not-observable-vs-zero rule are durable product invariants, not
implementation detail. Cross-reference ADR 0009 (two planes) for decision 3.

**Done when**: `CONTEXT.md` defines the four terms; a new ADR is indexed in
`docs/adr/README.md`.

### Step 2 — Extraction primitives, per harness, in `packages/local-machine`

One pure, unit-tested extractor per harness. Each takes raw history and returns
observations; none touches the store.

- **Claude Code** — extend `claude-session-facts.ts`. Scan for `tool_use` named
  `Skill`; look ahead a bounded number of envelopes (**3 is sufficient in
  measured data; treat >3 as a miss, not an error**) for
  `Base directory for this skill: <path>`. Emit name, args presence (not the args
  text — see STOP conditions), timestamp, `cwd`, `sessionId`, success from
  `toolUseResult.success`, and the optional resolved path.
- **OpenCode** — extend `opencode-session-facts.ts`. Narrow the existing tool
  part predicate to `json_extract(data,'$.tool') = 'skill'`; decode
  `state.input.name` and `state.status`.
- **Codex** — extend `codex-session-analysis.ts`. Two separate extractors:
  the catalogue parser (`exposed` tier, from the system prompt block) and the
  `exec`-command matcher (`inferred` tier). They must return distinct tiers and
  must not be merged into one function.

Each extractor gets fixture-based tests using redacted transcript samples in the
existing `test-fixtures` directories. Follow the PII convention: scrub the real
name, real paths, and hostname; keep generic labels.

**Done when**: `bun test packages/local-machine` passes with at least one
positive and one negative fixture per extractor, including the Claude Code
no-base-directory case (bundled skill) and the OpenCode unresolvable-name case.

### Step 3 — Collect

Wire the extractors into `packages/local-collectors/src/collectors/{claude,opencode,codex}.ts`,
producing a new observation stream alongside the existing session rows. Reuse
`collector-cache.ts` so an unchanged corpus is a cache hit. The existing Claude
cache is corpus-fingerprinted rather than per-file: changing one transcript
still re-parses the corpus. Per-file incremental invalidation is a separate
performance improvement, not a correctness claim of this plan. This is a **new
fact from existing collection sources**, not a new collection source; the
source vocabulary does not change.

**Done when**: an isolated synthetic-home collector integration produces
observations for the three harnesses, and a second run produces no additional
work (cache hit). The demo runtime intentionally runs web alone and forbids
local-history and engine capabilities, so it is not a collection fixture.

### Step 4 — Persist

New tables in `packages/usage-store`, mirroring the provider-quota module's
shape and retention discipline. At minimum: harness key, skill name, tier,
timestamp, session id, project path, resolved target path (nullable), success
(nullable). Persist producer completeness per machine and harness in the same
transaction, including for an empty batch, with invocation and exposure kept
separate. Include the migration and its test alongside the existing ones in
`migration.test.ts`.

**Beware the read re-validation trap**: this store re-validates persisted rows on
read, so a later schema tightening retroactively breaks stored data. Choose the
permissive shape now — nullable resolved path, open-vocabulary skill name — and
validate at the presentation edge instead.

**Done when**: `bun test packages/usage-store` passes, including a migration test
that opens a pre-migration database and a round-trip test for an observation
with a null resolved path.

### Step 5 — Read

Extend `UsageReadModel` in `apps/web/src/server/usage-read-model.server.ts` with
a bounded skill-observation read. Follow the `readLatestProviderQuota` precedent
and its documented rationale: do not force this through the report bootstrap.
The read is keyed by skill name and returns per-tier, per-harness counts plus a
last-seen timestamp.

**Done when**: both the live and SQLite read-model implementations are covered by
tests, and the read is demonstrably independent of the report revision.

### Step 6 — Contract and query policy

Extend `packages/web-contract/src/skills.ts` with the observation shape, and add
**one named query policy per data identity** in `apps/web/src/lib/query/options/skills.ts`.
Observations change on collection, not on navigation — give them their own
policy rather than reusing the snapshot's.

**Done when**: `bun run typecheck` passes and the contract test covers the new
schema, including the unresolved-observation case.

### Step 7 — Surface it

On the skill detail and matrix surfaces, render for each skill:

- per-harness observation counts **with their tier**, and *not observable* for
  harnesses with no collector (Cursor today);
- last-seen timestamp;
- the two verdicts this feature exists for: **projected everywhere but never
  invoked** (deletion candidate) and **invoked but unmanaged** (adoption
  candidate). An incomplete invocation read makes the absence verdict
  provisional; exposure-only truncation does not.

The second verdict needs a home for observations that resolve to no inventory
entry — the bundled and plugin skills. Surfacing them as a distinct group is
in scope; wiring an "adopt into the source repo" action is **not** (that remains
plan 083's).

Accessibility is a hard gate: tier and observability must be conveyed
textually, never by colour alone. Add the e2e coverage to the existing
Playwright stack per ADR 0006.

**Done when**: `bun run check` passes, axe reports no new violations, and the
surface renders correctly with n=0, n=1, and a mixed-tier skill.

### Step 8 — Document

Update `docs/architecture.md` with the new fact family and its read path. Update
the skills spec with the observability model and the per-harness coverage table.
State plainly, in the docs, that Cursor is unobservable and why.

## STOP conditions

- **The Claude Code base-directory string is not a contract.**
  `Base directory for this skill:` is prompt text and can change without notice.
  If it is absent from a majority of sampled invocations at execution time, stop
  and report: the scope-resolution design needs revisiting, and everything
  downstream inherits the assumption.
- **Skill arguments are user prose and may contain anything.** Measured examples
  include client names and business context. Do **not** persist `input.args`.
  If a step's design appears to require the argument text, stop.
- **Codex heuristic yields near-zero at execution time.** If the `exec` matcher
  finds fewer than ~5 invocations across a comparable window, stop and report:
  ship the `exposed` tier alone for Codex rather than a misleading `inferred`
  count.
- **A step requires importing `@ai-usage/usage-store` into `@ai-usage/skills`.**
  That inverts the domain dependency. Stop and re-derive via the
  `skills.server.ts` seam.
- **A step requires the usage engine's read-write connection from web or CLI.**
  Violates ADR 0009. Stop.
- **Collection time regresses materially.** If a full sweep grows by more than
  ~15%, stop and report before optimizing; the disk-write amplification work has
  prior art on where the cost hides.

## Done criteria

- `bun run check` passes.
- The three in-scope harnesses produce observations; Cursor is explicitly
  modelled as not observable and is never rendered as `0`.
- Every rendered count carries its tier and harness provenance; no global
  data-quality flag was introduced.
- Observations that resolve to no inventory entry are retained and surfaced.
- `@ai-usage/skills` has no usage-store dependency.
- `CONTEXT.md`, the new ADR, `docs/architecture.md`, and the skills spec are
  updated; this plan's row in `plans/README.md` is updated.

## Verification

```
bun test packages/local-machine
bun test packages/local-collectors
bun test packages/usage-store
bun run test
bun run typecheck
bun run check
bun run build
bun run test:e2e    # includes the synthetic /skills surface and axe gate
```

Manual: run the supervised development stack, open `/skills`, pick a skill observed in more than one harness, and
confirm the tiers are distinguishable without colour. Then pick a skill with no
observations and confirm it does not read as "unused" in harnesses that cannot
report.
