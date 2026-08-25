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

## Direction Audit 074–085, Unattended Five-Train Run — 2026-08-20

Twelve plans executed in parallel by five coordinator-dispatched executors, each
in its own git worktree branched from `5e4cf954`. The main checkout was never
touched: a concurrent live session was committing to
`refactor/report-decision-first-ui-ux` throughout, and it advanced to `6beb0c0e`
("Restore draggable report period brush") during the run.

Because plans 074–085 and their `plans/README.md` rows were still untracked in
that checkout, every train branch was seeded with an identical plans-baseline
commit `462758ce` — same parent, tree and message, so it is literally the same
commit object on all five branches and resolves cleanly wherever they merge.
E2E was serialized across trains behind one `flock`: `playwright.config.ts` pins
port 4174 with `--strictPort` and `reuseExistingServer: false`, so concurrent
runs would have failed to bind and produced false BLOCKED rows. The baseline was
verified green *and* verified capable of failing (an injected type error was
caught in the worktree) before any executor started.

### Train outputs

No executor STOP condition was triggered. All twelve plans produced their
intended implementation or design artifact. Whole-train and final QA reviews
subsequently identified and corrected several integration defects; the per-train
gate results below are the executors' own, recorded before those reviews, and
the corrections are listed under "Resolved during final QA".

- **A `feat/quota-surface`** (PR #30) — 074 provider-neutral quota history with a
  two-provider fixture and the dormant `providerHistoryAvailable` gate finally
  wired; 081 `quota --history` as a pure read; 080 the md-band compact rail plus
  the two missing presentation viewports.
- **B `feat/sync-transfer`** (PR #31) — 075 bundle identity, age and bounded
  warnings in the `/sync` preview, with `merge-proof.ts` untouched; 079 Cursor CSV
  import and machine renaming from the web, tightening the upload media-type check
  to match the parsed action.
- **C `feat/report-ux`** (PR #32) — 076 display-only campaign title inheritance
  with `session-query.ts` untouched; 078 client-side sessions CSV export; 082
  bounded `Other` member disclosure with no filter surface added.
- **D `feat/sources-onboarding`** (PR #33) — 077 zero-source first-run guidance on
  `/sources`.
- **E `docs/design-spikes`** (PR #34) — 083/084/085 delivered as memos only, no
  build phase executed.

### What awaits a decision

- **083** recommends approving Phase B but splitting it: 84% of unmanaged entries
  are symlinks and only ~23 are adoptable, so the first ship should explain the
  other 159 rows rather than offer to consolidate them.
- **084** recommends **not building** the intent signal. Coherent clusters have
  86–99% top-term recall, so they cannot group sessions that share an intent but
  not a vocabulary; coverage tops out near 14.5%. It asks to close the standing
  intent-grouping deferral for good.
- **085** rules a print stylesheet **outside** the plan-009 rejection and cuts the
  recap to four statements the bounded Overview payload already carries. Its
  two-engine print gate is unmet — no reachable Gecko exposes `--print` — and the
  status row now says so.

### Resolved during final QA

Two review passes ran after the trains finished — a whole-train review that
found the compositions no single-plan review could see, and a final QA pass that
took each branch to a green local gate against the current base. What they
changed:

**Correctness across two plans.**

- **Protocol version.** 075 changed `merge-preview`'s wire shape into required
  fields while `USAGE_ENGINE_PROTOCOL_VERSION` stayed 1, so an old engine meeting
  a new web failed as `invalid-response` instead of `protocol-mismatch`. The
  constant is now 2. The sweep that followed was larger than the bump: a dozen
  fixtures still hardcoded `1`, and `client.test.ts` threw at module scope, which
  silently dropped its whole file — 38 tests collected before, 58 after. Fixtures
  now derive from the constant, and deliberate-skew fixtures derive from it as
  ±1 so a future bump keeps testing skew.
- **Machine-label cap.** 079's editor accepted 240 UTF-8 bytes while 075's
  preview parser rejected past 120 characters, so a machine renamed in the new
  editor could export a bundle its peer could not preview. One canonical bound of
  240 UTF-8 bytes now spans the editor, the command parser and the preview
  parser, with the boundary asserted at 240/241 ASCII and 120/121 `é`.
- **Stale merge proofs.** A rename or a Cursor import moves the store generation,
  which invalidates an open preview's confirmation token server-side; the UI kept
  an armed Confirm button in front of it. Sibling mutations now invalidate the
  open preview instead of leaving a button that could only fail.

**Honesty of what the product says.**

- **Sessions CSV.** A filtered campaign could produce a display row carrying the
  root's identity beside child-derived metrics, serialized as if it were a real
  session. The export now has its own `campaign_aggregate` schema — `row_kind`,
  `campaign_key`, `campaign_label`, `visible_sessions`, `campaign_sessions` and
  metrics — and carries no harness, machine, provider, model, project or session
  identity at all. Absent metrics stay empty rather than becoming zero.
- **Sessions scope wording.** The control compared a campaign-row count against a
  session total in one sentence. Campaign-row pagination and represented session
  coverage are now stated as two separate units.
- **First-run guidance.** `/sources` no longer implies collection will notice a
  newly installed tool by itself; it offers `Detect all`, and the OpenCode entry
  lists the Linux, macOS and Windows locations the collector actually accepts.
- **Quota history.** A read that skipped every corrupt row produced the same
  empty array as a store that never recorded anything, and both were reported as
  `empty`. `partial` now wins, in the wide event and in the CLI's own sentence.
- **Upload policy.** The manual upload route was described as accepting only
  `portable-usage-json` while it also receives `text/csv`; it has its own
  media-neutral size class now, with the per-action media type still enforced
  exactly.

**Design documents that would have been built wrong.**

- **083** gained two invariants. The quarantine root was only `mkdir`-ed
  idempotently, which succeeds on a symlink to a directory and would have let the
  quarantine rename follow it out of the projection root; it is now lstat-ed and
  canonical-path-checked under the lock, and an unsafe root is refused rather
  than repaired. Separately, re-hashing the entry immediately before the rename
  does not close the TOCTOU window — the rename moves the original — so the
  digest is re-taken after quarantine and divergence restores the original rather
  than publishing a stale copy.
- **084** splits its local-only option in two and requires B2 to name what
  enforces it: a strip-list over named exports is a denylist over a growing set
  of portable surfaces.
- **085** no longer reads as though two engines produced and validated the same
  PDF. Chromium produced a real paginated PDF; Gecko was exercised under print
  media only, and its pagination stays unverified.

**Gates that were not actually green.** The executors' per-train "gates green"
notes did not survive re-running against the current base. `feat/report-ux`
failed the formatter, then eight `svelte-check` errors behind it, then two stale
SSR assertions. `feat/sources-onboarding` had an unbalanced brace that stopped
`ultracite check` at parse. Both are fixed. The gzip ledger was over budget on
two branches after merging the base; both were re-measured against that base
rather than bumped, and the growth that had no entry at all — 93 bytes on A, 367
on B — now carries one.

One CI failure was not a regression. `docs/design-spikes` is documentation only,
yet its "Unit, Build, Client Boundary" job failed on `@ai-usage/design-system`'s
Chromium compound-controls test at exactly 15001.79ms — a launch timeout, not an
assertion. The same suite ran 47/47 five times in a row locally on that branch's
head. Treated as a pre-existing flake in a browser-launching unit test, not a
finding; a docs-only diff cannot reach that package.

### Notes for the next run

Three of four out-of-scope file edits were forced by the plans' own steps
colliding with guards their authors had not run — a gzip budget, a package
boundary rule, a pinned fixture count. The plans were right about intent and
wrong about mechanism, and the executors were correct to follow the evidence and
record the deviation in the plan file rather than ship a red gate. Plan 081's
prescribed import is a genuine plan defect if that text is ever reused.

The whole-train review earned its place: the two most valuable findings of the
run — the label-cap mismatch and the stale merge proof after a sibling mutation —
are compositions of two individually correct plans, invisible to any single-plan
review.

`git rebase --continue` and `git merge` were blocked by the session's permission
policy, so the trains were left based on `5e4cf954`. All five now carry the tip
as an ancestor: B, C, D and E merged it themselves, and A was merged during
final QA. Each conflicted with the tip in exactly one file,
`apps/web/src/css-bundle.test.ts`, whose additive budget ledger is a
serialization point every bundle-affecting branch must touch. The resolution is
always to keep every constant and every term in the sum, never `ours` or
`theirs`.

That ledger has a second, sharper hazard the run made concrete: each branch
measured its own budget against the base *it* started from, and gzip deltas do
not add. Two branches went over once the tip was merged, and on both the excess
turned out to belong to a change that had shipped with no entry at all, hidden
by whatever headroom the older base happened to have. Whoever merges these in
sequence must re-run `bun test apps/web/src/css-bundle.test.ts` after each merge
and, if it fails, measure the split rather than raise a number.

## UI/UX Audit 086–098, Unattended Five-Wave Run — 2026-08-24

The program ran on `plan/086-ui-ux-audit-remediation` from fixed base
`51815b70`. Implementation reached `1f36977d`; PR #46 stayed a draft and was
not merged. Only the production changes for 087 and 091 were fast-forwarded
into the program branch. Every other delivery branch tip was preserved; only
selected child worktrees were recreated, while the original 088/090/095
worktrees remain absent.

### Child outcomes

| Plan | Result | Commits | Correction rounds and Codex verdicts |
| --- | --- | --- | --- |
| 087 | BLOCKED — production code landed, but U01 still lacks an assigned asymmetric root-query fixture | `ac53024e` merged | 2/2; verbatim verdicts unavailable; checkpoint confirms a proof-means defect, not a reproduced production defect |
| 088 | BLOCKED — the two-machine/different-value aggregate proof and deterministic visible-copy assertions remain incomplete | `59792b5f` not merged | 2/2 plus the exceptional third correction exhausted; checkpoint records BLOCKED, verbatim Codex verdict unavailable in this clone |
| 089 | BLOCKED — an open bound outside the known domain can produce a negative inclusive day count | `4521e995`, `5bca1f65` not merged | 2/2; r1 REWORK, r2 REWORK, r3 REWORK |
| 090 | BLOCKED — a row without a commit date can inherit an out-of-period scoring date | `79a0a3a6` not merged | 2/2; verbatim Codex verdicts unavailable in this clone |
| 091 | DONE — the single-scroll contract now includes a paged campaign's real trailing control | `f726c11e`, `99229546`, `1f36977d` merged | 2/2; r1 REWORK, r2 ACCEPT, final-r1 REWORK reopening, r3 ACCEPT |
| 092 | BLOCKED — explicit accessibility STOP: the Ark dialog has no accessible name | no delivery commit | 0; STOP before delivery review |
| 093 | BLOCKED by 089 | not launched | 0 |
| 094 | BLOCKED by 088 and 093 | not launched | 0 |
| 095 | BLOCKED — absent `machineId` values collapse under one empty grouping key | `6d71cbbc` not merged | 2/2; verbatim Codex verdicts unavailable in this clone |
| 096 | BLOCKED — the warning-tone proof can assert before its transformed refresh settles | `39eb5aa9`, `4940ee5b` not merged | 2/2; r1 REWORK, r2 REWORK, r3 REWORK |
| 097 | BLOCKED by 088 | not launched | 0 |
| 098 | BLOCKED by 088 and 094 | not launched | 0 |

Plan 091 has three clearly scoped commits because each of its two permitted
correction rounds was committed separately. This follows the runbook's
allowance for a few commits with clear scopes. Its `dashboard.spec.ts` oracle
replacement was explicitly reviewed and accepted in 091 r1/r2; it is evidence
maintenance for U12 copy plus the settled column focus/geometry contracts, not
an unreviewed scope expansion.

### Finding closure ledger

Every U-row is accounted for below. `RESIDUAL` means no accepted child closes
the finding; it does not claim that every demo fixture visibly reproduced it.
The final fresh-eyes ledger separately records the symptoms it re-observed.
`UNVERIFIED` means the deterministic repository fixture did not establish
closure; private discovery material gives it no acceptance credit.

| Findings | Final state | Evidence or residual |
| --- | --- | --- |
| U01 | UNVERIFIED / 087 BLOCKED | The production fix is present, but the asymmetric root-query presentation fixture is still missing. |
| U02, U03, U06, U42 | RESIDUAL / 088 BLOCKED | Canonical-number, fleet, drawer-root, and longest-session contracts remain rejected with the unmerged child. |
| U04a, U04b, U05, U19, U32, U37a | RESIDUAL / 089 BLOCKED | Period count, caveat, date, and domain behavior remain rejected; the final child review found a negative open-bound day count. |
| U08 | RESIDUAL / 090 BLOCKED | Cursor-AI period/date inheritance remains rejected. |
| U11, U12, U13, U14, U36 | VERIFIED / 091 DONE | Repository-owned units, settled geometry, a real paged-campaign component fixture, production-report, scale, and fresh Codex r3 all pass. |
| U07, U15, U39, U40 | RESIDUAL / UNVERIFIED / 092 BLOCKED | The explicit STOP remains: the opened Ark dialog has no accessible name. U39 remains UNVERIFIED while the synthetic source fixture reports ready; no other filter-bar claim is promoted. |
| U04-chart, U17, U18, U34 | RESIDUAL / 093 BLOCKED | The child was not launched because 089 did not land. |
| U16, U20, U21, U35, U38, U41 | RESIDUAL / 094 BLOCKED | The child was not launched because 088/093 did not land. |
| U22, U23, U28b | RESIDUAL / 095 BLOCKED | Provider grouping remains rejected and U28's warning transition is not promoted from discovery evidence. |
| U24, U25, U26 | RESIDUAL / 096 BLOCKED | The warning presentation proof remains unsettled; the unmerged Skills branch receives no closure credit. |
| U27, U28a, U30 | RESIDUAL / 097 BLOCKED | The child was not launched because 088 did not land. |
| U09, U10, U29, U31, U33, U37b | RESIDUAL / 098 BLOCKED | The child was not launched because 088/094 did not land. |

### Gates by wave

- Wave 1 (087, 088, 090, 095): 087 was merged; 088, 090, and 095 finished
  BLOCKED and were not merged. The resumed clone does not contain verbatim
  whole-wave gate/review evidence for this checkpoint, so no green wave claim
  is made.
- Wave 2 (089, 092, 096, 097): lint covered 1,083 files and five guards;
  typecheck passed 28/28;
  package coverage recorded 2,204 positive tests and tools recorded 115;
  build passed 15/15 immediately before bundle 4/4 at 284,561 B. The wave
  composition review returned ACCEPT.
- Wave 3 (091, 093) before the last 091 correction: package coverage recorded 2,212
  positive tests; tools recorded 115; production-report passed 12/12; the
  5,000-session scale proof passed 2/2; bundle measured 284,635 B. The wave
  composition review returned ACCEPT.
- Final 091 correction: units 33/33, exact paged-campaign causal browser 1/1,
  geometry 5/5, production-report 12/12, scale 2/2, build 15/15 immediately
  before bundle 4/4. Codex r3 returned ACCEPT.
- Program tip `1f36977d`: lint passed over 1,084 files and five guards;
  typecheck passed 28/28 and direct Svelte checking returned no errors or
  warnings; build passed 15/15 immediately before bundle 4/4 at 284,635 B.
  Tools passed 115 tests with 302 assertions while exactly seven D16/D17
  titles stayed excluded; D16 had one aborted invocation after it spawned the
  forbidden install, never completed, and was excluded thereafter. The package
  aggregate was not all-green: one writer-lock race failed and then passed
  both alone and in its workspace rerun; the browser-backed design-system
  complement passed 47/47 under the shared lock.
- Final default Playwright under the shared lock and two workers collected 151
  tests: 145 passed and six failed. D18 reproduced alone at 44 px observed
  versus 48 px expected. Four missing Darwin snapshots passed individually
  against generated images whose dimensions and hashes matched the earlier
  differential exactly; those untracked images were then deleted by exact
  path. The Svelte shell timeout/`EBADF` passed alone. A navigation-hydration
  title failed once alone and passed on a second final isolate and at the
  unchanged wave-start baseline; it remains an intermittent, unattributed
  gate failure. The separately filtered positive run was therefore honestly
  144/146, not all-green.
- The final clean synthetic production environment first exposed a race in one
  request-count test. The same unchanged title also failed at the wave-start
  baseline at a different phase. A canonical final rerun passed 12/12. The
  5,000-session desktop/mobile scale proof passed 2/2 in 1.6 minutes. All
  credited data was generated by repository fixtures.
- Wave 4 (094) and wave 5 (098) were NOT RUN and had no wave gate: their
  required parents remained BLOCKED. No dependent child was launched merely
  to manufacture a gate result.

### Final fresh-eyes at `1f36977d`

- The real paged-campaign component proof passed 1/1 under the shared lock
  with one worker. Its repository fixture renders a synthetic 201-session
  campaign and real 54 px trailing control while keeping document scroll at
  zero, the Sessions surface independently scrollable, and real body rows
  visible below the sticky header.
- Report completed 48/48 settled captures from `bun run demo` on port 4176:
  six routes, four viewports, two themes. Manage completed 40/40 settled E2E
  synthetic captures on port 4174: five routes over the same viewport/theme
  matrix. All 88 had exact-target HTTP 200 navigation, synthetic attestation,
  and no console, page, critical request, loading, settle, theme, or screenshot
  error.
- Report had 42 mechanically clean entries. The six flagged entries were
  unchanged: Sessions at 768 px in both themes had 46 px document overflow;
  Models at 768 px had a 110 px overflowing section around a 122 px inner
  scroller in both themes; Projects at 768 px in both themes extended the
  document by 164 px. The earlier detached
  `1273dbfe` differential already reproduced the Sessions value exactly, so it
  is not caused by 091. Models and Projects are recorded only as unchanged
  residuals observed alongside blocked work, not assigned to a child without
  causal proof.
- Manage had 38 mechanically clean entries. Skills Global at 1280 px in both
  themes retained a 64 px overflowing `Disabled…` disclosure. It is likewise
  an unchanged residual, not proof that a particular blocked child owns it.
- Visual inspection covered 88/88 images. All 48 Report images were
  pixel-identical to the prior matrix. Thirty-two Manage images were
  pixel-identical; the eight Sources images differed only in their synthetic
  snapshot timestamp, with normalized ledgers and layout identical. No new
  causal regression was found. The visible `Skills reloaded.` toast, compressed
  Skills header/matrix, and Report table/tab edges remain discovery residuals
  and receive no acceptance credit.
- The base matrix did not replay the special Today or opened-Origin states;
  those earlier captures are discovery/residual evidence only. The final
  Sources route again used the `Sources ready` fixture, not the exact
  warning-count case, so U39 remains UNVERIFIED.
- Both synthetic servers were stopped. Ports 4174 and 4176 and the shared lock
  were clear at the end. The four earlier causal starts that reported
  `EADDRINUSE` were pre-collection sandbox artifacts; only the escalated,
  locked 1/1 run counts.

### Literal program decisions

The literal program gate is **NOT SATISFIED**.

| Decision | Honest status | Reason |
| --- | --- | --- |
| D14 | NOT PASS | The macOS SQLite identity and legacy-metadata cases are not consistently green; the current isolates split between one fail and one pass, so no finding is overruled. |
| D15 | NOT PASS | Web bootstrap/production-lock and usage-engine process-identity tests retain their Linux-assuming host failures. |
| D16 | NOT RUN / NOT PASS | One invocation reached its forbidden `bun install` and was interrupted; the gate never completed and was excluded thereafter. |
| D17 | NOT PASS | The non-UTF-8 and process-cleanup tool cases remain host-dependent; current isolates again split between failures and passes. |
| D18 | NOT PASS | The responsive navigation height is 44 px where the assertion requires 48 px. |
| D19 | NOT PASS | The latest custom browser annex passed, but no code changed after the earlier exact Drawer/Escape failure; a single host rerun cannot overrule a presentation finding. |

Private captures and real local-state observations were discovery-only and
contributed to no PASS or DONE decision. Credited acceptance evidence was
limited to deterministic repository-owned synthetic fixtures and assertions;
where a server or browser was involved, it also used isolated temporary state,
loopback, and settled checks.

### What awaits a maintainer decision

- Whether to reopen any exhausted correction budget for 088, 089, 090, 095,
  or 096. Their dependent plans remain blocked until the relevant parent is
  accepted.
- Which plan should own the asymmetric root-query fixture needed to close 087's
  U01 presentation proof; plan 080 is only a candidate and does not currently
  scope it.
- Whether to authorize the ARIA contract change required to give 092's Ark
  dialog an accessible name.
- Whether to repair or formally port the D14, D15, and D17 host gates, and how
  to resolve D16 without violating the no-install rule. D18 and D19 require
  product corrections and deterministic presentation proofs; they cannot be
  waived or overruled by host reruns. The intermittent positive E2E/package
  races also remain open rather than counting as completion.
- If repository authentication still cannot update draft PR #46, a maintainer
  must update its body manually; no replacement PR should be created.

### Maintainer decision D20 — resume the blocked program

On 2026-08-24 the maintainer explicitly reopened every exhausted child and
authorized the orchestrator to make the implementation decisions needed to
converge. This includes the asymmetric U01 fixture, the ARIA contract required
by 092, product fixes for D18/D19, and repairs or portability work for the host
gates. `bun install` is permitted if a dependency is genuinely missing, but is
not a default step. Existing BLOCKED labels remain historical and honest until
their replacement implementations pass fresh gates and Codex review. The
original PR constraints remain: use only draft PR #46 and never merge it.

## Program 086 closure — 2026-08-25

Decision D20 replaced the blocked checkpoint above with fresh implementations,
fresh gates, and fresh reviews. Decisions D21 and D22 accepted only inspected,
causal macOS snapshot changes; no presentation finding, PII finding, or settled
product decision was overruled. No Docker was used.

### Final child ledger

| Plan | Final result | Integrated commit(s) | Correction/review history |
| --- | --- | --- | --- |
| 087 | DONE | `ac53024e`, `94f049dc` | asymmetric synthetic hydration proof added; accepted by final composition review |
| 088 | DONE | `0acfba17` | D20 reopening after the historical exhausted cycle; r4 ACCEPT |
| 089 | DONE | `05b2c77f` | historical r1–r3 REWORK; D20 replacement r4 ACCEPT |
| 090 | DONE | `cdf58c70` | D20 replacement; r3 ACCEPT |
| 091 | DONE | `f726c11e`, `99229546`, `1f36977d` | two correction rounds; r1 REWORK, r2 ACCEPT, final reopening, r3 ACCEPT |
| 092 | DONE | `09670e38` | D20 authorized the ARIA contract and extra convergence; r1–r3 REWORK, r4 ACCEPT |
| 093 | DONE | `652ebb96` | two correction rounds; r1–r2 REWORK, r3 ACCEPT |
| 094 | DONE | `67fed079` | one correction round; initial REWORK, then ACCEPT under D21 |
| 095 | DONE | `efffa53c` | D20 replacement plus identity-collision correction; final r4 ACCEPT |
| 096 | DONE | `cb1fbc08` | D20 replacement; r4–r5 REWORK, r6 ACCEPT |
| 097 | DONE | `46e595a3` | one accessibility correction; Standards and Specification ACCEPT |
| 098 | DONE | `236417fd` | two specification rounds; Standards r1 PASS, Spec r1 REWORK, Spec r2 PASS |

The final responsive composition correction is `4f46e5df`: tablet Sessions and
Projects tables keep horizontal overflow inside their scroll surfaces, and the
Skills health layout stacks at 1280 px while retaining the 1440 px two-column
contract.

### Gates by accepted wave

- Reopened P0/data wave (087–090, 095): child unit, Web, SQLite parity/scale,
  typecheck, lint, full locked Playwright, production, build, and immediately
  following bundle gates passed before integration. Each accepted child had a
  fresh terminal review.
- Interaction/Skills wave (092, 096): full Web and locked Playwright gates,
  deterministic accessibility/geometry proofs, visual baselines, lint,
  typecheck, build, and bundle passed. Terminal verdicts were r4 ACCEPT and r6
  ACCEPT.
- Analysis wave (091, 093): the paged-campaign single-scroll proof, dated brush
  and palette/hero proofs, full Web, locked Playwright, production, scale,
  lint, typecheck, build, and bundle passed. Wave composition review ACCEPT.
- Overview/Manage wave (094, 097): post-rebase packages passed 1,341/1,341 for
  094 and Web passed 1,047/1,047 for 097; typecheck passed 28/28; full locked
  Playwright passed 172/172 then 173/173; root lint, build, and bundle passed
  after each fast-forward. Composition review ACCEPT.
- Chrome/polish wave (098): candidate Web 1,091/1,091, visual 4/4, production
  13/13, scale 2/2 at 5,000 sessions, and locked Playwright 173/173 passed.
  Rebase gates and both review axes passed before fast-forward.
- Final program tip: lint passed on 1,097 files plus five guards; typecheck
  28/28; packages 28/28 with Web 1,091/1,091; tools 122/122; locked Playwright
  176/176 with two workers; visual 4/4; production 13/13; scale 2/2 over
  exactly 5,000 synthetic sessions; build 15/15 immediately followed by bundle
  4/4. Added-line PII, diff, `.only`, and `.skip` scans were clean.

### Final fresh-eyes and review

The synthetic-only walk settled and visually inspected 88/88 states over 11
routes, 1920/1280/768/390 viewports, and both themes. Three responsive
composition defects found on the first pass were fixed and recaptured in both
themes: Sessions and Projects no longer widen the 768 px document, and Skills
health disclosures no longer overlap at 1280 px. No residual U-row remains.

Fresh whole-diff review of `main...4f46e5df` returned ACCEPT with no findings.
Every U01–U42 row maps to a DONE child. The host-gate work closed D14–D19 with
portable implementations and deterministic proofs; D20–D22 are settled
maintainer decisions recorded in the ignored run state.

### Remaining external action

Program code and acceptance are complete. Draft PR #46 must remain unmerged.
Its body update is retried after the closure push; if the current GitHub token
still lacks `UpdatePullRequest`, only that metadata edit awaits a maintainer
with sufficient repository permission. No replacement PR is authorized.
