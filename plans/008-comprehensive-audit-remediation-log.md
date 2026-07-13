# Plan 008 Execution Log

## Execution context

- Started: 2026-07-13 (Europe/Paris)
- Baseline commit: `7ff9944b3925700059ffac0139a010ad5b34afc7`
- Bun: `1.3.13`
- Initial source diff from `7ff9944`: none
- Pre-existing plan changes: `plans/README.md` and the untracked Plan 008 source were supplied with this task and preserved.

## Wave 0 — Baseline and characterization

Status: complete.

### Frozen acceptance budgets

- Deterministic fixture: seed `144776471`; 4 harnesses; 5 projects; campaigns of 5 sessions; 1 warm-up and 5 measured repetitions.
- Existing-row lookup queries: at most 3 for 1,000 rows and 125 for 50,000 rows (400-row batches).
- Maximum Sessions page: 200 top-level items, with storage queries using `LIMIT pageSize + 1`.
- Report runner artifact: 134,217,728 bytes (128 MiB). The 50,000-row compatibility payload is 78,143,748 bytes; the ceiling provides more than 50% headroom and still imposes a hard bound.
- Served bootstrap: 524,288 bytes.
- Overview refresh: 2,097,152 bytes.
- One Sessions page refresh: 2,097,152 bytes.
- Wall-clock measurements are informational only. No timing regression tolerance is frozen because the baseline has high filesystem/cache variance; semantic, query-count, row-count, and byte budgets are the acceptance gates.

### Commands and results

- `bun x ultracite check`: PASS, 303 files, 0.317 s.
- `bun run lint`: PASS, 0.214 s.
- `bun run typecheck`: PASS, 18 Turbo tasks (cached), 0.085 s wrapper time.
- `bun run test`: PASS, 17 Turbo tasks (cached), 0.082 s wrapper time. Replayed package output included 169 web tests, 64 report-core tests, and all remaining workspace suites with no failures.
- `bun run build`: PASS, 10 Turbo tasks (cached), 0.088 s wrapper time. Baseline root client chunk: 661.85 kB (199.79 kB gzip).
- `bun run test:e2e`: PASS, 27 tests, 25.091 s.
- `bun run test:html-export`: PASS, 6 tests, 17.439 s.
- `bun tools/measure-audit-baseline.ts`: PASS. Machine-readable baseline:

  ```json
  {
    "importRows": {
      "1000": { "medianMs": 31.616, "samplesMs": [34, 37.623, 31.512, 31.308, 31.616] },
      "50000": { "medianMs": 1930.406, "samplesMs": [7568.986, 1930.406, 1573.019, 4932.532, 1560.554] }
    },
    "reportPayload": {
      "bytes": 78143748,
      "medianMs": 284.979,
      "samplesMs": [382.508, 283.855, 287.772, 270.698, 284.979]
    },
    "skillsFirstLoad": {
      "datasetCollectionRuns": true,
      "durationMs": 209.202,
      "fullPayloadSerializationRuns": true,
      "ok": true,
      "projectPaths": 22
    }
  }
  ```

- `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts e2e/audit-performance.spec.ts`: PASS, 5 tests, 13.1 s. Machine-readable DOM baseline:

  ```json
  {
    "advancedAnalysisClosed": 246,
    "sessions": {
      "361": { "surface": 185, "table": 87, "mobileSummaries": 53 },
      "1024": { "surface": 185, "table": 87, "mobileSummaries": 53 }
    }
  }
  ```

  Both Sessions surfaces are present at both viewports before Wave 5; CSS alone hides one. Closed Advanced analysis still mounts 246 descendant nodes.

## Deviations and STOP-condition audit

- No deviations or STOP conditions identified at start.

## Wave 1 — Production runtime and loopback trust

Status: complete.

- Added workspace-root discovery independent of bundle location, Nitro's Node server preset, and a loopback-forcing start wrapper.
- Added global trusted-local request and server-function CSRF middleware. The Vite `/sync` interception now streams through the production bounded upload boundary.
- Rejected Vite uploads use a lazy, backpressured request adapter and drain unread hostile bodies; a 4 MiB hostile-body regression test proves the import path is never reached.
- Setup now exposes a closable loopback-only listener and bounded, strict, same-origin JSON mutation handling.
- Added production/setup listener smoke tools and CI wiring.
- Focused runtime/trust/Vite/setup verification: PASS, 25 tests.
- `bun run test:web-production`: PASS.
- `bun run test:setup-loopback`: PASS.
- Deviation: `apps/web/src/start.ts` and the Nitro `node-server` preset were required in addition to the plan's enumerated files; without them, adding a start instance would drop fallback CSRF behavior and the documented Node command would execute a Bun-preset artifact.

## Wave 2 — Legacy LAN stack removal

Status: complete.

- Deleted `packages/sync`, CLI `serve`/`sync`, remote merge options, sync-storage, active sync config typing/validation, and manifest/lockfile references.
- Added the local `readUsageSnapshotFile` adapter and routed merge/project/setup file inputs through it.
- Legacy unknown `sync` config is inert and preserved byte-for-byte structurally during unrelated updates; no user data or token material is migrated or deleted.
- Focused CLI/snapshot/config verification: PASS, 30 tests before the stricter Wave 3 parser; current combined focused suites remain green.
- CLI empty-history file round trip (`snapshot --out`, `merge <file>`, `projects list --paths <file>`): PASS.
- Residue check over active code/manifests/lockfile: PASS; `packages/sync` is absent.

## Wave 3 — Strict bounded snapshot files

Status: complete.

- Shared strict serialized-row/warning validation now backs merge bundles and snapshots.
- `MAX_USAGE_SNAPSHOT_ROWS` is 50,000, aligned with the supported manual-merge boundary.
- `MAX_USAGE_SNAPSHOT_BYTES` is 64 MiB. The deterministic 50,000-row snapshot representation is below 40 MiB; the limit leaves format headroom while matching the manual-upload boundary.
- The CLI opens with no-follow/nonblocking flags, validates the same regular-file handle, reads at most `MAX + 1`, decodes strict UTF-8, closes in `finally`, and returns path-only failures.
- Snapshot/merge/setup/reader verification: PASS, 42 focused tests after integration.

## Wave 5 — Dashboard mount costs

Status: complete.

- Closed Advanced analysis now mounts only its native summary.
- Sessions starts with a hydration-stable pending surface, then mounts exactly mobile, desktop, or complete non-virtualized print output; media/print/ResizeObserver listeners are cleaned up.
- Controller/model/schema verification: PASS, 27 tests.
- Dashboard/performance Playwright verification: PASS after correcting the disclosure fixture to assert the available Punchcard chart. Final DOM measurements:

  ```json
  {
    "advancedAnalysisClosed": 4,
    "sessions": {
      "361": { "surface": 53, "table": 0, "mobileSummaries": 53 },
      "1024": { "surface": 88, "table": 87, "mobileSummaries": 0 }
    }
  }
  ```

## Wave 4 — Focused Skills discovery and production adapter seam

Status: complete.

- Added `KnownLocalProjectSources` Effect/Promise APIs that query only the local machine and perform at most one fallback collection when local rows are absent.
- `/skills` no longer constructs or serializes a complete report; imported machine rows cannot suppress local discovery or contribute repository paths.
- Production and tests use the same fully injected `SkillsServerAdapter` factory. Temporary-storage tests cover redaction, config preservation, Markdown revision conflicts, target creation, toggle/preview/reconcile workflows, unsafe targets, and imported-path exclusion.
- The production Node adapter invokes the focused query through a Bun subprocess with 512 KiB stdout, 64 KiB stderr, and timeout bounds; explicit temporary storage keeps the in-process test seam. The production smoke now requires the server-rendered known-project success marker.
- The route loader reads independent project paths and Skills state in parallel.
- Focused verification: PASS, 43 tests. Full workspace run during the wave: PASS, including 200 web tests and 16 typecheck tasks.

## Wave 6 — Batched SQLite imports

Status: complete.

- Existing rows load in 400-key batches; insert/update/touch statements are prepared once and all batches remain under one `BEGIN IMMEDIATE` transaction.
- Tests cover more than two batches, mixed states/counters, duplicates within and across batches, concurrent writers, and late full rollback.
- Usage-store/usage-merge verification: PASS, 22 focused tests.
- Post-change deterministic measurement: 1,000-row median 34.352 ms (`34.352`, `34.866`, `32.128`, `34.266`, `36.749`); 50,000-row median 1,467.169 ms (`1,417.530`, `1,518.002`, `1,912.413`, `1,358.459`, `1,467.169`). The informational 50,000-row median improved by 24.0% from baseline while the frozen 3/125 lookup-query budgets remain enforced structurally.

## Wave 7 — Time Range state machine

Status: complete.

- Extracted one pure discriminated interaction reducer with separate selection/day and visual/bucket contexts.
- Preserved pointer capture, DOM measurement adapters, keyboard behavior, default ranges, and URL semantics; fixed hover invalidation so timeline legend interaction remains attached.
- Verification: PASS, 18 reducer tests, 25 focused unit tests, and all 4 Time Range Playwright tests.

## Wave 8A — Bounded report-runner artifact

Status: complete.

- Replaced the 64 MiB buffered stdout transport with a private 0700 directory/0600 precreated file and a spawned Bun runner.
- The 128 MiB ceiling is enforced by the writer and by same-handle `stat` plus a bounded `MAX + 1` reader. Stdout is drained without retention; only a 64 KiB stderr tail is kept.
- Cleanup tests cover success, >64 MiB valid payload, ceiling overflow, child failure, permission rejection, parse failure, and cancellation.
- Verification: PASS, 13 focused artifact/server tests, 21 report-data tests, report-data/web typechecks, and an isolated-HOME runner smoke.

## Waves 8B–8D — Immutable revisions and focused served state

Status: complete.

- A completed compatibility capture is split once into immutable rows/support artifacts and atomically published with an opaque revision, capture/digest validation, owner-only permissions, TTL, retained-count bounds, and reference-counted leases. Exact reads return typed `RevisionExpired`/`RevisionUnavailable` results and canonical fingerprints.
- Force refreshes, project-group mutations, and successful manual imports invalidate only the latest pointer. A generation guard prevents an older capture from publishing after invalidation; leased prior revisions remain immutable and readable until release.
- Added strict `@ai-usage/report-core/session-query` contracts for the 25 Session sort fields, filters/ranges, canonical request fingerprints, stable identity ties, maximum 200-item pages, campaign summaries/children, and full-sequence neighbors. Web presentation enrichment/sort/campaign calculations now reuse those contracts with fixture parity.
- Before publication, a silent Bun job bounded-reads `rows.json` once and materializes an owner-only `sessions.sqlite`. Production queries open it immutable/read-only and use storage `LIMIT pageSize + 1`; Nitro never imports `bun:sqlite` or deserializes the complete rows artifact. Results use private bounded artifacts with a 2 MiB ceiling.
- Served refresh validates manifest, rows, support, revision, and fingerprints before atomically applying slices through focused Solid store accessors. Expired revisions discard partial results and restart once; last-good state survives failures. Compatibility reconstruction is lazy and reserved for explicit HTML export.
- Selected implementation fallback: the coherent Bun-produced compatibility capture is the single source for revision materialization because a simultaneous live store/config SQLite snapshot is not guaranteed by the existing collectors. No query reads live rows or config after publication.
- Focused verification covers exact JavaScript/SQLite ordering parity (including Unicode, punctuation, floating-point ties, campaigns, and all 25 sort fields), bounded SQL projections over 50,000 rows, strict nested response parsing, revision publication/expiry/leases, atomic last-good refreshes, paging, neighbors, and full export semantics.
- Served Overview and Breakdown derive bounded aggregates in SQLite; closed Advanced analysis omits its expensive projections. Bootstrap support is byte- and item-bounded and reports exact omission counts.
- A parallel Standards/Spec review identified ordering parity, deep parser, partial refresh, printing, inactive-query, setup accessibility, and boundary-guard gaps. Each finding was remediated and covered by a regression test before closure.

## Static HTML `file://` contract

Status: complete.

- Added a deterministic Codex fixture and Chromium test that generates a self-contained report, opens its absolute `file://` URL, verifies hydration/filter/drawer interaction, and rejects every additional request, console error, or page error.
- Added the missing trusted `Host` header to the CLI's in-process SSR request so global local-request middleware applies equally to export rendering.

## Wave 9A — Executable package guards

Status: complete.

- `collectViolations(root)` is importable and CLI execution is guarded by `import.meta.main`.
- Retired root/subpath imports and manifest dependencies for `@ai-usage/sync` and `@ai-usage/lan-pairing` are forbidden globally; web also forbids CLI adapter imports.
- Root tests explicitly run both Turbo package tests and tool tests, with `test:tools` repeated in CI as a wiring guard.
- Verification: PASS, 6 negative/current-graph boundary tests, including recreated manifests and CommonJS subpath imports.

## Wave 9B — Current documentation

Status: complete.

- Reconciled all listed current docs with file-only transfer, loopback listeners, focused local Skills discovery, immutable served revisions, strict Session contracts, and static compatibility exports.
- Removed LAN/remotes/tokens/polling/network-command guidance without rewriting the historical audit or plan record.
- Public-package documentation matches every surviving manifest export; required current-doc and active-code residue checks pass.

## Final measurements

The deterministic post-change run used the same seed, row counts, warm-up, and five measured repetitions as Wave 0:

```json
{
  "importRows": {
    "1000": { "medianMs": 35.182, "samplesMs": [35.43, 36.076, 32.818, 34.412, 35.182] },
    "50000": { "medianMs": 1897.29, "samplesMs": [1897.29, 1445.341, 2255.144, 1555.631, 3640.507] }
  },
  "reportPayload": {
    "bytes": 78143748,
    "medianMs": 319.83,
    "samplesMs": [319.83, 431.157, 359.639, 281.095, 317.943]
  },
  "skillsFirstLoad": {
    "datasetCollectionRuns": 0,
    "durationMs": 1441.507,
    "focusedProjectSourceQueryRuns": 1,
    "fullPayloadSerializationRuns": 0,
    "ok": true,
    "projectPaths": 5
  }
}
```

- The 1,000/50,000 import paths retain the exact 3/125 lookup-query budgets. Timing remains informational, as frozen in Wave 0; the final 50,000-row median is 1.7% below baseline.
- Compatibility payload size remains 78,143,748 bytes, below the explicit 128 MiB private-artifact ceiling. Served refreshes no longer transport that payload.
- Skills performs one focused project-source query, no complete dataset collection, and no full-payload serialization.
- Final client entry is 708.78 kB, below the frozen 720 kB regression ceiling.
- Final browser DOM measurements:

  ```json
  {
    "advancedAnalysisClosed": { "nodes": 4 },
    "sessions": {
      "mobile": { "viewportWidth": 361, "sessionSurfaceNodes": 41, "tableNodes": 0, "mobileSummaryNodes": 41 },
      "desktop": { "viewportWidth": 1024, "sessionSurfaceNodes": 76, "tableNodes": 75, "mobileSummaryNodes": 0 }
    }
  }
  ```

## Final verification and closure

Status: complete on 2026-07-13. Final implementation commit: `fea9f77`.

- `bun x ultracite check`: PASS, 342 files.
- `bun run lint`: PASS, including workspace paths, public exports, and package boundaries.
- `bun run typecheck`: PASS, 16 Turbo tasks.
- `bun run test`: PASS, 15 package tasks plus 6 tool fixtures; web reported 248 tests and 708 assertions.
- `bun run test:tools`: PASS, 6 tests.
- `bun run build`: PASS, 9 packages; client entry 708.78 kB.
- `bun run test:web-production`: PASS; production `/` and `/skills` are healthy and IPv4-loopback-only.
- `bun run test:setup-loopback`: PASS with a real snapshot-file process fixture.
- `bun run test:e2e`: PASS, 32 tests.
- `bun run test:e2e-production`: PASS, 1 test proving revision/fingerprint/page/neighbor identity through the built Node server.
- `bun run test:html-export`: PASS, 6 tests.
- `bun run test:html-file`: PASS, 1 Chromium test with no network or dynamic assets.
- Active-code retired-package, current-doc legacy phrase, deleted-directory, public-export, package-boundary, and `git diff --check` residue checks: PASS.
- No STOP condition remains. The only implementation fallback is the documented coherent compatibility capture used to materialize each immutable revision; it preserves one-source revision semantics because the existing collectors do not expose a simultaneous live config/store snapshot.
