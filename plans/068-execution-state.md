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
- Current integration checkpoint:
  `ac63cf8bb2e4623d62f949d2991a853b3e4826f7` (post-PR corrections
  independently ACCEPTed and complete implementation CI green)
- Last independently reviewed implementation checkpoint:
  `ac63cf8bb2e4623d62f949d2991a853b3e4826f7`
- Active design bases: D1 `4862293`, D2 `fce5c1a`, D3 `e2f13cd`
- Implementation PR: [`#27`](https://github.com/Ziktraug/ai-usage/pull/27),
  draft and unmerged
- Exclusive process-test token: coordinator `/root`, for serialized browser,
  production, SSE, lifecycle, benchmark, and performance suites

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
| Q1 | Q0 | INTEGRATED | `97e34b4`, corrections `9366ace`, `656ef4e`, campaign-page corrections `ca0b058`, `b8188b2` | `/root/v5_parity_spec_review`, `/root/q2_spec_review`, `/root/d123_parity_review` / ACCEPT | `b8188b2` |
| Q2 | Q0 | INTEGRATED | `3d0490a` | `/root/v34_parity`, `/root/q2_spec_review` / ACCEPT | `3d0490a8052a73da024ea523f3c0012d0e2aca9f` |
| Q3 | Q1, Q2 | INTEGRATED | `614174f`, corrections `0ecbd21`, `c8fb80e`, `d925f4c` | `/root/d123_parity_review`, `/root/q2_spec_review` / ACCEPT | `276ca0e` |
| D0 | F0 | INTEGRATED | `d476690`, `65d48b4`, `3cea781`, `f84ad2c`, evidence `bd948a7`, `a27764b`, correction `7e0c6ef` | `/root/v_vertical_audit`, `/root/v0_impl`, `/root/d123_parity_review`, `/root/v5_parity_spec_review` / ACCEPT | `4ddf145` |
| D1 | D0 | INTEGRATED | `4862293`, `3b22c28`, evidence `b31c3af` | `/root/d123_parity_review` / ACCEPT | `b31c3af` |
| D2 | D0 | INTEGRATED | `fce5c1a`, `9935846`, evidence `b31c3af` | `/root/d123_parity_review` / ACCEPT | `b31c3af` |
| D3 | D0 | INTEGRATED | `e2f13cd`, `0702203`, `70f5796`, evidence `b31c3af` | `/root/d123_parity_review` / ACCEPT | `b31c3af` |
| D4 | D1, D2, D3 | INTEGRATED | `662182e`, bundle correction `6646fe5`, series-color delta `3f42bfa`, evidence `216ec3b` | `/root/d4_review`, `/root/v34_parity`, `/root/q2_spec_review` / ACCEPT | `216ec3b` |
| R0 | F0, V5, Q3, D4 | INTEGRATED | `435aa06`, evidence `88d56c9`, corrections `98235ab`, `4e46acc`, evidence `4f293e5`, `23635c7`; integrated as `affcee4`, `01fa070`, `688b629`, `fa92709`, `66a650e`, `c8b7c7e` | `/root/d123_parity_review`, `/root/q2_spec_review` / ACCEPT | `c8b7c7e872f25648dbf5df407f92e76d64948eff` |
| R1 | R0 | INTEGRATED | `40116b5`, `121d78b`, corrections `95b67d6`, `7c85cf1`, evidence/checker `c5cc7ea`, `1befaef` | `/root/d123_parity_review`, `/root/q2_spec_review`, `/root/v34_parity` / ACCEPT | `1befaefd71ef5ffe59866021f216104b3f83f9ef` |
| P1 | R1, V1, V2, Q1, D4 | INTEGRATED | `a19914b`, `874cb1b`, `2422c2c`, evidence `02782f8`, activation correction `5bc8055` | `/root/v34_parity`, `/root/d123_parity_review` / ACCEPT | `f3610aa` |
| P2 | P1 | INTEGRATED | `0f252ca`, `8e41350`, corrections `5880b09`, `cb8552a`; integrated `7b8d65a`, `11572e1`, `045e279`, `64128c4`; evidence `e593b70` | `/root/q2_spec_review` / ACCEPT | `e593b70` |
| P3 | P1, V2, Q1, D4 | INTEGRATED | `1e7fb76`, `38bbbcc`, `dddd96b`, `07db531`, `fe3357e`, `24b9bc6`, final `7ce6027`, `a9fc2ff`; integrated `9460bc2` through `fe37669`; evidence `509b756` | `/root/q2_spec_review` / ACCEPT | `509b756` |
| P4 | P3 | INTEGRATED | `73fbce3`, `5de8823`, corrections `ff683bf`, `f993bd8`, `d749135`; integrated `531f8b6`, `9c72353`, `1697adc`, `f05d17b`, `1970793`, evidence rewrite `c11d01a` | `/root/v34_parity` / ACCEPT | `c11d01a` |
| P5 | R1, V3, Q2, D4 | INTEGRATED | `231f109`, `a5b657f`, `72c6a76`, `448c782`, activation `5c0e27e`; integrated as `c84b957`, `32533a7`, `e951cd1`, `a170123`, `0f6b118`, evidence `6f639ab` | `/root/d123_parity_review`, `/root/v34_parity` / ACCEPT | `6f639ab` |
| P6 | R1, V4, Q2, D4, B2 | INTEGRATED | accepted fresh range `e23bc9` through `414ea1a`; integrated `3c08e12` through `68dd82f`; evidence `eb2f669`; composition `79341c1`; browser corrections `db4eb57`, `1096a4d` | `/root/q2_spec_review` / ACCEPT | `1096a4d` |
| P7 | R1, V4, Q2, D4 | INTEGRATED | original `d2486bd`, `80a6db3`, `ed0a76d`; fresh `8ccb108`, `a012190`, corrections `10618fd`, `83fdd04`; integrated `6612030`, `f5f1e16`, `f98f6b1`, `054d656`, evidence rewrite `0ecf1df` | `/root/q2_spec_review`, `/root/v34_parity` / REWORK; `/root/v34_parity` / ACCEPT | `0ecf1df` |
| P8 | P1 | INTEGRATED | `4dd9b93`, `12939b4`, `caa138a`, corrections `2bf22ee`, `2665d04`, `cfae414`; integrated `22ff3ef`, `0b442e2`, `5702dca`, `6a92e8d`, `3d7763f`, `4c8766c`, evidence rewrite `3f7bfca` | `/root/v34_parity` / REWORK; `/root/d123_parity_review` / ACCEPT | `3f7bfca` |
| P9 | P5 | INTEGRATED | `9d48303`, evidence `4cb0f0d`; integrated `82451ad`, `be5e49b`, evidence rewrite `c859f7f` | `/root/q2_spec_review` / ACCEPT | `c859f7f` |
| P10 | P5 | INTEGRATED | `455b569`, evidence `dac69e0`; integrated `8e35926`, `3a43913`, evidence rewrite `e953bdc` | `/root/q2_spec_review` / ACCEPT | `e953bdc` |
| X0 | P2, P8, P4, P9, P10, P6, P7 | INTEGRATED | `db66cc0` through `c84d48c` | Skills `/root/x0_sync_review` / ACCEPT; Report/campaign `/root/v34_parity` / ACCEPT; full range and corrections `/root/x0_final_review` / ACCEPT | `c84d48c` |
| X1 | X0 | INTEGRATED | `c84d48c..c733f797`, evidence `a161860` | `/root/x1_final_criteria_audit`, `/root/review_combined_destination_atomicity`, `/root/repair_session_owner_contract_refs`, `/root/implement_combined_sessions_destination/docs_standards_axis` / visual, combined Sessions, report retention, navigation/load, performance, clean-typecheck, isolated dev-port, canonical Skills probe, trusted-local hook, documentation, and complete clean full gate ACCEPT | `a161860` |
| X2 | X1 | INTEGRATED | `6d0f35f`, documentation `6391883`, publication and reviewed CI corrections `b89fe28..ac63cf8` | `/root/x2_parity_spec` / ACCEPT; `/root/x2_quality_security` / ACCEPT on the final implementation delta | `ac63cf8bb2e4623d62f949d2991a853b3e4826f7` |

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
were requested; standards ACCEPTed.

The spec/parity review then reproduced a fresh-cache reactivation edge: after
unconfigured-to-configured or configured-A-to-configured-B transitions, the
single canonical inventories key could remain fresh for 30 seconds, so enabling
the observer alone performed no new read. This was distinct from the disabled
projection fixed above. Correction `d925f4c` marks every successful add-path,
remove-path and save-config snapshot replacement to refresh dependants. The
coordinator still skips that exact refetch when the resulting snapshot is
unconfigured. A real Solid Query observer now proves one new query call for
unconfigured-to-configured and configured-A-to-configured-B transitions while
the prior entry remains fresh; a second regression freezes all three action
flags. Gates passed 47 focused tests with 303 assertions, the complete Web suite
at 721 tests and 3,287 assertions, Web TypeScript with Svelte 0/0, Svelte build,
boundaries, repository lint, Ultracite, parity and diff cleanliness. Third
correction re-reviews were requested on both axes. Both ACCEPTed the exact
complete Q3 checkpoint at
`276ca0e`; Q3 is integrated and R0 is ready.

R0 was dispatched from clean integration head `774885c` to local-only branch
`agent/068-r0-url-navigation` in isolated worktree `/tmp/ai-usage-068-r0`.
Its mandatory card owns all 18 URL-contract IDs, permits new files only below
`lib/foundation/navigation/svelte/**` plus symbol-limited R0 parity evidence,
forbids route/layout composition and process suites, and requires the exact
codec, navigation, history, scroll, retry, dirty-blocker, typecheck, build,
boundary and parity gates. The worker has no process-test token and cannot push.

R0 candidate `88d56c9` contains implementation commit `435aa06` plus a separate
append-only parity-evidence commit. Its 12 new files total 980 lines under the
exclusive navigation subtree; the only other delta appends target source/test
evidence to the R0 shard. It provides injected navigation/history, a
TanStack-compatible raw search codec, canonical Dashboard and Skills URL
adapters, numeric history and scroll directives, deduplicated retry, and a
dirty-navigation controller with synchronous cancellation, Keep focus,
Discard replay-once and idempotent cleanup. All 18 URL records reference target
evidence without claiming route composition.

Worker gates passed 24 R0 tests with 86 assertions, 69 frozen behavior tests
with 233 assertions, Svelte check with 0 errors/0 warnings, Web typecheck,
Svelte production build, Ultracite, package boundaries, complete parity at
18/18 URL contracts, diff cleanliness and a clean worktree. The fresh isolated
worktree first lacked dependency and built design-system artifacts;
`bun install --frozen-lockfile` restored the exact lock set. One test fixture
then used invalid Session column IDs and was corrected to frozen valid IDs
`fresh` and `tokIn`. A direct Dashboard parser import also pulled Solid JSX
through a type-only shared path into Svelte diagnostics; R0 now injects the
frozen validator through an opaque codec seam, preserving the real parser while
keeping Solid out of the Svelte static closure. No invariant or product behavior
changed. Independent standards and spec/parity reviews are running.

Both first R0 reviews returned REWORK. Standards found that scroll ownership was
only a pure directive classifier, with no installed lifecycle for recording,
post-navigation application, stale-work cancellation or idempotent cleanup;
Dashboard navigation swallowed rejected promises; and Skills intents discarded
unrelated query/hash state. Spec independently reproduced the Skills loss and
found target evidence too coarse: fallback URL, matrix push/scroll/blocker,
drawer identity, several declared canonical/default/legacy variants and retry
were not directly exercised by target tests even though the aggregate checker
was syntactically green. The retry controller also retained a standards risk
because it exposed no disposal or late-callback suppression.

The original worker resumed the same isolated worktree. Its focused card requires
a real dependency-injected SSR-safe scroll lifecycle with timing, cancellation
and cleanup tests; observable Dashboard navigation failure; cloned-current-URL
Skills intents; retry disposal; explicit target tests/evidence for all 18 IDs;
and fresh source/evidence commits. No R0 dependant is dispatched from the
rejected checkpoint.

Focused R0 correction `98235ab` plus append-only evidence `4f293e5` closes the
review findings. The injected scroll lifecycle now records keyed outgoing
positions, applies preserve/reset/restore after a supplied render boundary,
restores zero coordinates, cancels superseded work and supports cancel,
idempotent disposal and remount. Dashboard rejection reaches a required typed
failure owner. Skills intents clone the current URL before changing pathname,
preserving unrelated query and hash. Retry owns cancellation, disposal,
generation-safe late suppression and post-disposal rejection. Every URL parity
ID has a named target test, including real structured drawer identity and matrix
blocker behavior, with evidence bound to the correction source.

Correction gates passed 33 R0 tests with 119 assertions, 69 frozen behavior
tests with 233 assertions, Svelte check with 0 errors/0 warnings, Web typecheck,
Svelte build, Ultracite, package boundaries, complete 18/18 URL parity, diff
cleanliness and a clean worktree. The required lifecycle and per-ID evidence
expanded the same 12 owned source/test files from 980 to 1,357 lines, beyond the
initial 1,000-line dispatch estimate. No path, product or architectural scope
expanded; independent correction reviewers must explicitly accept or reject
this documented size deviation. R1 must supply stable history-entry keys, the
real post-render scheduler and dirty-cancellation wiring; it must not duplicate
the lifecycle.

The correction standards review ACCEPTed every prior quality finding and the
documented size deviation. Spec/parity returned a second REWORK because named
tests did not yet exercise every canonical/default/legacy/lifecycle clause that
the evidence described as exact. Missing target variants included several
Dashboard enum/default/legacy/history cases, Skills matrix tree scope and
project basename/rename/reload behavior. The new structured drawer owner also
used `undefined` for closed state and omitted the frozen target field rather
than representing explicit null key/revision/target.

The original worker resumed again for an evidence-focused correction: compact
direct target assertions for every declared variant and lifecycle, a narrow
P4-compatible drawer owner with explicit closed state and target, and fresh
source/evidence commits. The accepted scroll, failure, URL-preservation and
retry lifecycles remain frozen unless a direct test exposes a real defect.

Exhaustive R0 correction `4e46acc` plus evidence `23635c7` adds direct assertions
for every clause of all 18 descriptors. No frozen URL/parser defect was found.
The drawer seam now exposes explicit closed null key/revision/target state,
local and served targets, exact revision/campaign/row disambiguation and owned
neighbor/Escape commands. A narrow Skills projection proves Matrix keeps global
tree scope while remaining its distinct destination. The evidence marks the
earlier named smoke proof superseded and appends per-ID exhaustive references;
descriptors, status and schema are unchanged.

Final worker gates passed 33 R0 tests with 233 assertions and 69 frozen behavior
tests with 233 assertions, plus Svelte check 0/0, Web typecheck, Svelte build,
Ultracite, boundaries, 18/18 parity, diff and clean status. The same 12 files now
total 1,647 lines, driven by the required exhaustive direct matrix; no assertion
was weakened and no path/product scope expanded. Final spec/parity and standards
delta re-reviews both returned ACCEPT. The six accepted commits were cherry-picked
as `affcee4`, `01fa070`, `688b629`, `fa92709`, `66a650e`, and `c8b7c7e`.
The parity source-SHA constants were then remapped from the local worker commits
to their integration equivalents. Post-cherry focused tests passed 33/33 with
233 assertions, the frozen matrix passed 69/69 with 233 assertions, and
Ultracite, package boundaries, 18/18 parity, Svelte check 0/0, Web typecheck,
Svelte build, repository lint and diff checks all passed. R1 is ready.

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

R1 was implemented directly by the coordinator as the serialized SvelteKit
composition packet. Implementation commits `121d78b` and `95b67d6` add the
complete route skeleton, application shell, request-owned Query hydration,
theme prepaint/controller, R0 navigation/scroll/retry/dirty integration,
accessible error/404 UI, and demo policy selected before protected acquisition.
Correction `7c85cf1` removes a keyed theme-control remount and hardens the D1
controlled Toggle seam so external state changes preserve one DOM node, focus,
callback ordering, disabled behavior, and propagation. The D1 SSR and Chromium
fixtures prove both user activation and external controlled updates.

The six-case shadow-browser gate proves the complete direct/reload/deep-link
route matrix and Axe scan, light/dark/system prepaint plus named toggle and
focus, mobile dirty navigation with modal Tab confinement/Keep/Discard/reload/
cleanup, keyed history and scroll restoration, exact retry/404 handling, and
demo redirects before the synthetic acquisition tripwire. The final run passed
6/6 against a freshly built adapter-bun artifact. Focused shell tests passed
13/13 with 47 assertions; D1 SSR passed 6/6 and its Chromium fixture passed.

Independent review initially returned REWORK for a dirty registry mounted below
navigation, missing shell-owned Keep/Discard composition, broad retry and error
allowances, incomplete route/a11y evidence, modal focus leakage, and the keyed
theme control. The coordinator corrected each finding without changing product
behavior. `/root/d123_parity_review` ACCEPTed code quality, client/server seams,
SSR, cleanup and the process-harness stabilization; `/root/q2_spec_review`
ACCEPTed parity/spec over `31aa91d..7c85cf1`. The retained low-risk handoff is
that P9 must decide and test Escape semantics while a real asynchronous discard
is pending.

Commit `40116b5` serializes package tests through Turbo and disables only the
unneeded Vite watcher in the D3 Chromium fixture. This followed two classified
parallel-process failures: one `EINVAL watch` and one 2-second ArrowRight focus
timeout under concurrent CPU contention. The exact D3 fixture passed 10/10
after `watch: null`; the complete serialized root test then passed without a
timeout, skip, weakened assertion, or omitted task. The independent standards
review ACCEPTed this stabilization.

Parity commits `c5cc7ea` and `1befaef` mark the four R1 features, four replaced
production TSX owners, six new Playwright titles and eleven new passive
`./svelte` exports complete with fresh final-SHA source/test/command/review
evidence. New inventory records no longer inherit baseline or D4 evidence, and
the checker now requires integrated target review evidence for every complete
record. `/root/v34_parity` ACCEPTed the final ledger range. Final checkpoint
gates passed: `bun run check` (932 files), `bun run lint`, `bun run typecheck`
(28/28), `bun run test` (all package tasks plus 93/93 tool tests), `bun run
build` (15/15), parity at 35 features, 30 retired operations, 72 production TSX
owners, 15 design rows, 413 live/436 ledger exports, 11 render suites, 110
Playwright titles and 18 URL contracts, and a clean diff/worktree.

P1, P5 and P6 were dispatched concurrently from clean integration commit
`407e835cd46fa7edb030e894ee839ef51620255e` to local-only branches and isolated
worktrees `/tmp/ai-usage-068-p1`, `/tmp/ai-usage-068-p5` and
`/tmp/ai-usage-068-p6`. Their complete mandatory cards freeze the assigned
feature/source/render IDs, upstream R1/V/Q/D/B interfaces, disjoint feature
prefixes, packet shards, coordinator-owned denylist, exact deterministic gates,
local-failure policy and handoff shape. None holds the process-test token; P6
uses virtual/injected stream time and may add only Sources-owned endpoint leaves.

P1 candidate `a19914b` contains 14 owned files and 572 lines. Its focused and
preserved lifecycle suite passed 20/20; Ultracite, Svelte check 0/0, Web
typecheck, shadow build, boundaries, parity and diff checks are green. A first
focused run exposed only harness/static defects (expected key literal, Svelte
warnings and missing TypeScript preprocessing), which were corrected. Final
seam inspection removed a module-global browser RPC client before handoff. P1
initial review returned focused REWORK: render and prove meaningful Overview and
support SSR for success and compatible-last publication; exercise the rune
owner rather than source-scanning it; retain the warning Cleanup interface;
preserve month/day 24-hour dates; use only Svelte/passive design-system exports;
remove workspace-wide live announcements; and add a real lifecycle consumer
with disposal proof. Its root composition request was accepted in shape but
must be reviewed after application. Correction `874cb1b` adds meaningful
success/compatible-last Overview SSR, exact bootstrap alias hydration, tested
rune-owner transitions, the warning Cleanup seam, exact Svelte/passive imports,
scoped live regions and a generic lifecycle consumer. Re-review retained five
focused gaps: add the owned root composition request; map exact target evidence
for both features and eight TSX rows; mount/destroy the generic consumer; prove
loader/dehydrated alias through the real ReportRoot; and assert the fixed date
exactly. No STOP condition was found and the shard stays `current`. Final
residual commits `2422c2c`
and `02782f8` add the exact route contract, real generic-consumer destruction,
loader-to-dehydrated-alias-to-ReportRoot SSR, exact timestamp and per-row target
evidence. `/root/v34_parity` independently re-reviewed the complete range and
returned ACCEPT on both axes; 27 focused tests with 86 expectations,
Ultracite, parity, zero-NUL, allowlist and diff checks are green. The four
accepted worker commits integrated as `52013fc`, `63d3866`, `20b2ad8` and
`3f6af3d`; coordinator evidence rewrite `6ec1b26` points the mechanical parity
ledger at the integrated source/test commit.

Activating the exact requested root composition exposed two optional-value
typing defects that had been unreachable behind the R1 marker. The route delta
was reverted immediately, the original P1 author normalized warnings to an
empty array and refresh errors to `null` in accepted commit `5bc8055`, and that
fix integrated as `e8008d0`. Coordinator commit `9ff4162` then activated the
awaited `+page.ts` loader and sole `ReportRoot`; `/root/d123_parity_review`
returned ACCEPT on both axes. The first shadow-browser run exposed the retired
marker assertion, and a diagnostic test adaptation exposed the underlying Axe
failure: the shipped P1 root had no `main` landmark. The adaptation was fully
reverted. Coordinator correction `f3610aa` instead preserves the R1 route
identity and adds the semantic `main` with passive design-system page/shell
styles. Independent delta review ACCEPTed it. The final P1 gate passed 24 tests
with 77 expectations, Svelte check 0/0, Ultracite, parity, shadow build and all
6 shadow-browser tests. No assertion or accessibility gate was weakened.

P2 candidate `0f252ca` plus evidence/integration request `8e41350` contains the
owned Overview/range implementation and shard. Its 76 focused/preserved tests
with 278 expectations, Ultracite, Svelte 0/0, shadow build, closure and parity
are green. Independent review returned REWORK: share bars divide sessions by
cost; timeline legend/filter/readout/boundary-tick interactions are incomplete;
heatmap keyboard indexes hidden days and drops price provenance; provider
progress DOM, Session Shape/campaign presentation and machine freshness labels
are missing; pointer cancel/lost-capture/Escape transitions are not wired; the
closure scanner leaves important packages/server classes opaque; and thirteen
target evidence paths do not exist. The single lifecycle/bootstrap/provider and
stable-series-color integration requests were accepted. Original-author
correction is queued behind the longer P6→P7 chain. No STOP condition exists.

P3 candidate `1e7fb76` plus evidence `38bbbcc` contains 14 owned Sessions
files and its shard. Its 75 focused/preserved tests with 573 expectations,
Ultracite, full Web/Svelte 0/0, shadow build, boundaries and parity are green.
Independent review accepted its 25-column inventory/presets, single Table Core
owner, initial atomic prepare and expiry retry, operation coalescing/abort/
supersession and bounded X0/P4 request, but returned REWORK on six concrete
parity gaps: incremental paging/campaign expiry lacks the one reacquire/retry;
cell adapters omit filter/highlight/provenance/label semantics and correct first
sort direction; rendered mobile geometry does not match the 188px window math;
mobile identity/keyboard and an actual 5,000-row bounded render are unproved;
the closure scanner leaves aliases/workspace packages opaque; and authoritative
envelope campaign keys are not projected onto rows. The original author is
correcting these without a process token. No STOP condition exists.

P5 candidate `231f109` plus current-status evidence `a5b657f` contains 16 owned
feature files plus its shard, 1,454 implementation lines, and requests only the
denied route composition documented in its owned `INTEGRATION.md`. Its 47
focused/preserved Skills tests, SSR render cases, demo/no-duplicate acquisition,
Ultracite, Web typecheck/Svelte 0/0, shadow build, boundaries, parity and diff
checks are green. The fresh worktree required frozen dependency links and
ignored Panda generation. Missing host bubblewrap caused repeated direct patch
helper failures; after one trivial scoped import rewrite, the coordinator
required all further edits through `apply_patch` in an escalated shell. The
candidate is clean. Independent review returned REWORK: wire the snapshot
controller into the shipped shell and expose its dirty/pending decision port to
P9; restore mobile close/scroll/focus and exact labels; hoist one responsive
tree UI-state owner; prove real route dehydration through SkillsShell hydration
without duplicate acquisition; and make frozen P9/P10 slot evidence exact per
owned row. No STOP condition was found. Focused correction `72c6a76` now wires
the shipped shell to the snapshot controller, exposes the identity-safe draft
registration and pending keep/discard/focus port, hoists one responsive tree
state owner, restores exact mobile labels/focus/close/scroll behavior, and proves
real loader-to-oRPC-to-dehydration-to-fresh-provider SSR without duplicate
acquisition. Evidence commit `448c782` maps all three feature IDs, eleven TSX
rows and the render row exactly. The candidate reports 67 tests with 284
assertions plus type, Svelte 0/0, shadow build, boundaries and parity green;
fresh independent review ACCEPTed both axes at actual head `448c782cc38e` (the
long SHA in the dispatch handoff was a transcription error). The accepted range
integrated as `c84b957`, `32533a7`, `e951cd1` and `a170123`; mechanical parity
rewrite `9b577aa` points target evidence at the integrated implementation.
Applying the exact coordinator route request then made the shipped shell
reachable to SvelteKit and exposed eight exact-optional/type-shape errors in
Inspector token counts, optional snippet forwarding and the dehydrated Skills
snapshot boundary. The route delta was fully reverted and Svelte check/parity
returned green. Activation correction `5c0e27e` validates the hydrated wire
snapshot through the canonical parser, omits absent optional snippet props,
restores the exact `Unknown` token fallback and adds a type-only reachability
fixture. `/root/v34_parity` ACCEPTed both axes; 15 focused tests with 84
expectations, Web typecheck/Svelte 0/0, Ultracite, boundaries and parity passed.
It integrated as `0f6b118`; mechanical evidence `6f639ab` advances all P5
targets to that reviewed implementation. The exact route/slot composition stays
deferred to X0 as requested so P9/P10 can replace the temporary editor and
management slots together; their frozen dependencies are now ready.

P6 candidate `f02f29f`, evidence `3076673`, virtual lifecycle proof `f598271`
and evidence `11a2ec6` contains 16 owned files and 1,518 lines. It supplies the
single explicit EventSource service/provider, Sources UI/summary and thin
policy-first endpoint leaves while reusing the existing broker/command owners.
Twenty-five focused tests with 100 assertions plus two virtual >30-second
lifecycle tests with nine assertions pass; Web full check/Svelte 0/0, shadow
build, boundaries, parity and diff checks are green. Frozen dependencies and
ignored Panda output were generated locally; missing bubblewrap forced scoped
escalated mechanical edits whose complete diff is in review. The shard remains
current pending ACCEPT. Independent review returned focused REWORK: provide an
exact bounded coordinator composition request for the root provider, shared
summary and `/sources` route; restore and test the Solid controls' `aria-busy`
pending semantics; add target evidence to all three owned production-TSX ledger
rows; replace revision-length magic numbers with named constants; and remove
the duplicated run action seam. The endpoint trust ordering, broker reuse,
single EventSource ownership, Query invalidation boundary, SSR/demo isolation
and virtual lifecycle evidence were accepted. No STOP condition was found.
The first correction pair `afe31e1`/`97cb207` centralized per-source actions,
named revision bounds, restored conditional busy attributes, added the bounded
provider/route request and mapped all owned TSX rows. Focused re-review retained
one local REWORK: source/helper assertions must become actual Svelte-rendered
pending/non-pending `Run now` and `Run all` evidence, and the summary request
must name the exact existing shell/navigation symbol and responsive placement.
The second correction pair `3f9985f`/`584b2a0` adds actual rendered busy proof
and deterministic desktop/mobile AppNavigation placement. Re-review accepted
those behaviors but found that the test still needs exact pending-disabled and
idle-enabled button assertions. It also found P6 imports formatters through
Solid-owning `shared.tsx`; P6 therefore cannot be cherry-picked from its stale
base. Coordinator commits `b087a7f`, `d827867` and `a71819c` extract tested
framework-neutral format and report-value seams, rewire every production `.ts`
consumer away from Solid-owning `shared.tsx`, pin direct
`@tanstack/table-core@8.21.3`, and recursively reject resolved TSX/Svelte,
framework-runtime, Node and server edges. `/root/q2_spec_review` returned ACCEPT
after two focused test/closure corrections. Repository lint/typecheck, 74
affected tests with 388 expectations, aggregate parity and the shadow build are
green. P6 will be redispatched from this reviewed checkpoint, consume the
neutral seam, add its feature closure test, rewrite evidence SHAs and rerun all
gates. No STOP condition was found.

The first released implementation slot took P7 from clean base `79881c1` in
isolated worktree `/tmp/ai-usage-068-p7`. Its full dispatch card freezes
SYNC-01, SYNC-02 and OPS-01, exclusive Sync/manual-transfer/observability
prefixes and the no-usage-merge/no-identity-copy boundary. P1 and P6 are under
cross-review; P5 queues for the next independent reviewer. Candidate `d2486bd`
contains 16 owned files and 1,091 lines; targeted Ultracite, 39 focused/deep-
owner/render tests and Svelte checking are green while its remaining long gates
run. Independent review returned REWORK: thread authoritative per-request demo
mode through both manual-transfer endpoints and prove zero handler acquisition;
restore abortable upload byte/percent progress, processing elapsed time,
accessible progressbar and export row count; supply an exact route/provider/
observability lifecycle composition request; replace compiler/source-string
checks with awaited prefetch/dehydration/no-duplicate-hydration and rendered SSR
proof; add target evidence for every owned ledger row; and run the omitted
shadow build, boundary, parity and affected full gates. The existing deep
staging, request identity/abort and serialized observability seams were
accepted. No STOP condition was found. P7 corrections `80a6db3` and `ed0a76d`
now thread per-request runtime mode before acquisition, restore the complete
transfer progress/elapsed/count interface, add the exact X0 request, prove real
dehydrate/fresh hydration without duplicate acquisition, and attach exact
current target evidence. Its 20 tests with 75 assertions and all static, type,
build, boundary and parity gates are green. Independent re-review returned
REWORK because all five Svelte components import the broad design-system report
barrel, whose TSX exports reach Solid; the SSR fixture masks this with
`vite-plugin-solid`, and the recursive scanner skips package imports. Its exact
integration request also names P6's stale `context` path instead of accepted
`context.svelte`. All transfer, runtime-mode, hydration, observability and
evidence behavior was otherwise accepted. P7 stays recoverable for its original
author and will be redispatched from the compatible accepted P6/D4 checkpoint.

P6 was freshly redispatched from neutral-presentation checkpoint `6ec1b26` in
`/tmp/ai-usage-068-p6-r1`. Its ten-commit range `7eba5bd..2d5b3fc` cleanly
reapplies the accepted endpoint/service/UI work, imports only the neutral format
seam, asserts exact rendered pending-disabled and idle-enabled command states,
adds recursive client closure coverage and rewrites every target evidence SHA.
The clean handoff reports 19 tests with 153 assertions, Svelte check 0/0, Web
type/build, shadow build, boundaries and aggregate parity green. Independent
fresh review returned REWORK on three focused seams: the copy-feedback timeout
survives navigation instead of being replaced/disposed; the closure scanner
does not traverse workspace package exports or `$lib` aliases; and the Sources
presentation adapter duplicates the legacy pure projection instead of consuming
one framework-neutral owner. All endpoint policy, broker reuse, sole
EventSource/provider, virtual lifecycle, invalidation, rendered command states,
demo/SSR isolation, composition request and exact evidence were accepted. The
review independently passed 42 tests with 246 expectations, full Web check,
Svelte 0/0, Ultracite, boundaries and parity. Original-author correction is
queued after P2; no STOP condition exists. P1's browser gate held and released
the only process-test token; neither P6 nor P7 used it.

P6 was then redispatched again from the exact reviewed neutral seam `9105ee6`
in `/tmp/ai-usage-068-p6-r2`. Its complete fresh range `e23bc9..414ea1a`
consumes the sole framework-neutral source presentation owner, closes timeout
cleanup and recursive package/alias closure traversal, and records exact current
evidence. `/root/q2_spec_review` ACCEPTed both axes with 59 tests and 150
expectations. The range integrated as `3c08e12..68dd82f`; `eb2f669` rewrites
worker evidence to the integrated implementation. Coordinator composition
`79341c1` places `WebQueryProvider` outside exactly one
`SourceControlProvider`, renders the responsive summary only on Manage surfaces,
and directly activates the sole-main `SourcesPage`. Making the accepted files
reachable exposed Svelte's reserved-rune ambiguity for a local variable named
`state` and named-snippet scoping at the provider boundary; the coordinator
renamed the local projection to `controlState` and hoisted the snippet without
changing behavior. Independent review ACCEPTed the complete composition.

The first activated P6 shadow-browser gate found two deterministic integration
contract misses rather than product failures: the direct Sources page no longer
carried R1's SSR route marker, and the new `Sources ready` summary link made
Playwright's substring name lookup collide with the exact `Sources` navigation
link. `db4eb57` restores the marker on the existing sole `<main>` and makes the
three destination clicks exact; `1096a4d` makes the active-destination assertion
exact as well. No assertion, timeout, accessibility check or behavior was
weakened. `/root/q2_spec_review` ACCEPTed the delta and the unchanged full shadow
suite passed 6/6, including SSR/reload, accessibility, dirty navigation,
history/scroll, error recovery and demo acquisition isolation. Repository lint,
28/28 typecheck tasks, Svelte 0/0, shadow build, package boundaries and parity
are green at `1096a4d`.

P3's deep paging correction exposed that Q1's accepted campaign-children Query
key kept the fingerprint cursor-independent but did not name the individual page
destination. Coordinator corrections `ca0b058` and `b8188b2` add the canonical
`campaign-children:initial|cursor:<JSON>` destination inside the Q1 owner, reuse
the parsed request exactly once in options, and freeze both properties: cursor
fingerprints remain equal while cursor keys differ. `/root/d123_parity_review`
ACCEPTed both axes; five focused tests with 34 expectations, Ultracite and
package boundaries pass. P3 can now remove its temporary local key shadow and
consume Q1 unchanged.

P2 correction `5880b09` plus evidence `cb8552a` closes every original review
finding: cost/session share bases, interactive timeline legend/readout and
collision retention, complete heatmap roving/day/provenance semantics, provider
progress/reset presentation, Session Shape/campaign language, range pointer and
Escape cleanup, machine presentation request, real target evidence and recursive
client closure. `/root/q2_spec_review` ACCEPTed both axes with 95 tests and 352
expectations, Svelte 0/0, Ultracite, boundaries and parity green. The four
worker commits integrated as `7b8d65a`, `11572e1`, `045e279` and `64128c4`;
`e593b70` points target evidence at the integrated implementation. The identical
95/352 gate, Svelte check and aggregate parity pass post-cherry. Its bounded D4,
root lifecycle/navigation, campaign/machine and P8 evidence requests remain for
X0 and do not introduce a parallel state owner.

P3's final correction `7ce6027` removes its temporary campaign-page key shadow
and consumes the accepted Q1 options, query function and cancellation key
unchanged. It also restores Solid's exact unavailable-column behavior: Turns
remains numeric with partial-session provenance while only cost, token, call and
tool columns use the unavailable hint. `/root/q2_spec_review` ACCEPTed both axes
with the complete deep paging, presentation, keyboard, responsive and
virtualization gate at 88 tests and 397 expectations. Eight P3 commits integrated
as `9460bc2..fe37669`, intentionally excluding the worktree's duplicate Q1
compatibility commits; `509b756` points evidence at integrated `198e7ee`. The
same 88/397 gate, Svelte 0/0, boundaries and parity pass post-cherry. P4 was
dispatched from this reviewed checkpoint.

One orchestration incident did not justify stopping the run: a network command
was treated as needing user approval even though the persistent `curl -sS`
permission already covered it, and the normal escalation path was available for
other sandbox failures. The coordinator resumed without changing scope or
security policy. Recoverable sandbox limitations, missing host bubblewrap and
truncated command output are henceforth documented and handled through bounded
escalated shells/read-only process inspection; only a blocker that invalidates
the complete migration can stop this run under the user's explicit instruction.

P9 candidate `9d48303` plus evidence `4cb0f0d` ports the Markdown editor,
draft/conflict controller, save shortcuts and dirty-navigation decision seam.
`/root/q2_spec_review` ACCEPTed both axes with 38 tests and 202 expectations,
Svelte 0/0, Ultracite, boundaries and parity green. It integrated as `82451ad`
and `be5e49b`; `c859f7f` points P9 target evidence at the integrated
implementation. Its X0 request is limited to filling the existing P5 editor
slot and removing the temporary dirty-navigation fixture. A post-cherry parity
run correctly discovered one new D4 public export introduced by the reviewed
P2 series-color convergence. `216ec3b` records
`./svelte::stableSeriesColor`, advances the frozen checker to 414 live/437
ledger design exports and restores 13/13 checker tests plus 414/414 inventory.

P10 candidate `455b569` plus evidence `dac69e0` ports Skills health,
diagnostics, context, consolidation, reconcile and responsive matrix surfaces.
`/root/q2_spec_review` ACCEPTed both axes: strict wire parsing, lazy browser RPC
acquisition, smallest-key snapshot publication and the unchanged P5
draft-decision owner all remain intact. It integrated as `8e35926` and
`3a43913`; `e953bdc` rewrites target evidence to the integrated implementation.
The exact post-cherry suite passed 70 tests and 237 assertions, followed by
Svelte 0/0, shadow build, Ultracite, TypeScript coverage, package boundaries,
13/13 parity-checker tests and complete inventory. The implementer handoff's
236-assertion count was a transcription error only; no committed evidence used
that value and the independently observed count is recorded here.

P8 candidate `4dd9b93`/`12939b4` plus evidence `caa138a` passed its 31
tests/77 assertions, Svelte 0/0, Ultracite, boundaries and parity, but
`/root/v34_parity` returned REWORK on two material evidence seams. The
controlled quota panel captured final focus at component construction rather
than the closed-to-open transition, so persistent closed mounting could restore
the wrong element. The owned interactive surfaces also relied on pure/source
assertions instead of rendered focus/a11y/interaction proof and exact per-row
test references. The original author is correcting both without changing URL
identity, filter state, query ownership or packet scope; this is not a STOP.

P8 corrections `2bf22ee`, `2665d04` and `cfae414` capture final focus on
every controlled closed-to-open transition and add an isolated Chrome/Axe
harness with distinct behavior references for all eleven owned TSX rows.
`/root/d123_parity_review` ACCEPTed both axes after replaying Chrome 150 and
Axe with complete fixture/browser/server cleanup. The accepted range integrated
as `22ff3ef` through `4c8766c`; `3f7bfca` rewrites source, focus and browser
evidence to the integrated SHAs. Post-cherry, 32 tests/79 assertions, the same
Chrome/Axe gate, Svelte 0/0, Ultracite, coverage, boundaries and parity all
pass. X0 retains the single R0 search owner and raw identity values.

P4 candidate `73fbce3` plus evidence `5de8823` passed its new/affected 63
tests/273 assertions, the five legacy render suites at 52 tests/175
assertions, Svelte 0/0, Web typecheck, shadow build, Ultracite, boundaries,
coverage and parity. `/root/v34_parity` nevertheless returned REWORK on five
material parity seams: Overview/local selections could not carry P1's accepted
revision without a neighbor query; controller-to-P3 selection echo could
cancel and duplicate an exact neighbor request; keying the complete Drawer by
row could replace the original final-focus target during neighbor navigation;
the campaign slot followed rather than preceded the detail grid; and the
SESSION-06 renderer omitted frozen timeline, timestamp, orphan-prompt, phase,
key and accessible-label semantics from the five authoritative suites. P7 was
left recoverable in its fresh worktree while the original author returns to
this critical-path correction. No process gate, assertion or product behavior
was weakened and this is not a STOP.

P4 corrections `ff683bf`, `f993bd8` and `d749135` close every review
finding. The independent revision enables detail/VCS with zero neighbor calls;
the selection echo is idempotent; one Drawer/final-focus owner survives
neighbor changes; the P8 campaign slot is in the frozen position; and the full
SESSION-06 timeline/orphan/phase/accessibility/icon semantics are restored with
all five legacy render suites in the authoritative command. `/root/v34_parity`
ACCEPTed both axes at 138 tests/541 assertions plus Svelte 0/0, build,
Ultracite, boundaries, coverage and parity. The five commits integrated as
`531f8b6` through `1970793`; `c11d01a` points evidence at integrated correction
`1697adc`. The identical 138/541 suite and all static/parity gates pass
post-cherry.

Fresh P7 candidate `8ccb108` plus evidence `a012190` correctly removes broad
design-report and Solid masking, traverses package exports in the client
closure, consumes P6's accepted `context.svelte` seam and keeps every transfer,
trust, abort/late-cleanup, hydration, demo and observability invariant. Its
66 tests/297 assertions and every static/build/parity gate are green.
`/root/v34_parity` returned a final focused REWORK because rendered upload
progress showed percent but not current/total bytes, and processing omitted the
legacy labelled indeterminate progressbar/large-file hint. Its X0 request also
said to keep two manual-merge leaves that do not yet exist instead of naming
their exact GET/POST creation and runtime-mode wiring. The original author is
correcting these two bounded gaps; this is not a STOP.

P7 corrections `10618fd` and `83fdd04` restore exact current/total byte and
percent upload presentation, labelled determinate upload progress, labelled
indeterminate processing progress, elapsed time and the large-file dedupe hint.
They also name the exact missing SvelteKit GET/POST leaves X0 must create and
freeze request plus `locals.runtimeMode` forwarding. `/root/v34_parity`
ACCEPTed both axes at 66 tests/303 assertions, including 2 rendered tests/18
assertions, plus Svelte 0/0, Ultracite, boundaries and parity. The accepted
range integrated as `6612030` through `054d656`; `0ecf1df` points evidence at
integrated correction `f98f6b1`. The identical 66/303 suite and static/parity
gates pass post-cherry. All pre-X0 packets are now independently accepted and
integrated.

X0 Skills convergence is committed as `db66cc0`. The canonical nested layout
now awaits the P5 route load, renders exactly one P5 shell with the accepted P9
editor and P10 health/matrix slots, and removes the temporary dirty-navigation
fixture. The real oRPC hook handles both network and SvelteKit-owned internal
requests without weakening external Host/Origin/CSRF validation; SvelteKit
serializes the oRPC `content-type` header required by its SSR fetch replay.
The browser readiness marker becomes true only after the first real Query cycle
is mounted and idle, preventing route churn from aborting hydration requests.
The real controlled editor also synchronizes its DOM buffer before publishing
controller state, so rapid replacement preserves the exact draft. Gates passed
35 focused tests/224 assertions, Svelte 0/0, scoped Ultracite, shadow production
build and all 6 Chromium/Axe shell scenarios.

The Skills activation exposed three local convergence issues which are retained
as resolved evidence rather than STOPs: the browser gate initially served a
stale pre-build artifact; SvelteKit internal SSR fetches omit the HTTP `Host`
metadata and require explicit response-header serialization; and the shell
test initially advanced from SSR HTML before hydration/query settlement,
causing legitimate aborts plus a controlled-textarea replacement race. The
final implementation uses owned internal-request normalization, the documented
SvelteKit serialization filter and a state-derived readiness seam. No timeout,
assertion, request trust rule or product behavior was weakened.

Coordinator deltas `3f42bfa`, `8020703` and `9d24e5b` expose the neutral stable
series-color helper to Svelte and use it for matching P2 timeline segments and
legend swatches, extract the collector-free machine freshness presentation
owner requested by P2/P8, and freeze raw-ID/fresh/unavailable behavior plus its
forbidden imports. `/root/v34_parity` independently ACCEPTed all three on both
axes. Its gates passed 29 color/entrypoint/timeline tests with 233 assertions,
14 freshness/runtime tests with 48 assertions, the direct leaf's 2 tests with 8
assertions, Svelte 0/0, Ultracite, package boundaries and diff cleanliness.

One repository-wide `bun run test` attempt during three simultaneous worker
build/test gates timed out only in the pre-existing design-system Chromium
segmented-control focus fixture at its unchanged two-second assertion. The one
allowed standalone classification rerun failed the same focus wait while the
workers were still contending for browser/build resources. No changed path
touches that compound control, no timeout or assertion was changed, and every
affected packet gate is green. The exact full command will be rerun in an
uncontended clean worktree at convergence; this local resource-contention
incident is retained rather than treated as a feature STOP.

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
  `0ecbd21`, `c8fb80e`, `d925f4c` are committed. The reviews, framework-version/
  build-graph failures and both retained-cache lifecycle regressions are
  recorded above; both correction re-reviews ACCEPTed. P1 retains the explicit
  awaited-prefetch/hydration seam.
- R0 recovery: the accepted worker range remains clean and recoverable in
  `/tmp/ai-usage-068-r0`; its six commits are integrated through `c8b7c7e`.
- Resolved R1 gate incidents: the client type closure initially reached Solid
  through the report entrypoint; synchronous history seeding caused hydration
  failure; hash-preserving replacement and focus-after-tick were required;
  popstate initially read the incoming history state instead of the outgoing
  key; the browser failure gate initially allowed broad errors; and concurrent
  package processes exposed the two D3 fixture failures described above. Every
  correction is committed, independently reviewed and covered by the final
  gates; no real local state was acquired.
- Resolved P1 activation incidents: optional component inputs were normalized
  before route activation; the browser then caught a missing report landmark.
  The final component preserves the route marker and exactly one `main`, and the
  unchanged 6-test shadow suite is green. The grouped pre-browser gate also
  once remained silent until manually interrupted; each constituent command
  subsequently passed under an explicit bound.
- Resolved P5 activation incident: the exact X0 route request exposed eight
  strict Svelte type errors while the additive shell was unreachable. The route
  was reverted before stacking work; reviewed correction `0f6b118` plus
  reachability fixture closes the gap, and all additive gates are green.
- Recovery point: `0ecf1df` is the latest independently reviewed green
  checkpoint. All 31 packets from B0 through P10 are integrated; X0 feature
  convergence is ready to begin from this clean base.

## X0 convergence review and correction ledger

The X0 implementation range is `0ecf1df..d2b8e6e`. Skills convergence landed
as `db66cc0`, its evidence ledger as `9766aea`, and focused corrections as
`86dfec4` and `6ff9b11`. The first readiness attempt based on render frames and
fetch counts exposed legitimate aborted observers. The final seam publishes a
deterministic hydration signature only after TanStack Query applies the exact
dehydrated state and verifies the canonical key. Browser proof counts only the
Query-owned `skills-shell` requests; the SvelteKit loader's intentional
`skills-shell-ssr` request remains a separate owner. The deep-link test also
waits for settlement before its intentional reload. `/root/x0_sync_review`
ACCEPTed the final range with 48 tests, 302 assertions, Svelte 0/0, build and
all six shadow browser scenarios green.

Report convergence landed through `d609e91`, `64bd261` and `3ae5f8e`. Its
first full review returned REWORK because served campaign selections lost the
P3 page-item target, active timeline keys were disconnected, Sessions counts
fell back to Overview/bootstrap, warning cleanup was not composed, and row
synchronization mutated parent state during template evaluation. Corrections
`9d48627` and `b5d76f7` restore authoritative targets and counts, live and
synthetic active keys, an owned derived/effect bridge, and warning cleanup that
pins one exact revision from Breakdown load through guarded save. The focused
review ACCEPTed 49 tests and 318 assertions plus Svelte 0/0, build, boundaries
and parity.

Sync convergence landed as `27f3491`, `8a4bf77` and `78350ae`. It shares the
single observability runtime lifecycle, preserves the owned RPC trust proof and
was independently ACCEPTed after redispatch on the compatible Skills base.

Campaign drawer recovery required the complete accepted five-commit chain
`74fe900..aadd9e9`: the controls/model, actual campaign-root protocol and
SQLite projection, same-owner filtered/unfiltered bounded paging and dual-depth
revision replay, plus a zero-match correction that keeps the actual root even
when current filters match no campaign row. An initial handoff accidentally
omitted the first two component commits; the implementer corrected the ledger
before integration and a reviewer ACCEPTed the complete original range. No
partial chain was integrated.

Coordinator composition `4bc2d83` then received focused REWORK: reselection
could page implicitly, owner destruction retained a stale binding, clear was
not scoped to the displayed key and hidden selection mixed the filtered query
with the collection total. `0ca26ca` gates initial load on map absence, clears
the binding exactly once on destruction, scopes clear to the current key and
uses served query counts. A fresh full-X0 reviewer found two further parity
gaps: hidden rows still could not belong to their neighbor query, and Report
mutations ignored the shared Sources connection. Final correction `d2b8e6e`
uses an exact revision-preserving campaign-scoped unfiltered selection query,
proves neighbor membership and total consistency, consumes the existing
source-control context without another owner, and enables cleanup/project saves
only for live runtime plus live connection. `/root/x0_final_review` ACCEPTed
both axes at 62 tests and 334 assertions with Svelte 0/0 and boundaries green.

Two recoverable orchestration incidents are retained. During Skills review, a
reviewer briefly attempted to claim the process token while another reviewer
held it; the coordinator interrupted the attempt and verified no listener was
created before serialized reruns passed. During full-X0 static review, the
unchanged design-system compound Chromium test hit its two-second `page.goto`
deadline and its one allowed isolated classification rerun reached a later
two-second ArrowRight/Month wait; 9/10 isolated assertions passed. Other
reviewer/build load was still concurrent. No timeout or assertion changed. The
coordinator now holds the exclusive token and will run the complete X0 gate
uncontended before accepting the checkpoint.

The uncontended X0 repository test then reproduced the ArrowRight/Month failure,
proving a deterministic fixture lifecycle defect rather than pure resource
contention. The scenario reopened the dynamic MultiSelect but began the next
SegmentedControl keyboard proof while its portalled positioner was still
visible, so the prior overlay retained keyboard ownership. Focused correction
`c0da876` closes the select through its real trigger and waits for the existing
positioner to become hidden before the unchanged segmented assertions. The
targeted browser proof passed 10/10 in 1.08 seconds; neither the two-second
default, the 15-second test budget nor any behavior assertion changed. The
attempt to load a global diagnostic Skill was rejected because Plan 068 forbids
access to configured local Skills; diagnosis remained repository-local.

The next complete repository-test pass reached 1,028 green Web tests before
five one-shot Svelte SSR fixture servers emitted `EINVAL: invalid argument,
watch`; the lifecycle fixture then tried to register `afterAll` after Bun had
already finalized the failed file. Exactly five older fixtures still allowed
Vite filesystem watching while the six newer fixtures already disabled it.
Correction `52163ed` sets `watch: null` on the complete five-file family, and
`3f61808` registers each stable server closer before any asynchronous
`ssrLoadModule` call. This removes the unnecessary watcher and guarantees
cleanup if module loading fails. The focused family passes 42/42 tests with 187
assertions; no product code, timeout or assertion changed.

Static X0 convergence then passed the complete repository `check`, `lint`,
`typecheck`, `test`, `build`, parity and boundary gates. The full repository
test includes 1,029 Web tests and the 170-second synthetic SvelteKit lifecycle
fixture; all passed after the watcher correction. The shadow production/browser
gate initially exposed two bounded Sync composition omissions: its SSR load did
not declare the stable request owner needed for SvelteKit's framework-proven
missing-Host normalization, and its existing `main` lacked the frozen
`data-route-shell="sync"` marker. `9dc4385` adds the owner and marker without
changing the external trust policy or adding another landmark. Targeted proof
passed 10 tests/75 assertions and the exact shadow browser gate passed 6/6;
`/root/x0_final_review` ACCEPTed both axes.

The legacy Solid Playwright gate then revealed that Bun/Nitro reconstructing a
native-socket request with `new Request(request, { signal })` changed POST to
GET. Fresh loopback curl retained the exact contradictory evidence: HTTP 405,
`Allow: POST`, and `MethodNotAllowed` for a POST. `c84d48c` explicitly preserves
the original method while retaining URL, headers, body and the connection
signal. Its regression proves POST JSON method/header/body identity; the
existing tests prove abort/listener cleanup. The same correction adds exact
same-origin CSRF evidence to the synthetic Sources cleanup request and makes the
browser failure gate order-independent only for resource errors already proven
intentional by exact path/status/header. RPC/policy proof passed 12/12 tests and
80 assertions; Skills+Sources passed 21/21. `/root/x0_final_review` ACCEPTed the
four-file correction with no trust or assertion weakening.

The legacy Solid/Nitro server bootstrap remains intermittently unable to bind
4174 before Playwright's unchanged 120-second startup bound. Two cold attempts
left Vite alive in `epoll` with no listener; the same fixture started in under a
second for the targeted 21-test gate. No timeout was increased. This is a
temporary X0 convergence deviation confined to the runtime that X1 deletes;
all spawned processes were stopped, the last reviewed checkpoint remains
green, and X1 must close the deviation by proving the canonical SvelteKit
dev/production lifecycle and the final `test:e2e` gate.


## X1 cutover and correction ledger (in progress)

At checkpoint `9b086f3`, the integrated X1 range spanned `c84d48c..9b086f3`. Canonical runtime,
build and lifecycle ownership moved to SvelteKit and oRPC; Solid, Start, Nitro,
retired TSX production sources and old generated-output paths were removed. The
machine ledger now closes 35 feature IDs, 30 operations, 72 former TSX files,
15 design rows, 437 design exports or reviewed removals, 11 render suites, 110
Playwright titles and 18 URL contracts. Source and emitted scanners enforce the
retired stack and the emitted client manifest remains closed to server modules.

Retirement and parity enforcement landed at `8b8b1c8`, `77abf38`, `200918c`
and `c659f9e`. `/root/x1_parity_review` independently ACCEPTed the scanner and
ledger corrections on parity/spec and quality/seam axes. Production bootstrap,
clean-build determinism, production Vite mode and lifecycle abort cleanup landed
at `7adbf1e`, `626e0c2`, `6799f5d` and `32ee18d`; their focused implementer and
independent reviews ACCEPTed the unchanged loopback, artifact and cleanup
invariants.

The deterministic production clock landed through `d82e791`, `e03178e` and
`7458724`. The Bun unit suite was initially placed under `e2e`, where Playwright
collected it while normal Web unit CI omitted it. Accepted correction `5e2760e`
moves the suite to the Web package root, and coordinator composition `a40b197`
adds that exact file to TypeScript ownership. `/root/production_fixture_review`
and `/root/x1_final_criteria_audit` independently ACCEPTed the result: 877 Web
tests passed, the four clock tests remained strict, Playwright listed 96 tests
without the Bun suite, parity remained complete, TypeScript coverage passed and
Svelte check reported 0 errors and 0 warnings.

Split PR workflow jobs initially relied on ignored production output built in a
different job. `6b75dd5` adds an uncached build to both isolated production
consumers; `/root/x1_final_criteria_audit` ACCEPTed job independence and workflow
maintainability. Operational README commits `ce328db`, `65cfcb4` and `49c33b1`
received one REWORK because they named a nonexistent source-scanner script. The
final explicit commit set documents the exact source and emitted scanners,
client closure, isolation and benchmark commands and was ACCEPTed by
`/root/x1_docs_audit`.

A literal final-criterion audit found obsolete `NITRO_` environment handling in
both the Svelte production launcher and its supervisor. `9b086f3` removes that
retired prefix knowledge while preserving the explicit untrusted adapter keys
and canonical loopback reconstruction, and adds a source/emitted scanner marker.
Focused validation passed 53 tests and 177 assertions; source scanning and the
production grep were clean. `/root/x1_final_criteria_audit` independently
ACCEPTed the correction on both axes.

Resolved local execution incidents retained for audit include unavailable
`apply_patch` sandbox support requiring narrow inspected Perl edits, temporary
bundle instrumentation that was removed and rebuilt away, one malformed local
Perl insertion caught by Ultracite before commit, two cold Vite startup
classification timeouts resolved by prewarming without timeout changes, an
exclusive-process-token collision stopped before a second fixture launched and
three focused fixture-clock corrections preserving strict ISO, monotonic and
integer-millisecond behavior. No real home, database, history, prompt, Skill or
configured state was accessed.

At `9b086f3`, `/root/x1_final_criteria_audit` provisionally ACCEPTed the
complete static parity/spec and code-quality/seam axes. X1 was then REWORK while
visual/production corrections, performance classification, clean full gates,
and ledger finalization remained. The following section closes the first three;
current X1 status is REVIEW solely while its clean full gate is pending.


### X1 post-`9b086f3` correction and validation ledger

The final X1 correction range is `9b086f3..aa992c6`.

| Commit | Correction / evidence |
| --- | --- |
| `8647ee5` | Recorded the first X1 correction checkpoint. |
| `eb5b589` through `e1dfd06` | Converged stable report identity, visual presentation, responsive geometry, Skills SSR/hydration, and parity evidence. |
| `2c056d1` through `af31bf3` | Preserved deterministic Skills fixtures, report/client closure, browser parity, and Session row geometry. |
| `7f250399` | Restored one atomic Overview/Sessions destination and exact-revision paging recovery after independent REWORK. |
| `89abdef` | Kept the last complete report subtree mounted during destination refresh; rebuilt production DOM identity passed 2/2. |
| `006d106` | Made immutable Session state replacement-only with `$state.raw` and introduced search-load isolation plus the one-bootstrap production contract. |
| `1d61fa3` | Advanced the frozen Playwright inventory to 112/112 with complete evidence. |
| `aa992c6` | Kept the root layout URL-reactive while the report page untracks its RPC origin and document-scoped parent metadata; history/scroll 2/2, source contract 1/1, and one-bootstrap/no-`__data` production proof 1/1. |

The machine ledger now owns 35/35 features, all 30 retired operations, all 72
retired production TSX records, 15/15 design rows, 353 current exports with 460
ledger records, all 11 retired render suites, 112/112 Playwright titles, and
18/18 URL contracts.

TanStack Svelte Query owns transport execution, exact query keys, immutable
result caching, cancellation/deduplication, and named freshness/GC policies. It
does not decide which report revision becomes visible. `ServedReportSession`
owns descriptor acquisition, destination identity, supersession, one expiry
retry, last-good retention, and atomic visible commit. The Session table query
owner owns bounded paging and transaction-owned replay; the combined
Overview/Sessions destination publishes one synchronous immutable snapshot.

Resolved local incidents retained for audit:

- The host image lacked Bubblewrap, so the normal sandboxed `apply_patch`
  helper failed before file access. Affected corrections first attempted that helper, then
  used bounded inspected Perl replacement outside the unavailable sandbox.
  Ultracite and `git diff --check` caught one malformed local substitution
  before commit.
- An early targeted production rerun used an ignored stale Svelte artifact and
  reproduced old DOM-remount failures. Rebuilding the selected output made the
  unchanged two-test command pass 2/2. Later process measurements verified the
  artifact timestamp preceded the final benchmark.
- Untracking both universal loads removed duplicate bootstraps but broke
  back/forward input resynchronization and made scroll restoration race a
  component anchor. The minimized split keeps the layout URL-tracked and
  untracks only the report page's origin and document-scoped parent. The final
  functional suite passed 97/97 and the network contract proves one bootstrap
  per filter/sort with no route-data request.
- One production pass observed a navigation-cancelled Session-page fetch; the
  single classification rerun did not reproduce it. That rerun then observed a
  startup rendezvous that rendered 0/0 before the 5,000-row publication. Its
  single exact scale rerun passed 2/2 in 1.7 minutes. No timeout, assertion, or
  browser-failure policy changed. A later rebuilt-artifact composite gate
  passed production 8/8 and scale 2/2 in one run.
- The final benchmark passed 4/4. Its synthetic telemetry sink emitted bounded
  lock-timeout messages with `dropped=0`; all product measurements, cleanup,
  process, and listener assertions passed.
- The first manual cold-start fixture used the wrong Bun script argument order.
  It was interrupted, its one exact listener process group was reaped, and the
  six corrected direct-Vite measurements returned HTTP 200 on isolated ports.
  Temporary fixture roots remain recoverable until final cleanup.

Final measured Svelte medians at `aa992c6` are initial 1525.805 ms, filter
300.274 ms, sort 1510.573 ms, heap delta 27,639,644 bytes, maximum Session page
220,694 bytes, desktop 33 items/624 nodes, and mobile 18 items/291 nodes. Two
independent audits ACCEPTed the filter (+33.055%) and mobile-node (+12.791%)
triggers with their raw samples and absolute gates. They also ACCEPTed cold
startup 4258 ms (+19.864%), warm startup 4211 ms (+22.470%), server/debug
artifact growth, hydration 146.231 ms (+24.452%), and 40-request asset fan-out.
The performance ledger records every explanation and makes no composite claim.

Current serialized gate evidence:

| Command | Result |
| --- | --- |
| `bun run test:e2e` | PASS; 97/97 |
| `bun run test:e2e-demo` | PASS; 1/1 |
| `bun run test:e2e-production` | PASS on rebuilt final artifact; 8/8 + 2/2 |
| `bun run --cwd apps/web benchmark:session-scroll` | PASS; 4/4 and three samples |
| `bun run test:web-production` | PASS |
| `bun run test:web-dev-build-isolation` | PASS; 77 healthy requests, zero HMR/deleted descriptors, process count 2 to 2 |
| `bun run test:setup-loopback` | PASS |
| client manifest / retired stack / migration parity | PASS; parity counts complete |
| `git diff --check` | PASS at each committed correction |

X1 still requires the coordinator documentation commit, a clean-worktree
frozen install and complete static/process gate at the resulting SHA, latest
`origin/main` reconciliation, and fresh-context independent X2 review before
the sole draft implementation PR.

The first clean-worktree final gate at `dfcafca` exposed a real ordering defect:
`bun run typecheck` invoked the repository coverage guard before SvelteKit had
generated `apps/web/.svelte-kit/check/tsconfig.json`, so TypeScript stopped with
TS5083. This was not reproducible in an already-generated coordinator worktree.
Accepted correction `200677b9` runs Turbo workspace checks before the coverage
guard and tools TypeScript check, makes the Web check use its existing
`dev:prepare` synchronization seam, and declares `.svelte-kit/check/**` as a
Turbo output. Independent review ACCEPTed both axes. A genuine cache MISS with
the check project absent passed 28/28 with Svelte 0 errors/0 warnings; after the
exact generated directory was moved aside, the next cache HIT restored its
`tsconfig.json` and passed 28/28 entirely from cache. No check, assertion, or
timeout was weakened. The unavailable Bubblewrap/apply-patch incident remained
local to the execution environment; bounded edits were independently reviewed.

The clean gate at documentation checkpoint `cfbfd40` passed the frozen install,
static checks, 898 Web tests, 28/28 workspace tasks, 153 tools tests, build
15/15, complete parity/client/retirement scanners, functional Playwright 97/97,
demo 1/1, production 8/8 plus scale 2/2, and the four-test benchmark. The new
benchmark medians were 1563.288 ms initial, 291.831 ms filter, 1489.281 ms sort,
27,639,784 bytes heap delta, 220,694 maximum page bytes, desktop 33 items/624
nodes, and mobile 17 items/275 nodes. These remain within the reviewed
performance classifications and absolute gates.

`test:web-production` then failed twice at the same root-development probe.
Both failures showed Vite healthy on its default `127.0.0.1:5173` while the
synthetic fixture correctly probed its reserved isolated `PORT`: Turbo passed
the variable, but bare Vite did not consume it. Focused correction `c733f797`
maps only Vite serve to a canonical 1..65535 `PORT`, numeric loopback and strict
binding, while preserving explicit CLI override and build isolation. The same
gate then exposed two further cutover omissions rather than stopping the run:
its health probe still targeted the intentional `/skills` 307 instead of the
canonical `/skills/global`, and the global SvelteKit hook did not enforce the
existing trusted-local validator for external document reads. The accepted
correction probes the canonical structural Skills workspace, replaces a retired
Solid-only privacy marker with synthetic private-path leakage checks, and
sequences external trusted-local validation before demo/acquisition/resolve.
Framework-proven `event.isSubRequest` calls retain their SSR seam and all deep
RPC/file/SSE trust and CSRF policies remain intact. Observability initialization
is lazy, singleton and lifecycle-owned after early trust/demo rejection.

Independent review ACCEPTed `c733f797` on both axes after 12 focused tests,
Web/Svelte typecheck 0/0, exact production lifecycle/collision cleanup, and the
dev/build-isolation gate with 78 healthy requests. Retained low risks are that
the selected Bun adapter serves immutable public assets before Svelte hooks
(application/data/API routes remain protected and no local state is exposed),
and `vite preview` inherits serve-mode strict-port validation. Neither changes
the production supervisor, frozen product behavior, or current SECURITY-01
scope. Bubblewrap remained unavailable; bounded inspected edit fallbacks were
reviewed. No real user state was accessed.

The fresh detached worktree `/tmp/ai-usage-068-final-gate-3` completed the
entire frozen gate at documentation descendant `a161860`; X1 is integrated and
X2 is ready.

### X1 clean-worktree final gate

The coordinator created a detached worktree at `a161860`, installed only the
frozen lockfile, and ran every required command without relying on generated
files from another worktree. `origin/main` was fetched afterward and remained at
`2183270ebfbb886fafa7e6268893122db9b364c0`, exactly the recorded `BASE_SHA` and
merge base, so no rebase or semantic reconciliation was required.

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS |
| `bun run check` / `bun run lint` | PASS; 1,035 files and architecture/package boundaries green |
| `bun run typecheck` | PASS; 28/28, genuine Web cache MISS, Svelte 0 errors/0 warnings |
| `bun test apps/web/src apps/web/*.test.ts` | PASS; 903 tests, 4,426 assertions, 177 files |
| `bun run test` | PASS; 28/28 package tasks and 155 tools tests |
| `bun run build` | PASS; 15/15 with uncached Web production build |
| migration parity / client manifest / retired stack | PASS; 35/35 features, 30 operations, 72 former TSX records, 15 design rows, 353/353 current exports, 11 retired render suites, 112/112 titles and 18/18 URLs |
| `bun run test:e2e` | PASS; 97/97 on the single permitted classification rerun |
| `bun run test:e2e-demo` | PASS; 1/1 |
| `bun run test:e2e-production` | PASS; 8/8 plus scale 2/2; one bootstrap, no post-hydration bootstrap |
| `bun run --cwd apps/web benchmark:session-scroll` | PASS; durable Playwright result 4/4 with no failed tests and complete process cleanup |
| `bun run test:web-production` | PASS; root and production health/trust plus both clean collision failures |
| `bun run test:web-dev-build-isolation` | PASS; 78 healthy requests, zero HMR/deleted descriptors, process count 2 to 2, expected second-build rejection |
| `bun run test:setup-loopback` | PASS; numeric IPv4 loopback only |
| `git diff --check` / status / process-listener audit | PASS; no output, clean detached worktree, no retained fixture process or measured listener |

The first functional Playwright pass reached 96/97 because the unchanged
scroll-restoration assertion observed 764 px instead of 700 px. No relevant
source changed and the one allowed unchanged full rerun passed 97/97, so this is
classified as a one-shot browser geometry scheduling fluctuation. No timeout,
assertion or product code changed.

The benchmark process survived a coordinator context compaction, but its
original terminal stream did not. The Playwright-owned durable result records
`passed` with no failed tests, and the exact server/browser/process/listener
audit was empty. The immediately preceding clean checkpoint retained medians
of 1563.288 ms initial, 291.831 ms filter, 1489.281 ms sort, 27,639,784 bytes
heap, 220,694 bytes maximum page, desktop 33/624 and mobile 17/275; no client or
Session implementation changed afterward. This execution-environment evidence
loss is retained explicitly rather than inventing replacement samples or
running an unplanned duplicate measurement.

### X2 cold review and deterministic-artifact correction

Fresh-context reviewers independently pinned `origin/main`, merge base and
candidate HEAD, reran the static parity, client-manifest, retired-stack, lint,
trust/RPC/query/revision/SSE/file-transfer suites, and reviewed the complete
754-path merge-base-to-HEAD diff. The quality/security axis found no additional
blocking issue. The parity/spec axis returned one focused REWORK: SvelteKit
default timestamp `kit.version.name` changed 72 hashed artifact paths across
same-SHA builds, making the recorded single-run identity non-reproducible.

The originally recorded `b7bd2d9b…` digest was a real observation. Repeated
diagnostic builds then produced different digests with the same 292 files,
aggregate bytes and 112 maps, proving version-driven name churn rather than
fabricated evidence or bundle growth. Correction `6d0f35f` resolves the app
version from the complete current Git revision with `execFileSync` argument
arrays, validates its 40 lowercase hexadecimal characters, and configures
SvelteKit explicitly. Its focused tests pass 17/17, Svelte check reports 0/0,
and two consecutive committed-checkpoint builds have byte-identical sorted
`path:size` manifests at
`7ab9de1edcd79b2ce3017cd16ef75cf0ecf159177ba9e3e2ceb16c5e146034c1`.
Both fresh reviewers independently ACCEPTed the correction and documentation
delta at clean HEAD `6391883` on the parity/spec and quality/security axes.

Two execution-environment incidents are retained. The standard patch helper
again failed before file access because Bubblewrap is unavailable; one bounded
Perl fallback mangled two regex end anchors, Ultracite caught both immediately,
and the files were repaired before any test or commit. The GitHub publication
skill could not be read because Plan 068 forbids access to configured local
Skills; policy rejected the read. Publication will use the already authorized
minimal GitHub CLI flow after X2 ACCEPT, without accessing or circumventing the
forbidden local state.

### X2 clean-worktree final gate

The coordinator created detached worktree `/tmp/ai-usage-068-x2-final` at exact
HEAD `639188324a958095573110af2100cba07fdd7030`, ran a frozen install, and kept
the SHA unchanged through the complete gate and both final reviewer verdicts.
`origin/main` and the merge base remained the recorded `BASE_SHA`.

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS |
| `bun run check` / `bun run lint` | PASS; 1,035 files and all architecture/package boundaries green |
| `bun run typecheck` | PASS; 28/28, genuine Web cache MISS, Svelte 0 errors/0 warnings |
| `bun test apps/web/src apps/web/*.test.ts` | PASS; 904 tests, 4,429 assertions, 177 files |
| `bun run test` | PASS; 28/28 package tasks and 155 tools tests |
| `bun run build` | PASS twice; 15/15 and byte-stable 146-file `adapter-bun` content-hash-chain digest `9fc863921cf52c15997074dc9b63cfeb662e0383b00a229ee84b3e4a2ad7ea86` |
| migration parity / client manifest / retired stack | PASS; complete 35 features, 30 operations, 72 former TSX records, 15 design rows, 353 current exports, 11 render suites, 112 titles and 18 URLs |
| `bun run test:e2e` | PASS; 97/97 on the one permitted unchanged classification rerun |
| `bun run test:e2e-demo` | PASS; 1/1 |
| `bun run test:e2e-production` | PASS; 8/8 plus scale 2/2 on the one permitted unchanged classification rerun |
| `bun run --cwd apps/web benchmark:session-scroll` | PASS; 4/4 with three durable samples |
| `bun run test:web-production` | PASS; root and production health/trust plus clean engine/Web collision failures |
| `bun run test:web-dev-build-isolation` | PASS; 79 healthy requests, zero HMR/deleted descriptors, process count 2 to 2, expected second-build rejection |
| `bun run test:setup-loopback` | PASS; numeric IPv4 loopback only |
| `git diff --check` / status / process-listener audit | PASS; clean detached worktree and no retained measured listener |

The first functional Playwright pass had two transient history/geometry
observations: scroll restoration returned 764 instead of 1200, and one date
history assertion retained May 21 instead of May 20. The unchanged complete
rerun passed 97/97. The first production scale pass completed all eight SSR
tests, then its 5,000-session fixture missed the initial published-count
rendezvous before the unchanged 20-second assertion. The unchanged complete
rerun passed 8/8 plus 2/2. No product code, assertion or timeout changed.

Final benchmark medians were 1,575.794 ms initial, 273.875 ms filter,
1,459.147 ms sort, 27,635,076 bytes heap delta, 220,694 maximum page bytes,
desktop 33 items/624 nodes, and mobile 17 items/275 nodes. The synthetic
wide-event file sink opened its bounded failure circuit during the benchmark;
the benchmark, application requests and cleanup completed successfully, and no
real user log or state was involved.

Five old Vite fixture servers from earlier migration worktrees were found on
reserved ports 42642-42646 during the final audit. Their exact PIDs and working
directories were verified as repository-owned, terminated gracefully, and all
five listeners disappeared. This cleanup did not touch unrelated processes.

From repository-root cwd, the exact X2 digest command was:

`find apps/web/.svelte-kit/build/adapter-bun -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`

It hashes the sorted per-file content hashes and
their repository-relative names for 146 files totaling 2,199,312 bytes. It is
intentionally distinct from the separately retained 292-entry aggregate
`path:size` manifest, which also includes SvelteKit intermediate client/server
output. Recomputing that exact command from repository root after all process
gates still returned `9fc8639…`; changing cwd or path spelling intentionally
changes the outer hash.

## Post-PR CI correction and finalization

The coordinator pushed only `agent/migrate-web-sveltekit-orpc` and opened
exactly one implementation PR:
[`#27`](https://github.com/Ziktraug/ai-usage/pull/27), targeting `main`.
It remains draft and unmerged. No packet branch or additional remote branch was
pushed. Latest `origin/main` and the merge base remained
`2183270ebfbb886fafa7e6268893122db9b364c0`, so no final semantic
reconciliation was required.

The first hosted runs exposed release-harness defects and exact browser
rendezvous gaps that did not reproduce as red product behavior in the complete
local gates. Every correction stayed on PR `#27`, retained the original
assertions and budgets, passed its affected local gate, and received independent
delta review before integration.

| Commit | Correction |
| --- | --- |
| `b89fe28`–`3f65d83` | Published and clarified the accepted X2 artifact evidence and exact digest provenance. |
| `5cfc8fc` | Fetched the history required by the TypeScript parity-coverage evidence guard. |
| `347f341` | Stabilized generated design outputs and release-gate fixture ownership. |
| `3a57be5`, `e8a7fd` | Closed navigation cleanup and cross-route scroll parity gaps. |
| `86d0c25`, `40ea45d` | Awaited detached runtime shutdown and retained signal ownership through cleanup. |
| `5b23c22`, `c9c35f` | Synchronized the Session benchmark and bounded each page step by real index or scroll-height progress. |
| `7dd8309`, `cf9f083` | Isolated browser-server readiness and separated demo preparation from readiness. |
| `639a5b6`, `42dc7a2`, `d812bae`, `ac63cf8` | Classified exact navigation aborts and made restored report history await both transport completion and hydration. |

The final report-history helper arms an exact `fetch /__data.json`
`requestfinished` rendezvous before `goBack`, immediately owns it in the
same `Promise.all`, and then requires the exact URL and hydrated report. It is
used for both root and Sessions-query restoration. Targeted history tests passed
20/20, the complete local functional suite passed 98/98 twice during correction,
Svelte check reported 0 errors and 0 warnings, Ultracite passed, and
`git diff --check` was empty. Independent review returned ACCEPT on both
parity/spec and quality/security axes at
`ac63cf8bb2e4623d62f949d2991a853b3e4826f7`.

Actions run
[`30947971788`](https://github.com/Ziktraug/ai-usage/actions/runs/30947971788)
is the first complete green implementation-PR checkpoint at `ac63cf8`.
Attempt 3 passed all five lanes:

| Lane | Result |
| --- | --- |
| Static, Types, Parity | PASS; check, lint, typecheck and migration parity |
| Unit, Build, Client Boundary | PASS; unit suite, build, client manifest and retired-stack scan |
| Production and Lifecycle | PASS; production, dev/build isolation and loopback |
| Functional Browser | PASS; 98/98 |
| Demo, Production, Performance | PASS; demo 1/1, production 8/8 plus scale 2/2, benchmark 4/4 |

The hosted benchmark used the unchanged 180-second outer product cap and the
existing 20-second assertion timeout for each progress step. A step must advance
the Session index or scroll height, and the final index must still be exactly
`4998`; the correction removed only coupling to a global 120-second driver
deadline. The three hosted samples at `ac63cf8` had medians of 2160.883 ms
initial load, 313.722 ms filter, 1562.129 ms sort, 27,746,240 bytes heap delta,
227,094 maximum page bytes, desktop 33 items/624 nodes, and mobile
19 items/307 nodes. All absolute gates and cleanup assertions passed.

Three execution incidents are retained rather than hidden. Attempt 1 of run
`30947971788` timed out waiting 120 seconds for the functional Playwright
webServer before tests. Attempt 2 spent about ten minutes without visible
progress in the Playwright system-dependency installation; the coordinator
submitted cancellation as the runner recovered, so cancellation reached the
functional test step without a product result. Under the user-relaxed local STOP
policy, attempt 3 ran on a fresh runner and passed without code changes. The
standard patch helper also remained unavailable because Bubblewrap was absent;
each documentation edit first attempted that helper, then used a bounded
exact-match Bun replacement with cardinality checks. This affected tooling only,
not source semantics or validation.

Plan 068 is complete after this first green implementation CI. The remaining
coordinator-only documentation commit must itself pass the same PR workflow;
that second run is final release evidence, not a reopening of feature scope.

## Reopened for presentation parity, 2026-08-05

The maintainer reported the Activity brush handles rendering incorrectly and the
Activity chart being broken. Both reproduced at `0f2f18ef` in a real browser
against deterministic E2E fixtures, and both were present in the SSR HTML, so
neither was a hydration, resize or measurement-order problem.

The audit compared the panel against the retired Solid control at merge-base
`2183270e`, served from a detached worktree with the same fixtures. Eight
divergences were measured, not inferred:

| Property | Solid `2183270e` | Svelte `0f2f18ef` |
| --- | ---: | ---: |
| Chart buckets for a 30-day range | 31 | 61 |
| Axis boundary labels | window | domain |
| Tick spans in the DOM | 1 month tick | 61 full dates |
| Month gridlines / crosshair | present | absent |
| Legend series | non-zero only | all, including `0.0%` |
| Range total | present | absent |
| Codex / OpenCode fill | branded teal / blue | two hashed tans, 10/255 apart |
| Brush handle | `button[role=slider]`, 44px, anchored | `input[type=range]`, `position: static` |

Two root causes account for most of it. `{#each rangeHandles as handle}` shadowed
the module-scope `handle` Panda class, so both thumbs emitted `class="start"` /
`class="end"` and fell back to static positioning. And the pure window
projections the Solid control owned — `chartRangeForSelection`,
`buildVisibleTimelineBars`, `visibleMaximum`, `timelineBucketLayout`,
`visibleMonthTicksFor` — were deleted with `time-range-control.tsx` rather than
ported, together with the seven-case test file that described them. One of those
cases was named "keeps dense day buckets inside the plot instead of overflowing
horizontally"; without it, `repeat(N, minmax(4px, 1fr))` pushed 249 day buckets
about a thousand pixels past the panel on the maintainer's own data.

Why the gates missed it: the E2E suite asserts roles, accessible names, text and
`data-*` attributes, which survive a framework change while CSS does not.
`getByRole('slider', { name: 'Start date' })` resolved to an unstyled
`input[type=range]` through its implicit role. The only settled Overview
screenshot scrolls the Activity panel out of frame. And `designExportRecords`
built its evidence as "the file exports this name", so 183 orphaned semantic
exports were all recorded COMPLETE.

Repairs, all on PR `#27`, each measured against the Solid baseline:

| Commit | Scope |
| --- | --- |
| `01d8fb05` | Anchor the brush handles; geometry gate at four viewports |
| `c613f4ac` | `role="slider"`, `aria-valuetext`, 44px target, `timeSliderThumb` |
| `17adb903` | Independent review rework: invented copy, focus order, keyboard semantics |
| `f544e626` | Clip the chart to the range; restore the window projections and their tests |
| `a0c1a840` | `dimensionSwatch` and `accentFill` for branded series fills |
| `e5bfb4dd` | Window-scoped legend shares and the restored range total |
| `434a563c` | Month gridlines, separate hover layer, crosshair |
| `e7766363` | Brush track, dim regions and pan grip from the design system |
| `4f7093e5` | Pin the index origin for one drag (pre-existing, found by review) |
| `962569dd` | Repository check for Svelte bindings shadowing style constants |
| `9ddfd4b4` | Require a real consumer for design exports; record 167 as ratcheted debt |

Deliberately not done: the 167 unconsumed exports are ratcheted rather than
deleted, because deciding which encode visual identity worth restoring and which
are layout belonging in the consumer is a product call. Surfaces beyond the
Activity panel — Punchcard, Breakdown bars, the Sessions table, the drawer, dark
theme and reduced motion — have not been compared to `2183270e` and remain
unverified at level 4.

### Punchcard and Rhythm presentation-parity audit

The reopened audit next compared the running Solid control at `2183270e`
against Svelte at `c1b019ad` before changing source. A single Playwright driver
measured both implementations at 361, 768, 1024 and 1440 pixels, in light and
dark themes, with JavaScript disabled and after hydration. It also captured 32
before screenshots and repeated the full 16-point DOM/geometry/style matrix
after repair.

Rhythm was already at presentation parity. Its measured cells were 18 × 18px at
361px and 12 × 12px at the three wider viewports, with a 3px gap, 61 days in 10
week columns, and the same intensity endpoints: light `rgb(172, 75, 18)` /
`rgb(236, 232, 224)` and dark `rgb(224, 131, 60)` / `rgb(44, 46, 51)`.
Hydration retained one roving target; Right moved May 25 to June 1 and Enter
selected May 25 in both implementations. No Rhythm source changed.

Punchcard was not at parity before `68b9a8c6ee43c771804747c0125ed8419ef1f50d`:

| Property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| Grid columns / gap | 24px / 2px | 18px / 3px | 24px / 2px |
| Intrinsic grid width | 658px | 560px | 658px |
| Active target / fill | 24 × 24px / 24 × 24px | 18 × 18px / 10 × 10px | 24 × 24px / 24 × 24px |
| Fill shape | 2px-radius square | circular (`9999px`) | 2px-radius square |
| Panel height at 361 / wider | 341.5px / 323.5px | 297px / 279px | 341.5px / 323.5px |
| Intensity key | `Low High session count` | `Low High` | `Low High session count` |
| Sole panel at 1024/1440 | spans advanced-analysis row | half row | spans advanced-analysis row |
| Arrow key on populated button | browser default; focus stays | focus moved to neighbour | browser default; focus stays |

The first root cause was the local 18px grid and 10px circular dot in
`apps/web/src/lib/features/report/overview/punchcard.svelte`, replacing rather
than consuming the retained `punch*` semantic exports. The second was the local
advanced-analysis reconstruction in `overview-page.svelte`, which omitted both
the semantic wrapper chrome and `twoColumns`' only-child span. The third was a
Svelte-only Arrow-key focus handler absent from the Solid control. Finally, the
focused projection lowercased a Punchcard-only advanced-analysis summary in
`packages/report-core/src/focused-report-query.ts`.

The repair restores the semantic Overview/Punchcard consumers, uses the
sibling-fallback `cx(punchDot, accentFill)` shape, restores the full intensity
key and advanced-analysis wrapper, removes only the extra Arrow behavior, and
capitalizes the shared summary. Thirteen exports regained live consumers, so
the recorded unconsumed-export debt shrank from 167 to 154 without adding or
deleting an export.

The strengthened `dashboard-presentation.spec.ts` title failed before repair on
the missing legend and header geometry, and its hydrated keyboard assertion
failed with the Tuesday 18:00 button inactive after ArrowDown. The focused query
test separately failed on `weekly/hourly activity`. After repair, the browser
test, focused query suite (28/28), Web typecheck (0 errors/0 warnings), consumer
ratchet (154), migration-parity gate, and the full 16-point differential matrix
all passed. Breakdown bars, Sessions, the session drawer, Overview tiles/token
anatomy, Skills, Sources/Sync, the duplicated Skills tree, reduced motion and
the remaining cross-surface dark/responsive review have not yet been reached.

### Breakdown bars presentation-parity audit

The next comparison drove the running Solid control at `2183270e` and Svelte
at `1794ca1` with the same synthetic E2E report before changing Breakdown
source. Hydrated geometry and computed style were measured at 361, 768, 1024 and
1440 pixels in both themes. Direct JavaScript-disabled routes were also checked:
Solid rendered the selected Breakdown panel in SSR, while Svelte rendered the
settled `Loading report` fallback. That runtime distinction belongs to the
already-settled transport and lifecycle outcome, so this audit records it as not
presentation-comparable and does not rework it.

Before `2eee573caaa4cd6f38ec67c34797e56bb614e1c6`, Breakdown was not at
presentation parity:

| Property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| 1440px row width | 1150px | 1112px | 1150px |
| Measured / hierarchy row height | 83px / 90px | 55px / 63px | 83px / 90px |
| Metric column / column gap | fixed 96px / 14px | auto 30.5–50.6px / 12px | fixed 96px / 14px |
| Track height / top margin | 6px / 8px | 7px / 6px | 6px / 8px |
| Fill end shape | rounded | square | rounded |
| Codex / OpenCode / Claude / Cursor | teal / blue / purple / violet | one orange accent | teal / blue / purple / violet |
| Known-value shares | 66% / 34% / 0.0% | 65.6% / 34.4% / 0.0% | 66% / 34% / 0.0% |
| Models / harness panel height | 346px / 370px | 328px / 319px | 346px / 370px |
| Narrow Copy / Export height | 30px | 32px | 30px |

The all-range partial fixture exposed the same reconstruction: Solid used an
82px row, a 6px dashed track and a 4px inner fill, while Svelte used a 55px row,
a 7px track and a 5px fill. Both controls agreed on legend order and on the
measured, partially measured and zero categories; the presentation of those
states was what diverged.

The root cause was the local Breakdown layer in
`apps/web/src/lib/features/report/breakdown/styles.ts` and the local row/panel
markup in `breakdown-row.svelte` and `harness-provider-panel.svelte`. They
reconstructed the retained `group*`, `bar*`, alignment, action and
unavailable-state semantics with smaller local geometry, and
`breakdown-row.svelte` applied one universal `accentFill` instead of the
Solid harness colour projection. The local sharing buttons likewise kept a
32px minimum rather than consuming `ghostButton`.

The repair restores the shared group shell and row consumers, the 6px
`barTrack` and rounded `barFill`, fixed value alignment, unavailable-state
and action semantics. The fill uses
`cx(barFill, fill.className ?? accentFill)`, so the base does not compete with
a semantic background in Panda's cascade. Harness colours now come from
`dimensionSwatch`; model rows retain their series colours; shares use the
Solid integer percentage formatter; and the narrow sharing actions consume
`ghostButton`. Fifteen Svelte exports were added to the public composition and
two report bar exports returned from reviewed removal to live use. Seven
previously orphaned exports regained consumers, shrinking debt from 154 to 147;
no export was deleted.

The strengthened existing `value-presentation.spec.ts` title first failed
with a 1112px row where the Solid invariant required at least 1148px. After the
main repair, its narrow action assertion failed at 32px instead of 30px, proving
that follow-up independently before the final fix. It now guards row and column
geometry, track and fill geometry, semantic colours, integer shares, legend
order, measured/partial/zero distinction and narrow action sizing. Web
typecheck reported 0 errors and 0 warnings; 40 focused component and
entrypoint tests passed; the focused browser test passed; the migration ledger
is complete at 384/384 live exports; the consumer ratchet is 147; and the
hydrated Solid/Svelte matrix is exact at all eight viewport/theme points.

Sessions, the session drawer, Overview tiles/token anatomy, Skills,
Sources/Sync, the duplicated Skills tree, reduced motion and the remaining
cross-surface responsive review have not yet been reached.

### Sessions table presentation-parity audit

The next comparison drove the running Solid control at `2183270e` and Svelte
at `af88b84` before changing Sessions source. The same Playwright driver
captured 32 states at 361, 768, 1024 and 1440 pixels in light and dark themes,
both with JavaScript disabled and after hydration, then repeated the complete
matrix after repair. Direct SSR is recorded rather than conflated with the
hydrated surface: Solid emits its pending Session shell, while Svelte emits no
Session table before the report owner settles. That is part of the settled
transport/lifecycle outcome and was not reworked.

Before `e7c64a86417ca12590e79c49357253dd7b181130`, the hydrated Sessions
surface was not at presentation parity:

| Property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| Advanced chooser on the zero-RTK fixture | 23 choices; `7 of 25` | 24 choices including empty RTK; no schema count | exact |
| Preset gap / preset / Advanced height | 2px / 26px / 30px | 6px / 36px / 36px | exact |
| First campaign row at 1440px | 75px | 67.19px | 75px |
| First campaign row at 768/1024px | 93px | 93px | 93px |
| Sorted arrow, light | accent `rgb(172, 75, 18)`, 10/10px | muted `rgb(110, 106, 96)`, 13/19.5px | exact |
| Mobile controls / inspect target at 361px | 60.5px / 52px | 92px / 16px | 60.5px / 52px |
| Mobile surface / first card width | transparent, no border/shadow / 321px | bordered card shell / 319px | exact |
| Responsive projection | mobile at 361; desktop at 768+ | exact | exact |
| Dark surface, line, shadow and accent tokens | semantic dark tokens | exact | exact |

Column widths and the 25-column schema itself were already intact. Work,
Tokens and Reliability also selected the correct columns; their retained
semantic chrome and the Advanced chooser presentation were missing. The main
root cause was the 134-line local reconstruction in
`apps/web/src/lib/features/sessions/table/session-table-styles.ts:3` through
line 135 at `af88b84`, consumed by
`session-table.svelte:332` through line 603 at that revision. It replaced the
retained table, control, mobile-summary, typography and sort semantics with
smaller local values. The same reconstruction flattened shared provenance into
a local title/glyph in `session-cell-projection.ts:113` and
`session-cell.svelte:65`, added 11px campaign annotations and a 28px expansion
button, and offered the empty RTK column without the Solid schema summary.

The repair makes the public Svelte composition expose and consume the retained
semantics. The live consumers are visible in
`session-table.svelte:3`, the zero-RTK/schema projection at line 152, the
desktop controls and chooser at line 360, the table at line 442 and the mobile
summary at line 527. `session-cell.svelte:3` now uses
`CellWithProvenance`, `ProvenanceMarker`, `filterTextButton`,
`sessionTitleClamp`, `highlightMark` and `muted` instead of recreating
them. Only the exact Solid popover header/grid layout remains local in
`session-table-styles.ts:3`; every other local Session style was removed.
Thirty-six live `./svelte` exports received ledger records and 25 retained
semantics regained consumers, shrinking the unconsumed-export debt from 147 to
122 without adding dead code or deleting an export.

Two measured differences are intentionally retained. The Svelte viewport is
776px at 361px, 876px at 768/1024px and 976px at 1440px, versus Solid's
629.41/646/694/794px. That is the approved viewport-only Session treadmill fix
already documented in the performance baseline, not a presentation regression.
Also, clicking the Solid campaign disclosure never changed its three rows or
issued a request during a two-second trace; Svelte correctly expands three rows
to five, including two depth-one children. The audit records that Solid defect
and does not regress the working Svelte behavior. Svelte's `aria-sort` is
likewise retained as an accepted accessibility improvement.

The strengthened existing titles at `dashboard.spec.ts:458` and line 533
failed before repair on the 6px preset gap and 36px mobile select, respectively.
They now guard the chooser schema, preset/Advanced geometry, 75px campaign row,
accent 10px sort arrow, non-overflowing table, 44/48px mobile sort pair,
transparent mobile surface, full-width card and inspect target. Restoring the
Solid last-cell affordance exposed `No ›` as its accessible name; the campaign
business invariant at line 508 now asserts the exact DOM text `No` instead of
removing the affordance. Web typecheck reported 0 errors and 0 warnings, 932 web
tests passed, the full dashboard browser spec passed 23/23, the consumer ratchet
is 122, and the migration ledger is complete at 420/420 live exports with 524
records.

The session drawer, Overview tiles/token anatomy, Skills, Sources/Sync, the
duplicated Skills tree, reduced motion and the remaining cross-surface
responsive review have not yet been reached.

### Session drawer presentation-parity audit

The next comparison drove the running Solid control at `2183270e` and Svelte
at `91734a3` before changing drawer source. The ordinary deterministic fixture
covered SSR and hydration at 361, 768, 1024 and 1440 pixels in light and dark
themes. The isolated synthetic production fixture then opened the same recorded
Claude revision on both sides, including source control and loaded chronology.
In total, 32 ordinary-fixture and 32 production-fixture screenshots accompanied
the DOM, geometry, computed-style and focus measurements; SSR was DOM-measured
because no drawer exists before hydration.

Before `bfcbe0c1491625e3e44f5256bd65ef37ed1141f1`, nearly all presentation was
already exact:

| Property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| SSR dialogs | 0 | 0 | 0 |
| 361px sheet | 361 x 624px | exact | exact |
| 768/1024/1440 drawer | 440px, full viewport height | exact | exact |
| Body padding / gap | 16px 18px / 14px | exact | exact |
| Detail grid / gaps | two columns / 12px 14px | exact | exact |
| Close target / glyph line-height | 30 x 30px / 14px | 30 x 30px / 21px | exact |
| VCS region, narrow / wide | 325 x 204.70px / 403 x 188.77px | exact | exact |
| Chronology at 361 / 768 / 1024+ | 325 x 960.88px / 684.91 x 753.38px / 923 x 693.38px | exact | exact |
| Initial focus / Tab behavior | Close / leaves after 12 internal stops | exact | exact |
| Immediate Escape return | `body` | exact shared defect | unchanged |
| Served campaign controls | absent | 164.25px block plus 14px gap | retained exception |

The sheet/right-drawer breakpoint, border side and radius, body overflow,
two-column details, navigation and action geometry, token anatomy, comparison
hint, VCS ordering, chronology tracks and notices, prompt disclosures, model
phases, and all light/dark semantic colours matched. Framework whitespace and
text-wrapper nodes differed, but their rendered region dimensions and computed
styles did not.

The one presentation regression came from the local semantic reconstruction in
`session-drawer.svelte:6` through line 84 at `91734a3`. Its local `drawerClose`
omitted the Solid semantic style's `lineHeight: 1`, transition and disabled-hover
state, leaving the glyph at the inherited 21px line-height. The same block
duplicated the retained drawer shell, body, grid, navigation, legend, comparison
and action semantics even where their current values happened to remain exact.

The repair restores those semantics as live Svelte exports in
`packages/design-system/src/svelte/overlays/styles.ts:24` through line 85 and
uses the retained close control at
`packages/design-system/src/components/button.ts:293`. The public composition is
declared in `packages/design-system/src/svelte.ts`, and the consumer imports are
visible in `session-drawer.svelte:16`. Only the 960px analysis width and token
segment tone classes remain local because they were local in the Solid source.
All 14 restored exports have consumers; the live/ledger counts grew from
420/524 to 434/538 while the unconsumed-export debt stayed at 122.

Two measured differences were deliberately not changed. First, the working
Svelte served-campaign controls add 164.25px plus the shared 14px grid gap before
the detail grid. Solid intentionally returns no selected campaign while a served
query is active. This is the same accepted working campaign-expansion exception
recorded by the Sessions audit, and removing it would regress product behavior.
Second, both implementations explicitly set `modal={false}` and
`trapFocus={false}`. Tab leaves after the same 12 internal controls, and even an
immediate Escape leaves focus on `body` rather than returning it to the focused
row/card trigger. That focus-return failure is shared by Solid; changing the
interaction requires product approval and was not smuggled into a parity repair.

The strengthened existing title at `dashboard.spec.ts:444` failed before repair
with expected `14px`, received `21px`, then passed with the exact 30 x 30px and
14px invariant. Web typecheck reported 0 errors and 0 warnings; 932 Web tests and
12 focused design-system tests passed; the consumer ratchet remained 122; and
the complete post-fix viewport/theme/SSR/hydration matrix matched. The migration
ledger is complete at 434/434 live exports with 538 records.

Overview tiles/token anatomy, Skills, Sources/Sync, the duplicated Skills tree,
reduced motion and the remaining cross-surface responsive review have not yet
been reached.

### Overview tiles and token-anatomy presentation-parity audit

The next pre-change comparison drove Solid `2183270e` and Svelte at `e39ee68e`
through 361, 768, 1024 and 1440 pixels, light and dark themes, and both SSR and
hydration. Ninety-six screenshots covered the full page, metric region and
Token anatomy panel for all 32 implementation/state combinations. The probe
captured rendered text and classes, element counts, bounding boxes, computed
grid/style/theme values and document height.

The Overview hero and Token anatomy were already exact. The secondary metric
surface was not:

| Property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| Hero at 361 / 768 / 1024 / 1440 | 321 x 231 / 480 x 206.89 / 736 x 151.39 / 1152 x 151.39px | exact | exact |
| Token anatomy at 361 / 768 / 1024 / 1440 | 321 x 279.5 / 480 x 260 / 736 x 240.5 / 1152 x 240.5px | exact | exact |
| Secondary shell | bordered card, separate header and count `8` | absent | exact |
| Grid columns at 361 / 768 / 1024 / 1440 | 2 / 4 / 4 / 4 with 10px gaps | 1 / 2 / 4 / 4 with 12px gaps | exact |
| Value bases at 361px | 291 x 252px, full grid width | 321 x 140px | exact |
| Value bases at 768 / 1024 / 1440 | 220 x 285 / 348 x 226.5 / 556 x 208.5px, two columns | 480 / 736 / 1152 x 140px, full width | exact |
| Remaining metric tiles | 5 in Sessions, Mean, Fresh, Turns, Tools order | 6 in a different order, including zero RTK | exact |
| Tile widths at 361 / 768 / 1024 / 1440 | 140.5 / 105 / 169 / 273px | 321 / 234 / 175 / 279px | exact |
| Tile hint controls | labelled `i` buttons on all five tiles | absent | exact |
| Value-basis hint controls | labelled bordered `i` buttons | borderless `?` buttons | exact |
| Large deltas | `×5.0`, `×11`, `×9.5`, `×17` | `400%`, `994%`, `850%`, `1611%` | exact |
| Light/dark surface, line, shadow, ink and accent | semantic theme tokens | Token anatomy/hero exact; metric shell divergent | exact |
| SSR versus hydrated target geometry and copy | identical | same divergences in both states | exact |

The hero's API-equivalent qualifier, price provenance, reported-spend badge and
5/5 spend coverage were exact before and after repair. Token anatomy likewise
kept its 61% headline, four-row order, exact token values/percentages, 8px
swatches with four accent opacities, row geometry and dark tokens. The shared
Solid narrow flex behavior can shrink nominal 24px hint buttons to 14–22px in
the most constrained cells; Svelte now reproduces those measured dimensions
instead of silently changing the shared design.

The main root cause was the local reconstruction in
`dashboard-metrics.svelte:1` through line 104 at `e39ee68`. It omitted the
secondary card/header/count, changed grid breakpoints and gaps, made Value bases
full-width, weakened its hint controls, and nested the shared `MetricTile`
inside marker wrappers. The parallel reconstruction in `view-model.ts:36`
through line 109 changed frozen labels and order, always emitted RTK even at
zero, and discarded the Solid factor formatter for deltas of at least 400%.
`overview-hero.svelte:1` through line 41 duplicated eight retained semantics;
its values happened to be exact, but all eight shared exports had lost this
consumer.

Commit `81aaa189319d3bac0a5a76225140d4486028cd62` restores the original
composition. The secondary shell, grid and Value-bases structure are visible in
`dashboard-metrics.svelte:12` through line 136. The exact frozen projection and
factor formatter live in `view-model.ts:31` through line 129. The app-specific
hint/tile leaves consume the restored shared metric styles from
`packages/design-system/src/components/metric-tile.ts:3`, while the generic
Svelte `MetricTile` consumes the same module. `overview-hero.svelte:2` now uses
the retained hero semantics directly. Five `./report` metric exports returned
to current ownership, eight existing hero exports regained consumers, and the
unconsumed-export debt fell from 122 to 114 without deleting an export.

The strengthened existing browser title at `dashboard.spec.ts:277` first
failed because the Solid secondary header/count did not exist. It now guards
the count, five-tile projection, Sessions hint, `×5.0` delta, four-column
desktop grid, two-column 361px grid, 10px gaps and full/half-width Value-bases
invariant. Web typecheck reported 0 errors and 0 warnings; 932 Web tests and 9
focused design-system tests passed; the browser title passed; and the final
96-screenshot matrix matched for every targeted element. The migration ledger
is complete at 439/439 live exports with 538 records.

The document height still differs outside these target bounds by 530px at 361,
268px at 768, 414px at 1024 and 402px at 1440. No target element accounts for
that remainder; it is carried into the remaining cross-surface review rather
than being misreported as Overview tile or Token-anatomy parity.

Skills, Sources/Sync, the duplicated Skills tree, reduced motion and the
remaining cross-surface responsive review have not yet been reached.

### Skills workspace presentation-parity audit

The pre-change comparison drove Solid `2183270e` and Svelte at `de246b4`
through 361, 768, 1024 and 1440 pixels, light and dark themes, and both SSR and
hydration. Ninety-six state captures covered the editor, matrix and global
management routes. The probe recorded page and workspace geometry, rendered
text/classes, table and card content, computed grid/display/wrapping/theme
values, focusable descendants and document height.

| Surface and property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| Editor workspace at 361px | 321 x 1382.89px | exact | exact |
| Editor workspace at 768 / 1024px | 480 x 1416.5 / 736 x 1662px | 8px shorter; editor 8px too high | exact |
| Editor workspace at 1440px | 1152 x 860px | 1152 x 900px; editor 40px too low | exact |
| Editor shell at 1440px | 554 x 738px | 554 x 778px | exact |
| Matrix workspace at 361px | 321 x 1696.5px | 321 x 1741px | exact |
| Matrix cards at 361px | 283 x 402px with Auto and `4 tok` metadata | 283 x 298px; metadata absent | exact |
| Matrix table at 768 / 1024 / 1440px | 860 x 224px | 860 x 238px | exact |
| Matrix Inspector at 361 / 768 / 1440px | 321 / 480 / 288 x 328.5px | 321 x 574 / 480 x 550 / 288 x 574px | exact |
| Global detail at 361 / 768 / 1440px | 321 x 974 / 480 x 766 / 592 x 626px | 321 / 480 / 592 x 175 / 166 / 166px placeholder | exact |
| Global consolidation row | 283 / 442 / 554 x 100px | content absent | exact |
| Disabled and Configuration disclosures | one responsive row with 16px gap | stacked; second row 95px too low | exact |
| Light/dark target geometry | identical by theme | same divergences in both themes | exact |

The editor root cause was a local breakpoint reconstruction in
`editor/skill-markdown-editor.svelte`. It kept the header, editor and actions
on three rows until `2xl`, whereas Solid switches to the two-row
`"header actions" / "editor editor"` grid at `md`. The first repair exposed a
second difference: the local heading style used `overflow-wrap: break-word`,
while the retained `strongCell` uses `anywhere` in the constrained toolbar.
Lines 47–57 and 180–196 now carry the exact grid and shared heading semantic.

The matrix root cause was the local presentation layer in
`management/skills-matrix.svelte`: it changed table cell height, badges,
separators and responsive cards, and omitted the Auto and token metadata on
mobile. Lines 42–75 and 285–330 now restore the measured card/table split,
860px table, retained badges and complete mobile content.

The global-scope branch in `shell/skills-workspace.svelte` rendered only an
integration placeholder, while the shared health slot owned the entire
management page inside the Inspector. Lines 297–379 restore the Solid detail
hero, metadata and Needs-attention content and place management detail and
Inspector summaries deliberately. `management/skills-health-slot.svelte`
lines 175–182 and 344–405 restore the 14px stacks, responsive two-column
disclosures and compact Inspector. `management/skills-health.svelte` lines
1–55 consume the restored shared `metricGrid` and metric semantics. Refresh
ownership remains reactive across Overview, matrix and skill transitions, so
this presentation repair does not reopen the settled lifecycle outcome.

Three existing Skills browser contracts were strengthened and shown red before
the implementation: the desktop workspace title failed on a 58px editor
offset and then `break-word` versus `anywhere`; the matrix title failed because
Auto and `4 tok` were absent on mobile; and the unmanaged-copy title exposed
the 95px disclosure offset. Commit
`0e5b16f8682d687fc9e37b436e35daebb51d4abf` makes all 16 Skills browser tests
green. Web typecheck reports 0 errors and 0 warnings, the final differential
is exact for every target in both themes, and the unconsumed design-export
debt fell to 103 without deleting an export. The migration ledger is complete
at 440/440 live exports with 538 records.

Both implementations still contain two `Skills` headings at desktop widths.
The mobile-picker tree is hidden by its outer `display: none`; its seven
descendant controls have zero rendered focus stops, but the descendants are
not individually `aria-hidden` or inert. This is a shared Solid accessibility
defect, so it is recorded rather than changed without product approval. Solid
also renders no Skills workspace with JavaScript disabled while Svelte emits
meaningful SSR content; that difference belongs to the already-settled
SSR/hydration outcome and was not rejudged.

Sources/Sync, reduced motion and the remaining cross-surface responsive review
have not yet been reached.

### Sources and Sync presentation-parity audit

The pre-change comparison drove Solid `2183270e` and Svelte at `5004715`
through 361, 768, 1024 and 1440 pixels, light and dark themes, and both SSR and
hydration. The base matrix captured 80 states and 160 full/target screenshots
across Sources default, expanded and degraded-SSE states plus Sync. Sixteen
additional live-upload states measured progress, and 16 no-JavaScript probes
isolated the Sync connection notice.

Sources was already at level-4 presentation parity and required no source
change. Sync was not:

| Surface and property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| Sources route at 361 / 768 / 1024 / 1440px | 321 x 511.59 / 480 x 532 / 736 x 512.5 / 1152 x 466.5px | exact | exact |
| Sources healthy summary, closed / expanded | 100px / 1034.5, 596, 558.5, 558.5px high | exact | exact |
| Sources degraded Codex card at 361 / 768 / 1024 / 1440px | 321 x 349.5 / 480 x 287.5 / 362 x 320.5 / 570 x 287.5px | exact | exact |
| Sync route at 361px | 321 x 687.5px at x20, y96.09 | 361 x 687.5px at x0, y72.09 | exact |
| Sync route at 768 / 1024 / 1440px | 480 x 1000.5 / 736 x 955.5 / 1152 x 875.5px at x252, y108.5 | 552 x 985.5 / 808 x 907.5 / 1224 x 875.5px at x216, y76.5 | exact |
| Fleet at 361 / 768 / 1024 / 1440px | 321 x 335.5 / 480 x 362.5 / 736 x 317.5 / 1152 x 237.5px | too wide with the route | exact |
| Live progress region | 283 / 442 / 698 / 1114 x 54px | 257 / 416 / 672 / 1088 x 72px | exact |
| Live progress track | full region width, 6px, bordered | inset, 8px, borderless native `progress` | exact |
| Narrow pending drop target | 283 x 128px with frozen drop copy | 283 x 112px with `Previewing merge file…` | exact |
| SSR connection notice at 361 / 768 / 1024 / 1440px | full-width 321 x 80.5 / 480 x 61 / 736 x 41.5 / 1152 x 41.5px before fleet | inset 12px paragraph inside Manual transfer | exact |
| Light/dark target colours, borders and shadows | semantic theme tokens | same geometry divergences in both themes | exact |

The Sources default panels, publication time, expanded per-source details,
deviation cards, missing-source copy, degraded-SSE notice, legend/order and all
measured computed styles were exact. The only text-node difference was
framework whitespace, with no rendered geometry or accessible-copy effect.

Sync's first root cause was the local `css({ minW: 0 })` shell at
`sync-root.svelte:28` in the pre-repair revision, replacing the retained
bounded shell. Commit `ad1da6c8d0a7adb3ceae3db8910e3fb90e7fd11e` restores
the shared shell, now consumed at `sync-root.svelte:3` and line 39. The same
commit replaces the locally reconstructed native progress element from
`manual-transfer-progress.svelte:16` through line 55 in the pre-repair
revision with the exact semantic 6px track at lines 18–75, and restores its
position after the drop target at `manual-transfer.svelte:252`.

That comparison also exposed two browser-only defects in the reconstructed
transfer flow. Reading `event.currentTarget` after an await at pre-repair
`manual-transfer.svelte:205` lost the element under Svelte event dispatch;
lines 193–197 now retain it before awaiting. The conditional pending label at
pre-repair lines 228–230 shortened the narrow drop target, so lines 217–218 now
keep the frozen Solid copy while the progress region communicates pending
state.

Finally, the no-JavaScript probe showed that the connection-state message was
passed into Manual transfer and rendered at pre-repair
`manual-transfer.svelte:188` as an inset paragraph. Commit
`7c45bee9ab4f4e39dfb078f9b84215d793e577a2` keeps the same derived state and
ownership but restores the Solid presentation at `sync-root.svelte:28` and
lines 50–53: a full-width bordered status before Machine fleet. No transport,
boundary, cache, lifecycle or hydration outcome was reopened.

The strengthened existing title at `accessibility.spec.ts:88` first failed
on `max-width: none` versus 1380px, then its no-JavaScript branch at line 106
failed on `display: block` versus grid. The strengthened transfer title at
`dashboard.spec.ts:691` first failed on the 8px track, then exposed the stale
event target and 112px pending drop target. Both titles are green. Web
typecheck reports 0 errors and 0 warnings, 21 focused Sync and 57 combined
Sources/Sync unit tests pass, the Sources browser spec passes 5/5, the
unconsumed-export debt remains 103, and the migration ledger remains complete
at 440/440 live exports with 538 records.

Reduced motion and the remaining cross-surface responsive review have not yet
been reached.

### Provider status and cross-cutting presentation-parity audit

The final comparison drove Solid `2183270e` and the integrated Svelte branch
through the frozen 361, 768, 1024 and 1440px widths. Provider status was
captured in light and dark themes, with JavaScript disabled and hydrated, and
with its provider details closed and open: 32 states before and 32 after the
repair. The cross-cutting probe added 160 states across Overview, Skills
editor, Skills matrix, Sources and Sync: both frameworks, all four widths,
both themes, and normal versus reduced motion. A one-second settled Sync probe
separated asynchronous layout settling from presentation geometry.

Provider status was the last unmeasured part of REPORT-03 and was not at
parity:

| Property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| Closed panel at 361 / 768 / 1024 / 1440px | 547 / 454 / 320 / 260px | 877 / 600 / 576 / 504px | exact |
| Open panel at 361 / 768 / 1024 / 1440px | 1255 / 1004 / 870 / 810px | 1551 / 1032.5 / 938 / 866px | exact |
| Attention group at the four widths | 123 / 84 / 54 / 24px | 316 / 153 / 153 / 153px | exact |
| Provider categories at the four widths | 162 / 144 / 84 / 54px | 362 / 266 / 242 / 170px | exact |
| Details summary | 38px | 24px | exact |
| Frozen subtitle | Quota usage and operational issues at a glance. | Quota windows and collection quality… | exact |
| Quota-history action | header action | after provider details | exact |
| Theme and SSR/hydrated geometry | invariant | same divergences in every state | exact in all 32 states |

The root cause was the local card-grid reconstruction in
`provider-status.svelte:1-197`. It replaced the compact Solid category and
issue composition, moved the history action and changed frozen copy. Commit
`12b47b39778aaa1fdf423fc5be9291a9b83da59c` restores the original
composition at `provider-status.svelte:200-370` while retaining the typed
provider projection and quota semantics. The strengthened existing browser
title first failed at 504px versus the 260px desktop invariant and now guards
the closed/open panel, attention/category groups, 38px disclosure summary,
frozen subtitle and the 361px responsive state.

That repair made the remaining whole-page difference legible. Svelte had
placed the Date range, active-filter summary, More report metrics and Provider
status inside the focusable `data-dashboard-panel`, while Solid places range
and filters before the active report view and secondary status after it. The
local workspace section also added 16px top and bottom padding that the
retained `section` semantic never had.

| Composition property | Solid `2183270e` | Svelte before repair | Svelte after repair |
| --- | ---: | ---: | ---: |
| Date-range ancestry | outside dashboard panel | inside | outside |
| Active-filter ancestry | outside dashboard panel | inside | outside |
| Metrics/provider ancestry | outside dashboard panel | inside | outside |
| Dashboard-panel start | exactly at Overview hero | before Date range | exactly at Overview hero |
| Secondary-status separation | 20px after dashboard panel | nested plus local grid gaps | exact |
| Dashboard height at 361 / 768 / 1024 / 1440px | 1815 / 1654.89 / 1424.89 / 1424.89px | included range/filter/padding | exact |
| Date-range y at the four widths | 287.59 / 300 / 254 / 208px | desktop 2px late inside padded panel | exact |

Commit `5e839aa2a89b0de02e27b18f8900237ca11a2bb2` restores
those ownership seams. The live ordering is explicit at
`live-report-destination.svelte:396-454`; the synthetic destination carries
the same boundary. `report-workspace.svelte:29-50` now owns only the active
report view and the following status snippet and consumes the retained
zero-padding `section` export. `overview-status.svelte:1-27` owns the
secondary metrics/provider projection instead of leaving it embedded in
Overview content. The strengthened provider-status browser title first failed
because Date range still had a dashboard-panel ancestor; it now guards all
four ancestry boundaries, exact hero/panel alignment and the 20px status gap.

The resulting primary stack still differed by 2px. The differential localized
that remainder to Top sessions: Solid's shared `Panel` applies
`panelHeader`, while `records.svelte` had rebuilt the header as an unstyled
`div`. The new browser title failed at 172px versus Solid's 174px. Commit
`2e74ebfacfccfeb662fe42899ec5c177480a24b5` restores the semantic
header consumer at `records.svelte:90-98`; the title is green and the entire
dashboard-panel height is now exact at all four widths.

After these repairs the only whole-document height remainder is the
already-closed Activity range outcome: Svelte is 156px taller at 361px, 78px
at 768px and 114px at 1024/1440px, exactly matching the measured Date-range
height difference at each width. Date-range top positions are exact and no
other element accounts for any remainder. Per the reopening scope, Activity
was not redone or rejudged.

Reduced-motion behavior is exact across the 80 reduced states: the maximum
computed animation or transition duration is `0.00001s` in both
implementations. All 80 normal-motion states top out at `0.15s`. Theme and
motion preference do not move target geometry. Skills, Sources and the
one-second settled Sync layout remain exact in light and dark at every frozen
width; the initial Sync difference at 100ms was asynchronous settling, not a
stable presentation divergence.

The shared Solid defects and accepted working differences remain explicit:
the duplicate hidden desktop Skills tree remains in both accessibility trees
without rendered focus stops; both nonmodal session drawers fail to return
focus; Solid campaign expansion remains inert while Svelte's working
expansion is retained; and the closed Activity outcome remains out of scope.
Changing any of those requires product approval.

No requested surface was left unreached. Punchcard/Rhythm, Breakdown,
Sessions, drawer, Overview metrics/token anatomy, Skills, Sources/Sync,
Provider status, dark theme, reduced motion and all four responsive widths
have level-4 measurement records in this reopening section. Focused validation
for the final repairs reports zero Svelte typecheck errors or warnings, 81/81
Overview/report-core tests, 20/20 Overview SSR/compile tests, green
red-to-green browser titles and an unchanged unconsumed-export debt of 103.
