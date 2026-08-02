# Usage-engine I/O baseline

- **Captured**: 2026-07-29, Europe/Paris
- **Before source**: planning revision
  `f2eb6c06469df9e43fcae0a1ae196f48af0faf92`
- **After source**: Wave 0 implementation revision
  `6841af605832ca8a1c1f1e4c514d856d6c7780be`
- **Dependency lock**: `bun.lock` Git blob
  `0070d1be25b87e47f7b707cf2dcf81b9405ba044` at both revisions
- **Runtime**: Linux, Bun 1.3.13, Vite 8.0.16, Nitro
  3.0.260610-beta, `CLK_TCK=100`
- **Primary fixture**: 128 synthetic Codex sessions, two synthetic Claude
  sessions, and a fixed synthetic machine identity

The checked-in orchestrator created a new owner-only
`plan052-usage-runtime-io-*` root for each run. It put source, `HOME`,
`TMPDIR`, every XDG directory, logs, the store, and child runtime state below
that root. Every child received an allowlisted environment rather than the
ambient environment, every Bun child used `--no-env-file`, and quota
collection used a fixture `codex` executable rather than an authenticated
ambient CLI. The tool stopped and verified every recorded process identity and
process group before removing only its own validated root. No measurement root
remained after either run.

Both source snapshots came from `git archive` at the exact revisions above.
The evidence document is intentionally absent from the after snapshot because
the measured implementation commit predates this document. Dependencies came
from the current workspace's `node_modules`; the identical `bun.lock` blob
above records that the dependency input did not drift between the two source
revisions. The historical `/tmp/ai-usage-*` population was never enumerated,
opened, changed, or deleted.

## Exact commands

These complete commands produced the tables. The explicit system Chromium
avoids a Playwright download and avoids using a user browser cache. The tool
performs fixture seeding, compiler preparation, readiness checks, interval
sampling, builds, process-group teardown, and root removal itself.

```sh
env -i PATH="$PATH" HOME=/nonexistent TMPDIR=/tmp TZ=Europe/Paris CI=1 \
  NO_COLOR=1 \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome \
  bun --no-env-file tools/measure-usage-runtime-io.ts \
  --revision=f2eb6c06469df9e43fcae0a1ae196f48af0faf92 \
  --concurrent-mode=legacy-observation --block-device=dm-0 \
  --codex-sessions=128 --cold-idle-ms=10000 --warm-idle-ms=10000 \
  --hmr-ms=10000 --concurrent-runs=1

env -i PATH="$PATH" HOME=/nonexistent TMPDIR=/tmp TZ=Europe/Paris CI=1 \
  NO_COLOR=1 \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome \
  bun --no-env-file tools/measure-usage-runtime-io.ts \
  --revision=6841af605832ca8a1c1f1e4c514d856d6c7780be \
  --concurrent-mode=isolated --block-device=dm-0 \
  --codex-sessions=128 --cold-idle-ms=10000 --warm-idle-ms=10000 \
  --hmr-ms=10000 --concurrent-runs=3
```

The disposable compiler warmup is outside every measurement interval and uses
an empty home. Consequently, “cold start” below means **process-cold and
compiler-warm**, not a cold dependency/compiler cache. The measured process is
new, its fixture home and store have no source run, and it creates the initial
stored publication.

The primary scenarios use the 128-plus-two history fixture. Concurrent
dev/build runs use a separate private root and the regression's bounded,
in-memory end-to-end fixture; they do not reuse the history fixture.

## Measurement semantics

The sampler polls `/proc` every 50 ms and uses 10 ms for the Sessions action.
Identity is `(pid, start-time ticks)`, so PID reuse cannot merge processes. For
processes already live at an interval boundary it subtracts starting
`write_bytes` and CPU ticks; a process born during the interval starts at zero.
It records peak aggregate RSS and threads and emits command names and roles,
not command-line paths. The tables below preserve every sampled process in a
normalized parent topology; nondeterministic PIDs are omitted.

Lease counts inspect only direct children of the harness-owned `TMPDIR` with
the exact legacy prefix. Traversal uses no-follow metadata reads, requires a
private directory owned by the current UID, rejects symlinks and special
entries, and sums regular-file logical bytes. Deleted-descriptor sampling is
likewise scoped to the selected dev output directory.

The collection interval includes the root request that triggers collection and
the resulting report query. Its lease delta is therefore an interval result,
not attribution to collection alone. The HMR interval performs and reverses an
actual source edit. Both before and after dev servers logged two HMR messages,
which confirms that Vite processed the edit.

`dm-0` writes are the host-wide `/proc/diskstats` sector delta multiplied by
512. They are noisy context, not process attribution. The zero process writes
beside large block-device values below demonstrate that distinction. CPU is
aggregate ticks divided by 100.

## Locked historical planning evidence

These values motivated plan 066. They came from maintainer-scale observations
before the isolated harness existed and were not regenerated from maintainer
state.

| Evidence | Historical value |
| --- | ---: |
| Vite process writes in one 10-second sample | 104 MB |
| Block-device writes in that sample | 122 MB |
| Other observed 10-second write samples | 239–394 MB |
| Vite RSS | approximately 2.1 GiB |
| Deleted legacy `.output` descriptors | 120 |
| Orphan Session query leases | 433 directories / 10,527,956,992 B |
| Representative Session query lease | approximately 45 MB |

## Comparable synthetic runtime evidence

Lease values are interval deltas. Deleted descriptors are the peak sampled
count. Every required metric was measured.

| Source / scenario | Duration | Process writes | `dm-0` writes | Peak RSS | CPU | Peak threads | Deleted FDs | Lease delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before / cold start | 2.982 s | 9,310,208 B | 3,170,304 B | 508,358,656 B | 3.93 s | 87 | 0 | 0 / 0 B |
| After / cold start | 2.988 s | 9,310,208 B | 3,338,240 B | 507,133,952 B | 3.86 s | 87 | 0 | 0 / 0 B |
| Before / cold idle | 10.009 s | 0 B | 203,800,576 B | 480,313,344 B | 0.07 s | 87 | 0 | 0 / 0 B |
| After / cold idle | 10.020 s | 0 B | 860,160 B | 475,578,368 B | 0.08 s | 87 | 0 | 0 / 0 B |
| Before / collection + publication interval | 2.221 s | 3,014,656 B | 4,984,832 B | 690,323,456 B | 3.90 s | 64 | 0 | +1 / +65,536 B |
| After / collection + publication interval | 2.211 s | 3,014,656 B | 7,016,448 B | 756,559,872 B | 3.83 s | 83 | 0 | +1 / +65,536 B |
| Before / warm idle | 10.013 s | 0 B | 61,059,072 B | 690,253,824 B | 0.24 s | 64 | 0 | 0 / 0 B |
| After / warm idle | 10.013 s | 0 B | 2,187,264 B | 676,163,584 B | 0.28 s | 64 | 0 | 0 / 0 B |
| Before / Sessions UI action | 3.426 s | 97,558,528 B | 12,075,008 B | 2,487,951,360 B | 7.96 s | 233 | 0 | +1 / +655,360 B |
| After / Sessions UI action | 3.681 s | 83,546,112 B | 297,553,920 B | 2,451,664,896 B | 7.57 s | 237 | 0 | +1 / +655,360 B |
| Before / source-edit HMR | 10.010 s | 0 B | 3,035,136 B | 1,202,585,600 B | 0.19 s | 76 | 0 | 0 / 0 B |
| After / source-edit HMR | 10.023 s | 0 B | 10,678,272 B | 1,157,292,032 B | 0.36 s | 79 | 0 | 0 / 0 B |
| Before / build without dev | 21.712 s | 15,716,352 B | 114,352,128 B | 2,447,544,320 B | 51.54 s | 86 | 0 | 0 / 0 B |
| After / build without dev | 21.417 s | 10,952,704 B | 34,045,952 B | 2,465,148,928 B | 50.26 s | 101 | 0 | 0 / 0 B |

Cold and warm idle had zero process-attributed writes in both sources. Wave 0
does not remove the initial/session materializer, copied revision database, or
query subprocess. The collection/publication interval observed one 65,536-byte
legacy lease. The Sessions navigation then observed one additional
655,360-byte lease, leaving two leases and 720,896 bytes live until runtime
teardown.

## Write-producing processes

Zero-write processes are retained in the topology table. Byte values below are
interval deltas and sum to the corresponding scenario total.

| Source / scenario | Write-producing processes |
| --- | --- |
| Before / cold start | dev Node 9,310,208 B |
| After / cold start | dev Node 9,310,208 B |
| Before / collection interval | dev Node 3,014,656 B |
| After / collection interval | dev Node 3,010,560 B; session-materializer Bun 4,096 B |
| Before / Sessions | dev Node 12,128,256 B; browser Bun 32,423,936 B; Chrome descendants 53,006,336 B |
| After / Sessions | dev Node 12,128,256 B; browser-action Bun 8,876,032 B; Chrome descendants 62,541,824 B |
| Before / build without dev | Node descendants 13,729,792 B and 1,986,560 B |
| After / build without dev | build-wrapper Bun 3,960,832 B; Node descendants 1,986,560 B, 1,970,176 B, and 3,035,136 B |

## Complete sampled process topology

Every process sampled in each interval is represented exactly once. Arrows
record parent-child relationships; multiplication records siblings with the
same normalized role. Short-lived workers that exited before role enrichment
retain their observed `dev Bun` role.

| Source / scenario | Count | Normalized parent topology |
| --- | ---: | --- |
| Both / cold start, cold idle, warm idle, HMR | 2 | dev Bun → dev Node |
| Before / collection interval | 3 | dev Bun → dev Node → short-lived dev Bun |
| After / collection interval | 3 | dev Bun → dev Node → session-materializer Bun |
| Before / Sessions | 18 | dev Bun → dev Node → Bun workers ×5 (revision-query ×3, short-lived dev ×2); browser Bun → Chrome main → {cat ×2, Chrome child ×3 → Chrome grandchild ×4} |
| After / Sessions | 17 | dev Bun → dev Node → Bun workers ×4 (revision-query ×3, short-lived dev ×1); browser-action Bun → Chrome main → {cat ×2, Chrome child ×3 → Chrome grandchild ×4} |
| Before / build without dev | 19 | build Bun ×4; Node ×10; esbuild ×5, rooted at build Bun → root Node with nested codegen, Vite, and Nitro branches |
| After / build without dev | 22 | build Bun ×7; Node ×10; esbuild ×5, rooted at build Bun → wrapper Bun with four locked phase branches |

## Comparable concurrent dev/build evidence

The barrier records process/block counters immediately before the primary
production build starts. The regression independently polls the live endpoint
and dev descriptors every 250 ms, retains bounded rolling logs, compares file
identities and process count, and verifies teardown. Descriptor results are
sampled evidence rather than continuous kernel tracing.

| Source / run | Build interval | Process writes | `dm-0` writes | Peak RSS | CPU | Threads | Healthy | Preserved files | Processes | Deleted FDs | HMR/reload | Contender |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Before / 1 | 21.956 s | 10,833,920 B | 71,770,112 B | 3,030,355,968 B | 53.16 s | 148 | 80 | 0 | 2 → 2 | 122 | 1 | not applicable |
| After / 1 | 23.884 s | 10,932,224 B | 72,486,912 B | 3,114,876,928 B | 56.51 s | 160 | 86 | 39 | 2 → 2 | 0 | 0 | exit 1, PID/path |
| After / 2 | 20.831 s | 10,973,184 B | 56,274,944 B | 3,084,414,976 B | 49.55 s | 167 | 77 | 39 | 2 → 2 | 0 | 0 | exit 1, PID/path |
| After / 3 | 20.847 s | 10,858,496 B | 53,108,736 B | 3,129,298,944 B | 48.43 s | 168 | 77 | 39 | 2 → 2 | 0 | 0 | exit 1, PID/path |

The concurrent process-write totals decompose as follows:

| Source / run | Write-producing processes |
| --- | --- |
| Before / 1 | Node descendants 6,991,872 B, 1,986,560 B, and 1,855,488 B |
| After / 1 | Bun 3,960,832 B; Node descendants 1,986,560 B, 73,728 B, 1,875,968 B, and 3,035,136 B |
| After / 2 | Bun 3,960,832 B; Node descendants 1,986,560 B, 1,875,968 B, 114,688 B, and 3,035,136 B |
| After / 3 | Bun 3,960,832 B; Node descendants 1,986,560 B, 1,875,968 B, and 3,035,136 B |

The complete concurrent topologies were 20 processes before (dev 2 plus build
18: Bun 4, Node 10, esbuild 4), 24 in after run 1 (dev 2 plus build 22: Bun 7,
Node 10, esbuild 5), and 23 in after runs 2 and 3 (dev 2 plus build 21: Bun 7,
Node 10, esbuild 4).

The synthetic planning run reproduced the maintainer-scale bug: the production
build replaced every recorded legacy dev-output identity, the live dev process
held 122 deleted `.output` descriptors, and Vite logged one HMR/reload. The
Wave 0 source preserved every recorded `.output-dev` identity in all three
runs, observed no deleted descriptor or HMR/reload, and rejected a root build
contender with the live PID and private lock path.

Wave 0 therefore fixes only the independent dev/build ownership collision.
Build I/O is not presented as an optimization. Collection cadence, sole SQLite
ownership, revision copies, per-query Bun processes, and lease growth remain
explicit acceptance work for waves 2 through 6.

## Final split evidence

- **Captured**: 2026-07-31, Europe/Paris
- **Measured source**:
  `89b4864dfa2d11916b2db70cf032c799ccaacc60`
- **Dependency lock**: `bun.lock` Git blob
  `20cce3baa63d6ef7977635ec314db4337592ef1a`
- **Runtime**: Linux, Bun 1.3.13, Vite 8.0.16, `CLK_TCK=100`
- **Fixture**: 128 synthetic Codex sessions, two synthetic Claude sessions,
  and one fixed synthetic machine

The final five-minute run used an immutable `git archive` of the source above
and the same private-root, allowlisted-environment, process-identity, no-follow
lease, and process-group cleanup rules described earlier. It exited zero and
removed its owned root. No maintainer history, configuration, store, log, or
pre-existing `/tmp/ai-usage-*` directory was inspected.

```sh
env -i PATH=/run/current-system/sw/bin:/usr/bin:/bin \
  HOME=/nonexistent TMPDIR=/tmp TZ=Europe/Paris CI=1 NO_COLOR=1 \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome \
  bun --no-env-file tools/measure-usage-runtime-io.ts \
  --revision=89b4864dfa2d11916b2db70cf032c799ccaacc60 \
  --concurrent-mode=isolated --block-device=dm-0 \
  --codex-sessions=128 --cold-idle-ms=10000 \
  --warm-idle-ms=300000 --hmr-ms=10000 --concurrent-runs=3
```

All eight machine-checked acceptance fields were `true`:

- collection path and process writes were attributable to the engine;
- deleted dev-output descriptors were absent;
- both engine dependency edits preserved the Web process;
- Web HMR preserved the engine instance, current publication, and SQLite file
  boundary with zero engine write bytes;
- every lease before/peak/after count and byte value was zero;
- no per-query Bun, revision-query, or Session materializer process appeared;
- the five-minute idle had no write loop.

### Final runtime intervals

Process writes are `/proc/<pid>/io` deltas for the measured process groups.
As above, `dm-0` is host-wide context and is not attributed to ai-usage.

| Scenario | Duration | Process writes | `dm-0` writes | Peak RSS | CPU | Peak threads | Deleted FDs | Lease before / peak / after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Collection + publication | 0.154 s | 3,534,848 B | 3,739,648 B | 950,542,336 B | 0.19 s | 174 | 0 | 0 / 0 / 0 B |
| Five-minute warm idle | 300.025 s | 0 B | 1,463,861,248 B | 961,302,528 B | 5.95 s | 174 | 0 | 0 / 0 / 0 B |
| Sessions UI action | 3.899 s | 74,272,768 B | 17,768,448 B | 2,632,867,840 B | 9.29 s | 299 | 0 | 0 / 0 / 0 B |
| Web source-edit HMR | 10.028 s | 0 B | 13,881,344 B | 1,456,173,056 B | 0.52 s | 174 | 0 | 0 / 0 / 0 B |
| Build without dev | 24.774 s | 12,779,520 B | 69,672,960 B | 2,472,153,088 B | 58.17 s | 96 | 0 | 0 / 0 / 0 B |

The warm-idle trace contains 30 samples from 10.039 seconds through 300.008
seconds. Every sample reports `totalWriteBytes: 0`; the enclosing interval also
reports zero process writes. The large host block-device delta therefore does
not represent an ai-usage write loop.

Collection mutated only these durable, attributable relative paths:

- `home/.config/ai-usage/codex-session-cache.sqlite`;
- `logs/wide-events-2026-07-31.ndjson`;
- `store/usage.sqlite`;
- `store/usage.sqlite-shm`;
- `store/usage.sqlite-wal`.

The engine process accounted for all 3,534,848 collection write bytes; Web
accounted for zero. No source, dev-output, revision-copy, or lease path changed.
The engine app-source and runtime-package edits produced exactly two sequential
engine rotations while the Web PID survived. After restoring source policies,
the Web edit produced HMR while preserving the engine instance and publication.

### Final concurrent dev/build intervals

Each isolated run used a fresh private root. The production build contender
failed with exit code 1, the dev process count stayed `2 → 2`, all 41 sampled
dev-output files retained identity, and no HMR/reload or deleted descriptor was
observed.

| Run | Build interval | Process writes | `dm-0` writes | Peak RSS | CPU | Threads | Healthy requests | Deleted FDs | HMR/reload | Contender |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 30.323 s | 14,360,576 B | 118,964,224 B | 3,064,291,328 B | 71.95 s | 162 | 104 | 0 | 0 | exit 1 |
| 2 | 24.479 s | 10,813,440 B | 105,566,208 B | 3,065,147,392 B | 60.55 s | 163 | 89 | 0 | 0 | exit 1 |
| 3 | 24.401 s | 12,689,408 B | 98,156,544 B | 3,059,073,024 B | 59.81 s | 158 | 89 | 0 | 0 | exit 1 |

### Before/after acceptance evidence

| Signal | Planning baseline | Final split |
| --- | --- | --- |
| Collection writer | Web dev Node plus Session materializer | Engine only; Web 0 B |
| Collection lease growth | +1 directory / +65,536 B | 0 directories / 0 B |
| Sessions lease growth | +1 directory / +655,360 B | 0 directories / 0 B |
| Per-query report workers | Three revision-query Bun workers | None |
| Active-build deleted dev descriptors | 122 | 0 in three runs |
| Active-build HMR/reload | 1 | 0 in three runs |
| Five-minute warm-idle process writes | Not previously proven | 30 zero-growth samples; 0 B total |

The first full-duration attempt exposed that the current projection's
five-minute retention timestamp was also being treated as a read expiry. The
reader now exempts only the current pointer; once superseded, the same revision
is expired normally. Focused store and Web tests prove both sides of that
contract, and the successful immutable run above repeats the unchanged
five-minute and Sessions order rather than masking the boundary with a longer
TTL or a publication heartbeat.
