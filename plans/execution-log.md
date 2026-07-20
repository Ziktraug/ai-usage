# Plan Execution Log

## Program 009–020 Closure — 2026-07-14

- Dedicated branch: `codex/execute-untracked-plans`.
- Program starting point: `17bcf28`.
- Every previously untracked plan from 010 through 020 is now present in this
  directory, executed in dependency order, and marked `DONE`.
- Plan 009, which already existed, was also completed on this branch before the
  previously untracked plans.

## Results by Plan

| Plan | Delivered result | Main commits |
| --- | --- | --- |
| 009 | Removed HTML export completely from CLI, web, queries, CI, and active documentation. | `4dd0434`, `c3e5869`, `5ba101f`, `6545e62` |
| 010 | Bounded production smoke with owner-process cleanup and real isolated CLI integrations. | `a4a237b`, `1260816`, `e64a222`, `1f11401`, `ffc7146`, `3bb577c` |
| 011 | Atomic machine identity, serialized concurrent writes, and owner-private state. | `ee86517`, `77ce626`, `7bb9ba1` |
| 012 | Bounded/no-follow history reads, WAL-coherent SQLite snapshots, and WAL-sensitive caches. | `a4bcf22`, `75940d5` |
| 013 | Runtime metric validation before aggregation. | `735c47d` |
| 014 | Symmetric portable limits and a preview/confirm workflow bound to exact bytes and store generation. | `d711d17`, `f815903` |
| 015 | Opaque portable provenance without local filesystem resolution or authority. | `6975445` |
| 016 | One exact-revision runner and shared process lifecycle for all six Focused/Session queries. | `fd000b0` |
| 017 | Semantic generation, one pure assembler, changed/unchanged capture, no-op publication skipping, and private renewal without SQLite rematerialization. | `de847d8`, `89edf9f` |
| 018 | One browser owner for acquisition, expiry retry, supersession, and atomic destination commits. | `dbd1fe2` |
| 019 | Target identity revalidated under lock, safe parent creation, and Skills use cases behind a deep application facade. | `61f45d9` |
| 020 | Truly staged-only hook, aligned Bun 1.3.13 metadata, removed CSV residue, and reconciled documentation. | `01cd39e` |

Plan 016’s conditional decisions and plan 020’s specific evidence are recorded
in their neighboring logs.

## Final Evidence

Run on the dedicated branch after the functional changes:

- `bun x ultracite check`: passed across 356 files with no fixes required;
- `bun run lint`: passed;
- `bun run typecheck`: 16/16 tasks;
- `bun run test`: 603 package tests and 8 tooling tests, no failures;
- `bun run build`: 9/9 tasks;
- `CI=1 bun run test:e2e`: 32/32 scenarios;
- `CI=1 bun run test:e2e-production`: 4/4 scenarios;
- `bun install --frozen-lockfile`: passed with Bun 1.3.13 and no lockfile drift.

The only non-blocking output was Playwright/Bun warnings about using `NO_COLOR`
and `FORCE_COLOR` together.

## Closure Review and Corrections — 2026-07-14

A cross-review against Standards and Specification ran after the first closure.
It found partial implementations that would have made the “all plans complete”
claim inaccurate. Commit `8e984a2` corrected them:

- plan 012: Claude/Codex JSONL and Cursor CSV now use an incremental UTF-8
  visitor bounded per file and line without rebuilding the file or full line
  list;
- plan 013: `safeJSON<T>` and its trust cast were removed; objects and nested
  JSON fields are narrowed at runtime before use;
- plan 014: the manual-import XHR response is validated through preview and
  confirmation data, and progress exposes the required ARIA semantics;
- plans 016–018: the exact-revision runner binds each request to its result
  without cross-casts, refresh uses `async/await`, and every prepared
  destination is validated before the first visible commit;
- plan 019: planning and application use the same lock identity under private
  `skills-projection-locks/`; parents are revalidated under lock, and raw
  mutations are no longer exported by the package root or orchestrated by the
  web adapter;
- `Row[] -> SourcedRow[]` assertions were replaced by the stored result’s real
  type.

Targeted post-correction checks passed: clean Ultracite, typecheck 16/16, and
108 high-risk collector, report-data, Skills, and web-server tests. The full
suite evidence above was replayed after this correction before handoff.

## Startup Fix for Over-Budget History — 2026-07-14

Real startup exposed a defect not triggered by bounded fixtures: more than 2
GiB of aggregate Codex history made `/` return HTTP 500 with only
`An error has occurred`.

The first conservative fix retained the limit but moved depth/completeness
failures from `walkFiles` into the typed `LocalHistoryError` channel. Collector
and dataset layers could then emit a Codex warning and let the rest of the
report start.

Evidence for that fix:

- red/green regression test through `collectHarnessDatasets -> walkFiles`;
- real `/` reproduction changed from HTTP 500 to HTTP 200 on two instances;
- clean Ultracite, typecheck 16/16, and 76 focused tests.

After user feedback, graceful degradation was replaced by the intended
capacity fix: total historical volume is no longer treated as resident memory.
Traversal remains bounded by depth and file count; JSONL is read sequentially
with a 1 GiB ceiling per session and 8 MiB per line; non-streamed formats retain
their lower limits.

A forced refresh over 2.55 GiB of real history then completed in 3.6 seconds:
997 Codex sessions parsed, 922 cache hits, 75 files reread, 13 new rows inserted,
and no Codex warning.

The final cross-review added two capacity guarantees:

- `session_index.jsonl`, which is not session history, retains an explicit 1
  MiB ceiling;
- a test traverses the complete Codex collector with four simulated 600 MiB
  sessions—2.4 GiB total—and verifies that all four usage rows are published.

After those guarantees, another forced real startup refresh completed in 2.18
seconds with 3,724 rows, including 882 visible Codex rows, and no Codex warning.
Ultracite, lint, typecheck 16/16, 603 package tests, 8 tooling tests, and the 9/9
build all passed.
