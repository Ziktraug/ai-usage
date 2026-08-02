# Plan 068 Execution State

This file is the coordinator-owned execution ledger for
`plans/068-migrate-web-to-sveltekit-orpc.md`. Packet workers and reviewers must
not edit it. The machine-readable parity ledger introduced by B1 remains the
authority for feature, operation, design, source-file, and test-title coverage.

## Run identity

- Started: 2026-08-02
- Coordinator integration branch: `agent/migrate-web-sveltekit-orpc`
- Planning PR: `#26`, squash-merged as
  `2183270ebfbb886fafa7e6268893122db9b364c0`
- `BASE_SHA`: `2183270ebfbb886fafa7e6268893122db9b364c0`
- Current integration checkpoint: B0 ledger commit pending independent review
- Last reviewed green checkpoint: `2183270ebfbb886fafa7e6268893122db9b364c0`
- Implementation PR: not opened
- Exclusive process-test token: coordinator owned

The integration branch did not exist locally or remotely before this run. Local
`main` and `origin/main` were clean and aligned at `BASE_SHA`; plans 066 and 067
were DONE, Plan 068 was TODO, and no unrelated user changes were present.

## Frozen decisions and invariants

- Svelte 5/SvelteKit owns Web routing and SSR; contract-first oRPC owns only the
  browser-to-Web boundary; TanStack Svelte Query owns explicit cache/SWR state.
- Web and CLI retain bounded direct read-only/query-only SQLite access. The
  usage engine remains sole writer and exposes only its authenticated numeric-
  loopback operational control plane.
- Browser code imports contracts, schemas, public errors, and the browser client
  adapter only. It cannot reach router implementations, server modules, Node,
  Bun, usage-store, report-data, local-machine, or engine implementations.
- Exact served revisions remain revision-keyed, fingerprint-validated,
  supersedable, retried once on expiry, and atomically committed by the existing
  deep coordinator.
- Source-control SSE and manual file upload/download remain explicit transports.
  They are not hidden in oRPC, Query, SvelteKit remote functions, or actions.
- Web never imports `@ai-usage/usage-merge` or usage-engine-runtime. Runtime
  adapters reuse `@ai-usage/usage-engine-control/node` identity and liveness
  helpers rather than copying them.
- Demo mode selects synthetic adapters before any live database, filesystem,
  Skills, engine, or network acquisition.
- Product routes, URL state, calculations, copy, accessibility, keyboard/focus,
  responsive layout, visual tokens, privacy, and operational behavior do not
  change as part of the migration.
- Workers use isolated local worktrees and synthetic homes, stores, ports, logs,
  rendezvous paths, and build outputs. Packet branches remain local-only.
- Only independently ACCEPTed packet commits are cherry-picked. Semantic
  conflicts are redispatched from a compatible checkpoint; generated conflicts
  are regenerated from accepted sources.
- Exactly one draft implementation PR may be opened, after X2 ACCEPT. It remains
  draft and unmerged.

## B0 entry evidence

The Plan 068 drift command produced no output between planned commit `72c648e`
and `BASE_SHA` for `apps/web`, `packages/design-system`,
`packages/web-contract`, `tools`, workspace manifests, Turbo, ADRs, or
architecture documentation. The only post-plan-base changes were the merged
Plan 068 documentation and status row. No served-revision, direct-read,
sole-writer, trust, demo-privacy, file-transfer, or process-identity invariant
drifted.

| Command | Result |
| --- | --- |
| `bun install` | PASS; 525 installs checked, no changes |
| `bun run check` | PASS; 710 files checked |
| `bun run lint` | PASS; architecture and package boundaries green |
| `bun run typecheck` | PASS; 26/26 Turbo tasks |
| `bun test apps/web/src apps/web/*.test.ts` | PASS; 585 tests |
| `bun run test` | PASS; 26/26 package tasks and 69 tool tests |
| `bun run build` | PASS; 14/14 workspaces and uncached Web production build |
| `bun run test:e2e` | PASS; 90 tests |
| `bun run test:e2e-demo` | PASS; destructive-negative demo privacy test |
| `bun run test:e2e-production` | PASS; 7 production report tests and 2 scale tests |
| `bun run --cwd apps/web benchmark:session-scroll` | PASS; 4 tests and 3 retained samples |
| `bun run test:web-production` | PASS; production lifecycle and collision cleanup |
| `bun run test:web-dev-build-isolation` | PASS; 79 healthy concurrent-build requests, no deleted dev descriptors |
| `bun run test:setup-loopback` | PASS; IPv4 loopback only |
| Disposable worker-isolation probe | PASS; clean detached worktree, five synthetic runtime roots, ephemeral IPv4-loopback listener |
| `git diff --check` | PASS; no output |
| `git status --short --branch` | PASS; clean integration base |

Retained Session benchmark medians at B0:

| Metric | Median |
| --- | ---: |
| Initial load | 1535.192 ms |
| Filter | 332.803 ms |
| Sort | 1409.614 ms |
| Heap delta | 32,452,828 bytes |
| Maximum page payload | 321,397 bytes |
| Desktop rendered items / Session DOM nodes | 33 / 624 |
| Mobile rendered items / Session DOM nodes | 17 / 258 |

The documentation-only planning PR observed two pre-existing CI timing misses:
the CLI foreground-timeout test and the TypeScript coverage guard. Each exact
local suite passed, and the complete B0 local suite subsequently passed without
an allowlist, skipped check, weakened assertion, or timeout change.

The coordinator also created a disposable detached worktree at the B0 ledger
commit, created separate temporary home, store, log, rendezvous, and build-output
roots outside the checkout, and served a successful HTTP probe on ephemeral
numeric IPv4 loopback port `40417`. The detached checkout remained clean at
`40cda764f655d68608f378dd9f8d02e4160e0f52`; the probe worktree and empty
runtime roots were then removed. B1/B2 dispatch will use the same mechanism with
packet-unique paths and ports.

## Packet ledger

Statuses are `BLOCKED`, `READY`, `IMPLEMENTING`, `REVIEW`, `REWORK`,
`ACCEPTED`, `INTEGRATED`, or `STOP`.

| Packet | Prerequisites | Status | Implementer commits | Reviewer / verdict | Integrated checkpoint |
| --- | --- | --- | --- | --- | --- |
| B0 | none | REVIEW | coordinator ledger pending | pending | pending |
| B1 | B0 | BLOCKED | - | - | - |
| B2 | B0 | BLOCKED | - | - | - |
| F0 | B1, B2 | BLOCKED | - | - | - |
| V0 | F0 | BLOCKED | - | - | - |
| V1 | V0 | BLOCKED | - | - | - |
| V2 | V0 | BLOCKED | - | - | - |
| V3 | V0 | BLOCKED | - | - | - |
| V4 | V0 | BLOCKED | - | - | - |
| V5 | V1, V2, V3, V4 | BLOCKED | - | - | - |
| Q0 | V5 | BLOCKED | - | - | - |
| Q1 | Q0 | BLOCKED | - | - | - |
| Q2 | Q0 | BLOCKED | - | - | - |
| Q3 | Q1, Q2 | BLOCKED | - | - | - |
| D0 | F0 | BLOCKED | - | - | - |
| D1 | D0 | BLOCKED | - | - | - |
| D2 | D0 | BLOCKED | - | - | - |
| D3 | D0 | BLOCKED | - | - | - |
| D4 | D1, D2, D3 | BLOCKED | - | - | - |
| R0 | F0, V5, Q3, D4 | BLOCKED | - | - | - |
| R1 | R0 | BLOCKED | - | - | - |
| P1 | R1, V1, V2, Q1, D4 | BLOCKED | - | - | - |
| P2 | P1 | BLOCKED | - | - | - |
| P3 | P1, V2, Q1, D4 | BLOCKED | - | - | - |
| P4 | P3 | BLOCKED | - | - | - |
| P5 | R1, V3, Q2, D4 | BLOCKED | - | - | - |
| P6 | R1, V4, Q2, D4, B2 | BLOCKED | - | - | - |
| P7 | R1, V4, Q2, D4 | BLOCKED | - | - | - |
| P8 | P1 | BLOCKED | - | - | - |
| P9 | P5 | BLOCKED | - | - | - |
| P10 | P5 | BLOCKED | - | - | - |
| X0 | P2, P8, P4, P9, P10, P6, P7 | BLOCKED | - | - | - |
| X1 | X0 | BLOCKED | - | - | - |
| X2 | X1 | BLOCKED | - | - | - |

## Review and integration ledger

No packet has been accepted or integrated yet. B0 awaits a different agent's
two-axis review of this ledger, branch provenance, drift evidence, and complete
baseline results.

## Deviations, STOPs, and recovery

- Reviewed deviations: none.
- Active STOP condition: none.
- Failed packet worktrees: none.
- Recovery point: `BASE_SHA` is the last reviewed green checkpoint until B0 is
  independently accepted.
