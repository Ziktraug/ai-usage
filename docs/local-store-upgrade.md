# Local store upgrade

This is the operator procedure for moving the local usage store across code
versions. It applies to every checkout that runs the real store, not to the
demo runtime.

The engine opens one store (ADR 0009,
[ADR 0084](adr/0084-retire-memory-checkout-resolution-and-replication.md)):

| Store | Location | Writer | Lock file |
| --- | --- | --- | --- |
| usage store | `AI_USAGE_DATABASE_PATH` (default `~/.config/ai-usage/usage-store.sqlite`) | `apps/usage-engine` only | `<database>.engine.lock` |

It uses WAL. Web, CLI, and MCP open it read-only (`query_only`); they never
migrate it. While it runs, the engine publishes one rendezvous file,
`rendezvous.json` (control plane), in its state directory
(`AI_USAGE_ENGINE_STATE_DIR`, default `~/.config/ai-usage/engine/`).

**Retired Memory store.** Revisions before usage schema 5 also opened
`<state directory>/memory.sqlite` (accepted Memory, Project and Checkout
identities, and the rows of the retired Session distillation) behind a second
lease, `memory.sqlite.engine.lock`, and published `memory-service.json`. Since
ADR 0084 the engine no longer opens, migrates, locks or deletes that file
(ADR 0075 rule 4). It stays on disk untouched with its WAL siblings, and
reading its content again means running a revision from before usage schema 5
against a copy. A `memory-service.json` or `memory.sqlite.engine.lock` left by
an older engine is inert and may be removed by hand once no older engine runs.
Keep `memory.sqlite` itself: it is the other half of the backup pair a rollback
to a revision before usage schema 5 needs.

Schema versions are the SQLite `user_version` pragma:

| Store | Before PR #53 (`main` at `b2411c21`) | After PR #53 | Current |
| --- | ---: | ---: | ---: |
| usage store | 3 | 4 | 5 |
| Memory store (retired) | absent | 6 | 8, frozen: no code opens it |

Migrations are forward-only and run inside one transaction, so an interrupted
upgrade leaves the previous version in place. The engine refuses a store newer
than it supports with `Usage store schema <n> is newer than supported schema
<m>` (`packages/usage-store/src/index.ts`). Read-only readers (Web, CLI, MCP)
refuse every version but their own (ADR 0075 rule 1): an older store answers
`schema-too-old` until the engine has migrated it, a newer one
`schema-too-new`. An older binary therefore cannot reopen a migrated store;
rollback means restoring the backup together with the code that wrote it.

## Version history

The entries below record what each change did when it landed and are kept as
history. Where they mention the Memory store, the replication outbox or
backing up both stores, they describe the code of their date; the current
procedure is in [Backup](#backup) and the sections after it.

Usage version 4 adds `replication_outbox_state` and
`replication_outbox_events` (empty in local-only mode). Memory version 6
rebuilds `repositories_provider_identity_unique` with a Space-scoped key for
#53-era version-5 stores, without changing their rows.

Memory version 7 adds empty `distillation_jobs`, `session_analyses`, and
`session_analyses_fts` tables for local Session distillation ([ADR 0042](adr/0042-local-session-distillation.md)).
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

2026-10-26 (ADR 0079): `work_jira_intake` records assigned Jira issues and the
operator's dismissals, under the same usage version 4. Only the engine creates
it; existing tasks, links and Jira-origin threads are left as they are, and no
issue is backfilled until the next successful assigned-issue search. Query-only
readers of a store without the table report it as not yet upgraded. Validation
uses disposable stores; no daily-store upgrade is authorized here.

2026-10-26 (ADR 0080): `work_thread_combinations` records combined tasks and
their separation, under the same usage version 4. Only the engine creates it; no
existing task, link or event is rewritten. An older binary ignores the table and
lists combined members as separate tasks again. Validation uses disposable
stores; no daily-store upgrade is authorized here.

The Claude Desktop session fact family (ADR 0050) adds `claude_desktop_sessions`
and `claude_desktop_collection_state` to the usage store without changing
`user_version`, following the `skill_observations` precedent: the engine
creates them on the next open when they are absent, moves no existing row, and
does not advance the store generation. They hold one bounded row per Claude
Desktop session registry file (`local_<uuid>.json`), never a proposal's prompt,
and they stay outside the served report revision, the replication outbox and
the merge bundle. A binary from before this change reopens the upgraded store
unchanged and ignores the two tables.

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

## Branch evidence (2026-10-27)

ADR 0081 adds three tables under usage version 4, created by the engine on its next open
when absent: `work_session_branches` (which session recorded which repository branch, derived
from the served revision and rebuilt with it), `work_session_branch_builds` (the revision and
host aliases it was built from) and `work_branch_reconciliation` (one creation cutoff per
machine, fixed three weeks before the first reconciliation). The first two are disposable: the
engine deletes and rebuilds them, and nothing operator-owned lives there. The same open adds a
nullable `cross_repository` integer column to `pull_request_observations`; rows written before
carry null and give no head branch until the PR is observed again. Task links stay where they
were: the engine adds `branch` links and `session`-origin tasks through its normal writer, never
rewrites existing rows, and a detached link remains a veto. The Work view's reader requires the
three tables, so it answers `schema-too-old` until the engine has reopened the store. An older
binary ignores them. Collector caches move to new versions (Claude 22, Codex 28), so the first
collection after the upgrade re-reads transcripts and rollouts once. Back up both stores before
restarting the engine with this change.

## Handed-off Jira statuses (2026-10-27)

The engine adds a nullable `handed_off` integer column to
`jira_issue_observations` under usage version 4, through the same
presence-based `ALTER TABLE … ADD COLUMN`. It holds `1` when the observed status
was one the home config names in `jira.handedOffStatuses` at observation time,
and null otherwise; rows written before carry null and read as "not handed
off". Nothing is backfilled: a change to the setting applies from the next Jira
read. Query-only readers tolerate the missing column, and an older binary
ignores it. Pull request discovery now records a third `discovery_role` value,
`team-review-requested`, in the existing column; an older binary reading such a
row treats the observation as invalid for that field, so upgrade the web and the
engine together. Back up both stores before restarting the engine with this
change.

## Pull request status history (2026-10-27)

ADR 0083 adds a nullable `history` text column (JSON) to `pull_request_observations` under
usage version 4, through the same presence-based `ALTER TABLE … ADD COLUMN` on the engine's
next open. Rows written before carry null and read as "history not read"; nothing is rewritten.
Query-only readers tolerate the missing column, and an older binary ignores it. The engine reads
each followed pull request merged before the upgrade once more to fill its history, then stops
re-reading it as before. Upgrade the web and the engine together: the Work view's wire contract
gains the milestone fields. Back up both stores before restarting the engine with this change.

## Usage schema 5 (2026-10-27, plan 120 phase B)

[ADR 0084](adr/0084-retire-memory-checkout-resolution-and-replication.md)
removes accepted Memory, Checkout resolution and replication. On its next start
the engine migrates the usage store to `user_version` 5. Inside the migration
transaction it drops `replication_outbox_state`, `replication_outbox_events`,
`idx_replication_outbox_ready` and `idx_replication_outbox_fact_history`. The
outbox tables were documented as empty in local-only mode, but the migration
does not check: it drops them whatever they contain. A version-3 store goes
straight to 5 without ever creating them, and a fresh store never has them.
The schema-5 step changes nothing else: usage rows, served revisions and every
other table are left as they are. A store newer than 5 is refused.

The migration is forward-only and there is no downgrade path. A binary from
before this change refuses the migrated store (`Usage store schema 5 is newer
than supported schema 4`). Readers from this revision (Web, CLI, MCP) refuse a
version-4 store as `schema-too-old` until the engine has migrated it, so start
the engine first; `bun run start` and `bun run dev` start it with the web. The
engine control protocol moves from 3 to 4 (the `replication-status` command is
gone), so a Web or CLI process from an earlier revision fails closed against
the new engine and the whole supervised stack restarts together.

The engine no longer opens `memory.sqlite`: it takes no Memory writer lease,
publishes no `memory-service.json`, and runs no Checkout observation or
replication runtime. The file stays untouched. CLI `memory search` and
`replication status`, the Web `/memory` and `/projects` pages, the Sources
replication panel, and the MCP tools `memory.search`, `memory.get` and
`memory.project_context` are gone.

Before the first start with this code, back up both files, the usage store and
`memory.sqlite`, as one pair (see [Backup](#backup)). This revision needs only
the usage store, but a rollback to a revision before schema 5 needs both: that
code reopens `memory.sqlite`, and would create a new one with new identities if
it were missing.

## Backup

1. With the revision that last wrote the store still checked out, stop the
   supervised stack (`bun run start` or `bun run dev`) with SIGTERM and wait
   until `<database>.engine.lock` and `rendezvous.json` are gone (with a
   revision before usage schema 5, also `memory.sqlite.engine.lock` and
   `memory-service.json`). `bun --no-env-file apps/usage-engine/src/main.ts check`
   must report `lock` and `rendezvous` as `absent`, `store` as `compatible`,
   and `ok: true`. Run it before updating the checkout: a newer revision reports
   an older store as `unavailable` (`schema-too-old`) until its engine has
   migrated it.
2. Copy the store with `VACUUM INTO` (from the `sqlite3` shell or any SQLite
   client, for example `bun:sqlite`): `VACUUM INTO '<backup>/usage-store.sqlite'`.
   When the state directory holds a `memory.sqlite` from an earlier revision,
   copy it the same way (`VACUUM INTO '<backup>/memory.sqlite'`) and keep the
   two copies together. Never copy a live database file or its `-wal`/`-shm`
   siblings by hand. Keep the copies owner-only (`0600`).
3. Record, next to the copies, the code revision that last wrote the store
   (`git rev-parse HEAD`), the `PRAGMA user_version` of each copy, and a
   checksum of the live `memory.sqlite` taken after the copy (for example
   `sha256sum`). The backup and that revision are one pair.

## Update

- Check out the target revision and run `bun install --frozen-lockfile`
  (`bun run build` for a production start).
- To test a branch without touching the real store, point the engine at a
  copy: `AI_USAGE_DATABASE_PATH=<copy>` plus a distinct, `0700`, owned
  `AI_USAGE_ENGINE_STATE_DIR`, and a distinct `AI_USAGE_HOME` if the harness
  caches must stay separate too. Two engines targeting one database are refused
  by the writer lock (ADR 0009).

## Start / migrate

The engine is the only migrator. On start it acquires the usage writer lease
and migrates the usage store in one transaction; it opens no other store. Start
Web, CLI and MCP from the same revision after the engine is up: until it has
migrated the store, their read-only connections refuse it as `schema-too-old`.

## Verify

- The engine's stderr carries no `usage-engine startupFailureKind=…` line;
  `<database>.engine.lock` and `rendezvous.json` exist while it runs; the
  `check` command reports `ok: true` (`lock` `live`, `rendezvous` `valid`,
  `store` `compatible`). `check` covers the usage store, its lock and the
  control rendezvous only.
- `PRAGMA user_version` reads 5, `PRAGMA integrity_check` returns `ok`, and
  `sqlite_schema` lists no `replication_outbox` object.
- The `usage_rows` count matches the pre-upgrade figure, and the report
  Overview renders the same totals.
- `memory.sqlite`, when present, still has the checksum recorded at backup.

## Recover

- `startupFailureKind=writer-lock-contended`: another engine is alive on the
  usage store. Stop it; do not delete a lock whose PID is alive.
- `startupFailureKind=startup-failure` with `check` reporting the store as
  `unavailable`: a schema or store problem. Stop and restore; do not edit the
  database.
- Restore: stop the engine, put the backup files back (the usage store, and
  `memory.sqlite` when the target revision predates usage schema 5), remove
  any `-wal`/`-shm` siblings left beside the restored files, check out the
  recorded code revision, then start.
- An older binary that was pointed at a migrated usage store refuses it but can
  leave a dead `<database>.engine.lock` behind; the next compatible start
  recovers that lease automatically. The same holds for the lock and
  `rendezvous.json` an engine of an earlier protocol left after a crash: the
  next start checks only that the rendezvous belongs to the dead lock owner,
  whatever its protocol version, and removes both. Until then `check` reports
  that rendezvous as `unsafe`.

Never edit `user_version` by hand, never run an older revision against a
migrated store, and never restore one file of a backup pair without the other.

## Limits

- Forward-only: there is no downgrade migration.
- The procedure covers the usage store, and the retired `memory.sqlite` only as
  backup payload for a rollback. The harness caches beside the usage store
  (`*-cache.json`, `codex-session-cache.sqlite`, `machine.json`) are not part
  of the store and are not covered here.
- Migration, preservation and rollback tests use disposable stores. They do
  not establish that an operator's real store has been backed up, migrated or
  validated. Real-history reading and provider processing require separate
  authorization from a code change or isolated migration test.
- Proof of the paths above lives in `packages/usage-store/src/migration.test.ts`
  (the schema-5 outbox drop, 3 to 5, rollback of a failed migration, refusal
  of a newer store) and `apps/usage-engine/src/process-child-stores.test.ts`
  (real engine processes on one store, with the files of the retired Memory
  store left untouched).
