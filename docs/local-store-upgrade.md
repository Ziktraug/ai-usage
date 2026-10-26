# Local store upgrade

This is the operator procedure for moving the two local SQLite stores across
code versions. It applies to every checkout that runs the real stores, not to
the demo runtime.

The two stores and their owners (ADR 0009, ADR 0024, ADR 0038):

| Store | Location | Writer | Lock file |
| --- | --- | --- | --- |
| usage store | `AI_USAGE_DATABASE_PATH` (default `~/.config/ai-usage/usage-store.sqlite`) | `apps/usage-engine` only | `<database>.engine.lock` |
| Memory store | `<AI_USAGE_ENGINE_STATE_DIR>/memory.sqlite` (default `~/.config/ai-usage/engine/`) | `apps/usage-engine` only | `<state directory>/memory.sqlite.engine.lock` |

Both use WAL. Web, CLI, and MCP open the usage store read-only or go through
the engine's loopback services; they never migrate a store. The engine also
publishes two rendezvous files in the state directory while it runs:
`rendezvous.json` (control plane) and `memory-service.json` (Memory service).

Schema versions are the SQLite `user_version` pragma:

| Store | Before PR #53 (`main` at `b2411c21`) | After PR #53 | Current |
| --- | ---: | ---: | ---: |
| usage store | 3 | 4 | 4 |
| Memory store | absent | 6 | 8 |

Usage version 4 adds `replication_outbox_state` and
`replication_outbox_events` (empty in local-only mode). Memory version 6
rebuilds `repositories_provider_identity_unique` with a Space-scoped key for
#53-era version-5 stores, without changing their rows.

Memory version 7 adds empty `distillation_jobs`, `session_analyses`, and
`session_analyses_fts` tables for [local Session distillation](session-distillation.md).
This additive migration preserves existing identities, Memory and outbox rows.
Generated analyses are not accepted Memory and never enter Memory export or
replication through these tables. The usage schema and served report revisions
are unchanged. A version-6 binary cannot reopen the upgraded Memory store.

Memory version 8 adds progressive distillation checkpoints, bounded segments,
withdrawal tombstones and explicit local analysis promotion provenance. Existing
version-1 analyses and their exact IDs remain readable. A version-7 binary cannot
open a version-8 store. Publication policy is independent from sensitivity;
knowledge explicitly promoted from a local analysis stays excluded from both
live replication and later backfill.

## Additive tables under usage version 4 (2026-10-21)

2026-10-22 (Work continuation, plan 122): `review_attempts` gains nullable
`native_turn_id`, `stop_requested_at` and `stop_confirmed_at` columns. Existing
attempts keep their identity, reservation, result and Claude guarantee; unknown
native/stop observations remain null. Query-only readers report a store not yet
upgraded instead of adding columns. Only the engine applies the additive upgrade.
The campaign validates this on disposable databases; it does not authorize or
prove an upgrade of the operator's daily stores.

The same continuation adds `codex_work_observations` for bounded native request
and client-provenance evidence (ADR 0061). Only the engine creates it, under
usage version 4. The table is excluded from usage rows, served revisions,
merge bundles and replication; importing observations does not advance report
generations. Readers of an older store report that it has not been upgraded.
The Codex parser cache is versioned separately so a warm cache cannot silently
omit the new evidence. Campaign verification uses disposable stores only.

2026-10-26 (PR #74 corrective coverage): `codex_work_collection_coverage`
records the current Codex collection identity and each successfully parsed
session's membership, under the same usage version 4. Only the engine creates
this additive table; no historical observation is rewritten or backfilled.
A missing or interrupted pass, an omitted session, or an older store without
coverage is read as incomplete while retaining previously observed requests.
Query-only readers never create the table. Recollection restores coverage for
the sessions actually read, independently of unchanged native timestamps.
These auxiliary rows do not enter served revisions, exports or replication.
Validation uses disposable stores; no daily-store upgrade is authorized here.

The Claude Desktop session fact family (ADR 0050) adds `claude_desktop_sessions`
and `claude_desktop_collection_state` to the usage store without changing
`user_version`, following the `skill_observations` precedent: the engine
creates them on the next open when they are absent, moves no existing row, and
does not advance the store generation. They hold one bounded row per Claude
Desktop session registry file (`local_<uuid>.json`), never a proposal's prompt,
and they stay outside the served report revision, the replication outbox and
the merge bundle. A binary from before this change reopens the upgraded store
unchanged and ignores the two tables.

Migrations are forward-only and run inside one transaction per store, so an
interrupted upgrade leaves the previous version in place. Code refuses a store
that is newer than it supports: the usage store fails with
`Usage store schema <n> is newer than supported schema <m>`
(`packages/usage-store/src/index.ts`), and a newer `memory.sqlite` raises
`MemoryIdentityStoreError('migration-incompatible')`, which is an engine
startup failure with no usage-only degraded mode (ADR 0038). An older binary
therefore cannot reopen a migrated store; rollback means restoring the
backup together with the code that wrote it.

PR #53 also raised the engine control-plane protocol from 2 to 3. A Web or
CLI process from the previous revision fails closed against the new engine,
so the whole supervised stack restarts together.

## Additive tables under usage version 4 (2026-10-21)

### Additive tables under usage version 4 (2026-10-21, executor observations)

The `executors.capabilities` source adds one table, `executor_observations`
(machine, harness, observed time, binary path, version, sign-in state, bounded
evidence, outcome), created `IF NOT EXISTS` on the next engine start without
changing `user_version`. Absence of the table is the migration signal, exactly
as for the skill-observation tables. Rows are retained ten per machine and
harness, never advance the store generation, and never enter a served revision,
a snapshot, or replication. An older binary ignores the table; after a restore
from a pre-table backup the source simply recreates it on its next run.

2026-10-22: the table gained a nullable `auth_method` column (the sign-in
method word the CLI reports, such as `claude.ai` or `api-key`). A store whose
table predates it receives `ALTER TABLE … ADD COLUMN` on the next open, under
the same `user_version`; existing rows read as "no method recorded".

2026-10-22 (ADR 0057): the table gained a nullable `account_fingerprint`
column (the 16-character hexadecimal hash of the account `claude auth status`
reports; the organization id and email themselves are never stored). Same rule
as `auth_method`: a store whose table predates it receives
`ALTER TABLE … ADD COLUMN` on the next engine open, under the same
`user_version`, with no backfill and no store-generation change; existing rows
read as "no identity reported", so a pinned declaration stays conditional
until the next executor observation. The query-only Web and CLI readers cannot
add the column: against a store the engine has not reopened since, they detect
its absence (`PRAGMA table_info`) and read every row as carrying no
fingerprint. An older binary opens the upgraded store and ignores the column.
There is no downgrade path: back up before the first start with the new code
(see [Backup](#backup)); rollback means restoring that backup together with the
code that wrote it.

### Additive tables under usage version 4 (2026-10-21, external and local facts)

The Work view's external and local fact family (ADR 0051) adds three tables to
the usage store without changing `user_version`: `pull_request_observations`
(dated `gh pr view` reads of explicitly linked pull requests),
`checkout_status_observations` (dated `git status --porcelain=v2` reads of
known checkouts) and `work_fact_run_state` (one row per producing source).
The engine creates them on its next start when they are absent, the way the
skill-observation tables were added; no backfill runs, existing rows and the
served report revisions are untouched, and the store generation does not move.
Rows are re-validated on read with the shared contract parsers; the readers
keep the latest observation and the latest successful one apart, and
retention keeps the five newest rows per pull request or checkout plus the
newest successful one. These tables are outside the served revision, the
export and the replication outbox: they describe this machine only and never
leave it. A binary from before this change opens the store normally and
ignores the tables; nothing is stored in them that an older reader needs.

### Additive table under usage version 4 (2026-10-22, Jira issue observations)

The Jira fact producer (ADR 0054) adds one more table to the same family,
`jira_issue_observations` (dated `acli jira workitem view` reads of issues a
Desktop session linked explicitly, with the ten newest comments stored as
JSON), and a third `work_fact_run_state` source id, `jira.issues`. The same
rules apply: created by the engine on its next start when absent, no
backfill, no change to `user_version` or to the store generation, rows
re-validated on read (a row whose comments column no longer parses is counted
as skipped, never shown), retention of five rows per issue plus the newest
success, outside the served revision, the export and the replication outbox.
A binary from before this change ignores the table; a binary from after it
reads an older store with no Jira rows as "not observed".

### Additive table and column under usage version 4 (2026-10-22, declaration history)

The Claude Desktop family (ADR 0056) adds one table,
`claude_desktop_turn_declarations` (the distinct turn declarations of each
desktop session, at most eight per session, with the session's own dates and the
time of a message recorded after each), and one nullable column,
`claude_desktop_sessions.latest_user_frame_at`. The engine creates the table
and adds the column on its next open when they are absent, without changing
`user_version` or the store generation; no backfill runs: the history starts
with the next sweep, and older rows read as "no message recorded". Both stay
outside the served revision, the export and the replication outbox. An older
binary opens the store normally and ignores the table and the column: a session
row it inserts leaves the column empty, and a row it updates keeps the value the
newer binary last wrote. There is no downgrade path: back up before the first
start with the new code (see [Backup](#backup)).

### Additive table under usage version 4 (2026-10-22, review attempts)

The first execution launched by the product (ADR 0053) adds one table,
`review_attempts`, without changing `user_version`: one row per attempt the
engine recorded (identity, target, checkout, the declaration it rested on,
state, timestamps, pid, native session id, bounded result excerpt, executed
validations, acceptance, failure reason), with a partial unique index that
keeps one live attempt per idempotency key. The engine creates it on its next
start when it is absent, the way the executor-observation table was added;
nothing is backfilled and the store generation does not move. Rows are
re-validated on read with the shared parser. At every engine start, rows still
`requested`, `starting` or `running` are marked `lost`: a restarted engine
holds no pipe to a process the previous one started, and nothing is relaunched.
The table is outside the served revision, the export and the replication
outbox; an older binary opens the store normally and ignores it.

2026-10-22 (ADR 0055): the table gains five nullable columns,
`launch_session_id`, `released_at`, `release_evidence` (`process-absent`,
`outcome-recorded-late` or `recorded-before-reservations`), `scope_json` and
`guarantee_json`, through `ALTER TABLE … ADD COLUMN` on the next engine open,
under the same `user_version` and without moving the store generation. The
same open drops the first version's live-only unique index
`idx_review_attempts_live_identity` and creates
`idx_review_attempts_reserved_identity`, which also covers `lost` rows not yet
released, so a lost attempt keeps its target reserved. Rows the first version
had marked `lost` were recorded under a rule that kept no reservation: the
migration releases them as `recorded-before-reservations` at the instant they
were marked lost, never with a process fact nobody observed. The migration is
idempotent (column and index presence are the signals; a second open changes
nothing). An older binary still opens the upgraded store, recreates its old
index beside the new one and ignores the new columns, but a launch it attempts
on a held identity fails visibly. There is no downgrade path: back up before
the first start with the new code (see [Backup](#backup)).

The same day the release evidence gained `operator-declared-ended`: the
operator's declaration, from the Work view, that a lost attempt's review no
longer runs, recorded with its time where the engine cannot look (a first
version row without a launch marker, or a machine whose process list does not
show the engine itself). SQLite cannot alter a column check, so a table whose
`release_evidence` check predates that value is rebuilt on the next engine open:
a new table with the current definition, every row copied, the old table
dropped and the new one renamed, then its two indexes recreated, all inside the
migration transaction and under the same `user_version`. The rebuild is
idempotent (the stored table definition is the signal). A first-version row
that was still live at an unclean stop is marked `lost` at the next start and
stays reserved until that declaration or a process check releases it. A binary
from before the rebuild opens the store and reads an operator-released row as a
row it refuses on re-validation, counted, never shown.

Until the engine has reopened an upgraded store, the query-only Web reads of
`review_attempts` (missing reservation columns) and of
`claude_desktop_turn_declarations` (missing table) cannot add them: they answer
a typed `schema-too-old`, shown on the Work view as "not upgraded for this
version yet; the engine upgrades it when it next starts", never as a raw
storage failure.

### Additive tables under usage version 4 (2026-10-25, delegation)

Delegation (`packages/usage-store/src/delegation-store.ts`) adds three tables
without changing `user_version`: `delegation_jobs` (one row per job a caller
handed to AI Usage: request, frozen scope SHAs, chosen route, state, result,
usage, harness guarantee, reservation release), `delegation_evaluations`
(append-only verifications and acceptances) and `delegation_qualifications`
(the admissible-route qualifications a selector chose from, pruned to the
newest 500 per machine and 7 days unless a job cites them). The engine creates
them on its next start when they are absent (`CREATE TABLE IF NOT EXISTS`,
absence is the signal, ADR 0075); nothing is backfilled and the store
generation does not move. A partial unique index keeps one reserving job per
(machine, action, checkout, base SHA, head SHA); `lost` rows keep that
reservation until release evidence is recorded, as review attempts do. Rows
are re-validated on read with the shared `parseDelegationJob` and
`parseDelegationEvaluation`; a row that no longer parses is counted in
`skipped`. The three tables stay outside the served revision, the export, the
merge bundle and the replication outbox; an older binary opens the store
normally and ignores them. Until the engine has created them, the query-only
reads (`readDelegationJobs`, `readDelegationJob`) answer a typed
`store-not-upgraded`, never a raw storage failure.

### Review fixes under usage version 4 (2026-10-25, PR #73 review)

Two additive changes, both on the engine's next open, inside the migration
transaction, without changing `user_version` or moving the store generation,
and idempotent (presence of the column or the table is the signal):

- `review_attempts` gains two nullable columns, `base_sha` and `head_sha`
  (`ALTER TABLE … ADD COLUMN` through the same additive-column list as ADR
  0055). The engine writes them only for a `requested` attempt that passed the
  common review policy: the frozen revision it reviews and reserves. No
  existing row is rewritten, no `lost` row is released or ended, and nothing is
  backfilled. The shared reservation rule
  (`packages/usage-store/src/review-reservations.ts`) reads what an older row
  recorded: its launch scope's SHAs when it has one, otherwise its whole
  checkout, or every review of the machine when it named no checkout. A row
  whose declaration does not parse counts against every pool of its harness.
  The query-only reads of `review_attempts` do not select the new columns, so
  a store the engine has not reopened still reads. An older binary ignores
  them.
- A new table `executor_account_changes` (one row per machine and harness: the
  last account fingerprint observed, the newest observation carrying it, and
  the time of the latest observed change) keeps the account-change barrier
  that makes a quota observed before the change unattributable. The engine
  advances it in the same transaction as each executor-observation import, and
  the observation pruning never touches it. On creation it is backfilled once
  from the retained `executor_observations` with the same rule, so a change
  still visible at upgrade time is kept. A null fingerprint (unknown identity)
  never moves it; Codex fingerprints observed through app-server follow the
  same barrier rule as Claude Code. The table is
  outside the served revision, the export and the outbox. Query-only readers
  answer "not persisted" while it is absent (only the history-derived change
  then applies), and an older binary ignores it.

There is no downgrade path: back up before the first start with the new code
(see [Backup](#backup)).
### Additive tables and columns under usage version 4 (2026-10-24, Work threads)

Durable Work threads (ADR 0063) add four tables without changing
`user_version`: `work_threads` (identity, title, intent, origin and its unique
`origin_key`, follow state and revision, waiting and done fields, note,
`last_activity_at`), `work_thread_links` (qualified keys, provenance,
`detached_at`; one active link per thread, kind and key), `work_thread_events`
(every follow-state, link, note and rename change) and `work_thread_commands`
(one recorded answer per client command id). The same open adds nullable
columns to the fact family: `discovery_role`, `mergeable` and
`merge_state_status` on `pull_request_observations`, `counts_changed_at` on
`checkout_status_observations` and `outcome_code` on `work_fact_run_state`,
through `ALTER TABLE … ADD COLUMN`. On 2026-10-25 (plan 123) the same rule added
`created_at`, `closed_at` and `unresolved_review_threads` to
`pull_request_observations` (ADR 0075 amendment): rows written before carry
null, read as "not observed", never as zero unresolved threads. Nothing is backfilled, the store generation
does not move, and the tables are outside the served revision, the export and
the replication outbox. Table and column presence are the signals; a second
open changes nothing. Collections and projection rebuilds never write the
thread tables, so a thread's follow state, links and history survive them.

The first engine run after the upgrade may create Following threads for the
operator's open pull requests (author or review requested) and assigned Jira
issues the CLIs return. An older binary opens the upgraded store and ignores
the new tables and columns; threads created meanwhile are kept for the next
upgrade, not deleted. Until the engine has reopened the store, the Work view's
query-only read answers `schema-too-old` ("not upgraded for this version yet"),
never an empty list.

## Work artifact browser links (2026-10-26)

The engine adds a nullable `url` column to `jira_issue_observations` under usage
version 4. Existing rows remain unchanged and query-only readers tolerate the
missing column. New observations retain only a public browser URL: the Jira REST
`self` URL for self-hosted instances, or the CLI's authenticated public site when
Atlassian returns an internal backend hostname. No auth status output or credential
is stored. Back up both stores before restarting the engine with this change.

## Backup

1. Stop the supervised stack (`bun run start` or `bun run dev`) with SIGTERM
   and wait until both `.engine.lock` files and both rendezvous files are
   gone. `bun --no-env-file apps/usage-engine/src/main.ts check` must report
   the lock and rendezvous as `absent` and the store as `compatible`.
2. Copy each store with `VACUUM INTO` (from the `sqlite3` shell or any SQLite
   client, for example `bun:sqlite`): `VACUUM INTO '<backup>/usage-store.sqlite'`
   on the usage store and `VACUUM INTO '<backup>/memory.sqlite'` on the Memory
   store. Never copy a live database file or its `-wal`/`-shm` siblings by
   hand, and never back up one store without the other. Keep the copies
   owner-only (`0600`).
3. Record, next to the copies, the code revision that last wrote the stores
   (`git rev-parse HEAD`) and both `PRAGMA user_version` values. The backup
   and that revision are one pair.

## Update

- Check out the target revision and run `bun install --frozen-lockfile`
  (`bun run build` for a production start).
- To test a branch without touching the real stores, point the engine at
  copies: `AI_USAGE_DATABASE_PATH=<copy>` plus a distinct, `0700`, owned
  `AI_USAGE_ENGINE_STATE_DIR`, and a distinct `AI_USAGE_HOME` if the harness
  caches must stay separate too. Two engines sharing one state directory are
  refused by design (ADR 0038).

## Start / migrate

The engine is the only migrator. On start it acquires the usage writer lease,
migrates the usage store, acquires the Memory writer lease, then opens or
creates `memory.sqlite` (first open creates exactly one local Person, personal
Space, and Device; a later open keeps those identities). A Memory bootstrap
failure stops the engine and releases both leases; that is the designed
outcome, not a partial start. Start Web and CLI from the same revision after
the engine is up.

## Verify

- The engine's stderr carries no `usage-engine startupFailureKind=…` line; both
  lock files and both rendezvous files exist while it runs; the `check`
  command reports `ok: true`.
- `PRAGMA user_version` reads 4 (usage) and 8 (Memory); `PRAGMA
  integrity_check` returns `ok` on both.
- `usage_rows` count and the single `spaces` / `people` / `devices` rows match
  the pre-upgrade figures; the report Overview renders the same totals;
  `/memory` and `/projects` render.
- `bun run cli replication status` prints `Replication: local-only` when
  `AI_USAGE_PLATFORM_BASE_URL` is unset.

## Recover

- `startupFailureKind=writer-lock-contended`: another engine is alive on one of
  the stores. Stop it; do not delete a lock whose PID is alive.
- `startupFailureKind=startup-failure` with `check` reporting the store as
  `unavailable`: a schema or store problem. Stop and restore; do not edit the
  databases.
- Restore: stop the engine, put both store files back from the backup pair,
  remove any `-wal`/`-shm` siblings left beside the restored files, check out
  the recorded code revision, then start.
- An older binary that was pointed at a migrated usage store refuses it but can
  leave a dead `<database>.engine.lock` behind; the next compatible start
  recovers that lease automatically.

Never edit `user_version` by hand, never run an older revision against a
migrated store, never restore one store without the other, and never delete
`memory.sqlite`: its identities bind the replication outboxes, and recreating
it restarts the Memory stream at generation 1 for the same enrolled Device.

## Limits

- Forward-only: there is no downgrade migration for either store.
- One process lifetime for both stores: the engine has no usage-only mode when
  Memory cannot open (ADR 0038).
- The procedure covers the two local stores only. The harness caches beside the
  usage store (`*-cache.json`, `codex-session-cache.sqlite`, `machine.json`) are
  not part of either store and are untouched by PR #53.
- Without `AI_USAGE_PLATFORM_BASE_URL` (the default; the connected server it
  pointed at was removed in plan 120) the engine starts no replication, contacts
  no server or account, and the outbox tables stay empty.
- Schema-7 migration, preservation and rollback tests use disposable stores.
  They do not establish that an operator's real stores have been backed up,
  migrated or validated. Real-history reading and provider processing require
  separate authorization from a code change or isolated migration test.
- Proof of the paths above lives in `packages/memory-sqlite/src/migration.test.ts`,
  `packages/usage-store/src/migration.test.ts`, and
  `apps/usage-engine/src/process-child-stores.test.ts`.
