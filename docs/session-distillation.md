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
unmapped paths, imported IDs and basename matches do not grant access. Resolve
missing or ambiguous mappings through the existing `/projects` workflow. The
`projects` command accepts `--limit 1..50` and `--cursor` for bounded discovery.

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
