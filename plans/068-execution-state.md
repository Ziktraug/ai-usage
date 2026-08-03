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
- Current integration checkpoint: `c8fb80e`
- Last reviewed green checkpoint: `656ef4e`
- Active design bases: D1 `4862293`, D2 `fce5c1a`, D3 `e2f13cd`
- Implementation PR: not opened
- Exclusive process-test token: free after the Q3 production, scale, and benchmark gates

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
| B0 | none | INTEGRATED | `40cda764f655d68608f378dd9f8d02e4160e0f52`, `2051c4887894e42f31b309adf8446869d2e1b566` | `/root/b0_review` / ACCEPT | `2051c4887894e42f31b309adf8446869d2e1b566` |
| B1 | B0 | INTEGRATED | `2613d9b`, `175e2d0`, `cd90bce`, `4348a2e1138a98a9dfd19b8de9bd3d839e3dc77e` | `/root/b1_final_review` / ACCEPT | `5f43d59` |
| B2 | B0 | INTEGRATED | `416ed3befda96e101763f129ddd32151a12f6ed2`, `f9fa43e3abff4ec14107cdd16272597e9bc8dc46` | `/root/b2_re_review` / ACCEPT | `28d2f42` |
| F0 | B1, B2 | INTEGRATED | `dd1469a`, `ee9a24e` | `/root/f0_final_review` / ACCEPT; Vite seam: `/root/b2_re_review` / ACCEPT | `ee9a24e` |
| V0 | F0 | INTEGRATED | `e95616f`, `848ad36`, `266d88d`, evidence `e76cc23`, `9b38bb2` | `/root/v_vertical_audit` / ACCEPT | `9b38bb260383d2743b0da1408c33d36b99f94d61` |
| V1 | V0 | INTEGRATED | `a9ce980`, `8cccff8`, `46d2b58`, evidence `d4c8457`, correction `9b17da8` | `/root/v_vertical_audit`, `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `4ddf145` |
| V2 | V0 | INTEGRATED | `bfae6c6`, `ab1ae5f`, `0db6f75`, `7c790c1`, `19c4c3b`, evidence `d4c8457`, correction `9b17da8` | `/root/v_vertical_audit` / REWORK; `/root/v0_impl`, `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `4ddf145` |
| V3 | V0 | INTEGRATED | `d465e65`, `9545bb0`, `4e87ebe`, evidence `71dc320`, correction `4ddf145` | `/root/v0_impl`, `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `4ddf145` |
| V4 | V0 | INTEGRATED | `bcff1ea`, `34e76eb`, `632ce8a`, `dcb8ecb`, `b59f264`, evidence `71dc320`, correction `4ddf145` | `/root/v0_impl`, `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `4ddf145` |
| V5 | V1, V2, V3, V4 | INTEGRATED | `781901a`, `f6bde5a`, `b93b70c`, `9804135`, `3dcf2bb`, `0d4f20a`, `66bc4d0`, `8b6164f`, `b0a6518`, `0a21f62`, `1529101`, `bed49d9`, `067b4bb`, `c87054f`, `04bc076`, convergence `9799299`, `7e0c6ef`, `9b17da8`, `4ddf145` | `/root/v5_bounds_review`, `/root/v5_transport_review`, `/root/v5_abort_review`, `/root/v5_loopback_review`, `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `4ddf145e4d29f92e059fb8deec3513e8af076d5b` |
| Q0 | V5 | INTEGRATED | `31c85a0`, correction `2f55410` | `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `2f55410ec9296dd2f66962d6ee3e4d2340e554b2` |
| Q1 | Q0 | INTEGRATED | `97e34b4`, correction `9366ace`, correction `656ef4e` | `/root/v5_parity_spec_review`, `/root/q2_spec_review` / ACCEPT | `656ef4e` |
| Q2 | Q0 | INTEGRATED | `3d0490a` | `/root/v34_parity`, `/root/q2_spec_review` / ACCEPT | `3d0490a8052a73da024ea523f3c0012d0e2aca9f` |
| Q3 | Q1, Q2 | REVIEW | `614174f`, corrections `0ecbd21`, `c8fb80e` | `/root/q2_spec_review` / ACCEPT; `/root/d123_parity_review` / REWORK; second correction re-review pending | candidate checkpoint `c8fb80e` |
| D0 | F0 | INTEGRATED | `d476690`, `65d48b4`, `3cea781`, `f84ad2c`, evidence `bd948a7`, `a27764b`, correction `7e0c6ef` | `/root/v_vertical_audit`, `/root/v0_impl`, `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `4ddf145` |
| D1 | D0 | INTEGRATED | `4862293`, `3b22c28`, evidence `b31c3af` | `/root/d123_parity_review` / ACCEPT | `b31c3af` |
| D2 | D0 | INTEGRATED | `fce5c1a`, `9935846`, evidence `b31c3af` | `/root/d123_parity_review` / ACCEPT | `b31c3af` |
| D3 | D0 | INTEGRATED | `e2f13cd`, `0702203`, `70f5796`, evidence `b31c3af` | `/root/d123_parity_review` / ACCEPT | `b31c3af` |
| D4 | D1, D2, D3 | INTEGRATED | `662182e`, bundle correction `6646fe5` | `/root/d4_review` / ACCEPT | `6646fe568e8b4c1fba74ac1b4150d1480d15ca6f` |
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

B0 was independently reviewed over
`2183270ebfbb886fafa7e6268893122db9b364c0..2051c4887894e42f31b309adf8446869d2e1b566`.
`/root/b0_review` returned ACCEPT on both parity/spec and code-quality/seam axes.
The review confirmed the exact base and planning-PR provenance, branch
ownership, Plan status and drift result, complete green Solid baseline, worker
isolation probe, packet DAG, recovery point, and absence of scope creep. It
also verified both recorded planning-PR timing misses against Actions run
`30752460299`; no B0 STOP condition remains.

B1 and B2 were dispatched concurrently from
`b1bc3c7414918041acef6c7eb7a914a2880d91f9` into local-only isolated worktrees
`/tmp/ai-usage-068-b1` and `/tmp/ai-usage-068-b2`. Their mandatory cards freeze
non-overlapping write sets, all assigned parity IDs, coordinator-owned files,
targeted gates, two-attempt STOP rules, and the exact handoff contract. B2 alone
holds the delegated process-test token with packet-unique ports and outputs.

B1 returned clean commits `bf39106fa692663957c26ac12ed063eb21dcd9a6` and
`11e184f08528b7ff7a1153443322713bd0df0b94`, a 3,484-line allowlisted delta.
Its scoped gates passed: targeted Ultracite, 40 parity/boundary tests, the
package-boundary checker, Web typecheck, and the aggregate ledger at 35
features, 30 operations, 72 production TSX files, 15 design rows, 385 design
exports, 11 render suites, 104 Playwright titles, and 18 URL contracts. Both
allowed lint corrections were consumed and the final lint result is green.
`/root/b0_review` returned REWORK on both required axes. Confirmed hard gaps are
the missing Wave-0 bundle/HTML/hydration/request/startup measurements; a final
checker that accepts Solid-only COMPLETE evidence and feature removals;
hard-coded server-wrapper discovery and deletion-unsafe render discovery;
missing `colsBase=work` and provider-quota `ForbiddenDemo` parity; evidence
stamped before the reviewed B0 checkpoint; all 26 ledger modules missing from
root TypeScript coverage; malformed records crashing instead of failing closed;
invalid shard owners passing; duplicated schema types; and I/O errors treated
as absent files. The review's scoped commands otherwise reconfirmed the exact
inventories, 40 tests, targeted Ultracite, boundary checker, path/size cap and
clean worktree. The commits remain recoverable in `/tmp/ai-usage-068-b1` and
were not cherry-picked. After the user relaxed local STOP handling, the original
implementer resumed B1. Its 48 focused tests, parity/package checkers, TypeScript
coverage and root typecheck are green; process measurements wait for the B2 token.

B2 initially stopped after exhausting both allowed focused corrections for the bounded
SSE lifecycle harness. The exact final command was `bun --no-env-file probe.ts`
in `/tmp/ai-usage-068-b2-spike.1VftYr/app`. The unchanged adapter-node artifact
served `event: held` and `data: 31100` after approximately 31.1 seconds, but on
both attempts Bun 1.3.13 remained blocked while consuming a deliberately open
stream client's subprocess output. The final native-curl attempt exceeded the
40-second client plus 8-second shutdown bound and left probe PID `204820` and
adapter PID `204841` alive past two minutes. The worker stopped those exact
synthetic processes, released port `42501`, and returned the process token. The
coordinator independently confirmed both PIDs and the listener were gone, the
B2 Git worktree was clean, and the recoverable synthetic spike remained at the
path above. No B2 commit was produced or integrated, and no B2 dependant may be
dispatched until B2 is independently accepted and integrated.

On 2026-08-02 the user explicitly relaxed Plan 068 local STOP policy for this
run: technical packet failures must be documented and corrected autonomously,
and execution stops only for a major blocker that calls the viability of the
complete migration into question. B2 was therefore redispatched for a fresh
audit using native curl with packet-isolated file-backed output rather than
Bun-managed subprocess pipes. The product invariant remains unchanged: the
production artifact must serve the held SSE event, terminate within the bounded
client/shutdown window, release its port and leave no descendants.

The fresh adapter-node audit is retained at
`/tmp/ai-usage-068-b2-spike-pass.csh2Si`. File-backed browser/server/curl output
removed the Bun pipe deadlocks, and bounded request-body reconstruction made
external oRPC success and closed-error responses reliable. Adapter-node was
then rejected for two independent Bun lifecycle failures: neither graceful FIN
nor forced client reset reached the delayed handler AbortSignal through public
request/socket events, and the generated SIGTERM shutdown left the process alive
past `SHUTDOWN_TIMEOUT` plus the eight-second harness bound. Every exact orphan
process group and listener was cleaned. Wave 1 therefore advanced to its mandated
`svelte-adapter-bun` fallback; this is an active ecosystem decision, not a STOP.

B2 then produced local commit
`416ed3befda96e101763f129ddd32151a12f6ed2` with its decision, ADR and
reusable lifecycle harness. Independent parity and standards review returned
REWORK. The committed test launched a plain `Bun.serve` fixture instead of a
built selected-adapter SvelteKit artifact, and the decision paired
`svelte-adapter-bun` version `1.0.1` (peer TypeScript `^5`) with incompatible TypeScript
`6.0.3`. The review also found partial-acquisition cleanup gaps, artifact
integrity limited to file identity and size, a timeout below the complete
failure envelope, spread accumulation, and decision assertions that did not
freeze exact values. B2 was redispatched to turn the disposable evidence into
an actual selected-adapter regression, resolve the peer set and harden failure
cleanup; the first commit remains local-only and unintegrated.

During B2 rework's first committed-fixture lifecycle attempt, the private
`bun install --frozen-lockfile` reached its 60-second setup deadline before any
SvelteKit server started. Cleanup passed. Read-only inspection identified an
overlapping B1 parity checker whose inventory path had spawned Playwright
`--list` despite being classified as static. The exact processes then exited
normally, no Plan listener remained, and the coordinator barred B1 from further
process-capable checkers until B2 returns the token. B2 retained the exclusive
token for one clean rerun after an evidence-based cold-install setup bound
correction; lifecycle, SSE and shutdown budgets remain unchanged.

The clean rerun completed its frozen install in about 41 seconds and then failed
deterministically in fixture Svelte check before starting a server: the isolated
fixture omitted a direct `@types/node` pin, so `process` in its shutdown hook had
no type. The private root was removed and B2 returned the token. Under the
relaxed STOP policy B2 received a third, narrower static correction to add an
exact compatible Node type dependency and regenerate only the fixture lock; it
must wait for a later token transfer before another lifecycle run.

B2's corrected full range was independently ACCEPTed on parity and standards.
The committed selected-adapter gate passed 4 tests and 8 assertions in 172.04
seconds before integration, then passed again post-cherry in 169.69 seconds.
Both runs built the exact-pinned private SvelteKit artifact, served meaningful
SSR and the static asset, held SSE for 31.1 seconds, exited through the shutdown
event with no process group, released the port, preserved artifact identity,
metadata and SHA-256 content, and removed private roots/generated output. The
coordinator cherry-picked B2 as `01a758d` and `28d2f42`; the integration branch
remained clean. Broader oRPC/Query/Ark/Panda/context/import-guard/supervisor
compatibility remains explicitly classified as disposable-matrix evidence for
F0 and later boundary gates.

B1's two fresh isolated production measurements then exposed a separate Wave-0
invariant failure: `getReportRevisionBootstrap` was requested exactly twice
before hydration in both runs. The samples recorded bootstrap counts `2/2`,
HTML size `36,832` bytes, 16 requests, TTFB `10.3/9.4` ms, hydration
`107.5/108.1` ms, and zero active fetch/XHR queries after settlement. B1's
static rework remains green and recoverable, but its runtime ownership did not
permit changing the Solid bootstrap lifecycle. Under the user's relaxed STOP
policy the coordinator therefore dispatched focused correction B1-C from
`05650f7a1a99c2b589332fc0b932a30585f4f878` in isolated worktree
`/tmp/ai-usage-068-b1-bootstrap-fix`. B1-C must first produce a deterministic
red regression, diagnose the request provenance, preserve ADR 0007 and all
product behavior, and eliminate the duplicate before B1 is redispatched for
fresh performance evidence.

B1-C produced local commit
`c7a2c445a45ca6fd360ed5559cacc6d1800f6fa4`. Its deterministic test failed
twice before the fix with expected one/received two acquisitions, then passed
with instance-local one-shot descriptor seeding plus fresh later refresh, expiry
retry and instance-isolation coverage. The exact synthetic production replay on
port `45177` observed the bootstrap operation hash once, 36,995 HTML bytes, 15
requests, 10.3 ms TTFB, 111 ms hydration and no fetch/XHR after settlement;
the listener and fixture roots were released. `/root/b1_bootstrap_review`
returned ACCEPT on both axes. The coordinator cherry-picked the correction as
`c85b077`, then passed 34 focused tests, root TypeScript coverage/typecheck and
diff cleanliness. B1-C is integrated; B1 must now be redispatched from this
compatible checkpoint and reproduce its complete budgets.

Fresh B1 redispatch from `7d1ff6e` applied the three recoverable commits without
conflict and added measured-baseline commit
`4348a2e1138a98a9dfd19b8de9bd3d839e3dc77e`. The final candidate passed exact
inventories `35/30/72/15/385/11/104/18`, 48 focused tests, 26/26 type tasks,
build, 90 browser tests, demo, production `7+2`, DOM, benchmark, production
lifecycle, dev/build isolation and loopback with an empty process/listener audit.
It measured one bootstrap, zero duplicate URLs and pending queries, 36,995-byte
HTML, 9.5 ms TTFB, 117.5 ms hydration and budgets documented in the performance
baseline. `/root/b1_final_review` returned ACCEPT on both axes; the bounded
wide-event file-sink lock timeout was honestly classified as lost synthetic
telemetry with successful assertions and cleanup. The coordinator cherry-picked
B1 as `a64ec59`, `57118ca`, `2ef4c50` and `5f43d59`. On the combined B1+B2
checkpoint, 48 focused tests, exact parity discovery, boundaries, TypeScript,
build, browser 90/90, demo 1/1, production 7/7+2/2, lifecycle, isolation and
loopback all passed again. B1 is integrated and F0 is ready.

## F0 foundation checkpoint

F0 candidate `dd1469a` establishes the isolated SvelteKit shadow, the empty
contract-first `@ai-usage/web-contract` package, exact framework pins, recursive
scanner coverage for Svelte and generated outputs, and framework-neutral table,
navigation-intent, and subscription vocabulary. The shadow owns only
`.svelte-kit-shadow/<phase>` and `.output-svelte-shadow/<phase>`; it cannot write
the Solid production output and contains no product route, live adapter,
transport, query cache, database, engine, Skills, or maintainer-state access.

The exact F0 dependency set keeps root TypeScript 6.0.3 while Web uses local
TypeScript 5.9.3 for the selected adapter peer set. Svelte 5.56.8, SvelteKit
2.70.2, the Svelte Vite plugin 7.2.0, svelte-adapter-bun 1.0.1, Ark Svelte
5.22.1, TanStack Svelte Query 6.1.38, oRPC 1.14.13, Panda 1.12.0, and Vite
8.2.0 are exact. Frozen install and lockfile reproduction passed.

Vite 8.2.0 changed the legacy Solid/Rolldown chunk topology and raised the
measured gzip closure from the preserved 8.0.16 baseline of 282,169 bytes to
285,305 bytes, above the unchanged 282,614-byte limit, while the generated CSS
remained byte-identical at 76,716 raw / 17,022 gzip. No source, Panda, product,
assertion, or budget change caused the regression. F0 therefore pins a
production-build-only `vite-solid` alias at 8.0.16 and launches its real CLI
through the existing owned build lock. The measured closure is 277,917 bytes,
4,697 below the limit, and the full client, SSR, and Nitro artifact is present.
`/root/b2_re_review` independently ACCEPTed this narrow seam. It must be deleted
atomically with the Solid build in X1; dev/preview remain on Vite 8.2.0, the
private CLI path is bounded by the exact pin, and the wrapper must never be
reused for SvelteKit.

| F0 command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS |
| `bun run check` | PASS; 768 files |
| `bun run lint` | PASS; recursive package, export and path boundaries |
| `bun run typecheck` | PASS; 28/28 tasks, Svelte 0 errors and 0 warnings |
| `bun run test` | PASS; 28/28 package tasks, Web 593 tests, tools 93 tests |
| `bun run build` | PASS; Solid client, SSR and Nitro |
| `bun run build:svelte` in `apps/web` | PASS; isolated adapter-bun artifact |
| focused build lock and CSS suite | PASS; 14 tests |
| foundation non-regression suite | PASS; 89 tests |
| `git diff --check` | PASS |

Resolved F0 implementation incidents are retained as evidence rather than STOPs:
the unavailable bubblewrap patch helper required exact local edit fallbacks; one
parity-checker edit and one package-script edit were immediately restored after
mechanical truncation/corruption and validated by the full gates; an accidental
Solid-table import rewrite was corrected before tests; generated Svelte env
declarations initially reflected inherited variable names, so the shadow now
fails closed with an explicit private prefix; supplemental TypeScript inclusion
and public-export declarations were tightened after the scanners correctly
identified bleed and undeclared tool imports. `bun install` loaded repository
environment configuration but no value was printed or copied, and all runtime
proofs used synthetic or generated state only.

`/root/f0_final_review` independently reviewed `1c76dad..ee9a24e` on both
required axes and returned ACCEPT. Its 41 focused tests / 50 assertions, public-
export, relative-path, package-boundary, diff-cleanliness, leakage and tracked-
generated-output checks passed. The reviewer confirmed no product, transport,
served-revision, writer, privacy or route behavior changed and retained only the
X1 deletion obligations for the exact-pinned Solid Vite wrapper. F0 is integrated. V0 and D0 were dispatched concurrently from `3ed2259`
to local-only isolated worktrees `/tmp/ai-usage-068-v0` and
`/tmp/ai-usage-068-d0`. Their mandatory cards freeze exact parity shards,
non-overlapping write sets, coordinator hot-file denylists, scoped gates and
handoffs. Neither worker owns the exclusive process-test token. The read-only V1-V4 audit completed without starting a dependent packet. It froze
disjoint leaves and identified coordinator-owned explicit contract exports as
the only prerequisite composition delta after V0.

Two dispatch-card commands were corrected without weakening a gate. The named
`apps/web/src/design-system-contract.test.ts` does not exist at the exact base;
D0 used the actual preset, generated-artifact and CSS-bundle authorities. Bun
1.3.13 also treats `bun --cwd <dir> run <script>` as a help-only exit-zero path,
so no such result was credited; every affected gate was rerun with the effective
`bun run --cwd <dir> <script>` syntax.

V0 converged through worker commits `e95616f`, `848ad36` and `266d88d`,
cherry-picked as `26967ea`, `5f3af77` and `7711974`. Descriptor-based JSON
validation never invokes accessors, every policy outcome is closed by
`PublicErrorFamily`, and the explicit `errors` and `schema-conventions` exports
keep the root contract empty. Evidence commits `e76cc23` and `9b38bb2` honestly
leave SECURITY-01 current until V5/R1 apply the kernel. Independent review and
post-integration gates passed: 53 tests, 792 assertions, 28/28 type tasks and
the Svelte shadow build.

D0 converged through `d476690`, `65d48b4`, `3cea781` and `f84ad2c`, mapped on
the integration branch through `8474f18`. The normalized CSS comparator now
preserves cascade order, quoted comment text, duplicate placement and unique
conflicting declaration winners. Independent adversarial review and the final
post-integration suite passed 21 tests and 158 assertions with byte-identical
artifacts and no framework runtime in passive closure. Evidence `bd948a7` was
cherry-picked as `bf94c65`; only preset/global CSS and passive modules are
complete, while semantic exports, icons and all 301 public exports remain
honestly current for D4.

Coordinator prerequisite commits `74fd6a9` and `ee6c59e` add only five empty
vertical leaves and their public exports. Review initially rejected a broad
Skills package-prefix allowlist because it could reach filesystem-backed
application code. The focused correction admits only exact pure `config` and
`shared` subpaths and rejects root, application and unknown subpaths. Contract
16/16, root typecheck 28/28, boundaries, parity and Svelte shadow build passed;
`/root/v_vertical_audit` returned ACCEPT on both axes for
`9b38bb2..ee6c59e`. V1-V4 are unblocked from reviewed checkpoint `bf94c65`.

V1-V5 transport convergence is implemented and independently accepted on all
review axes. Solid callers use oRPC or the frozen explicit SSE/file routes;
production server-function wrappers and warmup code are gone. Browser response
consumption is bounded, abort cleanup does not wait on a stuck reader, and the
exact caller reason survives cancellation. Request cancellation reaches the
actual report/quota/revision/sync Effect reads, Session local-history Effect
runtime and VCS subprocess. The Session correction at `bed49d9` added an active
acquire/use/release interruption proof and exact signal-identity assertion.

The real Nitro loopback gate is permanently available as
`bun run test:web-rpc-loopback`. It proves numeric-loopback registration and
dynamic import, validation, typed/sanitized errors, uniform live/demo 404,
Host/origin/CSRF policy, concurrent dependency isolation and oversized-response
replacement. Two Vite/Bun adapter limitations were isolated rather than hidden:
an oversized streamed upload does not settle within the frozen five-second
loopback phase, so the exact 12 MiB + 1 byte stream remains proven at the real
handler seam; Vite dev interposes socket lifecycle before `event.req.signal`,
so the production `req.socket.close`/`res.finish` bridge and listener cleanup
are proven by route integration tests. The first permanent run exposed a Nitro
watcher leak after printing success. Commits `067b4bb` and `c87054f` make the
fixture own and close its Nitro instance idempotently and pass a bundling-stable
synthetic Web root. The integrated gate then exited naturally with status zero
in 0.91 seconds. `/root/v5_loopback_review` re-reviewed both corrections and
returned ACCEPT.

D1-D4 are integrated. The design package root is framework-neutral, coexistence
uses explicit `/solid` and `/svelte` entrypoints, and the recursive Svelte
closure cannot reach TSX, Solid or Ark Solid. Panda scans TS, TSX and Svelte;
generated CSS/token output is unchanged. `/root/d4_review` ACCEPTed both axes.
The frozen root-route gzip closure is 263,392 bytes against the unchanged
282,614-byte limit. Restoring this gate required moving Sync RPC out of the
eager route graph, separating Report query keys from Skills implementation and
lazy-loading the optional Session drawer; no threshold or assertion changed.

Checkpoint validation through `04bc076` passed repository check/lint, all 28
typecheck tasks with Svelte 0/0, the complete production build, 668 Web tests,
the Nitro loopback gate and the exact D1-D3 browser fixtures. The first full
repository test attempt encountered `EINVAL: watch` in D3 while Turbo ran
packages concurrently; the single exact rerun passed 10/10 and 93 assertions,
classifying the environment watcher failure without a timeout/assertion change.
Its untracked two-file fixture directory was moved intact to
`/tmp/ai-usage-068-d3-watch-artifact-xbGOHQ`. An independent D4 reviewer also
accidentally selected one isolated Chromium test with a broad directory glob;
it used no shared port/artifact and was not rerun. The first post-V5 typecheck
correctly found `rpc-test-transport.test.ts` outside every project; `04bc076`
adds it to the Web project and the complete coverage/typecheck gate is green.

Final V1-V4/D0-D3 parity evidence landed through `a27764b`, `d4c8457`,
`b31c3af` and `71dc320`; `9799299` updates the checker assertions to the exact
retired/live inventory. The first independent convergence review returned
REWORK because several command claims were attached to earlier SHAs and V3/V4
had replaced frozen Wave-0 parser descriptions with target schemas. Focused
corrections `7e0c6ef`, `9b17da8` and `4ddf145` restore the baseline inventory,
retain target schemas only as target evidence and attach each command/review to
the checkpoint where it actually passed. Both independent re-reviews returned
ACCEPT. The final aggregate is 30 operation ledger records with no live legacy
wrapper, plus 402/402 live design exports and 425 ledger records including 23
reviewed removals.

During the V1/V2 rework, the worker accidentally ran the intended cherry-pick
from the integration workdir rather than its combined detached worktree. The
resulting `9b17da8` touched only the two allowlisted shards, applied without a
conflict and was retained after coordinator inspection, full parity gates and
both independent re-reviews. No reset, branch overwrite or unrelated mutation
was performed; the source correction remains recoverable as `4bcd9c0` in the
isolated V1/V2 parity worktree.

Q0 is integrated through `31c85a0` and focused correction `2f55410`. It adds a
request-scoped QueryClient factory, named current/immutable/finite-SWR/control
policies with bounded GC, typed key vocabulary, hydration/dehydration seam and
pure cache harness. The first spec review returned REWORK because the isolation
test proved distinct caches only with synchronous writes. The correction uses
promise barriers to overlap same-key work on two clients, then proves alpha
resolution, active-refetch cancellation and clearing cannot resolve, abort or
mutate beta. Both re-reviews returned ACCEPT. Post-cherry gates passed 7 tests
and 71 assertions, Web TypeScript with Svelte 0/0, the shadow production build,
architecture boundaries, parity, Ultracite and diff cleanliness.

Q2 is integrated at `3d0490a`. Skills snapshot/path/inventory/markdown and Sync
fleet options use explicit browser ownership, named finite policies, bounded GC
and exact Query cancellation. Sanitized Skills error unions become typed Query
errors so a failed SWR refresh retains prior cache data; dirty editor buffers
never enter keys or cache. Save and invalidation helpers touch only the exact
managed document, selected Skills leaves or compatible Sync generation. Both
independent reviews ACCEPTed; post-cherry gates passed 8 domain tests, 15 Query
tests, Web TypeScript with Svelte 0/0, the shadow build, boundaries, parity and
Ultracite. Q3 retains the documented coordinator delta to apply these explicit
policies to the two legacy Solid Skills query callsites before removing the
root fallback.

Q1 is integrated through `97e34b4`, focused identity correction `9366ace`
and canonical-request correction `656ef4e`. Report, Session and Quota
factories now derive every exact key dimension from validated requests, capture
immutable canonical copies for deferred RPCs, forward exact abort signals and
use only named finite policies. The first standards review found that
caller-supplied identities could diverge from request payloads; after that
correction, the spec re-review found mutable Report request closures could
still diverge from their already-built keys. The second focused correction
parses once and shares the same deep copy between key and RPC. This exceeded
the original two-attempt local STOP threshold for one invariant, but the user's
relaxed execution policy authorized continuing while preserving the evidence.
Both final independent reviews returned ACCEPT. The first correction's
typecheck exposed strict optional/literal fixtures, and the second exposed
TanStack phantom-key readonly assertions; assertion-only fixture corrections
made both complete gates green without casts or weakened behavior. A read-only
`git status` probe in the packet worktree also stalled and was terminated;
the coordinator verified all commits from the integration checkout. Post-
cherry gates passed 15 Q1 tests with 121 assertions, all 30 Query tests with 235
assertions, Web TypeScript with Svelte 0/0, the shadow build, repository lint,
parity, Ultracite and diff cleanliness.

Q3 candidate `614174f` composes one request-owned Svelte Query client and oRPC
client per SSR load, returns only serializable dehydrated state through the
SvelteKit boundary, and creates a separate browser client under the official
Svelte Query provider. Solid and Svelte retain distinct framework clients while
sharing only plain finite-GC defaults, key vocabulary and policies. The complete
ownership matrix covers current/exact Report, Session, Quota, Skills and Sync;
publication deduplication invalidates exactly the two current Report aliases and
does not touch exact Report, Quota, Skills or Sync data. The legacy Solid root
fallback no longer makes all queries infinitely fresh, and its Quota/Skills
callers now use their accepted explicit Q1/Q2 policies and exact cancellation.

Q3's initial gates passed 36 Query/RPC tests with 270 assertions, Web TypeScript
with Svelte 0/0, the shadow production build and an HTTP 200 meaningful-HTML probe,
repository check/lint/typecheck/build, the complete parity inventory, the
production Report suite 7/7, Session scale 2/2 at 5,000 sessions, and the
Session benchmark 4/4 with three retained samples. Current benchmark medians
are initial 1533.787 ms, filter 224.403 ms, sort 1424.641 ms, heap delta
33,272,824 bytes and maximum page payload 220,694 bytes; desktop renders
33 items / 624 Session DOM nodes and mobile 19 / 288. Every absolute suite gate
passed. The mobile sample crossed B1's 284-node investigation trigger by four
nodes while remaining inside the absolute row, network, geometry, heap and page
budgets. Q3 did not change the Solid Session table implementation, and B1 itself
observed sample variance down to 18 items / 273 nodes. This is retained as a
reviewed investigation rather than presented as an unconditional performance
pass; X1 must remeasure the final Svelte implementation.

Both first independent Q3 reviews returned REWORK. They found that the Solid
Skills refresh targeted only a parent legacy key while the active key had an
extra configuration segment; Solid Quota and Skills reused policies but not the
accepted canonical Q1/Q2 identities; the Quota range-only identity could collide
for different time windows; Skills combined snapshot and known-path reads and
dropped abort signals; the ownership matrix incorrectly marked Skills and Sync
browser-only; and the 1,000-entry cache test cleared entries manually instead of
proving automatic GC. The standards reviewer also retained a forward seam for
P1: awaited SSR prefetch and navigation hydration must populate the same
request-owned client because the current Q3 layout intentionally dehydrates an
empty client.

Focused correction `0ecbd21` extracts framework-neutral Quota and Skills
identities, so Solid Query and Svelte Query share keys and policies without
sharing incompatible framework option objects. Solid Quota now keys the exact
canonical request window and forwards abort. Solid Skills separates canonical
snapshot and known-path reads, forwards abort, uses the exact canonical
inventories key, and refreshes that active key. A real Solid Query observer
regression proves the refresh invokes the query again. The matrix now marks
Skills and Sync `ssr-awaited`, and the bulk-cache test proves all 1,000 entries
expire automatically under a shortened production-equivalent finite policy.
The first correction gates passed 43 focused tests with 293 assertions, Web
TypeScript with Svelte 0/0, Web production build, the complete Web suite at 717
tests and 3,277 assertions, repository check/lint/typecheck/build, Ultracite,
parity and diff cleanliness. The spec/parity correction review ACCEPTed.

The standards correction review returned a second focused REWORK. It proved
that a configured-to-unconfigured Skills transition disabled the now-canonical
inventories query while Solid Query retained its previous successful data under
that same key; the adapter projected the stale inventory because it did not also
test the business enablement gate. It also demonstrated that retained-data SWR
errors were hidden when adapters prioritized data over the simultaneous Query
error. Correction `c8fb80e` makes the projection return no inventory whenever
configuration is unavailable, retains successful data during an enabled SWR
refresh failure, and exposes the error independently in the existing Skills
error surfaces. Regression tests cover both transitions. Its gates passed 45
focused tests with 298 assertions, the complete Web suite at 719 tests and 3,282
assertions, Web TypeScript with Svelte 0/0, Svelte build, boundaries, repository
lint, Ultracite, parity and diff cleanliness. Both second correction re-reviews
are pending.

Three Q3 incidents are retained. The first complete repository test run hit the
known D3 `ArrowRight` focus timeout; its one allowed exact rerun passed 10/10,
classifying a flake without changing timeouts or assertions. The first
production Report run exposed a latent relative browser `/rpc` URL once the
global infinite-stale fallback stopped hiding transport; the focused correction
resolves `/rpc` against the exact browser origin, adds method/URL tests, and the
full production gate passed 7/7. The first Session scale run then reached the
real CSRF boundary without an Origin header and correctly received 403
`CsrfRejected`; the fixture now derives the loaded page origin and sends it
explicitly, preserving the policy, and both viewports passed. A root-relative
Playwright config invocation also failed before test discovery and was rerun
from `apps/web`. Benchmark telemetry reported synthetic file-sink lock timeouts,
but all four benchmark tests and retained budget assertions completed green.
The first Q3 rework typecheck also exposed that Svelte Query 6 option objects
cannot be passed into Solid Query 5 because their private Query Core types are
intentionally incompatible. The correction now shares only plain identities
and policies. The first complete Web rework suite then proved that importing a
Svelte option module from a Solid entry leaks Svelte syntax into the Solid build;
extracting the identities into framework-neutral modules removed that graph
edge, and the exact complete rerun passed 717/717 without exclusions.

## Deviations, STOPs, and recovery

- Reviewed deviations: the two Vite/Bun loopback proof substitutions above are
  accepted, deterministic and retain the same production invariants.
- Resolved isolation incident: the V1/V2 evidence rework produced `9b17da8`
  directly in the integration workdir. Its exact two-file delta was inspected,
  independently accepted and retained; no semantic conflict occurred.
- Resolved local STOP: B2 exhausted both original focused SSE-harness
  corrections. The user authorized autonomous correction of this class of
  technical blocker; the incident remains recorded above and B2 is integrated.
- Resolved B1 correction: B1-C is independently accepted and integrated at
  `c85b077`; its production proof and post-cherry gates are recorded above.
- B1 recovery: final accepted candidate remains at `4348a2e` in
  `/tmp/ai-usage-068-b1-final`; its four commits are integrated through
  `5f43d59` and the earlier worktree remains recoverable evidence.
- B2 recovery: `/tmp/ai-usage-068-b2` is clean; the original pipe-harness spike
  remains at `/tmp/ai-usage-068-b2-spike.1VftYr`, and the adapter-node rejection
  audit remains at `/tmp/ai-usage-068-b2-spike-pass.csh2Si`.
- Resolved B2 correction: exact SvelteKit selected-adapter lifecycle coverage is
  independently accepted and integrated at `28d2f42`; adapter-node failure
  spikes remain recoverable evidence until final convergence.
- Resolved Q1 local STOP: exact request/key identity required two focused
  corrections after the implementation commit. The immutable canonical-copy
  result is independently accepted and integrated; no dependent work began
  from either rejected checkpoint.
- Resolved Q3 gate incidents: the browser RPC origin and Session scale fixture
  corrections above preserve the production CSRF and request-isolation
  contracts; no test, assertion, timeout, cache bound or security policy was
  weakened.
- Q3 correction recovery: initial candidate `614174f` and focused corrections
  `0ecbd21`, `c8fb80e` are committed. The reviews, framework-version/build-graph
  failures and retained-cache lifecycle regression are recorded above; R0
  remains blocked until both correction re-reviews ACCEPT. P1 retains the
  explicit awaited-prefetch/hydration seam.
- Recovery point: `656ef4e` is the latest independently reviewed green
  checkpoint. Candidate `c8fb80e` is fully gated and recoverable while Q3
  independent review runs; R0 remains blocked until both axes ACCEPT.
