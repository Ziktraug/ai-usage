# Architecture

`ai-usage` reports usage from local coding-tool history. Provider quota sources
are the narrow provider-facing exception: the usage engine may invoke the
installed Codex CLI's supported local app-server interface or the experimental
Claude Agent SDK. Those provider clients own communication and authentication.
`ai-usage` does not read provider credentials, call private provider HTTP
endpoints, or persist raw provider payloads.

The central runtime rule is a strict split between two planes:

- the durable SQLite database is the **data plane**;
- authenticated numeric-loopback HTTP is the **control plane**.

`apps/usage-engine` is the only production composition root that may open the
usage database read-write. Web and CLI query durable revision-keyed projections
through read-only, query-only SQLite connections. The control plane carries
commands, status, and bounded SSE events only; it is not a report data API.

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
provider-quota observations and does not name a served revision. SSR reads the
current manifest and bounded support bootstrap in one transaction; destination
queries after hydration name that same revision. The browser owns destination
fingerprinting, supersession, atomic commit, and one expiry retry.

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

### `@ai-usage/usage-engine-control`

Owns strict protocol contracts, client, completion tracking, private rendezvous
parsing, and in-memory test adapters. Its Node handoff seam stages bounded
bytes, fsyncs owner-only/no-follow inbox files, returns opaque IDs, and cleans
them; the engine independently revalidates/consumes the file and owns document
semantics. The package imports no runtime, data, collector, store, or app
package. Its contracts are operational only and enforce fixed
byte/count/time/path budgets.

### `@ai-usage/usage-engine-runtime`

Owns the deep write-side application service: source state and cadence,
adapters, quota refresh, enrichment, source-policy/config mutations, transfer
workflows, publication, recovery, and sanitized engine events. It may import
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
imports collectors, engine-runtime, or `usage-store/writer`.

Portable snapshot/output files remain explicit CLI writes performed after
bounded reads. CLI wide-event delivery is file-only: it never writes event or
sink diagnostics to stdout/stderr and drains its scoped appender before an
explicit exit so structured output and warning order remain unchanged.

### `apps/web`

Owns SvelteKit SSR/UI, browser Query composition, the explicit oRPC
endpoint at `apps/web/src/routes/rpc/[...rest]/+server.ts`, source-control SSE
routes, manual-transfer file leaves, `/sync`, web read observability, and the
unrelated `/skills` route. Report queries use the
read-only server facades over `usage-store/reader`; commands use
`usage-engine-control`. Web never imports collectors, engine-runtime, source
adapters, or `usage-store/writer`.

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
writes its latest bounded snapshot into Query; publication invalidates only
current report aliases.

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
  of Web and CLI. It rejects collector, writer, and runtime side doors.
- Sole-writer searches must find `usage-store/writer` only behind
  `usage-engine-runtime` and its one app composition root.
- `bun run lint` runs Biome restricted-import rules plus workspace-path,
  public-export, and package-boundary checks.
