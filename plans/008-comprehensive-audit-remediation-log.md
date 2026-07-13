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
