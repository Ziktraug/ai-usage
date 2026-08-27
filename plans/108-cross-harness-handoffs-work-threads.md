# Plan 108: Add Cross-Harness Handoffs and Work Threads

> **Executor instructions**: Build continuity above harnesses, not by forging
> their private stores. A Handoff combines deterministic evidence with explicitly
> reviewed narrative. A Work Thread groups logical work across native sessions.
> Do not call activity metrics “outcomes” or infer success from tokens, duration,
> commits, or lines changed.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages/report-core packages/report-data packages/usage-store packages/local-machine packages/memory packages/memory-search packages/mcp-adapter packages/project-registry packages/replication apps/usage-engine apps/server apps/web apps/cli docs/architecture.md docs/adr`
> Re-read plans 105–107 and reconcile Memory, Project, Session, and replication
> contracts before adding a second identity layer.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM–HIGH — generated summaries can be mistaken for observed facts,
  and incorrect Git state can make a continuation destructive
- **Depends on**: 102, 105, 106, 107
- **Category**: cross-harness continuity and work identity
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

A developer may use Claude for architecture, Codex for implementation, OpenCode
for review, and a different machine the next day. Native session history is
fragmented by harness and machine. Reconstructing one provider’s private format
inside another is brittle and unnecessary for the first valuable product.

The useful abstraction is the logical work:

```text
Work Thread: Implement shared memory sync
  Claude session — architecture
  Handoff — accepted state at checkpoint
  Codex session — implementation
  OpenCode session — review
  Handoff — next machine/context
```

The target harness starts a normal native session, retrieves the accepted
Handoff through MCP, verifies current source state, and continues without the
user manually retelling the entire history.

## Current state

### `handoff` already means something else here — twice

This is the plan's first correctness hazard, before any code:

| Existing meaning | Where |
|---|---|
| A staged file passed CLI → engine via an inbox directory | `packages/usage-engine-control/src/handoff.ts`, `contracts.ts` (`UsageEngineHandoffId`), `packages/usage-engine-runtime/src/input-file.ts` + 7 more files |
| A durable **memory entry type**, "current state and next actions" | the NixOS agent-memory contract (`references/memory-contract.md:18`), imported by plan 105 |
| **This plan** — cross-harness work continuity | new |

Naming decision, to be applied consistently:

- this plan's concept is **Work handoff** in `CONTEXT.md`, and `WorkHandoff` in
  code;
- the file-transport meaning keeps `UsageEngineHandoff*` unchanged — it is
  correct and in use;
- the memory entry type keeps `handoff` **in stored imported data** for fidelity
  (plan 105 Step 1's `CHECK` constraint).

Verify plan 100 recorded the disambiguation in `CONTEXT.md` and plan 105 honored
it. If not, fix it before writing a schema — renaming after data exists means
rewriting rows across two tables.

### Dated executable-contract normalization (2026-08-26)

The original domain sketch below is retained verbatim as plan history. For
implementation, normalize it as follows before creating migrations or exports:

- `Handoff`, `HandoffId`, and `HandoffStatement` become `WorkHandoff`,
  `WorkHandoffId`, and `WorkHandoffStatement`;
- `WorkThread.projectId` is nullable;
- `WorkThread.status` is `active | paused | completed | abandoned | archived`;
- `WorkHandoff.status` is
  `draft | accepted | superseded | rejected | expired`;
- `currentHandoffId` becomes `currentWorkHandoffId`.
- `memory.latest_handoff`, `handoff.get`, and the original `*_handoff`
  permissions become `memory.latest_work_handoff`, `work_handoff.get`, and
  `*_work_handoff` respectively.

The Step 2 schema and every public tool/permission below use only this normalized
contract. A contract/schema test enumerates both status sets from one shared
constant so they cannot drift again.

### Session facts already exist per harness

`packages/local-machine/src/` holds `claude-session-facts.ts`,
`opencode-session-facts.ts`, `claude-session-analysis.ts`,
`codex-session-analysis.ts`, `opencode-session-analysis.ts`, and
`session-detail.ts` (exported at `packages/local-machine/package.json:24` as
`./session-detail`).

`docs/session-analysis-sources.md` is the authoritative record of what each
harness can truthfully provide, with a quality vocabulary (`:15-23`) this plan
must reuse rather than restate: **Recorded**, **Derived**, **Partial**,
**Estimated**, **Unavailable**.

The line at `:24-25` is binding: *"An unavailable or estimated metric must not
be presented as an exact zero or as a default setting."* A handoff that presents
an inferred branch as a recorded one violates it.

### The existing detail boundary this plan pushes against

`docs/session-analysis-sources.md:9-14` draws the current line:

> **report metrics** are normalized rows that may be persisted […];
> **local detail** is read from the source machine only after the user opens a
> supported session analysis. It is not part of the report revision.

A handoff needs *some* local detail to be useful. This plan takes only bounded,
explicitly-stated evidence — the full archive is plan 109, opt-in. Do not widen
the boundary here.

### Prerequisites

Plans 102 (projects), 105 (memory), 106 (search), 107 (replication). A handoff
that cannot be searched or replicated is a local note, which the file-based
system already provides.

## Domain definitions

### Session reference

A portable reference to an observed native session:

```ts
interface SessionReference {
  deviceId: DeviceId;
  harnessKey: string;
  sourceSessionId: string | null;
  sessionFactId: SessionFactId;
  observedAt: Instant;
}
```

A reference does not claim the server can open or mutate the native session.

### Work Thread

```ts
interface WorkThread {
  id: WorkThreadId;
  owningSpaceId: SpaceId;
  projectId: ProjectId;
  title: string;
  status: "active" | "completed" | "abandoned" | "archived";
  currentHandoffId: HandoffId | null;
  createdByPersonId: PersonId;
  createdAt: Instant;
  updatedAt: Instant;
}
```

Related tables/relations:

```text
work_thread_sessions
  work_thread_id
  session reference
  role: planning | implementation | review | investigation | documentation | other
  linked_by / linked_at
  confidence/source

work_thread_events
  started, session-linked, handoff-created, status-changed, etc.
```

Rules:

- sessions are linked explicitly or through a reviewed high-confidence
  suggestion;
- one session may contribute to more than one Work Thread only through an
  explicit supported case;
- changing a title/status never rewrites session facts;
- a Work Thread is not a project, branch, issue, or PR, though it may reference
  all of them.

### Handoff

```ts
interface Handoff {
  id: HandoffId;
  owningSpaceId: SpaceId;
  projectId: ProjectId;
  workThreadId: WorkThreadId;
  revisionNumber: number;
  status: "draft" | "active" | "superseded" | "rejected";

  sourceSessions: SessionReference[];
  sourceDeviceId: DeviceId | null;
  sourceHarnessKeys: string[];

  repositoryId: RepositoryId | null;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  pullRequests: string[];

  changedAreas: string[];
  relevantFiles: string[];
  decisions: HandoffStatement[];
  completed: HandoffStatement[];
  openQuestions: HandoffStatement[];
  nextActions: HandoffStatement[];

  completeness: "complete" | "partial";
  createdByPrincipal: PrincipalRef;
  acceptedByPersonId: PersonId | null;
  acceptedAt: Instant | null;
  createdAt: Instant;
}
```

A Handoff revision is immutable. Accepting a new one supersedes the previous
active Handoff for the Work Thread atomically.

### Handoff statement

Every statement identifies its epistemic source:

```ts
type HandoffStatementSource =
  | "observed-git"
  | "observed-session"
  | "explicit-user"
  | "explicit-agent"
  | "generated-summary";

interface HandoffStatement {
  text: string;
  source: HandoffStatementSource;
  provenance: ResourceReference[];
  confidence: "observed" | "declared" | "generated";
}
```

Generated summary text must never be serialized as if Git or session facts
proved it.

## Work intent

Introduce an optional explicit work category when a Thread/Handoff is created:

```text
planning
implementation
bugfix
refactor
review
investigation
documentation
operations
```

This is user/agent-declared intent, not prompt clustering. The repository’s prior
intent spike found insufficient reliable signal in first prompts; do not reopen
that rejected inference under a new name.

## Evidence inputs

### Deterministic ai-usage evidence

Use existing/new normalized facts for:

- Device, harness, source session identity;
- Project/Repository mapping;
- session start/end/title/models/tools/partial state;
- branch/commit/PR references when provenance is reliable;
- source freshness and parser limitations.

### Git evidence

The source Device may collect a bounded snapshot at Handoff creation:

- repository identity;
- current branch;
- HEAD/base commit;
- clean/dirty summary (never full secret-bearing diff by default);
- relevant changed file names if explicitly included;
- upstream/PR references when already known.

The target Device must re-check current checkout state before presenting “ready
to continue”. A stored Handoff is not authority that the worktree still matches.

### Explicit statements

Agent/user supplies:

- decisions and rationale;
- what is truly complete;
- open questions;
- intended next actions;
- relevant areas/files not deterministically inferable.

### Generated proposal

An agent may propose a Handoff from evidence, but it remains `draft` with every
statement source labelled. A Person or explicitly trusted workflow accepts it.
No background job silently activates generated Handoffs.

## Handoff creation workflow

```text
Select/create Work Thread
  ↓
Select source sessions and current Project checkout
  ↓
Capture deterministic session + Git evidence
  ↓
Agent/user writes or generates bounded statements
  ↓
Preview: evidence, uncertainty, sensitive fields, target Space
  ↓
Accept
  ↓
New active immutable Handoff; prior one superseded
```

Preview/accept must use a state-bound proof so source evidence changing between
preview and acceptance yields `preview-stale` or a refreshed diff.

## Continuation workflow

### Target selection

User chooses:

- target Device/checkout;
- target harness;
- optional profile/Skills set;
- active Handoff.

The system verifies:

- permission to view Handoff and Project;
- target Device ownership/availability when local;
- checkout resolves to the same Project/Repository;
- target branch/commit compatibility;
- dirty worktree risk;
- required Handoff content is available and not deleted;
- target MCP capability is configured.

### MCP retrieval

Enable `memory.latest_handoff` and optionally:

```text
handoff.get
work_thread.get_context
```

Response is bounded and contains:

- Work Thread and Project IDs/title;
- source sessions/harnesses/devices as metadata;
- Git state with observed-at time;
- accepted decisions/completed/open/next statements with source labels;
- relevant files/areas;
- completeness and limitations;
- instruction to verify source/tests/current user request.

### Launch

The first release may:

- generate/copy a harness-neutral continuation prompt;
- open a local harness CLI through a narrow allowlisted launcher after explicit
  confirmation;
- or leave launch manual while proving MCP retrieval.

It must not write a fabricated native session record or pass arbitrary shell
strings from the browser. Any launcher follows structured adapter/allowlist
rules and remains local.

## Handoff as Memory

Handoffs are related to Agent Memory but have their own lifecycle:

- Handoff = current operational continuation state for one Work Thread;
- Memory Item = durable guidance intended to affect future work beyond the
  checkpoint.

A Handoff may reference active Memory Items. Completing a Thread may produce
Memory Proposals (decision/pitfall/pattern), but does not auto-promote all
Handoff text into durable Memory.

Avoid duplicating Handoff content permanently in a `memory_items` row. Search may
index accepted Handoffs as a separate authorized resource type.

## Server/local ownership

### Connected mode

PostgreSQL owns shared Work Threads/Handoffs and revisions. Device replication
publishes session facts/evidence; Handoff commands use server application
services and Authorizer.

### Local-only mode

Support a local Handoff capability using local SQLite or a bounded local store if
plan 100 accepted it. The domain contracts stay identical enough for later
publication, but local-only operation must not require a Person login/server.

Do not force the existing usage SQLite schema to own all Memory/Handoff tables if
a separate local domain store is safer; plan 100’s data matrix decides the local
composition.

## Authorization

Permissions:

```text
view_work_thread
manage_work_thread
view_handoff
create_handoff
accept_handoff
continue_from_handoff
link_session_to_work_thread
```

Rules:

- viewing aggregate usage does not grant Handoff content;
- source session content permission is not automatically required to view an
  accepted Handoff, because the Handoff is a separately reviewed artifact;
- provenance links reveal only metadata permitted to the caller;
- creating/accepting in an organization requires Project/Space permission;
- target Device selection cannot expose another person’s checkout paths;
- sensitive Handoff statements may require stronger permission/policy.

## Conflict and staleness behavior

Handle:

- two concurrent draft Handoffs;
- accepting against a newer active revision;
- branch or HEAD changed after capture;
- source session facts updated/partial;
- target checkout missing or at divergent commit;
- Work Thread completed while another client continues;
- memory decision superseded after Handoff acceptance.

Never rewrite accepted Handoff history. Show stale/changed evidence and require a
new revision or explicit continuation override.

## Product surfaces

### Work

A future top-level `Work` destination may show:

- active Threads;
- latest Handoff and age;
- source/target harness and Device metadata;
- current branch/commit readiness;
- next actions;
- continue/copy-context action.

Do not reorganize the full navigation until this vertical slice exists. The
initial surface may live within Sessions/Project detail.

### Session detail

Show:

- linked Work Thread;
- create/update Handoff;
- source/target relationship;
- whether detailed content is local, archived, or opaque.

### CLI

Conceptual commands:

```text
ai-usage work list
ai-usage handoff create --session ...
ai-usage handoff show <id>
ai-usage handoff continue <id> --harness codex
```

Final names follow the CLI grammar. Commands use application services rather
than duplicating state logic.

## Validation scenario

The first product gate should use synthetic sessions but mirror real work:

1. Claude session is linked to a new Work Thread for `ai-usage`;
2. deterministic evidence identifies Project, branch, commit, source Device, and
   partial/complete state;
3. draft Handoff records one observed fact, one explicit decision, and one
   generated next-action proposal;
4. Person reviews and accepts it;
5. Codex on another Device/checkout retrieves it through MCP;
6. target verifies repository/branch/commit and reports one mismatch if fixture
   is deliberately stale;
7. Codex starts a new native session/context and links its resulting session to
   the same Work Thread;
8. no Claude private session file is written or copied;
9. unauthorized user/auditor cannot retrieve the Handoff.

Success is continuity without manual retelling, not proof that the target model
makes the correct code change.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite: naming resolved | `grep -c "Handoff" CONTEXT.md` | ≥ 1 |
| Prerequisite: memory exists | `test -f packages/memory/src/services.ts` | exit 0 |
| Work-thread tests | `bun test packages/work-threads` | all pass |
| Evidence provenance tests | `bun test packages/work-threads/src/evidence.test.ts` | all pass |
| Staleness tests | `bun test packages/work-threads/src/staleness.test.ts` | all pass |
| Cross-harness scenario | `bun test apps/server/src/cross-harness-handoff.test.ts` | all pass |
| MCP tools | `bun test packages/mcp-adapter` | all pass |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/108-work-handoffs`, cut from plan 107's branch.
- Migration `0007_work_threads` — check `packages/postgres-store/src/migrations.ts`
  for the current highest number first; 105 and 107 may both have landed.
- Stage by explicit path. Never `git add -A`.
- Four commits:
  1. `feat(work-threads): add work threads and handoffs with source-labelled evidence`
  2. `feat(work-threads): add creation and continuation workflows`
  3. `feat(mcp-adapter): expose handoff creation and retrieval tools`
  4. `feat(web): add the work thread and handoff surfaces`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Make evidence provenance unforgeable at the type level

The program's STOP condition — "a cross-harness handoff cannot distinguish
observed facts from generated summary content" — is satisfied structurally or
not at all. A `source` string field will be filled in wrongly within a month.

`packages/work-threads/src/evidence.ts`:

```ts
export type EvidenceSource =
  | { readonly kind: 'observed'; readonly sessionFactId: SessionFactId; readonly quality: SessionFactQuality }
  | { readonly kind: 'git-snapshot'; readonly deviceId: DeviceId; readonly capturedAt: Instant }
  | { readonly kind: 'stated'; readonly by: PersonId; readonly statedAt: Instant }
  | { readonly kind: 'generated'; readonly by: AgentRef; readonly model: string; readonly generatedAt: Instant };

export interface EvidenceItem<T> {
  readonly value: T;
  readonly source: EvidenceSource;    // required, no default
}
```

`SessionFactQuality` is `docs/session-analysis-sources.md:15-23`'s vocabulary
(`recorded` | `derived` | `partial` | `estimated` | `unavailable`), imported
rather than restated.

There is **no** `EvidenceItem` constructor that omits `source`, and no default
variant. Every handoff field is an `EvidenceItem<T>`, so an unlabelled statement
is a typecheck failure — `strict` and `exactOptionalPropertyTypes` are on
(`tsconfig.json:8,12`).

`evidence.test.ts`: rendering a handoff always emits the source per field; a
`generated` item is never presented with the same affordance as an `observed`
one; an `unavailable` quality is never rendered as zero or as a default
(`docs/session-analysis-sources.md:24-25`).

**Verify**: `bun test packages/work-threads/src/evidence.test.ts` → all pass.

### Step 2: Schema

Migration `0007_work_threads`:

```text
work_threads   (id, space_id NOT NULL, project_id NULL, title, intent,
                status text CHECK (status IN ('active','paused','completed','abandoned','archived')),
                created_by, created_at, closed_at NULL)
work_handoffs  (id, thread_id NOT NULL, space_id NOT NULL,
                status text CHECK (status IN ('draft','accepted','superseded','rejected','expired')),
                source_session_ref jsonb NOT NULL,
                target_session_ref jsonb NULL,
                evidence jsonb NOT NULL,          -- EvidenceItem-shaped, validated on write
                created_by, created_at,
                accepted_by NULL, accepted_at NULL)
work_thread_sessions (thread_id, session_fact_id, role, linked_at)
```

- `status` defaults to `'draft'`. A generated handoff is never `accepted`
  without an explicit act — the same rule plan 105 applies to memory proposals,
  and for the same reason.
- `evidence` is validated against the `EvidenceItem` schema on write, not just
  typed. `jsonb` accepts anything; the validator is the guard.
- `source_session_ref` is a `SessionReference` (below): a *reference*, not a
  claim that the server can open the session.

**Verify**: `bun test packages/postgres-store/src/migrations.test.ts` → all pass.

### Step 3: Creation — draft by default, accepted by a person

`createHandoff` produces `draft`. `acceptHandoff` requires a person principal
and `Authorizer` permission on the thread.

`creation.test.ts`:
- an agent-proposed handoff is `draft` with every generated field labelled;
- no background job can transition `draft → accepted` — assert by enumerating
  the service surface for any function that accepts without a person principal;
- accepting records `accepted_by` and `accepted_at`;
- a handoff in a Space the principal cannot write is denied, with nothing written.

**Verify**: `bun test packages/work-threads/src/creation.test.ts` → all pass.

### Step 4: Continuation — re-check, never trust the snapshot

The plan's own rule: *"A stored Handoff is not authority that the worktree still
matches."*

`continueHandoff` returns a **continuation briefing**, never a "ready" boolean:

```ts
export interface ContinuationBriefing {
  readonly handoff: Handoff;
  readonly checkoutState: 'matches' | 'diverged' | 'unavailable';
  readonly divergences: readonly Divergence[];   // branch moved, HEAD differs, dirty, checkout missing
  readonly staleness: { readonly capturedAt: Instant; readonly ageSeconds: number };
}
```

`staleness.test.ts`:
- the target device's HEAD differs → `diverged`, with the specific divergence;
- the branch was deleted → `diverged`, not `unavailable`;
- the checkout does not exist on the target device → `unavailable`, and the
  briefing is still returned with its stated evidence intact — a handoff whose
  worktree is gone is still useful context;
- an old handoff → age reported, never silently hidden by a default filter
  (ADR 0017).

**Continuation creates a new native target session.** It never writes into
another harness's store — ADR 0030, and plan 110 is the only place authorized to
investigate that.

**Verify**: `bun test packages/work-threads/src/staleness.test.ts` → all pass.

### Step 5: Handoff as memory

An accepted handoff becomes a memory **proposal** (plan 105), not a memory item.
It goes through the same acceptance path as everything else. Reuse
`proposeMemory`; do not add a bypass.

**Verify**: `bun test packages/work-threads/src/handoff-memory.test.ts` — an
accepted handoff creates a proposal, and the proposal still requires acceptance.

### Step 6: The cross-harness scenario — program gate #8

`apps/server/src/cross-harness-handoff.test.ts`:

1. synthetic Claude session on device A produces session facts;
2. an agent proposes a handoff; a person accepts it;
3. synthetic Codex session on device B retrieves it through the MCP adapter;
4. the briefing contains enough verified context to continue: project, branch,
   stated decisions, open questions, next actions — each with its source;
5. **no write occurred to any native harness store.** Assert it: snapshot the
   fixture harness directories before and after and compare byte-for-byte.

Step 5 is the assertion that keeps ADR 0030 honest.

**Verify**: `bun test apps/server/src/cross-harness-handoff.test.ts` → all pass.

### Step 7: MCP tools and surfaces

Tools: `handoff_create` (→ draft), `handoff_get`, `thread_list`,
`thread_sessions`. No `handoff_accept` over MCP — acceptance is a person's act,
so it belongs on a surface where a person is authenticated, not in an agent's
tool list.

Web surfaces: thread list, thread detail with its session timeline, handoff
detail with per-field provenance, and the accept action. ADR 0010/0012 and the
presentation gate apply; one named Query policy per data identity.

**Verify**: `bun test packages/mcp-adapter` → the tool allowlist test includes
the absence of `handoff_accept`. `bun run test:e2e -- e2e/<new-spec>.spec.ts`
→ passes, axe clean.

### Step 8: Documentation

- `packages/work-threads/README.md` — the evidence model, why `source` is
  non-optional, and the draft→accepted rule.
- `CONTEXT.md` — **Work handoff** and **Work thread**, with `_Avoid_` lists
  naming the two colliding meanings explicitly.
- ADR 0030's evidence — cite the no-native-write assertion from Step 6.
- `plans/README.md:66` row → `DONE`.

## Testing requirements

### Domain/persistence

- Work Thread create/status/archive;
- explicit/reviewed session linking;
- immutable Handoff revisions and atomic active pointer;
- concurrent acceptance/stale preview;
- source-labelled statements/provenance;
- Handoff/Memory separation;
- cross-Space/project relationship rejection;
- delete/retention behavior.

### Git/checkout safety

- clean matching target;
- missing checkout;
- same Repository different path;
- branch mismatch;
- HEAD divergence;
- dirty worktree warning;
- source evidence age;
- paths remain Device-local/authorized;
- no full diff or secret captured by default.

### MCP/launcher

- bounded latest Handoff response;
- status/trust/source labels retained;
- unauthorized retrieval;
- stale Handoff indication;
- identical schema across harness fixtures;
- launcher allowlist/structured args/no `sh -c`;
- no native session-store writes;
- resulting target session can be linked back to Thread.

### Presentation

- Thread/Handoff state understandable on desktop/mobile;
- generated versus observed copy is visually and accessibly distinguishable;
- no hidden content in tooltips only;
- presentation gate assertion fails on stale/missing readiness regression.

## Done criteria

- [ ] Work Thread and Handoff are stable, authorized, versioned domains above
      native harness sessions.
- [ ] Handoff statements preserve observed/declared/generated provenance.
- [ ] Creation has state-bound preview and explicit acceptance.
- [ ] Latest active Handoff is retrievable through shared MCP tools.
- [ ] Target Device/checkout verifies current Git state before continuation.
- [ ] At least one cross-harness, cross-device synthetic vertical slice passes.
- [ ] Target starts a normal native session; no private harness store is forged.
- [ ] Handoff does not auto-promote all content into durable Memory.
- [ ] Aggregate-only roles cannot view Handoff content.
- [ ] Local-only behavior remains possible according to accepted platform
      topology.

## STOP conditions

Stop and report when:

- a generated summary is stored as observed fact;
- Work Thread linkage is inferred solely from prompt similarity;
- continuation requires writing undocumented native session DB/JSONL;
- target launch accepts an arbitrary shell string from Web/server;
- the server needs access to target machine files;
- dirty/divergent Git state is hidden to present a successful continuation;
- Handoff content becomes visible through aggregate usage permission;
- accepted Handoff history is overwritten;
- all Handoff text is automatically promoted to durable Memory;
- success/productivity is inferred from token count, duration, commits, or lines.

## Out of scope

- exact native session migration (plan 110);
- synchronizing uncommitted worktrees;
- automatic code checkout or Git credential distribution;
- autonomous acceptance of generated Handoffs;
- issue-tracker integration beyond stored references;
- generalized workflow engine or project-management replacement;
- recommendation scoring for which harness is “best”.
