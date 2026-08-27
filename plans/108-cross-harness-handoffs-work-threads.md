# Plan 108: Add Cross-Harness Work Handoffs and Work Threads

> **Executor instructions**: Build continuity above harnesses, not by forging
> private stores. Implement the local/offline vertical after plans 105/106, then
> the connected extension after plan 107. Every statement distinguishes
> observed, declared, and generated content. Do not infer successful outcomes
> from tokens, duration, commits, or lines.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages/report-core packages/report-data packages/usage-store packages/local-machine packages/memory packages/memory-search packages/mcp-adapter packages/project-registry packages/replication apps/usage-engine apps/server apps/web apps/cli docs/architecture.md docs/adr`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM–HIGH — generated narrative can be mistaken for fact and
  stale Git state can make continuation destructive
- **Depends on (local phase)**: 102, 105, 106
- **Depends on (connected phase)**: local phase, 107 (and therefore 103/104)
- **Category**: cross-harness continuity and work identity
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO, two phases

## One vocabulary

The three meanings remain distinct:

1. `UsageEngineHandoff*` is the existing CLI-to-engine staged-file transport;
2. imported Agent Memory `kind: "handoff"` is a legacy record value retained
   for import fidelity;
3. **Work handoff** is the new cross-harness concept, represented only by
   `WorkHandoff*` domain symbols.

There is no bare new `Handoff`, `HandoffId`, or `HandoffStatement` TypeScript
domain type in this plan. Prose uses **Work handoff**.

Tool names are exactly:

```text
memory.latest_work_handoff
work_handoff.get
work_thread.get_context
```

Work handoff permissions are exactly:

```text
view_work_handoff
create_work_handoff
accept_work_handoff
manage_work_handoff
```

Do not introduce legacy tool aliases, underscore tool aliases, or legacy
permission aliases for this domain.

## Product value and phase order

The first valuable workflow is local and offline:

```text
local Memory SQLite + FTS5 + local MCP
  ↓
source harness session + reviewed evidence
  ↓
accepted WorkHandoff in a Work Thread
  ↓
different local harness retrieves context through MCP
  ↓
normal new native target session
```

This phase needs no shared server, login, PostgreSQL, replication, or full
organization ReBAC.

The connected extension later stores shared Work Threads/Work handoffs in
PostgreSQL, publishes eligible local facts through plan 107, and supports
cross-device retrieval under full authorization. One domain/service contract
serves both phases.

## Existing evidence boundaries

- per-harness session facts/analysis already exist in `packages/local-machine`;
- `docs/session-analysis-sources.md` supplies the truthfulness vocabulary:
  Recorded, Derived, Partial, Estimated, Unavailable;
- local detail is currently source-machine-only. Work handoffs capture bounded,
  selected evidence; they are not session archives (plan 109);
- stored Git state is evidence captured at a time, never authority that the
  target checkout still matches.

## Domain contracts

### Status sets

```ts
export const WORK_HANDOFF_STATUSES = [
  "draft",
  "accepted",
  "superseded",
  "rejected",
  "expired",
] as const;

export type WorkHandoffStatus = (typeof WORK_HANDOFF_STATUSES)[number];

export const WORK_THREAD_STATUSES = [
  "active",
  "paused",
  "completed",
  "abandoned",
  "archived",
] as const;

export type WorkThreadStatus = (typeof WORK_THREAD_STATUSES)[number];
```

These shared constants drive runtime schemas, SQLite/PostgreSQL checks, public
contracts, and tests. There is no `active` WorkHandoff status and no Work Thread
status set missing `paused`.

### Session reference

```ts
interface SessionReference {
  readonly deviceId: DeviceId;
  readonly harnessKey: string;
  readonly sourceSessionId: string | null;
  readonly sessionFactId: SessionFactId;
  readonly observedAt: Instant;
}
```

The reference never claims the current process/server can open or mutate native
session storage.

### Work Thread

```ts
interface WorkThread {
  readonly id: WorkThreadId;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly intent:
    | "planning"
    | "implementation"
    | "bugfix"
    | "refactor"
    | "review"
    | "investigation"
    | "documentation"
    | "operations";
  readonly status: WorkThreadStatus;
  readonly currentWorkHandoffId: WorkHandoffId | null;
  readonly createdByPersonId: PersonId;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}
```

`projectId` is nullable for legitimate global, personal, exploratory, or
pre-Project work. Work intent is explicitly declared, never inferred from prompt
clustering. A Work Thread is not a Project, issue, branch, PR, Session, or
campaign.

### Work handoff

```ts
interface WorkHandoff {
  readonly id: WorkHandoffId;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly workThreadId: WorkThreadId;
  readonly revisionNumber: number;
  readonly status: WorkHandoffStatus;

  readonly sourceSessions: readonly SessionReference[];
  readonly sourceDeviceId: DeviceId | null;
  readonly sourceHarnessKeys: readonly string[];

  readonly repositoryId: RepositoryId | null;
  readonly branch: string | null;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly pullRequests: readonly string[];

  readonly changedAreas: readonly string[];
  readonly relevantFiles: readonly string[];
  readonly decisions: readonly WorkHandoffStatement[];
  readonly completed: readonly WorkHandoffStatement[];
  readonly openQuestions: readonly WorkHandoffStatement[];
  readonly nextActions: readonly WorkHandoffStatement[];

  readonly completeness: "complete" | "partial";
  readonly createdByPrincipal: PrincipalRef;
  readonly acceptedByPersonId: PersonId | null;
  readonly acceptedAt: Instant | null;
  readonly expiresAt: Instant | null;
  readonly createdAt: Instant;
}
```

Each revision is immutable. Creation defaults to `draft`. Acceptance records a
Person and atomically sets `currentWorkHandoffId`, superseding the prior accepted
revision. Rejection and expiry preserve history. Concurrent stale acceptance
fails with a typed conflict.

### Work handoff statement and evidence

```ts
type WorkHandoffEvidenceSource =
  | { readonly kind: "observed-session"; readonly sessionFactId: SessionFactId; readonly quality: SessionFactQuality }
  | { readonly kind: "observed-git"; readonly deviceId: DeviceId; readonly capturedAt: Instant }
  | { readonly kind: "explicit-user"; readonly personId: PersonId; readonly statedAt: Instant }
  | { readonly kind: "explicit-agent"; readonly agent: AgentRef; readonly statedAt: Instant }
  | { readonly kind: "generated-summary"; readonly agent: AgentRef; readonly model: string; readonly generatedAt: Instant };

interface WorkHandoffStatement {
  readonly text: string;
  readonly source: WorkHandoffEvidenceSource;
  readonly provenance: readonly ResourceReference[];
  readonly confidence: "observed" | "declared" | "generated";
}
```

Source is required and has no default. Generated text cannot render as observed.
Unavailable/estimated facts never render as exact zero/default.

## Persistence and writer ownership

The logical schema is implemented twice behind one repository/application
contract:

```text
work_threads
  id, space_id, project_id NULL, title, intent, status,
  current_work_handoff_id NULL, created_by, timestamps

work_handoffs
  id, thread_id, space_id, project_id NULL, revision_number, status,
  source refs, Git evidence, statements/evidence, completeness,
  created/accepted/expiry metadata

work_thread_sessions
  thread_id, session_fact_id, role, link source/confidence, linked_at

work_thread_events
  immutable lifecycle/audit events
```

Local phase: these tables live in the dedicated Memory SQLite store and share
its sole writer/application-service composition.

Connected phase: equivalent PostgreSQL tables use the same domain validation,
non-null Space fence, nullable Project, and Authorizer. Plan 107 carries
`WorkHandoff`/Work Thread publication events added in the connected extension;
it does not convert legacy Memory `kind: "handoff"` records automatically.

Web, CLI, and MCP never open write-capable SQLite/PostgreSQL connections. They
call Work application services.

## Application services

```text
createWorkThread
changeWorkThreadStatus
linkSessionToWorkThread
createWorkHandoffDraft
previewWorkHandoffAcceptance
acceptWorkHandoff
rejectWorkHandoff
expireWorkHandoff
getWorkHandoff
getWorkThreadContext
getLatestWorkHandoff
continueFromWorkHandoff
```

Services use only the four normalized Work handoff permissions:

- viewing retrieval/context uses `view_work_handoff`;
- draft creation/session linking uses `create_work_handoff`;
- Person acceptance uses `accept_work_handoff`;
- thread/status/rejection/expiry/supersession administration uses
  `manage_work_handoff`.

Aggregate usage permission grants none of them. Source-session content is not
automatically required to view a separately reviewed accepted Work handoff;
provenance reveals only metadata the caller may see. Sensitive statements may
add a condition but never bypass these permissions.

Local phase composes `SingleUserAuthorizer`; connected phase composes the full
adapter. No route/MCP permission logic exists.

## Creation and acceptance

```text
select/create Work Thread (Project optional)
  ↓
select source sessions and optional checkout
  ↓
capture bounded session/Git evidence
  ↓
author or generate source-labelled statements
  ↓
preview evidence, uncertainty, sensitive fields, destination Space
  ↓ state-bound acceptance proof
Person accepts
  ↓
accepted immutable WorkHandoff + atomic currentWorkHandoffId
```

Generated proposals remain draft. No background job or MCP tool accepts them.
Preview becomes stale when evidence/thread/current pointer changes.

## Continuation

The user selects target harness and, when applicable, target Device/checkout.
The service verifies permission, Project/repository compatibility, branch/HEAD,
dirty worktree risk, evidence availability, and MCP capability.

```ts
interface ContinuationBriefing {
  readonly workHandoff: WorkHandoff;
  readonly checkoutState: "matches" | "diverged" | "unavailable";
  readonly divergences: readonly Divergence[];
  readonly staleness: { readonly capturedAt: Instant; readonly ageSeconds: number };
}
```

Missing checkout still returns the accepted stated context with `unavailable`.
Branch/HEAD/dirty divergence is visible and never collapsed into a ready boolean.
Continuation creates a normal new target session/context and later links its
Session reference. It never writes a fabricated native record or executes an
arbitrary shell string from Web/server.

## MCP contract

The initial agent-facing Work tools are read-only and exactly:

```text
memory.latest_work_handoff
work_handoff.get
work_thread.get_context
```

They return bounded Work Thread/Project identity, accepted statements with
source labels, relevant areas/files, source metadata, captured Git evidence,
completeness, staleness, and instructions to verify current code/tests/user
request.

Draft creation/acceptance stays in application services exposed through
authenticated Person UI/CLI flows. No `work_handoff.accept` MCP tool exists in
the first release.

## Relationship to Memory

A Work handoff is current operational continuity for one Work Thread. A Memory
Item is durable guidance beyond a checkpoint. Search indexes accepted Work
handoffs as their own resource; do not duplicate them as Memory Items.

Completing a Work Thread or accepting a Work handoff may create a pending Memory
Proposal via plan 105's service. It never creates/accepts an Item directly. A
legacy imported Memory `kind: "handoff"` remains legacy Memory unless a Person
explicitly creates a new WorkHandoff from it through a reviewed migration flow.

## Phase A: local vertical slice

1. implement domain/status/evidence contracts and conformance tests;
2. add SQLite tables to the dedicated Memory store under the existing local
   writer;
3. add application services with `SingleUserAuthorizer`;
4. implement draft preview/Person acceptance and current pointer;
5. activate the three MCP retrieval tools over local FTS5/application services;
6. prove a synthetic Claude → accepted WorkHandoff → Codex new-session context
   flow with no server/account/network/PostgreSQL call;
7. prove native harness fixture directories are byte-identical before/after.

This is the early product-validation milestone. Do not wait for plans 103/104/107.

## Phase B: connected extension

After plan 107:

1. add equivalent PostgreSQL repository adapter and full Authorizer composition;
2. add normalized WorkHandoff/Work Thread replication change kinds and fact/event
   identity tests;
3. publish eligible accepted local Work handoffs according to policy;
4. enable shared/cross-device retrieval through the same MCP contracts;
5. prove unauthorized member/auditor denial and offline source Device behavior;
6. prove conflicting local/shared revisions surface review instead of silent
   overwrite.

Connected direct commands may create shared drafts; replicated/local changes
must have one documented conflict/authority rule. Do not introduce two current
pointers for one shared Work Thread.

## Product surfaces

Minimum local surface may live under Session/Project detail and shows Thread,
draft/accepted Work handoff, per-statement source, staleness, and continue/copy
context. Connected surface adds Device/freshness/conflict context. A top-level
Work destination is deferred until the vertical proves value.

CLI vocabulary uses explicit `work-thread` and `work-handoff` nouns, not a bare
new `handoff` command that collides with engine transport.

## Tests

### Domain/persistence

- exact status sets and schema/check alignment from shared constants;
- nullable Project legitimate case;
- Work Thread lifecycle and immutable WorkHandoff revisions;
- atomic current pointer and concurrent stale acceptance;
- source-required evidence and generated/observed presentation;
- cross-Space rejection and content-free events;
- legacy Memory handoff remains distinct.

### Git/continuation

- matching/missing/different checkout;
- branch deleted, HEAD divergence, dirty state, evidence age;
- paths remain Device-local/opaque when remote;
- no full diff/secret by default;
- no native store mutation and no arbitrary shell.

### MCP/authorization

- exact three tool names and no aliases;
- exact four permission names and no old aliases;
- bounded result and identical local/connected response shape;
- unauthorized retrieval and aggregate-auditor denial;
- no MCP acceptance;
- local flow makes zero platform calls.

## Verification

- grep finds no bare new `interface Handoff`, `HandoffId`, or
  `HandoffStatement` domain declaration;
- status/tool/permission contract tests enumerate exact sets;
- local cross-harness scenario passes before connected work;
- connected scenario passes after plan 107 with same contracts;
- native harness directories are unchanged;
- lint, typecheck, package tests, e2e/accessibility gates pass.

## Done criteria

- [ ] Work Thread and WorkHandoff use one normalized domain contract.
- [ ] WorkThread.projectId is nullable and both status sets are exact.
- [ ] All WorkHandoff statements distinguish observed/declared/generated.
- [ ] Local offline cross-harness flow works through the exact MCP tools.
- [ ] Connected extension reuses contracts and depends on plan 107.
- [ ] Target starts a normal native session and rechecks Git state.
- [ ] Aggregate-only roles cannot see Work handoff content.
- [ ] Work handoff does not auto-promote into durable Memory.

## STOP conditions

Stop and report when:

- a bare new `Handoff` domain type or old tool/permission alias appears;
- local WorkHandoff requires shared server/login/PostgreSQL;
- generated content is stored/rendered as observed;
- Project becomes required for legitimate non-project work;
- accepted history/current pointer is overwritten non-transactionally;
- continuation writes undocumented native stores or accepts arbitrary shell;
- Work handoff content becomes visible through aggregate permission;
- all content auto-promotes to Memory;
- success is inferred from activity metrics.

## Out of scope

- native session migration (plan 110);
- uncommitted worktree synchronization/Git credential distribution;
- autonomous acceptance;
- generalized workflow/project-management engine;
- harness recommendation scoring.
