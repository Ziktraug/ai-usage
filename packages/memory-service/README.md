# DB-native Agent Memory

This package owns the Agent Memory domain, application-service contracts, and
the separately named local protocol. SQLite and PostgreSQL adapters implement
the same repository port. Markdown and JSONL are explicit import, export, and
projection formats; they are not mutation authorities.

## Pinned migration source

The compatibility baseline is `Ziktraug/nixos` commit
`71915d4566dd1079ec4fa8bd14666d59e4e1bbef`, inventoried on 2026-08-29 from:

- `modules/devtools/ai/agent-memory/SKILL.md`;
- `modules/devtools/ai/agent-memory/default.nix`;
- `modules/devtools/ai/agent-memory/references/memory-contract.md`;
- `modules/devtools/ai/agent-memory/scripts/agent-memory.ts`;
- `tests/scripts/test-agent-memory-harvest.sh`;
- `docs/agent-memory-harvest-hardening.md`.

No Memory content was copied during the inventory. When prose and runtime
behavior differ, the pinned TypeScript implementation is authoritative.

### Command and flag inventory

The source exposes:

- `doctor`;
- `init-global [--check]`;
- `sync-adapters [--check] [--repo <path>]`;
- `recall`, passed through to the recent-work context adapter;
- `harvest [--repo <path>] [--since <duration>] [--query <text>]`
  `[--lens <name>] [--retention-days <positive integer>]`
  `[--max-events <positive integer>] [--dry-run]`;
- `distill [--scope repo|global] [--repo <path>] [--dry-run]`
  `[--limit <positive integer>] [--accept-session-harvest]`;
- `append --scope session|repo|global --type <kind> --title <text>`
  `[--body <text>|--stdin] [--repo <path>] [--source <text>]`
  `[--sensitivity <value>]`;
- `lint [--scope global|repos]`.

Positive integers require a complete decimal representation. A repeated option
without its value is rejected rather than consuming the next flag.

### Durable vocabulary and schemas

Legacy kinds are `decision`, `pattern`, `pitfall`, `command`, `constraint`,
`handoff`, `lesson`, and `preference`. `handoff` remains a legacy Memory kind;
it is not a `WorkHandoff`. Scopes are `session`, `repo`, and `global`; durable
statuses are `active`, `superseded`, and `rejected`; trust is `explicit` or
`harvest-accepted`.

Inbox JSONL events contain `version`, `timestamp`, `scope`, `type`, `title`,
`body`, `repo`, `source`, `sensitivity`, and an optional structured `payload`.
Distilled Markdown frontmatter contains `title`, `type`, `scope`, `status`,
`created`, `updated`, `trust`, `source`, `provenance`, `tags`, and
`distillation_hash`; the body contains summary, guidance, evidence, file, and
supersession sections. The runtime version is `0.1.0`.

Automatic session harvest is evidence, not durable guidance. Distillation skips
it unless `--accept-session-harvest` is supplied, and accepted harvest remains
labelled with `trust: harvest-accepted`. Manual append is explicit. Secret-
redacted material becomes a redaction pitfall rather than accepted source text.

### Identity, deduplication, and retention

Record and summary components receive deterministic exact fingerprints. The
versioned harvest state stores a diagnostic high-water timestamp plus the set
of seen fingerprints. The timestamp is not a cursor: an unseen observation
older than the watermark remains eligible. Seen fingerprints outlive inbox
compaction for at least the configured retention, twice the source window, and
seven days. Age/count compaction applies only to automatic harvest events and
never removes manually appended durable candidates.

Distilled filenames and hashes are deterministic, so rerunning distillation is
idempotent. File paths are provenance, not logical identity.

### Filesystem and security behavior

Global Memory and repository `.agent-memory/` trees contain an `index.md`, one
directory per durable kind, and `inbox/events.jsonl` plus
`inbox/harvest-state.json`. Managed directories are mode `0700` and managed
files mode `0600`. Existing executable Git hooks are not normalized. Expected
private paths reject symlinks and non-regular files before permissions or
siblings are changed.

Redaction runs before persistence. It covers private keys, GitHub/OpenAI/AWS/
Slack token shapes, Bearer/Basic/JWT credentials, URL userinfo, credential-like
assignments, and recursively sensitive object keys. Invalid JSON is retained
only as bounded recursively redacted raw output. This heuristic is not a claim
that arbitrary transcripts are safe to persist.

Writes use exclusive temporary files, file synchronization, and atomic rename.
Writers are serialized by a cooperative `flock` gate and an owned hard-link
lock carrying PID, process start time, and a random token. A lock is recovered
only when that exact owner is proven dead; missing, malformed, live, or replaced
owners remain authoritative. Takeover revalidates inode and content identity.

`--dry-run` makes no inbox, state, permission, compaction, or adapter mutation.

### Adapter output and configuration

Nix configuration supplies `globalRepoPath`, `managedRepos`, automatic capture
(`enable`, `since`, `onCalendar`, `retentionDays`, `maxEvents`), and per-harness
adapter flags. A private systemd user service/timer runs harvest with an idle
priority and restrictive umask.

Adapter synchronization replaces only generated managed blocks in AGENTS,
Copilot, Cursor, Claude, OpenCode, and registry surfaces. It preserves unmanaged
content and does not publish or synchronize the Memory repository.

### Synthetic compatibility scenarios

The pinned suite proves strict integer parsing; no-follow initialization;
private modes; recursive redaction; incremental and older-than-watermark
capture; exact deduplication after compaction; manual-event retention; invalid
JSON handling; symlink refusal; unknown/live/dead lock owners; concurrent stale
lock takeover; replacement-owner fencing; canonical repository identity and
in-repository file evidence; removal of Git URL credentials; and explicit
review before session-harvest distillation.

DB-native adapter conformance mirrors those semantic boundaries while testing
Observation, Proposal, accepted Item/Revision, relation, import, and local
replication-outbox invariants. The compatibility implementation remains active
until import/export and plan-106 search/MCP parity are demonstrated.

## Import, preview, and confirmation

The import boundary accepts the pinned durable Markdown subset, legacy inbox
JSONL, and DB-native exports. Parsing is bounded to 1,000 documents, 512 KiB
per document, 4 MiB per source, and 100 reported issues. A durable Markdown
record becomes an accepted Item and first Revision only after a Person confirms
the preview. Rejected records remain rejected Proposals. Inbox and session
harvest records remain Observations with pending Proposals.

Preview stores a content/import fingerprint and a proof over the exact
destination Space, optional Project, and current per-Space Memory state.
Confirmation takes the state row lock and either applies the complete batch in
one transaction, reports an already-confirmed import, or returns stale. Invalid
or ambiguous batches are quarantined without partial content mutation. The
source documents are input values only and are never rewritten or deleted.

The machine-readable, content-free mapping is
[`migration-mapping.json`](./migration-mapping.json).

## Portable export and intentional reimport losses

JSONL and Markdown exports are deterministic and bounded to 4 MiB. They include
stable Item/Revision IDs, every revision, status, trust, sensitivity, bounded
provenance, and relations. They omit principal identifiers and replace raw
source locators with source-kind/Observation/time labels. Export does not bypass
pre-persistence redaction and is not a relational backup.

Reimport intentionally creates one first Revision from the exported current
content rather than recreating historical revision identities. Person scope
collapses to Space scope because the legacy format has no Person scope.
Supersession relations are reconstructed; other relation kinds remain visible
in JSONL but are not reconstructed. A rejected Item reimports through the
legacy-safe rejected-Proposal path. These are the complete intentional
round-trip losses for this migration format version.

Both adapters consume an opaque, complete `view_memory` authorization scope
before list or export queries. PostgreSQL never fetches Space-wide Memory and
filters it afterward. Superseding an Item changes its content lifecycle, not
its authorization-resource lifecycle, so exact historical reads remain
authorized according to the original grant.

Privacy purge is a separate `manage_memory` application command. It removes the
Item, immutable Revisions, accepted Proposal, orphaned source Observations,
relations, authorization rows, and local replication-outbox payloads in one
transaction, then records only a content-free audit tombstone. The immutable
evidence triggers accept deletion only while that transaction-scoped purge
capability is set; ordinary update/delete attempts still fail.

The local identity kernel can serialize its live sole-writer connection to one
new owner-only SQLite snapshot. Backup publication uses an exclusive temporary
file, file sync, a non-replacing hard link, and parent-directory sync, so an
existing recovery snapshot is never overwritten. PostgreSQL recovery remains
an operator/database backup concern rather than an application export.
