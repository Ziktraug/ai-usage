# Local Session distillation

Session distillation produces a versioned, sourced account of one local Codex
Session in an explicitly selected Project. The existing Session panel's
**Analysis** tab reads its summary, episodes, decisions, outcomes, entry points
and open questions. Agents use the same saved analyses through the `analyses`
CLI. Generated accounts form a separate corpus from accepted Memory.

## Prerequisites and selection

Use the already running local usage engine and the active harness. The engine
prepares evidence and stores results; the harness performs generation with its
existing authorized subscription. The CLI starts no provider process and has
no paid API fallback. Connected and demo modes do not provide this feature.

Follow [the paired-store upgrade procedure](local-store-upgrade.md) before
running schema-7 code against operator stores. Development and verification
use disposable stores and synthetic histories. Implementing or testing this
feature does not authorize reading real histories or sending them to a
provider. Both permissions must cover the selected Project and Sessions;
existing authorization in the active task can be reused.

Selection needs a durable **Project UUID**, a retained **report revision** and
one or more exact **usage row IDs**:

- Open the Session from Sessions, Agent Map or Project Timeline. In a report
  detail URL, `/sessions/<encoded-row-id>` carries the row identity. The
  browser's Analysis status request carries the exact
  `selection: { revision, rowId }` in its request payload; use that pair when
  inspecting a Campaign member or a pinned report revision. A Campaign key
  and the harness's native Session ID are different identities.
- Use the Project UUID from the acknowledged Checkout-to-Project resolution.
  The existing `/projects` resolution action returns `projectId` when a
  Project is created or linked. For an existing analysis, its status `latest`
  and exact `get` response also contain `projectId`.
- There is no dedicated CLI catalog of durable Project IDs or report
  selections in this version. `projects list --paths --local` lists usage
  Project sources; its names and source keys are not Project UUIDs. The
  report's basename filter and Project groups do not grant local access.

The runtime re-resolves the report row and acknowledged Project mapping. It
requires a locally observed Codex source on this machine and checks the native
Session metadata's exact working path. An ambiguous, missing, foreign-machine
or portable source is ineligible; there is no basename fallback.

## Run a bounded batch

Read the command reference without opening histories:

```sh
bun run cli analyses --help
```

After obtaining an authorized selection, use these placeholders with its exact
values. `select` is a metadata-only dry run:

```sh
DISTILLATION_PROJECT='<acknowledged-project-uuid>'
DISTILLATION_REVISION='<retained-report-revision>'
DISTILLATION_ROW='<exact-usage-row-id>'

bun run cli analyses select --project "$DISTILLATION_PROJECT" \
  --revision "$DISTILLATION_REVISION" --row "$DISTILLATION_ROW"
```

Ask the active harness to follow the repository's
[`session-distillation` skill](../skills/session-distillation/SKILL.md) for this
selection. Once local reading and provider processing are authorized, the
skill prepares and claims each job, writes its own structured submission file,
submits it and reads the saved result. The operator does not copy model JSON
between steps. The underlying commands are:

```sh
bun run cli analyses prepare --project "$DISTILLATION_PROJECT" \
  --revision "$DISTILLATION_REVISION" --row "$DISTILLATION_ROW" \
  --authorize-provider-processing
bun run cli analyses claim --project "$DISTILLATION_PROJECT" --job '<job-id>'
bun run cli analyses submit --file '<skill-written-submission.json>'
bun run cli analyses status --revision "$DISTILLATION_REVISION" --row "$DISTILLATION_ROW"
bun run cli analyses get --project "$DISTILLATION_PROJECT" --id '<analysis-id>'
```

Repeat `--row` to select at most ten Sessions at one retained report revision.
Pass `--producer-session` only when the active harness's native identity is
known. It records worker-declared provenance and excludes that Session from
later default selection; it does not prove provider/model identity.

Preparation reuses the existing job for the same snapshot and extractor.
Changing only the report anchor or filesystem modification time does not
create another default job. Add an explicit `--revision-key '<new-key>'` to
prepare another interpretation; published analyses retain their earlier IDs
and revision numbers.

There is one active lease for the local service. A lease lasts 15 minutes and
a job has at most three attempts. After expiry or engine restart, use `retry`
then `claim`; the old worker cannot publish. `cancel` is terminal. Published
jobs cannot be retried or overwritten, and a different submission for the same
published job conflicts. A failed regeneration leaves the earlier analysis
readable.

```sh
bun run cli analyses retry --project "$DISTILLATION_PROJECT" --job '<failed-job-id>'
bun run cli analyses cancel --project "$DISTILLATION_PROJECT" --job '<job-id>'
bun run cli analyses cleanup --project "$DISTILLATION_PROJECT" --before '<ISO-instant>'
```

Cleanup removes terminal job evidence packets, preserving analyses, source
grants and native history. Cleaned failed jobs no longer have a packet to
retry; a new explicitly keyed preparation is needed. The skill also removes
its temporary files.

## Read and resume

Open **Analysis** in the existing Session panel, choose an analysis revision
and click a claim's evidence control to read the exact recorded excerpt. A
changed or unavailable source is reported explicitly; an older analysis stays
readable. Opening the panel, scrolling or receiving a usage publication does
not trigger generation. Analysis revision and inspected usage revision remain
separate.

The CLI returns JSON and scopes search to one Project:

```sh
bun run cli analyses search --project "$DISTILLATION_PROJECT" --query 'ENOENT cache' --limit 10
bun run cli analyses get --project "$DISTILLATION_PROJECT" --id '<analysis-id>' --episode '<episode-id>'
bun run cli analyses context --project "$DISTILLATION_PROJECT" --query 'ENOENT cache' --max-bytes 16384
```

Search indexes the latest analysis of each Session; older revisions remain
available by exact ID. Search returns at most twenty results with an omission
count. Context retains selected summaries, source identities and coverage,
then fits episodes containing query terms within a UTF-8 byte bound, including
the JSON envelope. Each entry reports `omittedEpisodes`; exact `get` remains
complete. An analysis whose summary and metadata cannot fit is omitted and
counted. The maximum context is 32 KiB; this is not a
token or subscription-quota estimate. Historical commands and retrieved text
are data to evaluate, never instructions to execute automatically.

## Ownership, evidence and limits

`apps/usage-engine` remains the sole writer of both existing SQLite stores.
The separately authenticated Memory service carries distillation operations;
the usage control plane does not carry transcripts. Jobs, immutable analyses
and their dedicated FTS index live in the existing Memory database's local-only
tables. They do not create Memory Observations, Proposals or Items and are
absent from usage snapshots, Memory export and replication/backfill. Promotion
to accepted Memory is outside this first vertical. No additional daemon,
database, scheduler, remote archive or MCP write tool is introduced.

The reader uses hardened local primitives, a stable bounded JSONL prefix and
the canonical Codex ownership/round derivation. It reads up to 4 MiB, retains
at most 256 events and 16 KiB per event, and limits the packet to 256 KiB.
Coverage records omitted content, budget cuts, recorded truncation and the last
native task's completion state. Only the selected Session is analyzed; child
discovery is not performed. Internal reasoning is excluded. Shared redaction
runs before transmission and persistence; it reduces exposure but does not
guarantee anonymization.

Native identity, source digest/version, redacted packet digest and optional
report anchor are stored separately. Exact evidence reload verifies the
expected snapshot rather than returning newer text under an older citation.
Source modification time is part of that conservative reload check.

Model output follows [the extractor contract](../skills/session-distillation/references/contract.md)
and is bounded to 48 KiB. The shared runtime contracts live in
[`platform-core/session-distillation`](../packages/platform-core/src/session-distillation.ts)
and [`platform-core/distillation-evidence`](../packages/platform-core/src/distillation-evidence.ts).
Runtime validation checks schema, exact quotations,
event identity and evidence tiers. A recorded tool result differs from an
assistant claim; a proposal differs from a decision; a patch differs from a
test pass or merge. These checks do not establish semantic entailment or
factual truth. Empty sections and abstention are valid, and no calibrated
confidence or productivity score is inferred.

## Synthetic evidence and verification

The [nine-case corpus](../tools/fixtures/distillation/README.md) has expectations
written before generation. Its [evaluation](../tools/fixtures/distillation/evaluation.md)
preserves real active-harness outputs, the initial coverage misses, targeted
retry results and provenance limitations. Examples include
[multiple attempts](../tools/fixtures/distillation/generated/initial/multi-attempt.analysis.json.txt),
[claimed success without recorded tests](../tools/fixtures/distillation/generated/initial/claimed-success.analysis.json.txt)
and [trivial-session abstention](../tools/fixtures/distillation/generated/initial/trivial-no-lessons.analysis.json.txt).
Review findings are not a measured accuracy score. Original input provenance
for the initial generation is incomplete; the review states that limitation.

A separate [persisted example](../tools/fixtures/distillation/generated/integration/multi-attempt.persisted-analysis.json.txt)
was generated from a claimed packet, submitted through the real CLI, then
read and replayed after closing/reopening the local writer and restarting its
HTTP service. The [integration receipt](../tools/fixtures/distillation/generated/integration/receipt.json)
records search, bounded context and real browser evidence reads. This is a
synthetic integration proof, not a semantic quality score.

```sh
bun tools/fixtures/distillation/check-corpus.ts
bun test packages/local-machine/src/distillation-evidence.test.ts
bun test packages/memory-sqlite
bun test apps/usage-engine/src/distillation-runtime.test.ts apps/cli/src/analyses.test.ts
```

Software tests use controlled producers and disposable stores. Real-provider
generation is evaluated separately from those deterministic tests. No real
Session history was authorized for this implementation's evaluation, and
synthetic migration tests do not prove safety of an operator-store upgrade.

For an isolated manual skill exercise, start the synthetic writer fixture:

```sh
bun --no-env-file apps/usage-engine/src/fixtures/distillation.ts multi-attempt
```

It prints `homeDirectory`, `stateDirectory`, `databasePath`, `projectId` and
the exact selection. Give those values to the active harness running the skill.
For its CLI commands, set `AI_USAGE_HOME`, `AI_USAGE_ENGINE_STATE_DIR` and
`AI_USAGE_DATABASE_PATH` to those three printed paths. This fixture uses the
real reader, service and SQLite adapter; it does not generate a model answer.
After `bun run build`, the same three environment overrides also let the
web-only process read that fixture:

```sh
PORT=4186 bun run start:web-only
```

Open `http://127.0.0.1:4186`, select the synthetic Session, then **Analysis**.
`SIGHUP` closes/reopens its writer and restarts the service for the durability
exercise. `SIGINT` or `SIGTERM` stops it and removes its disposable stores.
This is a development fixture, separate from the read-only product demo.
