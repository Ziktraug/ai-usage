# 115 — Local session distillation

Status: DONE (synthetic local vertical), 2026-10-05.
Baseline: clean `main`, `b93f2f6d`, 2026-10-04.
Authorization: local implementation and isolated verification; no real history
processing, real-store upgrade, commit, push, or PR.

## Scope and sequence

1. Revalidate source authority, canonical rounds, Project resolution, and Memory
   persistence. Existing structured Observations are immutable evidence for
   promotion/export; they are not the right local-only analysis authority.
2. Executable synthetic spike through the production Codex normalizer and
   redactor, with active-harness generation and independent factual checkpoints.
3. Local-only jobs and immutable analyses in the existing Memory database,
   authenticated service, CLI selection/prepare/claim/submit/recall, project skill.
4. Lazy Analysis tab in the existing Session drawer, exact revision reads and
   source verification. Preserve report selection and navigation owners.
5. Isolated persisted workflow, adversarial tests, affected browser gates, broad
   `verify`; document remaining semantic limits.

## Execution record

- Inspected current baseline, ADRs 0039–0041, source/read boundaries, Memory
  observation/export/outbox behavior, and paired-store upgrade procedure.
- Added nine synthetic transcripts and 50 independent review checkpoints before
  generation. A separate active-harness agent produced all nine structured
  outputs without the expectation manifest. Schema/quote/evidence checks pass.
- Initial semantic review: 47 checkpoints supported, two coverage omissions,
  no contradictions; one secret lifecycle checkpoint not assessable from the
  generation artifacts. These are case judgments, not measured precision.
- The spike exposed omitted interruption/truncation metadata in the reader.
  Corrected and tested the normalizer, refined skill coverage guidance, retained
  initial outputs, and generated two separate revised examples. See the
  [evaluation](../tools/fixtures/distillation/evaluation.json).
- Completed the existing Memory writer extension (schema 7), leased local
  jobs, immutable analysis revisions, isolated FTS search and packet cleanup.
  Pure contracts live in platform-core; runtime source resolution stays in
  the engine and uses the hardened local-machine reader.
- Delivered the active-harness skill and CLI select/prepare/claim/submit,
  exact analysis/episode reads, search and byte-bounded context. Context keeps
  summaries plus relevant episodes and reports both analysis and episode
  omissions; an exact read is never truncated.
- Generated another account from a claimed synthetic packet and submitted it
  through the real CLI. Closing/reopening the SQLite kernel and restarting the
  HTTP service preserved the account; identical submission returned the same
  ID. Search and a 6,106-byte context were verified. The
  [receipt](../tools/fixtures/distillation/generated/integration/receipt.json)
  preserves this integration proof separately from the semantic evaluation.
- Real browser gestures opened the saved account from Sessions and retrieved
  its exact source passage. No analysis request preceded the Analysis tab,
  the report URL stayed unchanged, desktop/mobile reads worked, and axe had
  zero violations after fixing a heading-order defect the UI fixture missed.
- Adversarial fixes: redact secrets in wrapped/nested JSON before packet and
  analysis persistence; ignore report-anchor/mtime-only differences for job
  deduplication while retaining the exact original grant; reject incompatible
  stored extractor versions before claim/retry/submit. Regression tests were
  run against disposable stores. No accepted Memory or outbox row is created.
- Full `verify` passed again after the persistence corrections. The separate
  bundle gate initially exceeded its unchanged 300,000-byte gzip ceiling by
  259 bytes. Using the existing required root RPC context removed a redundant
  fallback from the lazy component; the final closure is 299,791 bytes.
- Production navigation passed all 49 cases, and the unchanged scroll benchmark
  passed its warmup and three measured samples. Every sample retained all
  5,000 Session identities with zero missing or duplicate identities. Median
  initial load was 507 ms and desktop traversal 3,382 ms; at most 17 desktop
  and 12 mobile rows were rendered. The mobile timing is a warmed follow-on
  path, not a cold full-traversal measure. These are current observations, not
  a measured performance improvement over the baseline.

## Verification ledger

All commands used the repository's cached Nix development environment through
`direnv exec .`, with disposable homes/stores and loopback-only test services.
No assertions, deadlines, isolation rules, or bundle budgets were relaxed.

| Gate | Result |
| --- | --- |
| `bun run verify` | PASS: formatting, lint, typecheck, tests and production build |
| Affected Analysis and existing drawer E2E | PASS: 7 cases after the final UI change |
| `bun run test:web-client-manifest` | PASS: semantic code stays outside the initial client closure |
| `bun run test:web-bundle` | PASS: 4 cases; 299,791 / 300,000 gzip bytes |
| `bun run test:web-production` | PASS: supervised startup, routing, collision cleanup |
| Demo E2E | PASS: 2 cases |
| `bun run test:e2e-production` | PASS: 13 report, 7 scale/map, 29 continuity cases |
| `bun run --cwd apps/web benchmark:session-scroll` | PASS: 4 cases, including warmup; 5,000 identities intact |
| `bun run test:postgres` | PASS: 63 tests, 740 assertions, 18 files |
| `bun run test:local-platform` | PASS: all 7 stages; zero PostgreSQL/authentication factory calls |
| Synthetic corpus integrity | PASS: 9 Sessions, 88 events, 50 independent checkpoints; not an accuracy score |
| Skill validator, document references, integration artifact digest, diff checks | PASS |

The separate real browser exercise used the persisted synthetic result, with
no route mocks: zero page errors or axe violations, exact evidence read,
unchanged selection URL, and mobile drawer scrolling. The owned browser and
fixture services were stopped and the disposable persisted-workflow stores
removed; the operator's existing server was left running.
The manifest and bundle gates passed again after the local-platform build.
Implementation remains an uncommitted diff on `main`; no commit, push or PR
was authorized or performed.

Publication follow-up, 2026-10-05: the operator authorized creating the PR.
The implementation is being published from `codex/local-session-distillation`
against `main`, with the verification results and synthetic-only limits above.

## Acceptance

A skill-produced synthetic analysis is validated and submitted exactly once,
read after restart, visible through the existing Session panel, found through
project-scoped CLI search, and resolves exact evidence or an honest unavailable
state. Duplicate, conflicting, cancelled, expired and recovered jobs cannot
publish twice. Old analysis revisions survive a failed regeneration. No local
mode/development/demo provider or PostgreSQL access; no implicit replication.

## Boundaries

No scheduler, paid API fallback, daemon, third database, raw transcript SSR,
Memory auto-acceptance, embeddings, remote sharing, or plans 108–110. Histories
remain authoritative native files; analysis snapshots never rewrite counters.
All verification uses disposable homes/stores. Real-session product validation
and real-store migration remain unperformed unless specifically authorized.
