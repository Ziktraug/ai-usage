# Plan 027: Extend Session Insight to Claude and Add Trustworthy Git Links

> **Coordinator instructions**: this master plan contains seven deliverable
> work packages. Every agent must read the complete plan before taking a
> package, then modify only the files assigned to that package. The coordinator
> alone updates status in `plans/README.md`, integrates commits, and resolves
> contract drift. Every agent must hand back its SHA, exact commands and
> results, plus any observed deviation. This plan authorizes local
> implementation and verification only. Do not push or open a PR unless the
> user explicitly requests it.
>
> **Required ordering**: plan 026 was completed at `9545fb8`. Work package E
> must build on that integrated drawer implementation. No agent may develop an
> alternate drawer or revert its summary/chronology model.
>
> **Run this drift check first**:
>
> ~~~sh
> git diff --stat 9545fb8..HEAD -- \
>   packages/report-core/src/session-detail.ts \
>   packages/report-core/src/types.ts \
>   packages/report-core/src/serialized-usage-validation.ts \
>   packages/report-core/src/snapshot.ts \
>   packages/report-core/src/merge-bundle.ts \
>   packages/local-collectors/src/collectors/claude.ts \
>   packages/local-collectors/src/codex-history.ts \
>   packages/local-collectors/src/opencode-history.ts \
>   apps/web/src/server/session-detail.server.ts \
>   apps/web/src/session-analysis-model.ts \
>   apps/web/src/session-analysis.tsx \
>   apps/web/src/session-drawer.tsx \
>   docs/session-analysis-sources.md
> ~~~
>
> If the exact-revision contract, portable format, session drawer, or any
> harness parser has materially changed since `9545fb8`, STOP and update this
> plan before writing implementation code.

## Status

- **Status**: TODO
- **Priority**: P1
- **Effort**: XL, delivered in seven packages
- **Risk**: HIGH
- **Depends on**: plans 025 and 026, both DONE
- **Category**: feature, data contract, privacy, UX, tests, docs
- **Audited at**: commit `23a6230`, 2026-07-20
- **UI baseline**: commit `9545fb8`, 2026-07-20
- **Suggested integration branch**: `feat/027-claude-session-insight-vcs`
- **Primary outcome**: a Claude session can show an honest local chronology
  even when complete active timing is unavailable, and the drawer can show
  repository, branch, commit, and PR links when provenance supports them.

## Executive Summary

The `agent/improve-session-analysis` branch made Codex and OpenCode analysis
verifiable. A user selects a row from an immutable report revision, the server
resolves its provenance, reads the local trace on demand, and compares local
facts with the report. The detail contract is still tailored to those two
harnesses: it requires active duration, idle duration, and a duration for every
turn. Claude records the events, prompts, models, tokens, tools, and lineage
needed for a chronology, but records turn duration for only a subset of
sessions.

This plan explicitly rejects fake parity. Claude becomes a supported harness
by making timing `recorded`, `partial`, or `unavailable`. A session without
duration can still show its wall-clock span, events, model phases, tokens,
tools, and prompts. It must not show first-event-to-last-event span as active
time.

Git context is a separate contract from chronology. It must be available in
the drawer summary even when a harness has no temporal detail. Collectors
retain Git observations recorded by the harness, or a clearly marked local
derivation. Recorded PR URLs render directly. Provider lookup through `gh`
may occur only after an explicit user action; it never participates in normal
collection, publication, revisions, or exports.

## Local Evidence Behind This Plan

The structural audit ran on 2026-07-20 without reading or retaining prompt
text:

| Source | Locally observed data | Conclusion |
| --- | --- | --- |
| Claude Code 2.1.199 | 451 JSONL files, 159 root sessions, 292 subagent files, about 51,000 events | enough real history to build and compatibility-test an adapter |
| Claude timing | 187 `system.turn_duration` records across 54 sessions; trace activity continued after the newest duration record | the field exists but does not reliably cover complete sessions |
| Claude Git | all 159 root sessions had `cwd` and `gitBranch`; 32 observed multiple branches | branch must be an ordered observation sequence, not one invented session-wide value |
| Claude PR | 48 `pr-link` events across 5 sessions, with `prUrl`, `prNumber`, and `prRepository` | recorded PRs can link without network access |
| Codex Git | 864/879 `session_meta` records had branch, 873 commit, and 846 `repository_url` | collectors currently discard trustworthy recorded metadata |
| OpenCode | roughly 640 MB local database; detail already supported | repository can be derived from directory, but historical branch cannot be claimed without source evidence |
| Cursor | roughly 1.18 GB local database plus one CSV export | composer-to-workspace linkage and timing coverage remain too weak for a general promise |

The Claude audit also observed `uuid`, `parentUuid`, `promptId`, `requestId`,
`message.model`, `message.usage`, `tool_use`, `agentId`, `isSidechain`, and
`gitBranch`. `turn_duration` records contained `durationMs`, `parentUuid`,
`messageCount`, `sessionId`, `timestamp`, `cwd`, and `gitBranch`.

These are untrusted runtime inputs despite their TypeScript-looking shapes.
Every value must be validated and bounded. The counts are compatibility
observations, not product invariants, and tests must not assume future Claude
versions preserve the same emission frequency.

## Goals

1. Add Claude to Session Analysis without presenting an estimate as a recorded
   measurement.
2. Give Claude report and detail paths one owner for tokens, models, tools,
   turns, deduplication, and subagent relationships.
3. Preserve exact-revision authority and on-demand local reads.
4. Add bounded, strictly validated Git context to locally observed sessions.
5. Show repository, observed branches, commit, and PR in the drawer when
   available.
6. Preserve collected Git context in portable formats through an explicit
   version migration, without credentials or ephemeral network results.
7. Provide optional `gh` resolution only after an explicit action, using a
   bounded, shell-free subprocess.
8. Document a repeatable process for future harnesses without speculatively
   implementing collectors for tools absent from the machine.

## Non-Goals

- Infer Claude effort from thinking blocks, reasoning tokens, model, or current
  configuration.
- Call the complete Claude session span active time.
- Reconstruct model runtime from message timestamps.
- Guarantee that every Claude session has duration or a PR.
- Make a network request during collection, publication, drawer opening,
  rendering, hover, prefetch, or automatic refresh.
- Persist detailed prompt bodies in revisions, snapshots, merge bundles, VCS
  caches, or provider-resolution responses.
- Infer a PR from branch name alone without provider confirmation.
- Present Git state derived from the current checkout as a historical harness
  observation.
- Add Gemini CLI, Aider, Copilot CLI, Windsurf, or another harness without an
  audited local format and representative fixtures.
- Rewrite all of `UsageRow`, the session table, or the design system.
- Put GitHub-specific URL construction directly in JSX.
- Push branches, mutate PRs, or call a GitHub mutation.

## Non-Negotiable Invariants

### Exact Revision and Authority

1. The browser requests detail with only `{ revision, rowId }`.
2. The server resolves machine, harness, source session, and authority from the
   requested revision.
3. A `portable-opaque` row never causes a local read, even when its identifiers
   resemble a local session.
4. An expired revision never falls back to the current revision.
5. `sessionRowIdentity` remains stable when only Git context or a resolved URL
   changes. Never add `source.vcs` to the identity hash.

### Privacy and Security

6. Detailed prompts remain local-only, bounded, and loaded after explicit user
   action.
7. A remote containing userinfo, password, token, query, or fragment is never
   serialized verbatim.
8. Clickable URLs are strictly validated. Reject `javascript:`, `data:`,
   `file:`, and unknown schemes.
9. External links use `target="_blank"` and `rel="noopener"`.
10. The `gh` resolver passes executable and arguments separately. It never
    builds an interpolated shell command from repository or branch input.
11. The resolver has a timeout, stdout budget, and exact JSON parser. It never
    returns raw stderr, local paths, or authentication state.
12. No `gh` result enters a revision, store, snapshot, or merge bundle. Any
    cache is private, bounded, and disposable.
13. Local Git derivation occurs only at a `local-observed` collector boundary.
    Portable `sourcePath` is never dereferenced to reconstruct Git context.

### Metric Quality

14. `recorded` means the harness supplied the relevant timing measurement.
15. `partial` means the value is a bound built from some recorded activity. UI
    renders `>=` active and `<=` outside activity.
16. `unavailable` renders no active/idle number. Zero is never an absence
    sentinel.
17. First and last event timestamps may define a derived span, not active time.
18. Claude effort remains `null` with `effortKind: 'unavailable'` until an
    explicit field is observed and documented.
19. Tokens are attributed to each assistant message's model, never only to the
    dominant model.
20. Repeated assistant messages use the same deduplication identity in report
    and detail.
21. Tool-result, meta, and synthetic user events are not human prompts.

### Portability

22. Git context recorded or derived during local collection is a normal
    portable source field and requires portable version 3.
23. v1/v2 readers migrate to v3 with `source.vcs` absent.
24. A v1/v2 artifact containing `source.vcs` is rejected rather than accepted
    under a misleading version.
25. Row and byte limits remain symmetric for producers and consumers.
26. Explicit provider-resolution results remain non-portable.

## Current Code State

### Detail Supports Only Two Harnesses

`packages/report-core/src/session-detail.ts` currently declares:

~~~ts
export const sessionDetailHarnessKeys = ['codex', 'opencode'] as const;
~~~

`apps/web/src/server/session-detail.server.ts` then selects Codex or OpenCode
with a ternary. Merely adding `claude` to the union would route Claude to the
OpenCode reader. Dispatch must become exhaustive and tested.

### Timing Is Mandatory

`SessionDetailTurn.durationMs`, `SessionDetail.activeDurationMs`, and
`SessionDetail.idleDurationMs` are numbers. Validation requires:

- `active + idle === elapsed`;
- `durationMs === endAt - startAt`;
- every interval is enclosed by its turn.

Those invariants fit complete captures but cannot represent Claude without
duration. Weakening them without a quality discriminant would create invalid
states.

### Claude Projection Is Useful but Monolithic

`packages/local-collectors/src/collectors/claude.ts` already:

- walks JSONL history;
- derives start/end;
- separates prompts from tool results;
- counts tools;
- deduplicates assistant messages;
- aggregates tokens and `modelSegments`;
- infers agent files and root parent;
- preserves only `sourcePath` in `UsageRowSource`.

A separate detail parser would recreate the duplicate-ownership problem that
plan 025 removed for OpenCode. Shared Claude facts must be extracted first.

### Recorded Git Metadata Is Discarded

`UsageRowSource` carries machine, harness, IDs, artifact, and source path, but
no Git data. Codex reads `session_meta.payload` and ultimately keeps only cwd.
Claude reads `event.gitBranch` without preserving it. Project-level
`gitRemote` may be derived from the current checkout, but it is neither a
session observation nor a historical branch.

### Portable Formats Are Strictly Versioned

Snapshots and merge bundles are version 2 for `modelSegments`. Validators use
exact key sets. Silently adding `source.vcs` would either break caches or accept
a new contract under the wrong version. Version 3 and migrations are required.

### The Unified Drawer Is Ready

Plan 026 now renders summary and chronology together. Git context belongs in a
compact summary block, not a new route, nested card, or competing timeline.

## Target Architecture

~~~text
Claude JSONL -- parseClaudeSessionFacts --+-- collectClaudeRows
                                          +-- readClaudeSessionAnalysis
                                               +-- bounded local detail
                                               +-- comparable projection

Codex session_meta ----------------+
Claude cwd/gitBranch/pr-link -------+-- portable validated SessionVcsContext
OpenCode dir + local Git -----------+       |
                                            +-- report row / snapshot v3
                                            +-- sessions.sqlite source_row_json
                                            +-- SessionDrawer Git summary

Session drawer -- explicit "Resolve GitHub links" action
                  +-- { revision, rowId }
                       +-- server resolves authoritative local anchor
                            +-- bounded shell-free gh execution
                                 +-- ephemeral repository/PR result
~~~

Claude detail and Git context share session identity, not lifecycle. Collected
Git context is available without opening prompts. Detail remains a local
on-demand read. Provider lookup remains explicit and ephemeral.

## Target Contracts

Names and discriminants below are prescriptive. Agents may extract private
helpers, but must not replace these states with booleans or free-form strings.

### Timing Contract

In `packages/report-core/src/session-detail.ts`:

~~~ts
export const sessionDetailTimingStatuses = [
  'recorded',
  'partial',
  'unavailable',
] as const;

export type SessionDetailTimingStatus =
  (typeof sessionDetailTimingStatuses)[number];

export interface SessionDetailTurn {
  durationMs: number | null;
  timingStatus: 'recorded' | 'unavailable';
  // existing fields unchanged
}

export interface SessionDetail {
  activeDurationMs: number | null;
  idleDurationMs: number | null;
  durationStatus: SessionDetailTimingStatus;
  elapsedDurationMs: number;
  // existing fields unchanged
}
~~~

Validation rules:

| Status | Active | Idle | Turns | Relation |
| --- | --- | --- | --- | --- |
| `recorded` | number >= 0 | number >= 0 | every relevant turn has duration | `active + idle === elapsed` |
| `partial` | recorded lower bound >= 0 | derived upper bound >= 0 | at least one recorded turn and one gap | `active + idle === elapsed`, rendered as bounds |
| `unavailable` | `null` | `null` | turns may all have null duration | no active/idle decomposition is claimed |

For each turn:

- `recorded` requires non-null duration, at least one interval, and interval
  union equal to duration;
- `unavailable` requires null duration and empty intervals;
- `startAt`/`endAt` remain the event envelope and are not described as active
  when timing is unavailable.

Do not add `estimated` in this plan. No defensible Claude estimator was found.
A future extension must specify method, bounds, and wording first.

### Shared Claude Contract

Create `packages/local-collectors/src/claude-session-facts.ts`:

~~~ts
export interface ClaudeSessionFacts {
  detailFacts: ClaudeDetailFacts;
  projection: SessionProjectionFacts;
  report: ClaudeReportFacts;
  source: ClaudeSourceFacts;
}

export const parseClaudeSessionFacts: (
  input: ClaudeSessionInput,
) => ClaudeSessionFacts | null;
~~~

The public type may be smaller, but tokens, deduplication, models, prompts,
tools, lineage, timing, and Git rules have one owner. All-sessions collection
and one-session detail may keep different I/O strategies while calling the
same pure parser over validated records.

### Portable Git Contract

Create `packages/report-core/src/session-vcs.ts`, exported as
`@ai-usage/report-core/session-vcs`:

~~~ts
export type SessionVcsProvenance =
  | 'harness-recorded'
  | 'local-derived';

export interface SessionVcsRepository {
  host: string;
  ownerPath: string;
  provenance: SessionVcsProvenance;
  webUrl: string | null;
}

export interface SessionVcsBranchSpan {
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  name: string;
  provenance: SessionVcsProvenance;
  webUrl: string | null;
}

export interface SessionVcsCommit {
  hash: string;
  observedAt: string | null;
  provenance: SessionVcsProvenance;
  webUrl: string | null;
}

export interface SessionVcsPullRequest {
  number: number | null;
  observedAt: string | null;
  repository: string | null;
  url: string;
}

export interface SessionVcsContext {
  branches: SessionVcsBranchSpan[];
  headCommit: SessionVcsCommit | null;
  partial: boolean;
  pullRequests: SessionVcsPullRequest[];
  repository: SessionVcsRepository | null;
}
~~~

Add `vcs?: SessionVcsContext` to `UsageRowSource`.

Initial budgets, expressed as constants and boundary-tested:

- 32 branch spans;
- 16 PRs;
- 256 characters per branch, host, owner path, or repository label;
- 2,048 characters per URL;
- at most 64 hexadecimal characters for a Git commit;
- deterministic deduplication and chronological ordering;
- at most 64 KiB serialized context per row.

The remote normalizer accepts HTTPS and SCP-like SSH forms, extracts host and
owner path, removes `.git`, and rejects credentials, query, and fragment. It
never turns an unknown SSH alias into an assumed web URL. Pure forge adapters,
at minimum GitHub and GitLab, own branch/commit URL construction outside JSX.
Unknown forges keep `webUrl: null` and render non-clickable text.

`partial` means some context was observed but a value was rejected, a budget
was exceeded, or multiple repositories/worktrees could not be represented by
the normalized row. It is a targeted Git-context limitation, not a global
session warning.

### Explicit Provider Resolution Contract

Keep provider lookup separate from `SessionVcsContext`:

~~~ts
export interface SessionVcsResolveRequest {
  revision: string;
  rowId: string;
}

export type SessionVcsResolveResponse =
  | {
      repositoryUrl: string;
      pullRequests: SessionVcsPullRequest[];
      status: 'available';
    }
  | {
      reason:
        | 'not-local'
        | 'provenance-unavailable'
        | 'resolver-unavailable'
        | 'repository-unsupported'
        | 'not-found'
        | 'timed-out';
      status: 'unavailable';
    };
~~~

The server resolves the anchor from `{ revision, rowId }`. It accepts no
remote, branch, or repository supplied by the browser. `gh` runs only when the
local row contains usable repository and branch facts and the user explicitly
clicks the action. Never invoke it from an effect, hover, prefetch, drawer open,
or refresh.

The first version requests only canonical repository URL and matching PR
number/URL. It requests no body, comments, author, diff, checks, or secrets.
Branch count and results are bounded. Prefer one structured `gh` command. If a
bounded unambiguous multi-branch query is unavailable, limit MVP to the final
observed branch and document it.

## Detailed Claude Semantics

### File Selection

- `sourceSessionId` remains the file identity used by the current collector.
- The reader walks Claude history through existing `LocalHistoryStorage`
  protections, rejects symlinks/non-regular files, and matches exact basename.
- No browser-provided path is used.
- Bound file count, bytes, and lines. A private fingerprinted index may contain
  file identity only, never prompts.
- Duplicate or ambiguous identity returns unavailable instead of silently
  choosing the newest file.

### Record Classification

Each valid JSON line becomes a bounded internal discriminated record or is
ignored with a bounded counter. Raw JSON does not escape the parser.

An eligible human prompt is a `user` event that:

- is not meta or synthetic;
- is not a tool result;
- contains eligible user text;
- is not an excluded housekeeping command;
- fits existing text budgets.

An usage-bearing assistant event:

- has validated usage;
- uses shared report/detail deduplication;
- carries its own model;
- counts `tool_use` blocks;
- retains only graph/timing identity needed internally, not assistant content
  in the UI response.

### Prompt, Assistant, and Tool Association

Build a bounded `uuid`/`parentUuid` graph:

1. Index unique record UUIDs.
2. Reject or isolate conflicting duplicates.
3. Walk each assistant to its nearest eligible human-prompt ancestor.
4. Keep tool-result user events in the chain but never as turn roots.
5. Bound traversal and detect cycles.
6. Keep unresolved assistant work in a prompt-less partial turn rather than
   dropping tokens/tools.
7. Never override contradictory graph evidence with timestamp proximity.

Subagents use `agent-*` files and current collector evidence. Agent-to-root
remains `parentSourceSessionId`. Do not invent lineage between ordinary Claude
root sessions.

### Models, Tokens, and Phases

- Input, output, cache-read, and cache-creation buckets use the same validators
  and deduplication as the report row.
- Attribute every contribution to `message.model` at its timestamp.
- Phases are chronological consecutive model sequences. The same model can
  appear in separate phases when another model intervenes.
- `costKind` is approximate with known pricing and unknown otherwise.
- Effort is unavailable on every Claude phase and turn.
- Local projection compares report `modelSegments`, not only dominant model.

### Timing

For every valid `system.turn_duration`:

1. Associate it through the `parentUuid` graph.
2. Use timestamp as interval end only when graph position and fixture prove it
   closes the turn.
3. Derive start from `end - durationMs`.
4. Reject negative, non-finite, over-budget, or incoherent intervals.
5. Union overlaps before active totals.
6. Do not add duplicate duration records twice.

Session status:

- all relevant turns timed: `recorded`;
- some timed and some untimed: `partial`;
- no usable timing: `unavailable`.

Span runs from first to last relevant local event. Long silent periods remain
visible/compressible span, but do not become exact idle when timing is absent.

### Claude Branches and PRs

- Compact consecutive identical `gitBranch` observations into ordered spans.
- Show branch changes; do not declare first or last branch true for the entire
  session.
- Deduplicate `pr-link` by canonical URL.
- Reject incomplete or unsafe PR URLs and mark context partial.
- Repository derives from Git at normalized `sourcePath` and is
  `local-derived` unless a trustworthy recorded source exists.
- If cwd values cross repositories, keep context for normalized sourcePath and
  mark partial rather than merging unrelated repos.

## Per-Harness Git Strategy

| Harness | Repository | Branch | Commit | Direct PR | Detail timing |
| --- | --- | --- | --- | --- | --- |
| Codex | recorded `session_meta.payload.git.repository_url` | recorded `payload.git.branch` | recorded `payload.git.commit_hash` | only a dedicated trustworthy field; otherwise explicit resolver | already supported |
| Claude | local Git remote for cwd, derived | recorded and compacted `event.gitBranch` | absent without future proof | recorded `pr-link` | added by this plan |
| OpenCode | local Git for `session.dir`, derived | never current checkout branch as history | absent | resolver only if recorded repo+branch later exist | already supported |
| Cursor | conditional on audited composer/workspace mapping | conditional on recorded observation | separate attribution dataset is not automatically session-owned | out of MVP | remains unsupported |

Codex `repository_url` may use a local SSH alias. Preserve safe host/owner path,
but do not invent web URL for an unknown forge. Explicit provider resolution
may return canonical URL to client memory only.

## Work Packages and Integration Order

| Package | Subject | Primary ownership | Depends on | Parallel? |
| --- | --- | --- | --- | --- |
| 0 | baseline, fixtures, measured decisions | coordinator and fixtures only | 026 integrated | no |
| A | nullable timing contract and pure models | report-core detail + pure UI models | 0 | no |
| B | portable Git v3 contract | report-core types/vcs/snapshot/merge + cache validation | 0 | with A only if file ownership stays disjoint |
| C | shared Claude facts, detail adapter, harness Git extraction | local-collectors | A, B | no |
| D | exact-revision Claude wiring and `gh` resolver | report-data runner + web server | C | no |
| E | Claude UI and Git context | web components on integrated 026 | A, D | no |
| F | OpenCode extension and conditional Cursor audit | relevant collectors | B, E | yes with strict ownership |
| G | system tests, docs, gates, closure | vertical tests, docs, log/index | A-F | no |

Suggested commits:

1. `Allow unavailable session timing`
2. `Add portable session VCS context`
3. `Share Claude session facts between report and detail`
4. `Serve Claude session analysis by exact revision`
5. `Resolve session repository links on explicit request`
6. `Show Claude chronology and session VCS links`
7. `Document multi-harness session insight guarantees`

Every commit must compile and pass focused tests. If A/B run in parallel, B
must not touch `session-detail.ts`, and A must not touch types, snapshots, or
merge bundles.

## Work Package 0: Baseline, Fixtures, and Format Proof

**Owner**: coordinator.

### Step 0.1: Verify Worktree and Create Log

~~~sh
git status --short --branch
git rev-parse --short HEAD
git diff --check
~~~

Create `plans/027-extend-session-insight-to-claude-and-vcs-log.md` with start
SHA, plan 026 state, pre-existing user changes, 0/A-G status table, one entry
per commit/gate, and format deviations without prompt content.

### Step 0.2: Freeze Test Baseline

~~~sh
bun test packages/report-core/src/session-detail.test.ts \
  packages/report-core/src/snapshot.test.ts \
  packages/report-core/src/merge-bundle.test.ts
bun test packages/local-collectors/src/codex-history.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/test-fixtures/harness-home.test.ts
bun test apps/web/src/session-analysis.test.ts \
  apps/web/src/session-analysis.render.test.tsx \
  apps/web/src/session-detail-client.test.ts \
  apps/web/src/server/session-detail.server.test.ts
bun run typecheck
~~~

Record pre-existing failures separately. Do not hide them in implementation.

### Step 0.3: Extend Fixtures Without Private Data

Update `packages/local-collectors/src/test-fixtures/harness-home.ts` with:

- Claude root containing two direct prompts, tool use/result, and two models;
- one linked `turn_duration` and one untimed turn;
- initial branch plus branch change;
- complete `pr-link`;
- duplicate assistant message;
- subagent with root parent;
- malformed record for each important category;
- Codex `session_meta.git` with remote, branch, commit;
- OpenCode directory inside a real temporary Git repository;
- existing prompt sentinel, absent from every expected portable fixture.

Expected values are literal. Fixture builders never call production parsers to
calculate goldens.

### Step 0.4: Optional Reproducible Probe

If live-format confirmation is necessary, add a `tools/` probe that outputs
only counts, record types, key shapes, field coverage, and min/max timestamps.
It must output no prompt, cwd, remote, branch, or PR URL.

**Verify**:

~~~sh
bun test packages/local-collectors/src/test-fixtures/harness-home.test.ts
~~~

## Work Package A: Make Timing Honest

**Exclusive ownership**:

- `packages/report-core/src/session-detail.ts` and test
- `apps/web/src/session-analysis-model.ts` and test
- presentation model/test only if a new kind is essential

### Step A.1: Write Failing Parser Tests

Cover complete recorded, valid partial, valid unavailable, invalid mixed
null/numeric states, recorded with null turn, partial with no recorded
interval, unavailable turn with intervals, incoherent union/duration, unknown
fields, and all existing budgets.

### Step A.2: Change Types and Validators

Implement the target contract without arbitrary `undefined`. Wire states are
explicit. Update comparison so duration is checked only when comparable;
asymmetric availability follows a written `cannot-compare`/coverage matrix;
and `checkedFields` ordering stays deterministic.

### Step A.3: Adapt Pure UI Models

- Treat null before formatting duration.
- Render unavailable, never `0ms`.
- Support point-only turns without active bars.
- Plan 026 gap compression must not turn points into intervals.
- Keep wording in `SessionDurationSemantics`, not JSX.
- Add Claude wording for recorded turn time, session span, and unattributed
  span, with literal tests.

**Verify**:

~~~sh
bun test packages/report-core/src/session-detail.test.ts \
  apps/web/src/session-analysis.test.ts \
  apps/web/src/session-analysis-presentation.test.ts
bun --filter @ai-usage/report-core check
bun --filter @ai-usage/web check
~~~

**Commit**: `Allow unavailable session timing`

## Work Package B: Add Portable Git Context v3

**Exclusive ownership**:

- new `session-vcs.ts` and test
- report-core types, serialized validation, snapshots, merge bundles, exports
- collector-cache validation only
- required usage-store/usage-merge roundtrip tests

### Step B.1: Build Pure VCS Domain

Test GitHub/GitLab HTTPS and SSH, `.git` suffix, branch special characters,
commit URL, PR deduplication, consecutive span compaction, unknown SSH alias,
credential/query/fragment rejection, dangerous schemes, budgets, ordering, and
deterministic serialization. Use `URL` plus segment-aware encoding.

### Step B.2: Extend `UsageRowSource`

Add optional `vcs` and update every exact-key validator, cache reviver,
clone/merge helper, and exhaustive test. Prove:

- session row identity does not change;
- source fingerprint/content hash changes when collected Git context changes;
- no SQL column migration is needed if JSON columns retain the complete source;
- SQLite queries preserve the field.

### Step B.3: Move Portable Formats to v3

- Make v2 an explicit legacy version alongside v1.
- Migrate v1/v2 with VCS absent.
- Reject v1 `modelSegments` and v1/v2 `source.vcs`.
- Write v3 for new artifacts.
- Preserve all limits.
- Prove v3 multi-machine roundtrip and whole-row newest-wins behavior.

### Step B.4: Verify CLI and Sync Formats

JSON/snapshots expose portable context. Do not add CSV columns automatically;
document that decision. Sync preview retains exact row/byte/warning behavior.

**Verify**:

~~~sh
bun test packages/report-core/src/session-vcs.test.ts \
  packages/report-core/src/snapshot.test.ts \
  packages/report-core/src/merge-bundle.test.ts \
  packages/local-collectors/src/collector-cache.test.ts \
  packages/usage-store/src/index.test.ts \
  packages/usage-merge/src/index.test.ts
bun --filter @ai-usage/report-core check
bun --filter @ai-usage/local-collectors check
~~~

**Commit**: `Add portable session VCS context`

## Work Package C: Share Claude Facts and Produce Detail

**Exclusive ownership**:

- new Claude facts/history modules and tests
- Claude collector and tests
- Codex history/tests for VCS only
- local-collectors exports/package manifest
- strictly necessary fixture additions

### Step C.1: Extract Common Claude Parser

Characterize existing rows for simple, multi-model, duplicate, subagent, and
malformed usage fixtures. Extract helpers without behavior change, route the
collector through the new parser, prove literal parity, then add detail/timing/
VCS. The pure parser reads no filesystem and knows no Effect, web, or SQLite.

### Step C.2: Implement Turn Graph

Cover string/block prompts, tool-result user events, direct and tool-mediated
assistant descendants, missing UUID/parent, cycles, prompt-less assistant,
duplicate assistant, subagent, and all depth/item budgets. Valid unattributed
assistant metrics remain in projection; `turnsStatus` becomes partial.

### Step C.3: Implement Claude Timing

Fixtures cover all three session statuses. Prove timed bars, untimed point-only
turns, partial bounds, zero timings -> unavailable, overlap union, rejected
outlier without lost metrics, and no active time from silent gaps.

### Step C.4: Implement `readClaudeSessionAnalysis`

Select exactly one safe file, use existing budgets/no-follow reads, return
`LocalSessionAnalysis`, bound prompts/full result, return null for not-found and
typed failure for unsafe reads, and never cache prompt text.

### Step C.5: Extract Claude and Codex VCS

Claude: compact branches, derived repository, recorded PRs. Codex: preserve
recorded repository, branch, and commit from the correct session meta. Define
multiple-meta ownership deterministically. Bump Claude and Codex cache versions.

### Step C.6: Prove Report/Detail Parity

Collect Claude fixture row, read detail, obtain `matches-report`, mutate local
usage, obtain exact divergence, recollect, and restore match.

**Verify**:

~~~sh
bun test packages/local-collectors/src/claude-session-facts.test.ts \
  packages/local-collectors/src/claude-history.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  packages/report-data/src/session-report-pipeline.integration.test.ts
bun --filter @ai-usage/local-collectors check
~~~

**Commit**: `Share Claude session facts between report and detail`

## Work Package D: Wire Claude and Provider Resolution

**Exclusive ownership**:

- session-detail server/test
- new session-vcs server/test and client/test
- report payload wrappers
- bounded process runner only if existing seam cannot safely fit
- revision runner only if a new query kind is truly required

### Step D.1: Make Dispatch Exhaustive

Use exhaustive switch or `satisfies Record<SessionDetailHarnessKey, ...>`.
Add Claude key only with reader/tests. Required cases: authoritative local
available, portable not-local/no read, wrong machine, missing provenance,
missing file, unsafe history, expired revision, Cursor unsupported.

### Step D.2: Reuse Revision Anchor for VCS

Collected VCS is already in the displayed row. Provider resolution must still
resolve authority, repository, and branches server-side from the immutable
revision. Extend the existing anchor or add a query kind only when exact parsers
and budgets stay simple. Browser sends no Git strings.

### Step D.3: Create `SessionVcsProviderResolver` Port

The business server depends on a testable port. Its `gh` adapter detects the
executable without shell, uses separate arguments, requests minimal JSON, has
recommended 5-second timeout and 256 KiB stdout limit, returns at most 16 PRs,
validates every URL, and maps absence/auth/timeout/not-found/invalid output to
typed reasons without raw details. Tests use fakes or a subprocess fixture,
never real GitHub.

### Step D.4: Prove No Implicit Calls

Rendering/opening detail performs no lookup. Explicit click calls once, pending
double-click deduplicates, changing rows invalidates result, close/reopen does
not persist into report, and retry works after typed failure.

**Verify**:

~~~sh
bun test apps/web/src/server/session-detail.server.test.ts \
  apps/web/src/server/session-vcs.server.test.ts \
  apps/web/src/session-detail-client.test.ts \
  apps/web/src/session-vcs-client.test.ts \
  apps/web/src/server/revision-query-runner.server.test.ts
bun --filter @ai-usage/web check
~~~

**Commits**:

- `Serve Claude session analysis by exact revision`
- `Resolve session repository links on explicit request`

## Work Package E: Render Claude and Git in the Unified Drawer

**Precondition**: plan 026 is integrated at `9545fb8` or a documented
descendant.

**Exclusive ownership**: session analysis component/tests, session drawer,
new VCS summary/model/tests, and the existing production E2E.

### Step E.1: Add Claude Semantics

Render span; recorded time and outside bound when partial; unavailable without
active/idle; model phases with unavailable effort; ordered turns/tokens/tools/
prompt; point-only untimed turns; targeted neutral coverage note; and report
divergence only when detected.

Never render an invented active bar, `0s active` for absence, exact idle from a
bound, a global warning for missing effort, assistant text, or tool results as
human prompts.

### Step E.2: Add Compact Git Summary

Use an unframed compact block with Repository, Branch/Branches, Commit, and
Pull request(s). One branch renders directly. Multiple branches show first/
last plus compact disclosure. Commit is abbreviated with full hash in title.
PR uses `#number` when known. Missing URL renders text, not fake action.
Derived provenance and partial context use targeted neutral hints. Use existing
Lucide external-link icon. Long values truncate with title and no mobile or
desktop overflow.

### Step E.3: Add Explicit Resolution Action

Show only when useful repository/branch facts exist and a web/PR URL is
missing. If source authority remains private, the server may reject not-local;
do not expose authority merely to hide the button. Use a clear icon tooltip,
pending/retry/unavailable states, and never hover-trigger lookup.

### Step E.4: Accessibility and Render Tests

Cover keyboard links, descriptive aria labels, noopener, unsafe URL rejection,
stable pending layout, long/multiple values, all Claude timing states, Codex
with VCS, OpenCode without context, Cursor unsupported, and prompt sentinel
absent before detail load.

### Step E.5: Production Smoke

Use one Claude and one Codex fixture. Verify Codex repo/branch/commit, Claude
recorded PR and branch changes, Claude chronology with timed and untimed turns,
lazy prompt visibility, and injected fake provider resolver rather than real
GitHub.

**Verify**:

~~~sh
bun test apps/web/src/session-analysis.test.ts \
  apps/web/src/session-analysis.render.test.tsx \
  apps/web/src/session-vcs-summary.test.tsx \
  apps/web/src/session-surface-mode.test.ts
bun run --cwd apps/web test:e2e-production
bun --filter @ai-usage/web check
~~~

**Commit**: `Show Claude chronology and session VCS links`

## Work Package F: OpenCode and Conditional Cursor Audit

**Exclusive ownership**: OpenCode facts/history/collector, Cursor collector,
their tests, and matrix docs after evidence.

### Step F.1: Add OpenCode Repository Without Fake Branch

Resolve local repo from recorded session directory using existing safe Git
reader or shared pure helper. Add `local-derived` repository only. Never record
current checkout branch as historical. Do not alter existing token/timing
facts. Bump OpenCode cache version when row changes.

### Step F.2: Audit Cursor Mapping

Answer with fixture and structural evidence:

1. Can composer ID map deterministically to workspace/worktree?
2. Is that mapping recorded at session time rather than only current?
3. Can branch/commit be attributed without joining global attribution by
   proximity?

If all are proven, add only proven fields, keep partial context where needed,
add a real DB fixture, and bump cache. Otherwise record `REJECTED for Cursor in
plan 027` with missing fields, keep matrix unavailable, and do not block the
other harnesses.

### Step F.3: Avoid Unsupported Generalization

`cursor.commit-attribution` is branch-owned, not session-owned. Never join it
to sessions by branch name/timestamp without a separate reconciliation
contract and plan.

**Verify**:

~~~sh
bun test packages/local-collectors/src/opencode-session-facts.test.ts \
  packages/local-collectors/src/opencode-history.test.ts \
  packages/local-collectors/src/db-collectors.integration.test.ts \
  packages/local-collectors/src/db-collectors.test.ts
~~~

**Commit**: `Add proven VCS context to remaining harnesses`

This commit may contain OpenCode only when Cursor is rejected with evidence.

## Work Package G: System Proof, Documentation, and Closure

**Owner**: coordinator after A-F integration.

### Step G.1: Extend Multi-Harness Vertical Golden

In `session-report-pipeline.integration.test.ts`, prove Claude collection ->
store -> payload -> sessions.sqlite -> anchor; VCS without prompts; local detail
match; exact divergence after mutation; match after recollect; v3 snapshot
roundtrip preserving VCS but becoming portable-opaque; imported row rejecting
detail/provider resolution; Codex VCS surviving pipeline; OpenCode repository
when proven; and no `gh` result in row or snapshot.

### Step G.2: Budget and Confidentiality Tests

Use separate sentinels for private prompt, credential-bearing fake remote,
fake provider stderr, and dangerous URL. None may appear in snapshot, merge
bundle, initial payload, sessions.sqlite, collector cache, error response, or
initial HTML. Prompt may appear only in on-demand local detail.

### Step G.3: Update Documentation

`docs/session-analysis-sources.md`: Claude supported locally on demand,
timing matrix, effort absence, prompt-less turns, branches/recorded PRs,
explicit ephemeral provider resolver, updated sanitized audit.

`docs/architecture.md`: shared Claude parser, VCS on `UsageRowSource`, portable
v3, and provider resolver separated from collection/publication.

`docs/public-package-interfaces.md`: `session-vcs` export, Claude local reader,
and nullable timing contract.

`README.md`: Claude analyzable, source-dependent Git links, provider lookup on
demand only, portable VCS privacy implications, and no promise of complete
Claude active duration. Update CLI/export claims for version 3. Keep the full
harness matrix only in `session-analysis-sources.md`.

### Step G.4: Measure Performance

Without retaining content, measure Claude cache miss/hit, small/large detail
open, v2-equivalent vs v3 snapshot size, sessions.sqlite size, files read per
detail, and zero `gh` processes without explicit action.

Recommended budget: no more than 10% Claude cache-miss regression at equal
fixture unless justified; cache hit remains O(1) in record count; detail stays
within budgets; average VCS stays far below 64 KiB per row. Record and justify
larger regressions instead of weakening safety.

### Step G.5: Run Final Gates

~~~sh
bun install --frozen-lockfile
bun x ultracite fix
bun run check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-production
bun run test:e2e
bun run test:e2e-production
git diff --check 9545fb8...HEAD
git status --short
~~~

Before global fix, inspect worktree and preserve unrelated user changes. Use
targeted fixes when not isolated.

Expected: all commands exit 0; no lockfile change without approved dependency
(none planned); no real GitHub calls in tests; log includes commits, measures,
and Cursor decision; coordinator marks 027 DONE only after all criteria pass.

**Commit**: `Document multi-harness session insight guarantees`

## Consolidated Test Matrix

### Report Core

- all three timing states and invariants;
- projection comparison with asymmetric availability;
- remote parsing, forge URL builders, budgets;
- snapshot/merge v1/v2/v3;
- stable session identity with/without VCS.

### Local Collectors

- shared Claude report/detail facts;
- direct prompts vs tool/meta events;
- UUID graph, cycles, orphans;
- models/tokens/tools;
- all timing states;
- multiple branches and PR dedup;
- Codex Git meta and cache invalidation;
- OpenCode derived repository;
- conditional Cursor proof/rejection.

### Report Pipeline and Storage

- source -> store -> payload -> immutable SQLite;
- local authority vs portable opacity;
- VCS preserved without identity change;
- correct content hash/store update;
- prompts/provider results absent;
- v3 multi-machine roundtrip.

### Server

- exhaustive harness dispatch;
- every unavailable reason;
- no local read for invalid anchor;
- trusted provider boundary;
- timeout/output/invalid JSON handling;
- no raw stderr or implicit calls.

### UI

- all Claude timing states and point-only turns;
- correct neutral/warning tones;
- repository/branches/commit/PR;
- null vs clickable URLs;
- provider pending/success/error;
- responsive long values;
- keyboard/ARIA/noopener;
- prompt lazy-only.

### E2E

- one real Claude smoke;
- one Codex VCS smoke;
- explicit fake resolver;
- no exhaustive browser matrix;
- no pagination, revision, or j/k navigation regression.

## Done Criteria

- [ ] Claude is in `sessionDetailHarnessKeys` with exhaustive dispatch, reader,
      and tests.
- [ ] Claude report and detail share one owner for tokens, models, tools, turns,
      and deduplication.
- [ ] Active, idle, and turn duration explicitly support unavailable without
      zero sentinels.
- [ ] Recorded/partial/unavailable states are strictly validated.
- [ ] Untimed Claude sessions show span/events but no fake active/idle.
- [ ] Partial sessions show targeted bounds.
- [ ] Claude effort remains unavailable.
- [ ] Human prompts exclude tool-result, meta, and synthetic events.
- [ ] Orphan assistants remain counted without invented association.
- [ ] Claude golden demonstrates match -> differs -> match.
- [ ] `UsageRowSource.vcs` is bounded, strict, credential-free, and portable.
- [ ] Snapshot/merge write v3, migrate v1/v2, and reject v3 fields under old
      versions.
- [ ] `sessionRowIdentity` is identical with and without VCS.
- [ ] Content hash/store updates when collected VCS changes.
- [ ] Codex preserves recorded repository, branch, and commit.
- [ ] Claude preserves branch spans and recorded PRs.
- [ ] OpenCode never presents current checkout branch as historical.
- [ ] Cursor shows only proven fields or is rejected with evidence without
      blocking other harnesses.
- [ ] Drawer renders repo/branches/commit/PR without mobile/desktop overflow.
- [ ] Values without URL are not links.
- [ ] External URLs are safe, accessible, and noopener.
- [ ] Provider URLs are never resolved automatically.
- [ ] `gh` receives only server-trusted anchor facts and runs bounded without
      shell.
- [ ] Provider result remains ephemeral and absent from portable formats.
- [ ] Portable rows trigger neither local detail nor provider resolution.
- [ ] No prompt, fake credential, provider stderr, or dangerous URL leaks into
      store, initial payload, SQLite, cache, or export.
- [ ] Documentation states exact per-harness guarantees.
- [ ] Focused tests, check, lint, typecheck, build, and E2E pass.
- [ ] Log 027 contains commits, measures, deviations, and Cursor decision.
- [ ] Plan 027 is marked DONE in `plans/README.md`.

## STOP Conditions

STOP and report without improvising if:

- baseline files materially drifted from `9545fb8`;
- unrelated user changes would be overwritten;
- live Claude format no longer supports deterministic fixture association;
- Claude report/detail cannot share token or deduplication rules;
- Claude timing can only render by treating span as activity;
- browser must provide machine, source session, remote, repo, or branch;
- portable row can authorize local reads;
- Git context requires serializing credential-bearing remote;
- web URL requires guessing the forge behind an SSH alias;
- finding PR requires automatic network calls;
- resolver requires interpolated shell command;
- a new runtime package is required without approval;
- v3 cannot unambiguously migrate v1/v2;
- VCS changes `sessionRowIdentity`;
- Cursor needs undocumented proximity matching;
- golden computes expectations with production code under test;
- safety budgets must be removed for a large trace;
- a gate fails twice after a reasonable correction;
- an agent must edit files owned by an unintegrated package.

## Rollback and Compatibility

- Keep each package in an autonomous commit; never combine portable contract
  and UI in one commit.
- Timing changes preserve current Codex/OpenCode recorded behavior.
- v3 readers accept/migrate v1/v2. Writer rollback after emitting v3 is not
  guaranteed, so integrate readers before enabling v3 writers.
- Provider resolver can be removed without removing collected Git context.
- Rejected Cursor changes no Cursor rows.
- Missing Git context leaves row/drawer valid without deceptive placeholders.

## Future Harness Maintenance

Before adding any harness:

1. Audit key shapes and aggregates only, without private content.
2. Add a representative local-collectors-owned fixture.
3. Classify every metric as recorded, derived, partial, or unavailable.
4. Define human prompt vs tool result.
5. Define usage-bearing response identity/deduplication.
6. Produce `SessionProjectionFacts` from the same parse as report row.
7. Define timing semantics in `session-analysis-model.ts`.
8. Add exhaustive dispatch and a golden case.
9. Preserve VCS only when observation truly belongs to session.
10. Never join branch/commit/PR by proximity without a dedicated contract.
11. Bump every affected cache version.
12. Document limitations in the single harness matrix.

Gemini, Aider, Copilot, or another adapter must follow this list. A local
directory or JSONL alone does not establish support.

## Priority Review Points

Reviewers must focus on:

- Claude span vs active/idle distinction;
- nullable states without implicit zero;
- one Claude report/detail owner;
- graph association rather than proximity;
- no invented effort;
- stable row identity;
- portable v3 migration;
- credential stripping;
- no guessed URL for SSH alias;
- no implicit provider call;
- server-side resolver authority;
- no prompts/provider results in artifacts;
- honest Cursor decision.
