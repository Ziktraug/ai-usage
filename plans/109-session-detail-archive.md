# Plan 109: Archive Session Detail Safely for Cross-Machine Read-Only Continuity

> **Executor instructions**: This plan adds an opt-in normalized archive, not raw
> provider backup and not native session synchronization. Preserve the current
> distinction between portable report facts and local session detail. Authorization,
> sensitivity, retention, deletion, provenance, and size bounds must be settled
> before the first prompt or turn is uploaded.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- packages/local-machine packages/report-core packages/report-data packages/usage-store packages/replication packages/authorization packages/project-registry packages/memory packages/mcp-adapter apps/usage-engine apps/server apps/web apps/cli docs/architecture.md docs/adr`
> Re-read current Session detail authority rules and plans 103, 107, and 108 on
> any drift.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: CRITICAL — prompts, tool chronology, paths, and outputs may contain
  source code, personal data, credentials, or organization-confidential content
- **Depends on**: 103, 104, 107, 108
- **Category**: sensitive session archive and cross-machine read continuity
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

Replicated usage rows can show that a session happened, where it fits in a
Project, which harness/model ran, and how much work was recorded. They cannot
always explain what the agent did or support a useful handoff review after the
source machine is offline.

The current product correctly treats imported/remote source paths as opaque and
reads detailed chronology only from authorized local harness artifacts. That
security boundary must remain explicit. Cross-machine detail should be a new
archive authority produced by the source Device, not a server pretending a
remote session is local.

## Current state

### The existing boundary this plan deliberately crosses

`docs/session-analysis-sources.md:9-14` is today's rule:

> **report metrics** are normalized rows that may be persisted, included in
> report revisions, snapshots, merge bundles, JSON, and CSV;
> **local detail** is read from the source machine only after the user opens a
> supported session analysis. **It is not part of the report revision.**

Session detail has never left the machine that produced it. This plan is the
first to move it, which is why it is `Risk: CRITICAL` and opt-in. Class A/B/C
below maps onto that existing split: Class A is roughly today's report metrics,
Class B is today's local detail, Class C is the raw source that has never been
readable off-machine and stays that way.

### The detail machinery that exists

- `packages/local-machine/src/session-detail.ts`, exported as
  `./session-detail` (`packages/local-machine/package.json:24`).
- Per-harness: `claude-session-analysis.ts`, `codex-session-analysis.ts`,
  `opencode-session-analysis.ts`, plus `*-session-facts.ts`.
- `docs/session-analysis-sources.md` records per-harness truthfulness with the
  quality vocabulary (`:15-23`).

`tools/check-package-boundaries.ts:147` already treats
`@ai-usage/local-machine/session-detail` as a named subpath with restricted
importers. Extending who may import it is a **boundary change**, and it must be
a visible one — do not widen the policy to make an import convenient.

### Opaque paths are already a rule

`CONTEXT.md:96-99` (**Project source**): *"Locally observed paths may be
canonicalized and inspected; paths from snapshots or merge bundles are opaque
labels and never authorize local filesystem access."*

Enforced by `SourceAuthority` in
`packages/report-data/src/project-projection.ts:26` (see plan 103's Current
state for why that word does not mean permission). An archive retrieved from the
server is, by this rule, **opaque** on the retrieving device. State it in the
archive contract: a path in an archive never authorizes a filesystem read.

### Encryption context

The program has no key-management component and none of 100–108 introduces one.
If this plan requires envelope encryption with a KMS, that is a new
infrastructure dependency — treat it as a decision for the maintainer (Step 1),
not something to pick mid-implementation.

### Prerequisites

Plans 103, 104, 107, 108. This plan moves the most sensitive content in the
program; the boundary that protects it must be in place and conformance-tested.

## Authority model

Every Session detail request resolves to one of these authorities:

```text
local-observed
  parsed now from an authorized harness artifact on the source Device

archived-observed
  normalized, bounded detail captured by the source Device and stored under an
  explicit archive policy

portable-opaque
  metadata/facts exist, but no authorized detail source is available
```

The UI/API/MCP must expose authority, captured-at time, parser/archive version,
completeness, and limitations. Never silently fall back from local to archive or
from archive to a synthetic reconstruction without changing the label.

## Data classification

### Class A — portable session metadata

May replicate by default under plan 107 policy:

- stable Session fact/reference;
- Device/harness/Project/Repository IDs;
- timestamps/duration/model/token/tool counts;
- partial/ambiguous flags;
- branch/commit/PR references when already authorized;
- bounded title only under current privacy rules.

### Class B — normalized session detail

Opt-in archive payload owned by this plan:

- prompts or user-turn summaries according to policy;
- normalized turns/phases and timestamps;
- model transitions and effort metadata;
- tool names/categories and bounded status;
- token/timing detail;
- accepted Handoff-relevant chronology;
- coverage, truncation, parser warnings, and source authority.

### Class C — raw local artifacts

Never synchronized by default and not included in this plan:

- Claude/Codex JSONL/rollout files;
- OpenCode/Cursor SQLite databases;
- raw terminal/tool output;
- arbitrary source file contents;
- environment variables, credentials, MCP secrets;
- full uncommitted diffs/worktrees;
- provider authentication/session state.

## Archive policy

Archive is configured explicitly at Space and Project levels.

Conceptual policy:

```ts
interface SessionArchivePolicy {
  mode: "disabled" | "metadata-only" | "normalized-detail";
  includePrompts: "none" | "user-only" | "bounded";
  includeToolNames: boolean;
  includeToolOutputs: "none"; // fixed for v1
  retentionDays: number | null;
  sensitivity: Sensitivity;
  requireUserConfirmation: boolean;
}
```

Rules:

- default is `metadata-only` or disabled according to deployment choice;
- organization Projects require organization-authorized policy, not a Device
  owner toggle alone;
- policy change affects future captures; historical archives are deleted only
  through an explicit previewed operation;
- personal and organization policies remain separate on one Device;
- sensitive/high-risk Projects may forbid archive entirely;
- raw tool outputs remain `none` in v1.

## Normalized archive contract

Use a versioned contract derived from the existing bounded Session detail model
rather than serializing harness-native structures.

```ts
interface ArchivedSessionDetail {
  archiveVersion: number;
  parserVersion: string;
  sessionFactId: SessionFactId;
  deviceId: DeviceId;
  harnessKey: string;
  sourceSessionId: string | null;
  owningSpaceId: SpaceId;
  projectId: ProjectId;
  capturedAt: Instant;
  sourceObservedAt: Instant | null;
  authority: "archived-observed";
  completeness: "complete" | "partial";
  contentHash: string;
  sensitivity: Sensitivity;
  retentionPolicyId: string;
  detail: BoundedNormalizedSessionDetail;
  limitations: ArchivedDetailLimitation[];
}
```

Strict bounds should match or be tighter than current Session detail limits:

- maximum prompts/turns/phases/tools;
- maximum per-text and total decoded bytes;
- maximum timestamps/model segments;
- explicit truncation markers;
- decompression ratio/output bound;
- no unknown keys in accepted versions unless the compatibility policy says
  otherwise.

Do not archive a detail response that already exceeds local safety budgets by
streaming it unbounded to the server.

## Capture flow

```text
Local source session changes or reaches checkpoint
  ↓
usage-engine verifies Project/Space archive policy
  ↓
local Session detail resolver parses through current bounded authority
  ↓
redaction/classification pass
  ↓
archive preview/summary when confirmation is required
  ↓
content-addressed encrypted/compressed payload enters separate outbox
  ↓
server authenticates Device and authorizes archive_session_content
  ↓
transaction stores metadata + payload and indexes only permitted fields
  ↓
ACK records exact archive hash/version
```

Archive capture runs outside the local usage publication transaction. Failure to
archive never blocks local collection or metadata replication.

## Redaction and content minimization

Before persistence:

- remove environment variables and known credential structures;
- reject or redact private keys, access tokens, bearer headers, `.env` content,
  and configured secret patterns;
- normalize local paths according to policy and never make them filesystem
  authority on another Device;
- store tool name/category, not arbitrary output;
- bound prompt text and mark redaction/truncation;
- retain enough provenance to explain that content was redacted without storing
  the secret in diagnostics;
- allow Project-specific deny patterns and archive-disabled paths;
- no claim that heuristic redaction makes arbitrary transcripts safe.

If a secret scan triggers a high-confidence finding, default to blocking the
archive and showing a local actionable error rather than uploading a partially
understood payload.

## Encryption and storage

### In transit

- TLS required;
- Device authentication from plan 104;
- payload never in URL/query/logs;
- request and decompression limits before parsing.

### At rest

At minimum:

- PostgreSQL/database-volume encryption is documented;
- sensitive payload may be stored in a separate encrypted blob/object column or
  store with metadata in PostgreSQL;
- encryption keys are not stored alongside ciphertext in application tables;
- backup/restore includes key-management requirements;
- key rotation and deletion behavior are documented.

### Client-side encryption readiness

Design the envelope so a future deployment can encrypt detail on the Device and
store ciphertext server-side. Do not claim end-to-end encryption in v1 unless
key distribution, multi-user sharing, search limitations, rotation, recovery,
and revocation are implemented and tested.

Metadata needed for authorization and listing must remain separate from the
sensitive payload. Avoid a schema that requires decrypting every archive to
answer “which sessions have archived detail?”.

## Search and Memory interaction

Default Memory search must not index raw archived prompts.

Allowed initial uses:

- exact Session detail retrieval by authorized Session ID;
- Handoff creation/review from a selected archive;
- user-triggered proposal generation whose source is explicitly the archive;
- optional bounded local/server processing under a documented policy.

Forbidden initial behavior:

- automatically embedding every prompt;
- mixing archive text into normal Memory search;
- organization aggregate queries reading archive payloads;
- using archive content to infer productivity or intent silently.

If later search is added, it needs separate permission, sensitivity-aware index,
retention/deletion propagation, and an evaluation plan.

## Authorization

Permissions remain distinct:

```text
view_session_metadata
view_session_content
archive_session_content
manage_session_archive_policy
purge_session_archive
```

Rules:

- `view_session_content` is required to retrieve/decrypt normalized detail;
- aggregate auditor receives none of these content permissions;
- Project collaborator access follows plan 103’s model, with extra sensitivity
  condition where configured;
- Device may upload only for an authorized Capture Context/Project policy;
- source Device owner cannot archive organization content against organization
  policy;
- Handoff permission does not automatically expose the entire source archive;
- provenance references shown to a Handoff reader are bounded to permitted
  metadata.

## Retention and deletion

Store archive metadata and payload with explicit lifecycle:

```text
active
scheduled-for-deletion
purged
blocked/quarantined
```

Requirements:

- policy-based expiry job uses a narrow service principal;
- user/admin purge is previewed and audited;
- deletion removes ciphertext/blob, search derivatives, caches, and accessible
  snippets;
- a content-free tombstone may remain to explain provenance/deletion;
- metadata-only Session fact may remain according to separate retention policy;
- source Device can learn ACK/purge state without receiving another user’s
  content;
- backups and replicas have a documented deletion latency/limitation;
- legal hold is out of scope but schema/status must not silently ignore it later.

## Replacement and versioning

A source session may gain more complete detail later.

- archive identity is stable per Session fact;
- a new content hash/parser version creates an immutable archive revision or
  atomically replaces current with retained revision metadata according to
  policy;
- stale/duplicate upload returns idempotent ACK;
- reduced/redacted re-upload cannot accidentally resurrect purged content;
- parser/version upgrade does not reinterpret old payload silently;
- exact Handoff provenance can reference the archive revision it used.

## Cross-machine read UX

Session detail should show:

```text
Archived from <authorized Device label>
Captured <time>
Source last observed <time>
Authority: archived observation
Completeness: partial/complete
Redactions/truncations: summary
Parser/archive version
```

When unavailable:

- `portable-opaque`: explain that metadata exists but detail was not archived;
- expired/purged: explain content no longer exists without revealing why to an
  unauthorized user;
- source online but no local access: do not attempt a server-to-device call;
- unauthorized: use normal authorization behavior, not a content-existence leak.

The archive is read-only. “Continue” uses plan 108 Handoff, not mutation of the
archived session.

## Local-only and offline behavior

- local Session detail continues to parse local harness history as today;
- no archive policy/server is required for local use;
- queued archive survives network outage through a separate bounded outbox;
- local user can cancel pending archive before ACK where safely possible;
- server archive can be read from another Device while source is offline;
- connected Web labels stale/offline metadata honestly.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite: content types are separate | `grep -c "session_content" packages/authorization/src/model.ts` | ≥ 1 |
| Classification tests | `bun test packages/session-archive/src/classification.test.ts` | all pass |
| Redaction tests | `bun test packages/session-archive/src/redaction.test.ts` | all pass |
| Default-off proof | `bun test packages/session-archive/src/opt-in.test.ts` | all pass |
| No-Class-C proof | `bun test packages/session-archive/src/no-raw-artifacts.test.ts` | all pass |
| Deletion tests | `bun test packages/session-archive/src/retention.test.ts` | all pass |
| Authorization conformance | `bun test packages/authorization` | all scenarios pass |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/109-session-archive`, cut from plan 108's branch.
- Migration `0008_session_archive` — verify the current highest number first.
- Stage by explicit path. Never `git add -A`.
- Four commits:
  1. `feat(session-archive): add the normalized archive contract and classification`
  2. `feat(session-archive): add opt-in capture with redaction`
  3. `feat(server): add authorized archive retrieval and deletion`
  4. `feat(web): add cross-machine read-only session detail`
- **Do not push or open a PR.** This moves prompts off-machine for the first
  time; the maintainer reviews.

## Steps

### Step 1: Apply the dated encryption decision before building storage

The original plan left two questions open, and both change the schema:

1. **Encryption at rest beyond PostgreSQL's own** — envelope encryption with
   per-Space keys, or rely on disk/database encryption?
2. **Where keys live** — no KMS exists in this program.

**Dated resolution (2026-08-26): application-level envelope encryption of Class
B payloads with a per-Space data key, wrapped by a deployment key supplied
through typed config** (same parsing discipline as plan 101 and redaction
discipline as plan 104). Database/disk encryption remains defense in depth; it
does not replace the per-Space envelope.

Rationale: it makes per-Space deletion meaningful — destroying the Space's data
key renders its archives unrecoverable even in a leaked backup. That is a
property the retention section needs and that database-level encryption cannot
provide.

Cost, stated plainly: key rotation and backup/restore both become more complex,
and a lost deployment key means lost archives. Step 1 therefore first adds a
synthetic backup/restore/rotation proof. Reconsider database-only encryption only
if that measured proof cannot meet the recovery SLO documented in plan 101; stop
and amend ADR 0038 rather than switching mid-implementation.

### Step 2: Make Class C unreachable, not merely undocumented

The strongest guarantee in this plan is that raw harness files never leave the
machine. Enforce it in the type system and in the boundary checker:

1. The capture function accepts only a `NormalizedSessionArchive` — a validated
   structure built from the per-harness analyzers. It has **no** field that can
   hold a file path's contents, a raw JSONL line, or a byte buffer.
2. `no-raw-artifacts.test.ts`: run capture against fixtures for all four
   harnesses; serialize the result; assert it contains no substring from the raw
   fixture files beyond what the contract explicitly permits (normalized turn
   text under policy). Assert on the raw *bytes* of the fixture, not on a
   summary.
3. Boundary policy: `@ai-usage/session-archive` may not depend on
   `@ai-usage/local-collectors`. Capture consumes already-normalized analysis
   output, never a collector's raw read.

`classification.test.ts` asserts every field in the contract carries an explicit
`A` | `B` classification, and that no field is unclassified — an unclassified
field is the route by which Class C content arrives.

**Verify**: `bun test packages/session-archive/src/no-raw-artifacts.test.ts`
and `classification.test.ts` → all pass.

### Step 3: Opt-in that is genuinely off by default

`archive_policies (space_id, project_id NULL, enabled boolean NOT NULL DEFAULT
false, prompt_policy text NOT NULL DEFAULT 'exclude', updated_by, updated_at)`.

`opt-in.test.ts`:
- a Space with no policy row → capture produces nothing. Assert on the archive
  table being empty, not on a returned flag;
- enabling at Space level does **not** retroactively archive existing sessions —
  a retroactive sweep would archive content captured under the old policy;
- a project policy may be stricter than its Space, never broader. Assert the
  broader case is rejected;
- disabling stops new capture and leaves existing archives, with the existing
  ones separately deletable (Step 6);
- `prompt_policy: 'exclude'` is the default even when `enabled` is true.
  Enabling the archive and enabling prompt capture are two decisions.

**Verify**: `bun test packages/session-archive/src/opt-in.test.ts` → all pass.

### Step 4: Redaction at capture, on the source device

Redaction runs **before** the payload leaves the machine. A server-side redactor
would mean the unredacted content already crossed the boundary.

- Reuse the redaction rules inventoried in plan 105 Step 0 where they apply;
  do not write a second rule set with different behavior.
- Record the applied rule-set version per archive so a later rule change is
  auditable and re-redaction is scopeable.
- `redaction.test.ts` with fixtures containing plausible secrets: an API key
  shape, a `.env` line, an `Authorization:` header, a connection string with a
  password, a private key header. Assert none survives.
- Redaction failure **blocks** capture. It never publishes partially-redacted
  content and never silently skips. Assert the typed error and that nothing was
  written.

**Verify**: `bun test packages/session-archive/src/redaction.test.ts` → all pass.

### Step 5: Storage and retrieval

Archives are a distinct resource type in plan 103's model
(`session_content`), authorized separately from session metadata. The
aggregate/content split from plan 103 Step 1 means an aggregate auditor cannot
reach this table by any declared path — verify by walking the model, the same
assertion plan 103's `model.test.ts` makes.

Retrieval is read-only across machines. A path inside an archive is **opaque**
on the retrieving device (`CONTEXT.md:96-99`); assert that the read UI never
turns an archived path into a local filesystem read.

**Verify**: `bun test apps/server/src/archive-retrieval.test.ts` — an
aggregate-only principal is denied; a project collaborator with content
permission succeeds; a metadata-only principal sees metadata and is denied
content.

### Step 6: Retention and deletion that actually deletes

- Per-Space and per-Project retention; default **no automatic deletion**.
- Deleting an archive removes the payload. Assert by querying the table
  directly after deletion, not by calling the reader.
- With envelope encryption (Step 1), destroying a Space's data key is the
  documented bulk path; test that archives are unreadable afterwards.
- Session **metadata** survives archive deletion — deleting detail must not
  delete the report row. This is the assertion most likely to be missed, and it
  breaks reports.
- Deletion is recorded in the audit trail with actor and time.

**Verify**: `bun test packages/session-archive/src/retention.test.ts` → all
pass, including metadata survival.

### Step 7: Cross-machine read UX and local-only behavior

- The read surface labels provenance and freshness (ADR 0016/0017): which
  device produced it, when, under which policy, and which parser limitations
  applied (`docs/session-analysis-sources.md` quality vocabulary).
- Local-only mode is unchanged: opening a local session analysis still reads
  from the local machine. Assert no archive lookup occurs in local mode.
- Never present an archived session as if it were live local detail. They have
  different truthfulness, and the quality vocabulary is how that is shown.

**Verify**: `bun run test:e2e -- e2e/<new-spec>.spec.ts` → passes, axe clean.
Local-mode e2e still passes with no server.

### Step 8: Documentation

- `packages/session-archive/README.md` — the A/B/C classification, the
  opt-in model, redaction, the encryption decision from Step 1, and deletion
  semantics.
- `docs/session-analysis-sources.md` — a new section recording that Class B may
  now be archived under explicit policy, and that Class C never leaves the
  machine. Update the `:9-14` boundary statement rather than contradicting it.
- ADR 0038 `per-space-envelope-encryption-for-session-archives`, extending ADR
  0033's opt-in archive boundary with the selected key/deletion model.
- `CONTEXT.md` — **Session archive** with `_Avoid_`: "backup", "transcript",
  "raw history".
- `plans/README.md:66` row → `DONE`.

## Testing requirements

### Classification/contract

- every Class A/B/C field category;
- unknown keys/version rejection;
- text/turn/prompt/tool/byte/decompression bounds;
- truncation and completeness;
- local path handling;
- raw tool output never serialized;
- synthetic secret blocks/redacts without log leakage.

### Policy/authorization

- default metadata-only/no detail;
- personal opt-in;
- organization policy required;
- one Device with personal and organization Projects;
- viewer metadata-only versus content permission;
- aggregate auditor denied;
- sensitive extra condition;
- revoked Device upload denied;
- policy change and historical behavior.

### Lifecycle

- capture outside collection transaction;
- network failure leaves local product healthy;
- duplicate/idempotent upload;
- more-complete revision;
- purge and retention expiry;
- deletion propagation to derivatives/cache;
- backup/key limitation documented/tested where practical;
- content-free audit events.

### End-to-end

- Device A archives a synthetic session and goes offline;
- Device B authorized user opens archived detail;
- authority/completeness/captured-at are visible;
- Handoff can reference exact archive revision;
- unauthorized user and aggregate auditor cannot infer content/title/snippet;
- raw harness fixture file never appears in server store/outbox;
- metadata-only sessions remain useful without archive.

## Done criteria

- [ ] Local, archived, and opaque authority states are explicit in contracts and
      UI.
- [ ] Metadata replication remains default; normalized detail is opt-in by
      Project/Space policy.
- [ ] Archive contract is normalized, versioned, bounded, and excludes raw
      harness artifacts/tool outputs.
- [ ] Capture/redaction runs locally and failure never blocks usage collection.
- [ ] Device auth and content-specific authorization protect upload/read/purge.
- [ ] Aggregate-only roles cannot access or infer archive content.
- [ ] At-rest/key-management and future client-side envelope boundaries are
      documented honestly.
- [ ] Retention, purge, revision, and derivative deletion are tested.
- [ ] Cross-machine read works while the source Device is offline and labels
      authority/completeness.
- [ ] Handoff references archives without treating them as resumable native
      sessions.
- [ ] Raw JSONL/SQLite/provider credentials are absent from normal archives.

## STOP conditions

Stop and report when:

- implementation proposes uploading raw harness history/database by default;
- prompt/tool output is archived before policy, authorization, redaction, and
  retention are implemented;
- archive upload runs inside or can roll back local collection;
- organization content can be opted in by Device owner alone;
- aggregate queries require decrypting/reading session detail;
- archived content is indexed into normal Memory search automatically;
- the server can call back into the source Device to fetch missing detail;
- authorization is applied only after payload decryption/snippet creation;
- encryption is marketed as end-to-end without client key-sharing/recovery
  design;
- purge leaves embeddings/snippets/caches accessible;
- archive is presented as a native resumable session.

## Out of scope

- raw provider backup/disaster recovery;
- tool-output/file-content archive;
- uncommitted worktree synchronization;
- semantic search over all prompts;
- native session import/resume (plan 110);
- remote source-machine fetch;
- legal hold/eDiscovery;
- cross-region encrypted object-store architecture.
