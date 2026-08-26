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
