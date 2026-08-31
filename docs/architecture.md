# Architecture

`ai-usage` reports usage from local coding-tool history. Provider quota sources
are the narrow provider-facing exception: the usage engine may invoke the
installed Codex CLI's supported local app-server interface or the experimental
Claude Agent SDK. Those provider clients own communication and authentication.
`ai-usage` does not read provider credentials, call private provider HTTP
endpoints, or persist raw provider payloads.

The current usage-report runtime keeps a strict split between two planes:

- the durable usage SQLite database is the existing **data plane**;
- authenticated numeric-loopback HTTP is the **control plane**.

`apps/usage-engine` is the only production composition root that may open the
usage database read-write. Web and CLI query durable revision-keyed projections
through read-only, query-only SQLite connections. The control plane carries
commands, status, and bounded SSE events only; it is not a report data API.
The accepted platform topology adds separate Memory and shared authorities; it
does not broaden either of these usage-runtime planes.

## Platform decision and delivery status

ADRs 0023–0036 and plan 100 record accepted architecture. Acceptance settles
the target boundaries; it does not make their runtime implementation available.
On `main` after this documentation lands:

- plan 100 is `DONE` because it is the documentation-only architecture plan;
- plans 101–106 are `IN PROGRESS`: implementation exists outside `main` and is
  pending integration;
- plan 107 is `IN PROGRESS`: partial implementation is pending integration and
  remaining done criteria are still open;
- plans 108–110 remain `TODO`.

The platform-specific topology, package, command, route, and measurement
sections below are therefore accepted target specifications until their plan
row reaches `DONE`. The existing usage-report data flow and ownership sections
continue to describe current runtime behavior.

## Data flow

1. `@ai-usage/local-collectors` reads supported harness inputs through the
   hardened neutral primitives in `@ai-usage/local-machine` and produces
   normalized contributions. Collector-private caches may be used only inside
   the production engine process (and isolated collector tests).
2. `apps/usage-engine` composes one scoped `UsageEngineRuntime`. It acquires a
   writer lock keyed to the canonical database path, opens the writer, applies
   migrations, recovers incomplete work, and owns collection, enrichment,
   checkpoints, scheduling, mutations, publication, retention, and shutdown.
3. A successful publication writes a complete immutable served revision into
   SQLite and atomically advances the current-revision pointer. An exact reader
   of revision A never observes rows from a later revision B.
4. `@ai-usage/report-data` assembles stored reports and executes bounded focused,
   Session, and quota projections using `@ai-usage/usage-store/reader`. It also
   provides pure portable snapshot assembly. It neither collects nor writes.
5. Web and CLI open the existing database read-only and query either the current
   compatible revision or an explicitly named retained revision. They do not
   copy databases, create revision files, acquire query leases, or spawn Bun
   subprocesses per query.
6. Fresh or mutating requests go to the usage engine. Web uses the authenticated
   control client. CLI uses a compatible running daemon when present, otherwise
   launches one bounded `once` engine process and waits for its committed
   result. There is no legacy one-shot writer fallback.

Codex quota history belongs to `codex.usage-limits`. App-server collection and
rollout backfill emit provider-neutral observations that the engine imports
transactionally. One Effect-native single flight owns query, collection,
import/checkpoint, attempt recording, and final projection in the scheduler
fiber. Joiners wait without owning cancellation; owner interruption aborts the
provider child before another durable phase begins. Quota history is not part
of `UsageReportPayload`, served report revisions, snapshots, or merge bundles.

## Accepted platform topology

Plans 100–110 extend the same monorepo and product with explicit local and
connected compositions. These are accepted ownership boundaries; packages and
runtime behavior land only through their dependent implementation plans.

### Local/offline composition

```text
apps/usage-engine
  existing usage-domain sole writer
  owns the usage SQLite write connection
  will compose the local identity/Memory writer by default
  owns durable publication/outbox scheduling

dedicated Memory SQLite store
  Agent Memory observations/proposals/items/revisions
  Work Threads and Work handoffs
  local FTS5 index
  Memory/WorkHandoff replication outbox

apps/web / apps/cli / local MCP
  call local application services
  never open independent write-capable Memory SQLite connections
```

The Memory store is not part of the usage SQLite data plane. The accepted target
assigns it the local identity kernel, Project-resolution state, DB-native Agent
Memory, its derived FTS5 search projection, and the Memory replication outbox.
Work handoffs remain a dependent plan. One local process owns every
write-capable connection to it;
the existing supervised usage-engine process is the composition root because it
already has explicit lifetime and sole-writer ownership. A separate Memory
process requires a new lifecycle decision covering its lock, startup, shutdown,
recovery, authentication, and IPC behavior.

The usage-engine control plane remains limited to usage commands, status, and
bounded events. Memory data and mutations do not cross under that name. If a
local application-service boundary needs IPC, it receives a separately named,
authenticated, bounded Memory service seam.

### Connected/shared composition

```text
Device ── outbound HTTPS ── apps/server
                                authenticated external endpoints
                                application-service composition root
                                sole PostgreSQL write composition root
                                  ├─ identity and authorization
                                  ├─ shared Memory and search
                                  ├─ replication projections
                                  ├─ shared Work handoffs
                                  └─ opt-in session archives

apps/web (connected mode)
  reuses the product and contract-first browser boundary
  never imports PostgreSQL or authorization adapters in browser code
```

`apps/server` will also own the GitHub-only shared-authentication HTTP boundary,
domain Web-session projection, and Device enrollment/lifecycle routes.
`@ai-usage/identity` wraps Better Auth and the Device application services;
`@ai-usage/postgres-store` keeps library/database rows private. A login resolves
to a Person but never bypasses the application `Authorizer`.

The shared server never reads machine-local harness files. PostgreSQL is
authoritative for connected product state and explicitly published/shared
resources, not for unpublished local Memory or native harness history. Devices
initiate every connection; the connected composition adds no inbound Device
listener or LAN discovery.

### Target mode guarantees

The accepted local composition must provide Usage, Skills, a stable local
Person/personal Space/Device, Project resolution, DB-native Agent Memory, FTS5
search, the `/projects` and `/memory` workflows, CLI search, and read-only MCP
without an account, login, external network, shared server, or PostgreSQL. Work
handoffs remain a later plan. Tests inject a platform connection adapter that
throws if called and assert zero calls while local operations pass.

Connected mode adds personal and organization Spaces, authorized cross-device
search, shared Work handoffs, replication, and opt-in normalized session
archives. It never silently demotes local SQLite into a cache of PostgreSQL.
The same domain and application-service contracts sit above local SQLite and
shared PostgreSQL adapters.

## Platform data ownership

Every logical resource has one mutation authority at a time. Replication is an
explicit publication transition: a local outbox owns an unacknowledged event;
after durable apply, PostgreSQL owns the shared projection and receipt without
becoming authority over the source harness file.

| Concern | Target mutation authority | Target local role | Target connected role |
| --- | --- | --- | --- |
| Harness raw history | Native harness | Read locally | Never published by default |
| Usage checkpoints and report revisions | `apps/usage-engine` + usage SQLite | Authoritative | Published projection only |
| Local Agent Memory | Memory application service + Memory SQLite | Authoritative | Published by policy |
| Shared Agent Memory | Memory application service + PostgreSQL | Import/export only | Authoritative |
| Local Work Thread and Work handoff | Work application service + Memory SQLite | Authoritative | Published by policy |
| Shared Work Thread and Work handoff | Work application service + PostgreSQL | Replicated projection | Authoritative |
| Local Memory search | SQLite FTS5 projection | Available | Not queried remotely |
| Shared Memory search | PostgreSQL FTS + `pg_trgm` projection | No direct database access | Available through services |
| Replication event | Owning SQLite outbox until ACK; PostgreSQL receipt after apply | Durable outbound state | Durable receipt/projection |
| Space, Person, organization membership | Identity application service + PostgreSQL in connected mode | Single-user identity kernel | Authoritative |
| Device credential | Private local secret + server verifier metadata | Plaintext secret only | Verifier and lifecycle metadata |
| SCM account | Person-scoped identity service + PostgreSQL | Optional metadata | Authoritative |
| SCM installation | Space-scoped identity service + PostgreSQL | No local ownership inference | Authoritative |
| SCM credential | Identity service encrypted secret/reference | Never inferred | Attached to account or installation |
| Session archive metadata and ciphertext | Archive application service + PostgreSQL | Queued publication only | Opt-in authority |
| Skills source and projections | Existing Skills filesystem domain | Authoritative | Future policy only |

Markdown and JSONL are accepted as Agent Memory import, export, and projection
formats. The target import is an explicit bounded preview/confirm workflow with
a proof bound to the source and destination Memory state. Portable export must
be deterministic, omit principal IDs and raw source locators, and never be
watched for implicit write-back. List/export reads must consume a complete
authorization scope before content queries.
The NixOS Agent Memory remains the migration source and temporary compatibility
implementation until application-service parity is demonstrated; it is never a
second mutation authority.

## Application services and trusted capabilities

Web/oRPC, CLI, MCP, and jobs are edge adapters over explicit application
services and ports. Route handlers and MCP tools neither implement permission
logic nor instantiate write repositories. SQLite and PostgreSQL adapters share
runtime-validated domain commands/results while their inferred storage rows
remain private. Search and MCP contracts, measurements, registration, and
retrieved-content rules are documented in
[Memory search and MCP](memory-search-and-mcp.md).

The accepted capability IDs are `usage`, `sources`, `skills`, `replication`,
`memory`, `work-handoff`, and `organization-governance`. Trusted capability
modules may contribute routes, jobs, MCP tools, navigation, and permission
requirements through normal composition. They share one reviewed migration
sequence, run no arbitrary third-party code, and expose no public plugin SDK.
A generic registry is introduced only when at least two real consumers would
otherwise duplicate composition logic.

A disabled capability has no navigation, public route, tool, or job execution,
and commands return a typed capability-disabled result. Disabling never skips
migrations or erases historical tables. Every real package remains subject to
the TypeScript project registry, package-boundary checks, and declared public
exports; speculative empty packages are not architecture.

## Runtime and process ownership

### Usage engine

`apps/usage-engine` has three internal modes:

- `serve`: persistent scheduler plus the authenticated control listener;
- `once <command-request-json>`: the same runtime and writer lock for one bounded
  CLI action;
- `check`: path, lock, rendezvous, and schema compatibility diagnostics without
  collection.

The writer lock is keyed to the canonical durable database path, not the state
directory. Two engines targeting one database therefore contend even if their
rendezvous directories differ. Lock and rendezvous recovery validate identity,
ownership, file type, link count, PID liveness, and process start time and fail
closed when evidence is suspicious.

The engine owns all usage-domain mutations, including source policies, machine
identity/label, project groups, Cursor imports, merge preview/confirmation,
collection, enrichment, and publication. The unrelated Skills control plane
remains web-owned and may update only the `skills` field through a field-scoped
config store that preserves unrelated configuration.

Under the accepted local platform composition, after the usage writer starts,
the engine will also open the separate owner-only
`memory.sqlite` identity kernel and start its independently authenticated
Memory service. The service carries bounded Project review, Memory review,
exact-item, Project-context, and search operations; it is not the usage control
plane. The engine closes the Memory service before the identity kernel and the
usage runtime. Only this post-writer-lease startup path replaces a stale Memory
rendezvous left by a crashed engine; the generic publisher preserves existing
files. This composition does not make identity data part of the usage database
or broaden the usage control-plane protocol.

When plan 107 is integrated and `AI_USAGE_PLATFORM_BASE_URL` is explicitly
present, the same composition will also start an independent outbound
replication supervisor after local startup.
It binds the offline identity kernel to the authenticated shared Device/Person/
Space snapshot, recovers and scans each owning outbox through bounded writer
ports, then performs HTTPS only after the SQLite transactions close. Missing
credentials and platform failures never degrade local engine readiness. On
shutdown, the outbound request is aborted and the supervisor closes before the
Memory service, Memory kernel, and usage writer. The exact protocol, retry,
privacy, and PostgreSQL apply contracts live in
[Device replication](device-replication.md).

### Control plane

The engine binds only to a numeric loopback address and publishes an owner-only
rendezvous file containing protocol identity, target identity, port, and bearer
token. Clients validate protocol/target binding while loading the rendezvous
before connecting. The HTTP server validates loopback peer/host, method, media
type, protocol header, authentication, body budget, runtime schema, deadline,
and abort propagation on every request.

The surface contains only:

- command admission/identity responses;
- current engine/source status;
- bounded sanitized SSE status, publication, and terminal command-completion
  events. Foreground `once` emits one separately bounded completion record.

It never returns report rows, focused results, Session pages, quota history,
SQLite bytes, or arbitrary files. Bounded web uploads use an owner-only,
no-follow inbox file plus an opaque server-generated handoff ID; the engine
revalidates identity, containment, ownership, and size before consuming it.

### Read path

`@ai-usage/usage-store/reader` opens only an existing compatible database with
SQLite read-only and `query_only` enabled, a finite busy timeout, and no create,
migration, journal-mode, checkpoint, or retention side effect. Typed failures
distinguish missing, old/new schema, unavailable/expired revision, busy, and
corrupt data.

Served report support, Overview, Breakdown, Sessions, campaign children,
neighbors, and detail anchors are bounded direct queries against revision-keyed
durable projections. Quota history is a separate bounded direct read of durable
provider-quota observations and does not name a served revision. Skill
observations are a second such read (see below). SSR reads the current manifest
and bounded support bootstrap in one transaction; destination queries after
hydration name that same revision. The browser owns destination fingerprinting,
supersession, atomic commit, and one expiry retry.

#### Skill observations

Skill observations are an auxiliary fact family with their own tables, their own
collector pass, and a read path that never touches the report bootstrap
(ADR 0022). One observation records that a named skill was invoked, or offered,
in one session of one harness, and carries an **observation tier** —
`declared`, `inferred`, or `exposed` — that is part of the fact rather than a
qualifier on it.

The read path is:

`skill_observations` + `skill_observation_collection_state` (durable rows plus
producer completeness, written together even for an empty observation batch)
→ `querySkillObservations` (`@ai-usage/usage-store/reader`, bounded, `query_only`,
reading the invocation tiers against the full budget before spending the
remainder on exposure, reporting the two bounds separately, and deriving
`producerProofValidUntil` from the producer cutoff rather than completion time)
→ `querySkillObservationDataset` (`@ai-usage/report-data/skill-observation-read`,
which classifies rows the presentation edge cannot render by their known tier,
folds producer/read/refusal facts through
`@ai-usage/report-core/skill-observation-evidence`, then folds and clamps to the
caps it is given, reporting count loss as `lowerBound` and invocation or
unknown-tier loss as `invocationLowerBound`)
→ `UsageReadModel.readSkillObservations`
(`apps/web/src/server/usage-read-model.server.ts`, which supplies those caps,
stated as the contract's own numbers)
→ `joinSkillObservations` (`apps/web/src/server/skill-observation-join.ts`,
which adds the inventory side and then clamps the *assembled response* to the
contract's caps, again reporting any clamp as `lowerBound` — the upstream clamp
cannot bound a payload the join grows — while preserving the proof deadline)
→ the `skills.observations` oRPC procedure
→ the `skill-observations` query family under the `collection-swr` policy.

These properties are load-bearing:

- **The tiers get separate read budgets, and separate bounds.** Exposure is
  written once per catalogue entry per session and outnumbers real invocations
  by roughly 50:1, so a pooled recency-ordered budget returns catalogue rows and
  nothing else. `lowerBound` says some count is a floor; `invocationLowerBound`
  says the `declared`/`inferred` evidence was itself cut short, and only that
  one makes an absence verdict provisional (ADR 0022).

- **One pure evidence policy decides what each loss can weaken.** Producer
  incompleteness, bounded reads, categorized refused rows, and later response
  clamps enter `skill-observation-evidence`; callers consume its claim-ready
  result instead of reconstructing the Boolean protocol. A known `exposed`
  loss weakens counts only. A `declared`, `inferred`, or unknown-tier loss also
  weakens invocation absence. The durable facts remain in SQLite and the final
  inventory join remains Web-owned.

- **Producer bounds are data-plane facts, not transient warnings.** Extractor
  rejection/truncation is persisted per machine and harness, split between
  invocation and exposure. A completeness-only change advances the store
  generation; a complete later rescan can clear it. This prevents an empty,
  truncated sweep from turning into an exact "never invoked" verdict after the
  source-control warning disappears or the process restarts.

- **Global completeness requires every observable producer to answer recently.**
  The Web composition always supplies Claude, Codex, and OpenCode for the
  current machine. Persisted source policy can mark one of those expected
  producers incomplete, but never remove it from the proof roster; disabling
  collection is not evidence of absence. The store accepts a producer answer
  only while its persisted `collected_at` is within the four-minute server-read
  window; the browser cache owns the final minute of the five-minute end-to-end
  proof budget. The store publishes that deadline as
  `producerProofValidUntil`; folds and inventory scans cannot renew it. Missing,
  stale, disabled, malformed, rejected, truncated, or state-read-overflow
  answers make absence provisional. A harness-filtered read intersects the
  roster with that harness, and Cursor remains `not-observable`, so it requires
  no producer state (ADR 0037).

- **Invocation history is durable; exposure is windowed.** The scarce
  `declared` and `inferred` facts survive age-based recovery and rescans. Only
  the high-volume `exposed` catalogue stream is pruned at 400 days, and only
  exposure receives the matching import cutoff, so a sweep cannot resurrect
  expired catalogue rows (ADR 0037).

- **A completed publication *cycle* or a Skills inventory mutation invalidates
  it — not only a new report revision.** The query policy also revalidates every
  minute and on window focus, because the producer proof can expire even
  when a stopped or disabled collector emits no invalidation. Mount always
  refetches so recreating a TanStack observer cannot restart the interval beyond
  the proof's remaining lifetime. Independently, its data-aware stale time is
  capped at one minute and ends at `producerProofValidUntil`; stale or in-flight
  retained data is fail-closed rather than presented as settled exact evidence.
  The fast freshness signal is keyed on the cycle
  (`publishedGeneration` and `lastPublishedAt` in the source-control snapshot),
  not on the revision, because a cycle that leaves the report rows identical
  renews the current revision instead of publishing a new one — and an
  observation-only sweep is exactly that shape. See `publicationIdentity` in the
  source-control service and `publicationInvalidatedKeys` (ADR 0037).
- **It is independent of the report revision.** Observations answer a question
  about the skills inventory, not about a published report, so `/skills` stays
  answerable before the first publication and after every revision expires.
- **Counts never leave their tier or their harness.** The dataset's smallest
  unit is one count plus the tier and harness that produced it. There is no
  per-skill or per-harness total to sum `declared` into `inferred`.
- **Harness coverage is enumerated, not inferred.** Every harness appears with
  an observability marker derived from the harness itself. Cursor has no
  collector and renders as *not observable*, never as `0`.

The inventory↔observation join happens entirely in the web server layer —
`apps/web/src/server/skills.server.ts` reads both sides and
`skill-observation-join.ts` decides every verdict — never inside
`@ai-usage/skills`, which stays a filesystem-projection domain with no
usage-store dependency, and never in the browser, which receives one
already-decided answer and imports only the contract (ADR 0010/0012). A store this read
cannot open fails the observation section explicitly rather than degrading to an
empty dataset, because an empty dataset would draw every observable harness as a
zero.

Engine availability and stored-data availability are independent. If the
engine stops after a compatible revision is committed, Web and `--stored` CLI
reads continue; fresh and usage-domain mutating actions are disabled or fail
explicitly. Web-owned Skills reads/mutations remain independent. A live
protocol/target mismatch fails closed and is never raced by a foreground writer.

### Supervision and build outputs

`bun run dev` supervises persistent engine and web tasks. UI HMR does not
restart the engine or trigger collection, publication, migration, or
checkpointing. `bun run start` supervises the production engine and built web
server, forwards signals, reports the first child failure, and reaps both
process trees. `bun run start:web-only` is an explicit diagnostic mode that
reads an existing store and never starts an engine.

SvelteKit check, development, and production phases use separate
`.svelte-kit/{check,dev,build}` trees. The Bun adapter writes the production
server to `.output-build/sveltekit`. A narrow production-build lock prevents
concurrent builders; production cleanup never targets active development
output.

Demo runs web alone with committed synthetic data. Its import boundary rejects
production store readers, control clients, engine modules, local history, and
mutations.

### SQLite backup and recovery

Do not copy only the main database file while the engine may have an active WAL.
The supported operator path is to stop the engine cleanly before copying the
database. A separately reviewed SQLite online-backup procedure may also produce
a coherent backup, but ai-usage currently exposes no online-backup command. Web
and CLI must never migrate, checkpoint, retain, repair, or back up the live
database through a write-capable connection.

The database backup does not include machine/config files; back those up
separately when desired. Writer locks, rendezvous, inbox files, logs, and other
engine runtime state are not backup payload.

SQLite recovery/retention removes abandoned incomplete served revisions inside
the database. Separately, startup filesystem scavenging removes only verified
ai-usage-owned legacy temporary artifacts under the expected temporary root. It
checks exact prefixes, UID, regular-file/directory identity, symlinks, age, and
live owners; suspicious entries are preserved and reported with counts and byte
totals only.

## Package ownership

### `@ai-usage/effect-runtime`

Owns domain-free schema-v2 wide-event contracts, boundary/hop measurement,
sanitize-on-emit, capture/no-op sinks, and Node console/NDJSON delivery with
private permissions, bounded locking, rotation, retention, and diagnostics. It
imports no other `@ai-usage/*` package.

Application adapters own boundary names, annotation allowlists, tagged-error
policies, process-resource configuration, and semantic terminal projectors.
Historical schema-v1 files remain valid append-only records and are not
rewritten to add schema-v2 resource fields.

Source, enrichment, publication, migration, retention, and engine-command
boundaries use surface `engine`; Web keeps HTTP/SSR/direct-read boundaries on
`web`; CLI keeps command/render events file-only. Event state is scoped per real
execution even when bounded workers are long-lived.

### `@ai-usage/report-core`

Owns pure domain data and deterministic calculations: usage rows, provenance,
pricing, analytics, project grouping, report/query contracts, provider status
and quota contracts, session detail/VCS contracts, portable snapshots, merge
bundles, and serialization. It reads no filesystem, SQLite database, browser
global, or app runtime state.

The platform-specific package sections from `@ai-usage/platform-core` through
`@ai-usage/mcp-adapter` are accepted target ownership. Those packages and
exports are pending integration and are not present on `main` yet.

### `@ai-usage/platform-core`

Owns canonical branded UUID identity types, canonical instants, bounded identity
text, and the shared Space, Person, Device, SCM, Repository, Project, Checkout,
and Capture Context contracts. It is pure and exports no storage or transport
implementation.

### `@ai-usage/authorization-contract`

Owns the portable tri-state `Authorizer` port, resource/permission values, and
complete opaque authorized-resource-scope contract. This small package lets
application contracts remain independent from authorization implementations
without duplicating or structurally weakening the port.

### `@ai-usage/authorization`

Re-exports the portable contract and owns the bounded `SingleUserAuthorizer`,
opaque-scope construction/adapter binding, and the adapter-independent
organization conformance model. The local adapter allows only the bootstrapped
Person over compatible resources in the personal Space; it is not an allow-all
substitute for organization authorization. The package owns no PostgreSQL
client, transport, or browser integration.

### `@ai-usage/identity`

Owns the GitHub-only shared-authentication wrapper, explicit identity-linking
policy, Web-session domain projection, redacted public-ID/HMAC Device tokens,
Device enrollment/lifecycle application service, and the Node-only private
local credential-file adapter. Better Auth `1.7.2` and its session/account rows
remain behind adapter-private subpaths. The package imports domain contracts
and `Authorizer`, but no PostgreSQL/SQLite adapter or HTTP router.

Local composition does not instantiate shared authentication. Connected
composition supplies PostgreSQL identity/Device ports and still calls
`Authorizer` for every Space/Device operation. Login, SCM account/installation,
provider credential, Device, and Device credential remain distinct.

### `@ai-usage/project-application`

Owns the authorization-aware Project-listing application service and its
persistence catalog port. The service requests a complete `view_project`
scope, passes it opaquely to the catalog, and never post-filters an unrestricted
Project result. It imports only authorization and platform identity contracts.

### `@ai-usage/project-registry`

Owns pure repository normalization/resolution outcomes, the additive
Project-source mapping contract, and privacy-safe Checkout review/action
contracts. It never opens a database or chooses between ambiguous candidates.

### `@ai-usage/memory-sqlite`

Owns the dedicated local identity kernel in `memory.sqlite`, including atomic
single-user bootstrap, strict SQLite schema, Project/Repository/Checkout
persistence, identity events, additive mappings, review actions, DB-native
Memory, its import ledger/state binding, owner-only coherent backup, and the
local replication outbox. It also owns deterministic FTS5 revision chunks,
transactional projection maintenance, structured eligibility, cursor binding,
and authorization-scoped local ranking. Only
the usage-engine composition may open this write-capable adapter in production.

### `@ai-usage/memory-service`

Owns the Memory domain/application contracts, adapter conformance, redaction,
bounded legacy/native import, deterministic portable export, and the separately
named protocol-v1 service contracts. It also owns the shared bounded search
query/result contract, runtime parsers, exact-item and Project-context reads.
Its numeric-loopback client and
owner-only/no-follow rendezvous primitives reach the sole local writer. It
imports no SQLite or PostgreSQL adapter and is distinct from
`usage-engine-control`.

### `@ai-usage/memory-search`

Owns deterministic chunking, portable lexical/trigram query helpers, the
synthetic cross-adapter evaluation corpus, and metrics/vector-gate reporting.
It imports no database adapter. SQLite and PostgreSQL consume these portable
contracts while retaining ownership of their SQL projections and queries.

### `@ai-usage/mcp-adapter`

Owns the harness-neutral MCP protocol edge, strict runtime input schemas,
bounded serialization, read-only tool annotations, cancellation, stable error
sanitization, retrieved-data labeling, local/connected application-service
composition, and safe registration helpers. It registers only real read tools
and imports no storage adapter. Harness configuration reuses identity-checked
Skills projection locking and refuses unmanaged same-name entries.

Current package ownership resumes below.

### `@ai-usage/local-machine`

Owns collector-independent local-machine primitives:

- hardened bounded/no-follow history and private-file reads;
- exact on-demand Claude, Codex, and OpenCode session analysis;
- shared pure harness fact parsers, paths, text, local Git, labels, and metric
  validation;
- serialized machine/config transactions and the field-scoped Skills config
  seam;
- deterministic synthetic test homes and memory storage.

It does not collect reports, cache Codex rollout data, import usage rows, open
the usage store, schedule work, or depend on collectors/runtime/apps. Exact
detail readers are read-only and bypass collector caches.

Local history access enforces explicit byte/file/depth budgets, no-follow
regular-file checks, strict UTF-8 decoding, and WAL-coherent SQLite reads.
Usage-bearing runtime values are finite and non-negative before aggregation.
ai-usage-owned private state is owner-only; harness-owned files are never
chmodded or otherwise normalized by a reader.

### `@ai-usage/local-collectors`

Owns collection-only adapters for Claude, Codex, OpenCode, Cursor, Cursor CSV,
Codex and experimental Claude quota batches, RTK savings, and Cursor commit
attribution. It may use collector-private caches and the neutral fact parsers
from `local-machine`, but it does not own machine configuration, report
assembly, usage-store access, scheduling, commands, or output rendering.
Production apps never import it; only `usage-engine-runtime` composes it.

Claude, Codex, and OpenCode collection plus exact detail share one semantic
facts/parser owner per harness rather than competing interpretations. Claude's
recorded turn activity remains distinct from the full Session span, and effort
remains unavailable. OpenCode report/detail attribution, parent kinds, turns,
tools, costs, and intervals come from the same facts implementation.

### `@ai-usage/report-data`

Owns stored-only and pure report assembly:

- complete compatibility payloads and stored publication captures from an
  explicit database path, config, and machine;
- bounded revision-keyed support/focused/Session query validation;
- read-only provider-quota history projection;
- pure multi-machine snapshot merge/project-source assembly.

It depends on report-core and `usage-store/reader`, not collectors, the engine
runtime, or `usage-store/writer`. It exposes no one-shot collection, scheduler,
source adapter, artifact runner, or filesystem lease.

### `@ai-usage/usage-store`

Owns the durable SQLite schema and explicitly separate exports:

- `./reader`: existing-store compatibility and bounded query-only reads;
- `./performance-testing`: benchmark-only, server-only Session query
  instrumentation. It is inert unless `AI_USAGE_PERF=1`, may be imported only
  by the Web server hook (plus repository benchmark tooling), and is never a
  browser or general production API;
- `./writer`: migrations, normalized imports, enrichment, merge mutations,
  checkpoints, atomic served-revision publication, recovery, and retention;
- `./testing`: mixed temporary-store fixtures for tests only.

There is no mixed root export. Production writer calls are owned by
`usage-engine-runtime` and its deep `usage-merge` dependency; the runtime itself
is composed only by `apps/usage-engine`.

Served revision content is immutable once complete: support JSON,
revision-keyed report rows, Session query columns, and private source authority
are never rewritten. Unchanged publication may renew current metadata/expiry
without rematerializing that content. Publication validates the complete
projection and semantic/config fingerprints before atomically changing the
current pointer. Retention always preserves current, tolerates WAL readers,
bounds retained work, and removes abandoned incomplete revisions.

The store distinguishes `local-observed` authority from `portable-opaque`
authority. Every local/peer/preview/confirm preparation splits validated
portable RTK values into a hash-recomputed base row plus a separate
`rtk.savings` contribution in the same transaction. A bounded, versioned,
opaque, stateless `confirmationToken` binds the canonical merge bundle and
relevant logical store state. First preview may initialize an empty
current-schema private store; preview of an existing store may migrate it, but
preview never imports rows or advances semantic generation. A document or
logical-state change returns `preview-stale` and requires another preview.
Generation advances only when the active semantic report projection changes;
observation timestamps and identical imports do not invalidate captures.

### `@ai-usage/usage-merge`

Owns the manual merge bundle parser, byte digest, preview/confirmation workflow,
bounded warning projection, and store-error mapping. Engine-runtime owns file
and command adaptation and must not duplicate these semantics. Only
engine-runtime may import this writer-capable package.

### `@ai-usage/postgres-store` (accepted target; pending integration)

Owns the connected PostgreSQL adapter behind explicit `./schema`,
`./migrations`, `./reader`, `./writer`, `./identity`, `./authorization`,
`./authentication`, `./devices`, `./memory`, and `./projects` subpaths.
`./testing` and `./performance-testing` are restricted to test/benchmark source.
There is no mixed root export. Storage rows and the `pg` pool remain private;
readers return validated domain results and typed bounded failures.

The migration registry uses explicit unique ordinals. One reserved client owns
one advisory lock, validates an exact applied prefix, applies one transaction
per migration, records its ledger row in that transaction, and always releases
the lock. Plan 101's ordinal-1 foundation creates only `platform_migrations`
and `platform_schema_metadata`; plan 102's ordinal-2 migration adds the identity
kernel; plan 103's ordinal-3 migration adds concrete authorization relations,
authorization scopes, audit events, and forced transaction-local Space RLS.
The invalid-value fixture remains test-only.

The package imports only authorization, platform identity, Project-application,
and Project-registry contracts from the workspace; it imports no SQLite, HTTP,
repository harness, or filesystem adapter. Only `apps/server` may import its
writer/migration capabilities in production. Testing injection, raw fixture
helpers, and authorization benchmark SQL are restricted to test/benchmark
source. See [authorization](authorization.md).

### `@ai-usage/usage-engine-control`

Owns strict protocol contracts, client, completion tracking, private rendezvous
parsing, and in-memory test adapters. Its Node handoff seam stages bounded
bytes, fsyncs owner-only/no-follow inbox files, returns opaque IDs, and cleans
them; the engine independently revalidates/consumes the file and owns document
semantics. Plan 107 will extend its operational command set with a content-free
combined replication status, never outbox payloads. The package imports no
runtime, data, collector, store, or app package. Its contracts are operational
only and enforce fixed byte/count/time/path budgets.

### `@ai-usage/usage-engine-runtime`

Owns the deep write-side application service: source state and cadence,
adapters, quota refresh, enrichment, source-policy/config mutations, transfer
workflows, publication, recovery, and sanitized engine events. Plan 107 will
add Usage replication outbox adaptation. It may import
collectors, report-data assembly, `usage-store/writer`, and control contracts,
but no app. Only `apps/usage-engine` may compose its live implementation.

### `@ai-usage/skills`

Owns Skills contracts, scans, diagnostics, source repository state, target
observation, and identity-checked projection workflows. Skills inventory is
local-machine scoped and independent from served report revisions. The web
Skills route is the intentional non-usage-domain filesystem control plane.

Portable source-repository state is JSON data, never executable TypeScript.
Projection plans capture a non-symlink target's canonical/device/inode identity
and revalidate it under a cross-process lock. Target creation walks and
validates every component instead of recursively creating an unobserved tree.
Reconciliation takes the source-state lock before any target projection lock
and revalidates the current enabled intent before mutation, so a concurrently
superseded create, repair, or unlink plan becomes a no-op. No projection path
acquires those locks in the opposite order.
Portable Node APIs narrow common races but do not claim complete protection
from a hostile same-UID actor inside every syscall window.

Skills inventory is local-machine scoped. Imported rows, snapshots, and
non-local machine IDs never decide what to scan. Discovery uses explicit config
plus one focused query of locally observed project paths; broad root scans are
opt-in and no personal directory convention becomes a default. User Skills
config shares `~/.config/ai-usage/config.json`; portable source state lives in
the configured source repository.

### `apps/cli`

Owns argument parsing, terminal/CSV/JSON/payload rendering, bounded portable
files, the loopback setup UI, and CLI diagnostics. Stored reads use the SQLite
reader without an engine. Fresh or mutating operations use one engine client or
one bounded foreground engine, then read the committed revision. The CLI never
imports collectors, engine-runtime, or `usage-store/writer`. After plan 106
integration, `memory search` will use the separately authenticated local Memory
client and never open `memory.sqlite` or PostgreSQL.

Portable snapshot/output files remain explicit CLI writes performed after
bounded reads. CLI wide-event delivery is file-only: it never writes event or
sink diagnostics to stdout/stderr and drains its scoped appender before an
explicit exit so structured output and warning order remain unchanged.

### `apps/mcp` (accepted target; pending integration)

Owns the local stdio process and explicit registration command. It resolves the
owner-only Memory rendezvous, adapts the bounded client to
`@ai-usage/mcp-adapter`, and never opens a database. Failure to reach the local
service is explicit; the process does not change modes or corpora.

### `apps/server` (accepted target; pending integration)

Owns the connected process, typed redacted configuration, health HTTP edge,
one shared PostgreSQL write composition root, migration/readiness startup, and
bounded graceful/forced shutdown. Its only foundation routes are
`GET /health/live` and `GET /health/ready`; not-ready responses are generic and
contain no database URL, hostname, credentials, SQL, migration detail, or raw
exception.

The shared writer exposes the plan-102 identity repository, plan-103
organization Authorizer, and authorization-aware Project catalog behind domain
contracts. The connected HTTP surface still has no identity, login,
organization, or Project endpoint because principal establishment belongs to
plan 104; permission logic is already confined to application services rather
than future handlers.

It does not import usage SQLite, collectors, local-machine readers, the usage
engine, CLI, or Web. `bun run dev:platform` is the explicit disposable
PostgreSQL connected-development composition; `bun run dev` remains local and
PostgreSQL-free. See [platform server operations](platform-server-operations.md).

### `apps/web`

Owns SvelteKit SSR/UI, browser Query composition, the explicit oRPC
endpoint at `apps/web/src/routes/rpc/[...rest]/+server.ts`, source-control SSE
routes, manual-transfer file leaves, `/sync`, web read observability, and the
unrelated `/skills` route. Report queries use the read-only server facades over
`usage-store/reader`; commands use `usage-engine-control`. Web never imports
collectors, engine-runtime, source adapters, or `usage-store/writer`.

Under the accepted platform target, Web will also own `/projects`, whose
SSR/oRPC server edge calls the separate local Memory service for bounded
resolution reviews and explicit create/link/leave-unassigned actions. Browser
code will import only the oRPC contract and TanStack Query will own the review
identity. `/memory` will expose accepted active search through one bounded oRPC
procedure and one TanStack Query identity containing every result-shaping
field; the server edge will call the same Memory client as CLI and MCP.
`/sources` will read the content-free combined Device replication status
through one browser-only `bounded-control-plane` Query identity. The Web server
will adapt the engine's strict status command to the oRPC contract; the browser
will receive only mode, runtime state, closed diagnostics, stream counters,
bounded error codes, generations, and freshness timestamps.

The SSR support bootstrap shares a 512 KiB budget across filter options,
provider representative rows/statuses, and warnings. It returns exact omission
counts and the UI identifies truncation; row-derived Overview, Breakdown, and
Session destination queries remain independent from those omissions.

One root document-scoped TanStack Svelte Query client is the sole browser owner
of remote results, freshness, request and mutation status, errors,
cancellation, retained data, invalidation, hydration, and bounded collection.
The shared contract-first oRPC client transports typed calls and exposes one
generated Svelte Query utility tree; it does not decide visibility or
freshness. Client-visible modules must not import `*.server.*`.

The Skills shell derives one immutable `SkillsPresentationProjection` from the
accepted inventory, Project, selection, and observation Query values. Workspace,
global, health, matrix, and observation renderers consume that projection rather
than rebuilding cross-surface joins. One shell-lived management-operation
episode owns the Query mutation observer, contract dispatch, snapshot
publication, dependent invalidation, pending state, reconcile plan, and scoped
outcome notice. Configuration drafts remain local presentation state; neither
module introduces another server-state cache.

Current report aliases and finite reads use named 30-second SWR policies.
Exact report and Session keys include the immutable revision and canonical
request fingerprint, remain fresh indefinitely, and are never swept by
publication invalidation. The composite report-destination Query publishes one
validated descriptor plus Overview and optional Breakdown or complete requested
Session window atomically. Its single typed expiry recovery refreshes the
bootstrap once. Failed background work retains the last complete Query value.

Initial document loads create an isolated request Query client, await bounded
Report, Skills, Sync, and quota data where useful, dehydrate the same keys, and
clear the request cache. SPA route loads return empty hydration deltas rather
than prefetching business data. The persistent browser client therefore serves
fresh tab revisits immediately and revalidates stale entries in the background.
Search, filter, range, sort, and report destination changes stay client-side and
request no route data.

Session paging rows and cursors remain in exact Query page data. Components own
only requested depth, expansion, selection, focus, URL intent, and
virtualization. The source EventSource retains one explicit connection and
writes its latest bounded snapshot into Query. A completed publication cycle
invalidates the current report aliases and the skill-observation identity, and
nothing else; the aliases are included because a renewal rewrites the served
revision's `publishedAt` and `expiresAt`, which the manifest carries.

On-demand Session Analysis first resolves a private `local-observed` anchor
from the exact served revision, validates its local machine identity, and only
then invokes a neutral `local-machine` exact reader. Portable rows remain
opaque even if identifiers match. Browser Session requests carry only revision
and row identity, never machine/session/repository/remote/branch/path authority;
paths and prompts are neither anchor fields nor comparison inputs. Provider
stderr and resolved URLs are never persisted. Explicit CLI operator-file
commands may carry paths, which the engine canonicalizes and validates under
fixed budgets.

### `@ai-usage/design-system`

Owns reusable Panda/Svelte primitives, report style slots, and generated Panda
consumer exports. Its tested Svelte component surface is exported through
`@ai-usage/design-system/svelte`. See
[generated tooling ownership](generated-tooling-ownership.md).

## Wide-event observability

Each real boundary emits one exhaustive bounded schema-v2 record. Its resource
identifies one process lifetime (`instanceId`), runtime mode, ai-usage version,
and `engine`/`web`/`cli` surface. Trace and span IDs remain scoped to that
boundary. Source-to-publication causality uses monotonic domain generations:
`previousPublishedGeneration < publicationDataGeneration <= dataTarget`
identifies source changes consumed by one coalesced publication without
inventing a cross-boundary trace.

NDJSON and JSON console output remain one object per physical line. Pretty TTY
output is an application-owned projector: success routes to info,
degraded/interrupted/timed-out to warn, and failure to error. `LOG_LEVEL`
filters only console presentation; debug expands the complete bounded hop tree,
annotations, and resource. Engine/Web delivery warnings use fixed,
rate-limited kinds and direct console writes so they never recurse into the
file sink. CLI event delivery and loss summaries remain file-only/silent.

Scheduler investigations group `source.run` by bounded source ID/trigger and
compare queue delay with boundary/source execution duration. The 2026-07-22
audit observed queue delay on 147 records; 40 exceeded one second, the maximum
was 5,054 ms, and `cursor.commit-attribution` had roughly 3,043 ms median queue
delay for roughly 7.8 ms median execution. Those aggregate values intentionally
omit event IDs, revisions, fingerprints, paths, and payload data. They motivate
a separate scheduler performance plan and do not change worker count,
admission, cadence, dependencies, or publication ordering here.

## Preserved domain invariants

- Stable sources are `claude.sessions`, `codex.sessions`,
  `opencode.sessions`, `cursor.sessions`, `codex.usage-limits`, `rtk.savings`,
  and `cursor.commit-attribution`. `claude.usage-limits` is an eighth,
  default-enabled experimental source whose upstream API may change.
- Sparse source-policy overrides are read only from user-home config. Repository
  config cannot authorize background work or provider communication.
- Policy, availability, lifecycle, outcome, and progress are independent.
  Disablement, missing input, empty output, failure, redetection, and restart do
  not delete prior contributions.
- The queue is finite, one worker remains the default, cadence is
  completion-relative, RTK waits for session producers, picked jobs own
  cancellation, and publication has one owner. Monotonic request/data
  generations preserve demand that arrives while publication is running.
- Pure source-control transitions own admission, detection, policy, source
  completion, RTK, and publication generations; the Effect runtime applies
  decisions atomically. Queue deduplication remains separate from monotonic
  demand, so a request arriving during publication produces a successor attempt.
- Cancellation is checked before every later durable phase. Disabling a source
  after its job is picked does not abort that picked run. Runtime queue/lifecycle
  state is ephemeral; contributions, policy, checkpoints, and semantic
  generation are durable. There is no source-delete command.
- Source/status/SSE events are strictly decoded, bounded, and sanitized. They
  contain no paths, prompts, rows, credentials, provider payloads, or tokens.
- Browser snapshot replacement requires the exact eight-source catalogue,
  canonical labels/cadences, consistent policy/availability/lifecycle/outcome/
  generation axes, and explicit operational bounds before accepting state.
- Publication uses a canonical semantic capture fingerprint that excludes only
  observation time. An unchanged forced capture retains/renews current and
  skips Session rematerialization.
- Skill observations carry their tier and harness through every derived count.
  An unobservable harness is `not-observable`, never `0`, and an observation
  that resolves to no inventory entry is retained and labelled rather than
  dropped (ADR 0022). Skill argument text is never persisted.
- Portable snapshot and merge-bundle rows carry credential-free display facts
  with `portable-opaque` authority. They never authorize local filesystem or
  provider access.
- Session VCS facts remain bounded and path/credential-free. Provider resolution
  is explicit, ephemeral, fixed-argv/no-shell, timeout/output-bounded, and not a
  collection or publication step.
- Portable schema-v3 snapshots/bundles preserve Session VCS display facts while
  changing authority to `portable-opaque`; v1/v2 readers migrate with VCS
  absent. VCS changes semantic content hashes but not `sessionRowIdentity`.
  Provider resolution additionally requires strict GitHub URL validation and
  capped output; stderr and resolved URLs are never persisted or exported.
- Production and setup listeners bind only to numeric loopback. Multi-machine
  transfer remains explicit files copied out of band; there is no peer discovery
  or LAN transport.

## Guardrails

- Cross-package imports use only exports documented in
  [public package interfaces](public-package-interfaces.md).
- Relative workspace imports and private `@ai-usage/*/src/**` imports are
  forbidden.
- Boundary tooling checks direct imports and the production dependency closure
  of Web and CLI. It rejects collector, writer, runtime, and PostgreSQL side
  doors.
- Sole-writer searches must find `usage-store/writer` only behind
  `usage-engine-runtime` and its one app composition root.
- `bun run lint` runs Biome restricted-import rules plus workspace-path,
  public-export, and package-boundary checks.
