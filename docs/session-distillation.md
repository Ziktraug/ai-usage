# Local Session distillation

Session distillation creates durable, sourced accounts of local Codex Sessions.
Memory opens on **Analysed sessions**; **Pending review** contains deliberately
submitted proposals; **Knowledge** contains accepted Items. A generated account
is useful without accepting every summary. Accepted Memory search and MCP tools
retain their accepted-only corpus.

## Start without internal identifiers

Use the already running local usage engine and repository CLI. Discovery reads
bounded report/Project/Checkout metadata, never transcript bodies:

```sh
bun run cli analyses projects
bun run cli analyses discover --limit 5
bun run cli analyses discover --checkout /absolute/checkout --limit 5
bun run cli analyses discover --project 'Exact Project name' \
  --since 2026-10-01T00:00:00Z --until 2026-10-07T00:00:00Z --limit 5
```

The selector defaults to the current checkout, including a directory inside an
acknowledged checkout. Exact Project names and IDs are accepted; ambiguous names,
unmapped paths, imported IDs and basename matches do not grant access. The
`projects` command accepts `--limit 1..50` and `--cursor` for bounded discovery.

Mappings come from the engine's local Checkout observation (ADR 0044): after
each publication it records one Checkout per local absolute path of this
machine, plus one for the parent repository of every linked worktree (the
published rows carry the parent's id), binds each to the Project of its
`origin` Repository (created on first sight) or to a local Project named after
the directory, and acknowledges the published `machineId|path` ids against the
parent and the worktree's own path against the worktree. A worktree follows
its parent's Repository Project, so `--checkout` inside a worktree selects the
same Project as the parent. A parent without an `origin` remote is a local
Project that its worktrees do not follow: each worktree becomes its own local
Project, and `--checkout` inside it finds no sessions, because they are
published under the parent; select the parent's Project instead. Only an
ambiguous remote waits in the `/projects`
review; `mapping-required` therefore means the path has not been published
yet, is missing on disk, or awaits that review, and a worktree's sessions wait
while their parent does. A directory inside several acknowledged Checkouts (a
repository under `~/Projects` under `~`, each with its own sessions) belongs
to the nearest one.
The engine logs `usage-engine checkouts=observed …` counts on stderr.

The skill itself lives in `skills/session-distillation` and is projected into
the harness directories this repository recognizes: `.claude/skills` for
Claude Code and `.agents/skills` for Codex and other standard agents. Both are
symlinks to the same source; a harness session started before they existed
must be restarted to list the skill.

`discover` returns titles, work dates, analysis/job states, eligibility reasons,
exact selections, and a copyable `prepareCommand`. Its opaque token binds the
report revision, selected row identities and acknowledged mappings. The runtime
rejects a stale revision or changed mapping; it never substitutes a new list.
To choose a subset, append repeated `--row '<candidate.selection.rowId>'` values
to that command. Values must belong to the same preview. The Memory preparation
screen provides the same guided Project/session selection and copyable command.

Before preparation, authorization must cover both local reading of the selected
histories and processing by the active provider. Reuse existing authorization
for the same scope. Running these commands or changing code does not authorize
processing a real home directory. The skill uses the active harness and its
subscription; the CLI never launches a provider or paid fallback. The browser
prepares an explicit scope and hands it to the skill; it does not pretend a
background generation worker exists.

## Execute and resume

Ask the active harness to use the repository's
[`session-distillation` skill](../skills/session-distillation/SKILL.md). It runs
the returned command, writes its own private submission files, and uses returned
identities in these commands:

```sh
bun run cli analyses prepare --selection "$SELECTION_TOKEN" --authorize-provider-processing
bun run cli analyses claim --project "$PROJECT_ID" --job "$JOB_ID"
bun run cli analyses submit --file "$PRIVATE_SUBMISSION_FILE"
bun run cli analyses jobs --project "$PROJECT_ID" --limit 50
bun run cli analyses get --project "$PROJECT_ID" --id "$ANALYSIS_ID"
```

The token comes from discovery; Project/job/analysis IDs come from preceding JSON
responses. No DevTools lookup or manual model-output copying is required.
`--producer-session` records a known native worker identity for exclusion from
future selection; otherwise leave it unknown. `--revision-key` explicitly asks
for another interpretation. Repeating default preparation or continuing a job
preserves its original snapshot and immutable published analyses.

Long sessions are read as bounded source windows. An oversized event remains
visibly truncated and does not prevent reaching later events. The packet fixes
the source identity and end bound; source changes fail closed. `advance`
submissions save bounded rolling checkpoints and queue another window; the final
`submit` publishes atomically after consolidation. Intermediate assertions are
interpretations, with citations still pointing to original events. The worker
can reopen an archived window with:

```sh
bun run cli analyses segment --project "$PROJECT_ID" --job "$JOB_ID" \
  --snapshot "$SNAPSHOT_DIGEST" --segment 0
```

Read the exact `job.progress` stage and completed-segment count. No semantic
percentage is estimated. Snapshot completion, truncated text and unanalysed
children are separate facts; a root Session is never a whole Campaign analysis.
The skill budgets eight total steps per run, at most ten selected Sessions,
one active 15-minute lease, 256 KiB packets and 48 KiB output per step. Exhausting
the run budget leaves queued resumable work, not a completed account.

The current reader accepts a fixed snapshot of at most 128 MiB. Each step makes
two bounded scans of that source under one 30-second deadline: extraction and
digest verification. These scans keep bounded buffers, but repeatedly reading a
large snapshot still has an I/O cost. An oversized event retains a bounded text
prefix with visible truncation. Crossing the source-size or time limit refuses
the step explicitly; it never reports the uncovered source as complete.

After interruption or engine restart, `jobs` lists durable jobs and progress;
follow its `nextCursor` using `--cursor`. Claim a queued job, or explicitly `retry`
an expired/recovered unpublished job before claiming. An old lease is fenced.
A published job cannot be overwritten; identical submission retries return the
same result. Do not create a new revision key merely to resume.

## Browse, recall and verify

Memory lists one current account per Session and keeps exact revisions and
selected episodes addressable independently from temporary report revisions.
Its detail separates narrative and outcomes from provenance/validation details.
Opening, searching, scrolling or receiving SSE does not run inference. Local
accounts are unavailable in connected mode; no corpus fallback occurs. Synthetic
demo data stays isolated from operator stores.

The CLI offers equivalent bounded reads:

```sh
bun run cli analyses browse --limit 20
bun run cli analyses browse --project "$PROJECT_ID" --query cache --limit 20
bun run cli analyses history --project "$PROJECT_ID" --id "$ANALYSIS_ID"
bun run cli analyses search --project "$PROJECT_ID" \
  --query 'How did we resolve cache invalidation?' --mode task --limit 10
bun run cli analyses search --project "$PROJECT_ID" \
  --query 'ENOENT: src/cache.ts' --mode literal --limit 10
bun run cli analyses get --project "$PROJECT_ID" --id "$ANALYSIS_ID" --episode "$EPISODE_ID"
bun run cli analyses evidence --project "$PROJECT_ID" --id "$ANALYSIS_ID" --event "$EVENT_ID"
bun run cli analyses context --project "$PROJECT_ID" \
  --query 'cache invalidation' --mode task --max-bytes 16384
```

`browse` supports `--since`, `--until`, `--project`, `--query`, `--cursor` and
`--limit 1..50`. Dates describe the Session's work when known, separately from
analysis generation. History also supports `--limit` and `--cursor`.

Literal mode requires the exact case-insensitive punctuated phrase. Task mode
uses at most 32 lexical terms, drops common English/French function words and
ranks overlap within the chosen Project. It never silently widens scope or
claims semantic equivalence. Search indexes current visible analyses; exact
historical reads remain separate. Retrieval and counts filter authorization
before ranking. Context stores each distinct citation once and refers to its
index from assertions. It retains limitations and exact source digests, declares
omitted episodes/accounts, and counts the full UTF-8 JSON envelope. The 32 KiB
maximum is a byte bound, not an exact token or subscription-quota estimate.

Evidence CLI first loads the immutable analysis and sends its packet/source
digests. An event is `available` only for that identity. `changed`, `unavailable`
and `denied` never return current text under an old citation. Historical
quotations remain in the account with their original interpretation status.

Business error codes survive transport: `worker-busy`, `lease-expired`,
`conflict`, `forbidden`, `source-modified`, `version-incompatible`, `cancelled`,
`storage-unavailable`, `selection-stale`, `mapping-required`, `unsupported-mode`
and `service-unavailable`. Inspect state and explicitly resolve the relevant
condition; clients never replay mutations automatically or parse human messages.
Execution failures from the analyses CLI write `{"error":{"code":"…"}}` to
stderr and exit with status 1; stdout remains reserved for successful JSON.

## Deliberate knowledge and deletion

**Propose as knowledge** selects an analysis element and opens an editable
formulation, type, scope, sensitivity and evidence. The application loads the
exact source revision and creates an Observation and Proposal with idempotent
provenance. Acceptance is a second human action in **Pending review**. After
saving, **Open Pending review** links to that exact proposal
(`/memory?view=review&proposal=<id>`): the review page starts at it wherever it
sits in the queue, through reload and history. A malformed, unknown,
inaccessible or already reviewed proposal is refused explicitly. The original
account remains unchanged. Accepted Items remain local unless a separate
publication policy and consent authorize publication; sensitivity is not used
as a substitute for that choice.

```sh
bun run cli analyses cancel --project "$PROJECT_ID" --job "$JOB_ID"
bun run cli analyses cleanup --project "$PROJECT_ID" --before 2026-10-07T00:00:00Z
bun run cli analyses removal-preview --project "$PROJECT_ID" --id "$ANALYSIS_ID"
bun run cli analyses remove --project "$PROJECT_ID" --id "$ANALYSIS_ID" \
  --mode withdraw --confirm --preserve-knowledge
```

Cleanup removes terminal packets. Withdrawal removes search/library visibility.
`--mode purge` deletes stored analyses and packets for the Session, preventing
an earlier revision from silently becoming current. Active work is cancelled
and fenced. The preview/result identifies dependent proposals and accepted
knowledge, which are preserved; their existence prevents a claim that every
derivative was erased. Native history and external backups are never removed.
A fresh explicit revision key is required for deliberate reinterpretation
after withdrawal.

## Upgrade and validation scope

Follow the [paired-store upgrade procedure](local-store-upgrade.md), including
backup of both stores and a single supervised restart, before running changed
schema code against operator stores. There is no downgrade path. Existing
version-1 analyses remain readable alongside progressive extractor outputs;
mutation compatibility checks do not discard historical accounts.

Redaction rule fixes keep packet `redactionVersion` 1. Packet digests and job
identity already follow the redacted event text, so only Sessions whose text a
fix changes get a new identity: preparing them again creates a new job, and
evidence for their earlier analyses reports `changed`. Events holding JSON with
duplicate keys that needs redaction are among them: such JSON is now redacted
from the members the parser keeps, while clean duplicate-key JSON stays
byte-identical. So is text outside parsed JSON (tool envelopes, JSON string
contents) whose secret-keyed value is a nested object or array that kept content
visible past its first token: when its brackets balance and the covered output
differs from the previous one only by text removed right after `[REDACTED]`
slots, the whole value is now masked; otherwise the previous output stands. So
are events whose JSON embedded in a tool envelope (also as an escaped string
literal) or nested in a JSON string needs redaction: once the raw-text rules
leave the text unchanged, the JSON rules now judge such JSON at every level,
without the Memory domain limits, and the version stays 1. The covering choice
above is made on the whole text first; this pass judges what it leaves and never
covers values itself, and the two alternate until neither changes the text. Once
a covered output has stood, the rounds also run without covering, and the
covered output is kept only when every run of it between whole-value
placeholders is text the other output shows, whitespace aside; otherwise (a
value covered whole can leave a truncated object unclosed, so the pass never
judges it) the whole text becomes `[REDACTED]`. A secret the raw text escapes
inside a JSON key (`https:\/\/user:password@host`) is now redacted as key text
too, also in a sensitive key whose name survives it. A re-emitted document that
outgrows its own text more than fourfold (string nesting spelled with `\u`
escapes doubles per level) becomes `[REDACTED]`. Embedded JSON nested deeper
than 256 levels is replaced in place by the marker below. This pass is bounded
by a scan budget: past it, the rest of the text keeps the earlier rules' output.
JSON the raw-text rules damage first (container values under sensitive keys,
which a slot now covers whole; sensitive dotted keys the shared token-shaped
rule rewrites) is judged only as far as it survives. Evidence reload rebuilds
packets with the current rules and version, so a version bump would report every
published analysis as `changed`. Packets stored before a fix keep their text;
re-redaction cannot recover a fragment the earlier rules left outside a
`[REDACTED]` slot.

Event text is not Memory content, so the Memory domain's JSON limits (empty or
over-long keys, more than 10,000 nodes, nesting deeper than 32, non-finite
numbers) do not apply to it. Tool output holding such JSON is redacted like any
other JSON; redaction no longer throws on it, which failed preparation for the
whole Session, and submitted quotes of it are accepted. The one bound is
nesting: a text that is JSON nested deeper than 256 levels, counting members a
duplicate key hides, or that masking turns into such JSON, is replaced whole by
the explicit marker
`[REDACTED: JSON nested deeper than 256 levels]`, because the redaction walks
recurse once per level. This fix also keeps `redactionVersion` 1, for the
reason above: Sessions that failed preparation had no packets, and only text
the fix changes gets a new identity.

Development tests use disposable homes, SQLite stores and localhost services.
They cover discovery, immutable preview preparation, interruption/restart,
long-session windows, exact evidence, bounded recall, library pagination and
promotion. Deterministic outputs test software contracts; they do not establish
semantic accuracy of actual model generations. Real-history reading, provider
processing and live-store migration require separate targeted authorization.

Run `bun run test:e2e-memory` for the browser journey through a disposable real
engine and SQLite stores. After `bun run build`, use
`AI_USAGE_MEMORY_BROWSER_PRODUCTION=1 bun run test:e2e-memory` to exercise the
production server; the production browser CI job runs this variant.
