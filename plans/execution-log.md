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
