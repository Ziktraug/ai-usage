# Plan 110: Spike Native Session Portability Across Claude, Codex, OpenCode, and Cursor

> **Executor instructions**: This is a bounded research spike, not permission to
> mutate real/private harness stores. Use disposable profiles, synthetic repos,
> copied fixtures, and official commands/APIs only. A negative finding is a
> successful result. Production implementation requires separate maintainer
> approval after this spike; do not create another numbered plan while running
> the spike.
>
> **Drift check (run first)**: record exact installed harness versions and
> current official documentation/API surfaces. Re-read plan 108's
> `WorkHandoff` contract and plan 109's archive authority. Pin version-specific
> findings and never generalize silently.

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P2
- **Effort**: L spike
- **Risk**: HIGH if scope escapes the sandbox — private formats may corrupt
  history, fabricate provenance, or upload unintended context
- **Depends on**: 108, 109
- **Category**: research; native session interoperability
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

Plans 105–109 provide DB-native Memory, accepted Work handoffs, and an optional
normalized archive. A stronger possibility is official native session import or
same-harness resume across machines. Private stores may also contain hidden
instructions, tool state, provider IDs, cached context, authentication bindings,
attachments, and version migrations; writing plausible JSONL/SQLite is neither
safe nor truthful.

This spike determines the strongest proven interoperability level per harness
and compares it with the accepted Work handoff baseline. It does not assume
native conversion is better.

## Existing research anchors

- ADR 0003 requires isolation at construction time, not merely hidden UI.
- `packages/local-machine/src/testing/harness-home.ts` is the repository-owned
  synthetic harness-home fixture and already has test-only import fencing.
- `docs/session-analysis-sources.md` is the dated truthfulness inventory with
  Recorded/Derived/Partial/Estimated/Unavailable.
- Existing Claude/Codex/OpenCode/Cursor readers document current local formats;
  read them before designing the research-only canonical graph.
- Plan 108's local and connected scenarios prove the baseline through exactly
  `memory.latest_work_handoff`, `work_handoff.get`, and
  `work_thread.get_context`.

No experiment writes an undocumented harness store. A successful accidental
file copy is evidence of current implementation behavior, not a supported API.

## Research questions

For Claude Code, Codex, OpenCode, and Cursor, answer:

1. local artifacts and which parts are documented contracts;
2. official resume-by-ID and fork behavior;
3. official export/import/create-from-context APIs;
4. account/provider conversation binding;
5. system/developer instruction reconstruction;
6. tool call/result validation and possible replay;
7. cwd/repository/worktree/Skills/MCP/permission assumptions;
8. external attachments/references;
9. schema/version migration behavior;
10. supported cross-machine behavior and provider uploads;
11. whether imported history is visibly identified as imported/generated;
12. privacy, token, latency, cost, and cache implications.

## Interoperability levels

### Level 0: metadata only

Session fact visible; no transcript/context continuation.

### Level 1: Work handoff continuation

Target starts a normal new native session and retrieves an accepted
`WorkHandoff`; no native import. This is the supported plan-108 baseline.

### Level 2: normalized context

Target new session receives bounded archived/normalized context as data, not
fabricated prior native turns/tool state.

### Level 3: official native import/clone

Target exposes a documented supported API/command, identifies import truthfully,
and validates version/account/project rules without private-store mutation.

### Level 4: exact supported same-harness resume across machines

Officially supported identity/provider state survives with reproducible
project/config/version requirements.

### Level 5: official cross-harness native conversion

Both export and import contracts preserve roles/instructions/tools/attachments/
provenance without invention. Expect most pairs to remain level 1 or 2.

## Investigation matrices

Per harness:

| Harness | Local format | Documented | Official resume | Official import | Safe cross-machine | Strongest level | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | | | | | | | |
| Codex | | | | | | | |
| OpenCode | | | | | | | |
| Cursor | | | | | | | |

Source → target:

| Source → target | Claude | Codex | OpenCode | Cursor |
| --- | --- | --- | --- | --- |
| Claude | | | | |
| Codex | | | | |
| OpenCode | | | | |
| Cursor | | | | |

Every cell records level, official surface, lost fields, account/project
constraints, security/privacy risk, pinned versions, and pursue/defer/reject.

## Research-only canonical graph

```ts
interface CanonicalAgentSession {
  readonly identity: CanonicalSessionIdentity;
  readonly source: NativeSessionReference;
  readonly project: CanonicalProjectContext;
  readonly instructions: CanonicalInstructionSet;
  readonly events: readonly CanonicalSessionEvent[];
  readonly modelPhases: readonly CanonicalModelPhase[];
  readonly artifacts: readonly CanonicalArtifactReference[];
  readonly provenance: CanonicalProvenance;
  readonly completeness: CanonicalCompleteness;
}
```

Event kinds may include user/assistant messages, available reasoning summaries,
tool-call/result references, model changes, compaction, attachment references,
checkpoints, and interruptions. Every field records observed/inferred/generated,
locator, completeness, sensitivity, and whether official target emission is
permitted.

The graph measures loss. It does not replace UsageRow, archive contracts,
Memory, WorkThread, or WorkHandoff, and it is never production authority.

## Safe environment

- dedicated disposable home/user/sandbox created before harness construction;
- synthetic Git repo/prompts/tool outputs, no secrets;
- copied read-only fixture stores and version-pinned binaries;
- separate test accounts only where terms/cost permit;
- checksums before/after each experiment;
- coherent SQLite copy after shutdown or supported backup path;
- no real personal/organization session history;
- no captured provider credentials or request payload logs.

`tools/spike110-sandbox.ts` must refuse any target resolving to the real home or
live profile, create under a task-specific temp root, checksum/verify, and
destroy only validated sandbox paths.

## Per-harness investigation

### Claude Code

Study official resume/fork/export surfaces, local transcript retention,
provider/account binding, instructions/Skills/MCP/hooks/permissions, cwd/repo
requirements, version migration, pruning, and cross-machine support.

### Codex

Study official CLI/app-server session surfaces, rollout files, provider/account
binding, developer/system instructions, approvals/sandbox/tools/compaction,
Git/worktree assumptions, and any official create/import distinct from a new
thread with context.

### OpenCode

Study official SDK/HTTP/CLI session APIs, SQLite schema/migrations only as read
evidence, provider/model routing, parts/attachments/permissions/agents/project
binding, and supported imported-message provenance. Use official API if present;
never write its tables directly.

### Cursor

Study official composer/chat export/resume/import, local/cloud account sync,
workspace binding, model/tool/edit/accepted-change representation, and version
migration. If no stable contract exists, classify it rather than creating a
writer.

## Experiments

### A: official same-harness resume on original disposable home

Record required files/config/network/provider state.

### B: same-harness behavior on second disposable home

Use documented export/import/sync or an isolated coherent copy experiment.
Record success/failure, provider calls, ID collisions, missing repo/config, and
version/account constraints. Copy behavior alone does not advance beyond an
officially supported level.

### C: official new-session import/context API

Where official docs prove one exists, create a new session and measure roles,
events, instructions, tool state, attachments, and provenance retained.

### D: Work handoff baseline

Retrieve the same accepted `WorkHandoff` through the exact plan-108 MCP tools
into each target. Measure setup, context quality, missing information,
verification work, and native-store non-mutation.

### E: research-only official emitter

Run only for an official import contract identified before experiments. Emit
the canonical graph through that contract and validate through the harness API/
UI. No official import means `not attempted`, not private-file reverse
engineering.

### F: cost/cache/privacy

Measure re-tokenization/re-upload, provider cache loss, latency, and recurring
cost without secrets. A conversion that works but uploads all history has a
material consequence.

## Evaluation

Score each dimension separately as `faithful`, `degraded`, or `fabricated`:

- message role/order;
- system/developer instructions;
- tool calls/results;
- attachments/artifacts;
- model/effort;
- Project/Git/worktree;
- permission/sandbox;
- identity/provenance;
- version stability;
- cross-machine/account;
- privacy/provider upload;
- cost/token/cache.

Do not compute an aggregate percentage. `fabricated` in any safety-critical
dimension disqualifies that path.

## Steps

### Step 0: Build the refusing sandbox

Implement creation/checksum/verify/destroy with tests proving real-home refusal
before writes. Every experiment is bracketed by checksum/verify.

### Step 1: Complete official-documentation table first

For each harness, cite official docs/license for export, import/context API,
store-format documentation, backup, and allowed mutation. Missing docs is an
explicit finding and gates Experiment E off.

### Step 2: Run A–D read-only

A–D never write private stores. Compare every result to the Work handoff
baseline, not to an imagined perfect conversion.

### Step 3: Run E only through official import

No official contract means do not run it. Verify every other store remains
checksum-identical.

### Step 4: Measure F and score dimensions

State measurement methods, pinned versions, and evidence for every score. Do
not hide fabricated state in an average.

### Step 5: Write the dated research report

Add one dated research snapshot to `docs/README.md` with matrices, official
citations, dimension scores, cost/cache findings, hard STOPs, and per-harness
recommendation: `pursue with separate approval`, `Work handoff is sufficient`,
`defer pending official API`, or `unsafe—do not pursue`.

### Step 6: Close safely

Destroy sandboxes and prove no captured harness data reached Git. If any route
merits production work, return the evidence/recommendation to the maintainer;
do not implement it or create a new numbered plan in this spike.

## Verification

- sandbox refuses real home/live profiles and writes nothing on refusal;
- all fixtures are synthetic and secret-scanned;
- checksums prove no unauthorized store mutation;
- official vs accidental behavior is labeled;
- exact WorkHandoff/MCP vocabulary is used throughout;
- research-only graph/tools cannot enter production package closure;
- repo diff stays within approved research docs/tooling for the future spike;
- lint/typecheck/relevant tests pass.

## Done criteria

- [ ] Every harness and source→target pair has a pinned evidence-backed level.
- [ ] Work handoff is measured as the level-1 baseline.
- [ ] Canonical graph exposes loss and is not production authority.
- [ ] No real/live or undocumented private store is written.
- [ ] Official import is distinguished from file-copy behavior.
- [ ] Privacy/provider upload/cost/cache/version risks are explicit.
- [ ] Recommendations require separate approval for production work.

## Hard STOP conditions

Stop a route immediately when:

- production needs direct undocumented JSONL/SQLite/private-store writes;
- imported/generated history cannot be distinguished from genuine history;
- instructions/tool state must be guessed, silently omitted, fabricated, or
  replayed;
- session identity depends on unexportable provider state;
- credentials/cookies/OAuth/private keys would be copied;
- historical tool calls may execute on import/resume;
- terms prohibit the experiment;
- real personal/company data is required;
- version drift cannot be detected before mutation;
- live profile corruption is possible.

Record the STOP, strongest safe level, and Work handoff fallback.

## Out of scope

- production adapter implementation or a new numbered plan;
- two-way native-store synchronization;
- provider credential/worktree transfer;
- remote shell/tool replay;
- bypassing auth/subscription limits;
- changing WorkHandoff/archive contracts without separate review.
