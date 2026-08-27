# Plan 110: Spike Native Session Portability Across Claude, Codex, OpenCode, and Cursor

> **Executor instructions**: This is a bounded research spike, not permission to
> mutate real harness stores. Work only with disposable profiles, synthetic
> repositories, copied fixtures, and officially supported commands/APIs. A
> conclusion that native portability is unsafe or unsupported is a successful
> result. Production implementation requires a separate accepted plan.
>
> **Drift check (run first)**:
> Record exact installed harness versions and current official documentation/API
> surfaces. Re-read plan 108’s Handoff contract and plan 109’s archive authority.
> If any harness format/API changed during the spike, pin both versions and do
> not generalize across them silently.

## Status

- **Priority**: P2
- **Effort**: L spike
- **Risk**: HIGH if scope escapes the sandbox — private formats may corrupt
  histories, fabricate provenance, or upload unintended context
- **Depends on**: 108, 109
- **Category**: research/spike; native session interoperability
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

ai-usage can normalize usage facts, archive bounded detail, and create a
harness-neutral Handoff. A stronger possibility is to recreate or continue a
native session in another harness or on another machine.

The conceptual pipeline is attractive:

```text
Claude / Codex / OpenCode / Cursor native session
        ↓ parser
Canonical execution/session graph
        ↓ emitter/import adapter
Target native session
```

But private session stores may include hidden system instructions, tool protocol
state, provider conversation IDs, cached tokens, authentication bindings,
versioned migrations, attachment references, and invariants not visible in the
reporting model. Writing a plausible JSONL row or SQLite record is not proof of a
valid session. It may corrupt the harness, cause it to send fabricated history to
a provider, or create a misleading audit trail.

This spike determines the highest safe interoperability level per harness.

## Current state

### The isolation precedent already exists — ADR 0003

`docs/adr/0003-isolated-synthetic-runtime.md` is the repository's existing answer
to "run against harness-shaped data without touching the operator's real
history":

> `bun run demo` runs on `127.0.0.1` with a temporary isolated home and committed
> deterministic report data. Synthetic-runtime requests are rejected **before**
> live collectors or mutation runtimes are constructed.

The rejected alternative is the load-bearing part: *"Hiding navigation alone was
rejected because presentation is not a privacy boundary."* The same standard
applies here — a spike that "just won't open the real profile" is not isolated.
Isolation is a construction-time property.

### The fixture harness home already exists

`packages/local-machine/src/testing/harness-home.ts`, exported as
`./testing/harness-home` (`packages/local-machine/package.json:27`) and
restricted by `tools/check-package-boundaries.ts:149` to test-only importers
(`isTestOnlySource`, `:163-165`).

**Build every experiment on this, not on a hand-made temp directory.** It
already encodes what a harness home looks like, and it is already fenced off from
production code paths by the boundary checker.

### The existing record this spike extends

`docs/session-analysis-sources.md` records what each harness truthfully exposes,
with a quality vocabulary (`:15-23`) and a dated status header (`:3-5`,
"current as of 2026-07-20"). It is the closest thing to a format inventory the
repo has. This spike's deliverable is a sibling document, dated the same way —
not an edit that silently ages the existing one.

Per-harness readers to read first, because they encode what has already been
learned about each format:

- `packages/local-collectors/src/claude-history.ts`, `claude-agent-sdk.ts`
- `packages/local-collectors/src/codex-history.ts`, `codex-app-server.ts`
- `packages/local-collectors/src/collectors/` (OpenCode, Cursor)
- `packages/local-machine/src/opencode-schema.ts`

### The rule this spike must not break

`AGENTS.md` and the program's cross-cutting invariant: **no child may write
directly into undocumented Claude, Codex, OpenCode, or Cursor session stores.**
Plan 110 is the only place authorized to *investigate* native portability, and
the hard STOP conditions below are not advisory.

Read that as: the deliverable of this plan may legitimately be **"this is not
safely possible"**. Rejection with evidence is a valid outcome (plan 099's
executor instructions say so explicitly). Do not treat a negative result as a
failed spike.

### Prerequisites

Plans 108 and 109. Experiment D benchmarks against an accepted work handoff, so
handoffs must work first — the whole point is to measure whether native
conversion beats the handoff, and without the baseline there is nothing to beat.

## Research questions

For Claude Code, Codex, OpenCode, and Cursor, answer:

1. What local artifacts represent session history?
2. Which parts are documented public contracts versus implementation detail?
3. Is there an official command/API to resume by ID?
4. Is there an official import/create-session API?
5. Can a session be exported portably?
6. Is identity bound to provider-side conversation state or local account?
7. Are system/developer instructions persisted, reconstructed, or hidden?
8. How are tool calls/results represented and validated?
9. What project/cwd/repository/worktree assumptions exist?
10. Which attachments/files are referenced externally?
11. What format/schema/version migrations occur?
12. Can a copied session be opened on a second machine using the same account?
13. Can a synthetic session be created without editing private storage?
14. What data is sent back to the provider when resumed?
15. What privacy/cost implications result from rehydrating context without the
    original provider cache?

## Interoperability levels

Classify each source→target combination at the strongest proven level.

### Level 0 — Metadata only

- usage/session fact visible in ai-usage;
- no transcript or continuation.

### Level 1 — Handoff continuation

- target opens a normal new native session;
- accepted Handoff/context is supplied through MCP/prompt;
- no native history import.

This is the supported baseline from plan 108.

### Level 2 — Normalized transcript context

- target new session receives a bounded normalized archive or generated context;
- conversation is context, not represented as native prior turns;
- tool results/system state are not fabricated.

### Level 3 — Official native import/clone

- target harness exposes a documented supported API/command;
- imported session is clearly identified as imported;
- schema/version/account/project rules are validated;
- no private store mutation.

### Level 4 — Exact native resume across machines

- supported by the same harness/provider;
- identity and server-side state remain valid;
- project/worktree/config requirements are reproducible;
- documented integrity and version behavior.

### Level 5 — Cross-harness native conversion

- only acceptable if both source export and target import are documented enough
  to preserve role, instructions, tool state, attachments, and provenance
  without invention.

Expect most combinations to remain Level 1 or 2. Do not treat that as failure.

## Investigation matrix

Deliver a table like:

| Harness | Local format | Documented? | Official resume | Official import | Safe cross-machine | Strongest proven level | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | | | | | | | |
| Codex | | | | | | | |
| OpenCode | | | | | | | |
| Cursor | | | | | | | |

And a source→target matrix:

| Source → target | Claude | Codex | OpenCode | Cursor |
| --- | --- | --- | --- | --- |
| Claude | | | | |
| Codex | | | | |
| OpenCode | | | | |
| Cursor | | | | |

Every cell records:

- achieved level;
- official surface used;
- lost/unsupported fields;
- account/project constraints;
- security/privacy risk;
- version tested;
- whether a production adapter is recommended, rejected, or deferred.

## Canonical execution graph spike

Define a research-only canonical model rich enough to measure information loss.
Do not replace `UsageRow` or production Session detail during the spike.

```ts
interface CanonicalAgentSession {
  identity: CanonicalSessionIdentity;
  source: NativeSessionReference;
  project: CanonicalProjectContext;
  instructions: CanonicalInstructionSet;
  events: CanonicalSessionEvent[];
  modelPhases: CanonicalModelPhase[];
  artifacts: CanonicalArtifactReference[];
  provenance: CanonicalProvenance;
  completeness: CanonicalCompleteness;
}
```

Possible event kinds:

```text
user-message
assistant-message
reasoning-summary (only if actually available and legally/contractually usable)
tool-call
tool-result-reference
model-change
context-compaction
attachment-reference
checkpoint
error/interruption
```

Every field records:

- observed versus inferred/generated;
- source locator;
- availability/completeness;
- sensitivity;
- whether it can be emitted safely to a target.

The model is an evaluation instrument. Do not claim a lowest-common-denominator
graph is sufficient for native resume merely because all formats can be parsed
into it.

## Test environment

Use:

- dedicated disposable OS user/home or sandbox;
- separate provider test accounts where terms/cost permit;
- synthetic Git repository with no secrets;
- generated prompts and tool outputs;
- copied read-only fixture stores;
- version-pinned harness binaries;
- network observation only when permitted and without collecting credentials;
- backup/checksum before every mutation experiment;
- no real personal or organization session history.

For SQLite stores, copy main/WAL/SHM coherently after clean shutdown or through
the harness’s supported backup path. Never edit the live profile.

## Per-harness work

### Claude Code

Investigate:

- local project/session transcript structure and retention;
- resume/fork commands and ID rules;
- account/provider-side relationship;
- system instructions, Skills, MCP, hooks, and permission state on resume;
- whether moving files to another machine is supported or merely happens to
  parse;
- behavior when referenced cwd/repo/files do not exist;
- version migration and transcript pruning.

### Codex

Investigate:

- rollout/session files and any app-server/session API;
- resume/fork/export surfaces;
- account/profile binding and provider conversation state;
- developer/system instructions, approvals/sandbox, tools, and compaction;
- worktree/cwd/Git state assumptions;
- whether an official create/import path exists distinct from starting a new
  thread with context.

### OpenCode

Investigate:

- SQLite/session/message/part schema and migrations;
- official SDK/HTTP/CLI session create/fork/resume/export APIs;
- model/provider routing metadata;
- tool parts, attachments, permission state, agents, and project binding;
- whether a supported API can create imported messages with provenance;
- cross-machine DB or server synchronization behavior.

OpenCode may offer the strongest documented local API; that does not justify
writing its SQLite tables directly if an API exists.

### Cursor

Investigate:

- composer/chat/session storage and workspace binding;
- official export/resume/import surfaces;
- cloud/account synchronization versus local database;
- model/tool/edit/accepted-change representation;
- project/workspace IDs and extension-version migration;
- whether the current ai-usage Cursor input is too aggregated for any
  continuation claim.

If Cursor exposes no stable session-level contract, classify accordingly rather
than reverse-engineering a production writer.

## Experiments

### Experiment A — Same-harness resume on original machine

Baseline official resume behavior, required files, and network/provider state.

### Experiment B — Same-harness resume on second disposable machine

Use only documented export/import/sync or an explicitly isolated copy experiment.
Observe:

- session opens or fails;
- provider calls and context re-upload;
- missing repository/config behavior;
- ID collision/duplication;
- version/account constraints.

A successful accidental file copy is evidence of implementation behavior, not a
supported production API.

### Experiment C — Official new-session import/context API

Where available, create a new session from normalized context and measure which
roles/events/provenance survive.

### Experiment D — Cross-harness Handoff baseline

Use plan 108’s accepted Handoff through MCP into each target. Measure setup cost,
context quality, and missing information. This is the benchmark native conversion
must materially improve.

### Experiment E — Research-only format emitter

Only when a harness has an official import contract. Emit from the canonical
model into that contract and validate through the harness’s own API/UI. Do not
write private files.

### Experiment F — Cost/cache impact

Measure whether imported/resumed content is re-tokenized/re-uploaded and loses
provider cache benefits. Record cost/latency implications without provider
secrets.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite: handoffs work | `bun test apps/server/src/cross-harness-handoff.test.ts` | all pass |
| Create the sandbox home | `bun tools/spike110-sandbox.ts --create` | prints an isolated `HOME`, refuses if `$HOME` is the real one |
| Checksum before any mutation | `bun tools/spike110-sandbox.ts --checksum <dir>` | manifest written |
| Verify no live path was touched | `bun tools/spike110-sandbox.ts --verify <dir>` | manifest matches |
| Harness versions | `claude --version; codex --version; opencode --version` | recorded in the report |
| Destroy the sandbox | `bun tools/spike110-sandbox.ts --destroy <dir>` | directory gone |
| Existing fixture home | `bun test packages/local-machine/src/testing` | all pass |
| Full verification (repo unchanged) | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `spike/110-native-portability`, cut from plan 109's branch.
- **This spike produces documents and throwaway tooling, not product code.** If
  a diff appears under `packages/` or `apps/` beyond `tools/spike110-*.ts`, the
  spike has escaped its scope — stop.
- Stage by explicit path. Never `git add -A`.
- Two commits:
  1. `chore(tools): add the plan 110 sandbox harness`
  2. `docs(research): record the native session portability findings`
- Never commit anything captured from a real harness profile, even redacted.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 0: Build the sandbox, and make it refuse the real home

Before any harness is launched. `tools/spike110-sandbox.ts`:

- `--create` makes a disposable `HOME` under `$TMPDIR`, seeded from
  `packages/local-machine/src/testing/harness-home.ts` plus a synthetic Git
  repository with no secrets;
- it **refuses to run** if the resolved home is the real one, or if any path it
  would touch resolves inside `$HOME` — a hard guard, not a flag. ADR 0003's
  standard: reject before constructing, not after;
- `--checksum` writes a manifest (path, size, mtime, SHA-256) of every file in a
  target directory;
- `--verify` re-checksums and reports differences;
- `--destroy` removes the sandbox.

Add `spike110-sandbox.test.ts` proving the refusal: given `HOME` as the target,
it exits non-zero and writes nothing.

**Every mutation experiment is bracketed by `--checksum` before and `--verify`
after.** A silent mutation of a copied store invalidates every conclusion drawn
after it.

**Verify**: `bun test tools/spike110-sandbox.test.ts` → passes, including the
refusal case.

### Step 1: Document the interoperability level per harness before experimenting

For each of Claude, Codex, OpenCode, Cursor, record — from **published
documentation only**, before touching a file:

| Question | Source required |
|---|---|
| Is there a documented session export? | official docs URL |
| Is there a documented session import / "start from context" API? | official docs URL |
| Is the session store format documented? | official docs URL |
| Is there a supported backup path? | official docs URL |
| What does the licence/ToS say about reading or writing the store? | the licence text |

A harness with **no documented import contract** cannot reach Experiment E. Fix
that boundary now, in writing, rather than discovering it mid-experiment when a
file write looks tempting.

**Verify**: the table is complete with a citation per cell, or an explicit
"not documented".

### Step 2: Experiments A–D, read-only

Run in order. A–D never write to a harness store.

- **A** — baseline resume on the original machine. Record required files,
  network calls, and provider state.
- **B** — resume from an isolated *copy* on a second disposable home. Copy
  SQLite stores coherently: clean shutdown first, then main + WAL + SHM
  together, or the harness's supported backup path. Never read a live profile.
  Record: opens or fails, provider calls, ID collisions, version constraints.
- **C** — official new-session-from-context API, where Step 1 found one. Measure
  which roles, events, and provenance survive.
- **D** — the **baseline that matters**: plan 108's accepted handoff through MCP
  into each target. Measure setup cost, context quality, and what is missing.

Everything else is judged against D. If native conversion does not materially
beat an accepted handoff, the honest conclusion is that handoffs are sufficient
— and that is a valuable, cheap finding.

**Verify**: `--verify` after each experiment → manifest matches.

### Step 3: Experiment E, gated

**Only for a harness where Step 1 found an official import contract.** Emit from
the canonical model into that contract and validate through the harness's own
API or UI.

If Step 1 found no import contract for a harness, Experiment E does not run for
it. Record "no official import contract — not attempted" rather than leaving a
blank, so a later reader knows it was considered and excluded.

Do not write private files. Do not reverse-engineer a private format into a
writer. This is the plan's central prohibition.

**Verify**: `--verify` → manifest matches for every store not written through an
official API.

### Step 4: Experiment F — cost and cache

Measure whether imported or resumed content is re-tokenized and re-uploaded, and
whether provider cache benefits are lost. Record cost and latency implications
with no provider secrets in the output.

This often dominates the decision: a conversion that works but re-uploads the
entire context has a real recurring cost, and it belongs in the report next to
the fidelity scores rather than as a footnote.

**Verify**: figures recorded per harness, with the measurement method stated.

### Step 5: Score each dimension separately

Twelve dimensions, listed below in "Fidelity and safety evaluation". Report each
separately.

**Do not compute an aggregate score.** The plan says why, and it is worth
repeating in the report itself: a session with 95% text fidelity and fabricated
system or tool state is unsafe, and an average hides exactly that.

Use a three-value scale — `faithful` / `degraded` / `fabricated` — rather than
percentages. `fabricated` on any dimension is disqualifying regardless of the
others, and a percentage invites averaging it away.

**Verify**: every dimension has a value and a supporting observation per harness.

### Step 6: Write the report and the recommendation

`docs/native-session-portability-2026-XX-XX.md`, dated in the header the way
`docs/session-analysis-sources.md:3-5` is, and listed in `docs/README.md` as a
dated research snapshot rather than living reference.

It must contain:

1. the Step 1 documentation table with citations;
2. per-harness interoperability level;
3. the twelve-dimension scores;
4. cost and cache findings;
5. a recommendation per harness: **pursue**, **handoff is sufficient**, or
   **unsafe — do not pursue**;
6. any hard STOP condition encountered, and where.

"Handoff is sufficient" for every harness is a complete and successful outcome.
The program's ADR 0030 already chose handoff-first; this spike exists to test
whether that choice should change, and confirming it is a result.

**Verify**: `git diff --stat` shows changes only under `docs/`, `plans/`, and
`tools/spike110-*`.

### Step 7: Close the loop

- If any harness scores `pursue`, write a follow-up plan (111+). Do not
  implement it here.
- If none does, amend ADR 0030's consequences with the evidence and mark this
  spike `DONE (negative result)` in `plans/README.md:66`. A negative result with
  evidence is worth more than an unwritten one.
- Destroy every sandbox: `bun tools/spike110-sandbox.ts --destroy <dir>`.
- Confirm no captured harness data reached the repository:
  `git status --porcelain` → clean beyond the two intended commits.

## Fidelity and safety evaluation

Score/report dimensions separately:

- message role/order fidelity;
- system/developer instruction fidelity;
- tool call/result fidelity;
- attachment/artifact fidelity;
- model/effort fidelity;
- project/Git/worktree fidelity;
- permission/sandbox fidelity;
- identity/provenance honesty;
- cross-version stability;
- cross-machine/account behavior;
- privacy and provider-upload impact;
- cost/token/cache impact.

Do not combine them into one reassuring percentage. A session with 95% text
fidelity and fabricated system/tool state is unsafe.

## Hard STOP conditions

Stop a harness/adapter investigation immediately when:

- production would require direct writes to an undocumented JSONL/SQLite/private
  database;
- an official import cannot distinguish imported/generated history from genuine
  provider history;
- system/developer instructions would be guessed, omitted silently, or elevated
  incorrectly;
- tool calls/results must be fabricated or replayed to satisfy validation;
- session identity is bound to server-side state that cannot be exported safely;
- copying data would include provider credentials, cookies, OAuth state, or
  private keys;
- target may execute historical tool calls or commands during import/resume;
- account/provider terms prohibit the experiment;
- real personal/company sessions would be needed;
- schema/version drift cannot be detected before mutation;
- a failed experiment risks corrupting the user’s live harness profile.

Record the STOP, strongest safe level, and recommended Handoff fallback.

## Deliverables

1. dated research memo with pinned versions and official sources;
2. completed harness and source→target matrices;
3. canonical-model loss analysis;
4. experiment scripts/fixtures safe for disposable environments only;
5. Handoff baseline comparison;
6. security/privacy/cost findings;
7. per-harness decision:
   - recommend production adapter;
   - handoff-only;
   - defer pending official API;
   - reject;
8. follow-up production plans only for accepted official surfaces;
9. explicit list of research code that must not ship.

## Verification

- all fixtures are synthetic and secret-scanned;
- experiments cannot discover/use the real home/profile by default;
- sandbox path guards and refusal tests exist;
- checksums prove live stores are untouched;
- official API/CLI behavior is captured in tests where automatable;
- version mismatch is detected;
- no production package imports research-only private-format emitters;
- package-boundary scanner prevents accidental shipping if needed;
- results reproduce on a clean disposable environment.

## Done criteria

- [ ] Every harness has a pinned, evidence-backed interoperability classification.
- [ ] Every source→target pair has a strongest safe level and rationale.
- [ ] Handoff continuation is measured as the baseline.
- [ ] Canonical graph exposes information loss rather than hiding it.
- [ ] No experiment writes a real/live harness store.
- [ ] Official import/resume surfaces are distinguished from reverse-engineered
      implementation details.
- [ ] Privacy, provider upload, token/cache, and version risks are documented.
- [ ] Unsafe/private-store routes are rejected with STOP evidence.
- [ ] Any recommended production adapter has its own follow-up plan and uses a
      supported API.
- [ ] Native portability is not promised where only Handoff/context transfer is
      proven.

## Out of scope

- production implementation of any adapter;
- automatic two-way synchronization of native harness stores;
- raw provider credential transfer;
- uncommitted worktree migration;
- remote shell/tool replay;
- bypassing harness authentication or subscription limits;
- declaring the canonical research graph a new source of truth;
- changing plans 108–109 contracts unless the spike produces a reviewed
  follow-up decision.
