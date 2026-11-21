# Plan 127: Structural Cleanliness — Make Module Size and Complexity Enforceable, Then Pay Down the Worst of It

> **Executor instructions**: This plan is a program of five packets (P1–P5).
> Execute one packet per branch, in the order given in "Packet order and
> ownership". Follow each packet step by step, run every verification command
> and confirm the expected result before moving on. If anything in a packet's
> "STOP conditions" or in the global "STOP conditions" occurs, stop and report —
> do not improvise. When a packet is done, update its row in the "Packet status"
> table below and the status row for this plan in `plans/README.md`.
>
> **Drift check (run first, per packet)**:
> `git diff --stat a1a902be..HEAD -- biome.json packages/usage-store/src apps/web/src packages/local-machine/src/internal/codex-history.ts packages/local-collectors/src/codex-history.ts packages/usage-engine-runtime/src/source-adapters.ts packages/report-core/src/portable-usage.ts`
> Line numbers in this plan are from `a1a902be`. If an in-scope file changed,
> re-locate each cited symbol by name before proceeding. A symbol that no longer
> exists is a STOP.

## Status

- **Priority**: P2
- **Effort**: L overall (P1 is S; P2, P3, P5 are M–L; P4 is M)
- **Risk**: LOW for P1; MED for P2–P5 (behaviour-preserving refactors of hot code, guarded by existing tests)
- **Depends on**: none
- **Category**: tech-debt (module shape, enforceable limits)
- **Planned at**: commit `a1a902be`, 2026-11-21
- **Origin**: read-only cleanliness audit of `main` on 2026-11-21 (whole-repo
  `git blame -w -M -C`, lint-rule dry runs, file-size census). No source file
  was changed by the audit.

### Packet status

| Packet | Title | Effort | Depends on | Status |
| --- | --- | --- | --- | --- |
| P1 | Turn the complexity and file-size limits back on, with the existing debt suppressed in place | S | — | TODO |
| P2 | Split `packages/usage-store/src/index.ts` into owned modules (move-only) | L | P1 | TODO |
| P3 | Move the flat `apps/web/src/*.ts` root into `lib/features` and `lib/foundation` | M–L | P1 | TODO |
| P4 | Extract the `campaigns-page.svelte` script into tested controller modules | M | P3 | TODO |
| P5 | Decompose the worst-complexity functions behind their existing tests | L | P1; P2 for any `usage-store` file | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason).

## Why this matters

The repository's mechanical hygiene is excellent and must stay that way: at
`a1a902be` there is no `any`, no `@ts-ignore`, no `TODO`/`FIXME`, no committed
`.only`/`.skip`, no empty `catch`, and 613 test files. What is not enforced is
the *shape* of modules, and that is where the debt is:

- `biome.json` switches `complexity/noExcessiveCognitiveComplexity` **off**. The
  Ultracite preset would otherwise enforce it at `error` with a maximum of 20.
  With the rule forced on, **284 functions in 146 files** exceed 20; 49 score 50
  or more; the worst scores 245.
- **39 non-test source files exceed 1,000 lines**. The largest,
  `packages/usage-store/src/index.ts`, is 4,100 lines with 146 exports and lines
  owned by 34 different commits. `AGENTS.md` asks for "small, deep modules".
- `apps/web/src/` holds **96 files flat at its root** (52 modules + 44 tests),
  left from the pre-SvelteKit layout, next to an organised `lib/features/`.
  Feature code reaches them through 249 imports of the form
  `'../../../../overview-model'`.
- `apps/web/src/lib/features/campaigns/campaigns-page.svelte` carries an
  808-line `<script>` with about 130 top-level declarations, none of it
  unit-testable in place.

Nothing here is a bug. The cost is that every one of these files is also a
churn hotspot (`usage-store/src/index.ts` and both `codex-history.ts` files are
each touched by 31 commits), so each new feature pays the reading cost again,
and nothing stops the next 4,000-line file. P1 stops the growth; P2–P5 pay
down the part with the best return.

## Design decisions (binding on the executor)

1. **Ratchet by in-place suppression, not by a central allowlist.** Existing
   violations get a `biome-ignore` comment with the reason
   `legacy, plan 127`. The debt is then countable with one `git grep`, each fix
   deletes a comment in the file it touches, and parallel sessions never
   conflict on a shared list. The repository already uses reasoned
   `biome-ignore` comments (49 for bitwise operators); this is the house style.
2. **No threshold tuning.** Complexity stays at the preset's 20. File length is
   1,000 lines. Do not raise either number to make a file pass.
3. **Refactors are behaviour-preserving.** P2–P5 change no observable
   behaviour, no SQL text, no schema, no public package export, no wire
   contract. Existing tests are the characterization suite: **a packet may add
   tests but must not edit or delete an existing assertion**. If a test must
   change for the refactor to pass, that is a STOP.
4. **No new abstraction that the move does not require.** No barrels, no
   `$lib` alias introduction (the web app uses relative imports only — zero
   `$lib/` imports exist), no dynamic `import()` added for bundle weight.
5. **The store migration is not refactored here.** `migrate` in
   `packages/usage-store/src/index.ts` (line 1370, complexity 55, ~650 lines)
   may be *moved* by P2 but its body must stay byte-identical. Changing it
   falls under `docs/local-store-upgrade.md` and is out of scope.
6. **Tests are exempt from the file-length rule** (44 test files exceed 1,000
   lines; long characterization suites are not the problem being solved). They
   are not exempt from the complexity rule.

## Commands you will need

Agent shells on the operator machine have no `node` on `PATH`, and
`ultracite` has a node shebang. Create a shim once per shell session and
prefix it (`<scratch>` is any private temporary directory):

```bash
mkdir -p <scratch>/bin && ln -sf "$(command -v bun)" <scratch>/bin/node
export PATH=<scratch>/bin:$PATH
```

| Purpose | Command | Expected on success (verified at `a1a902be`) |
| --- | --- | --- |
| Format + static checks | `bun run check` | exit 0, `Checked 1691 files … No fixes applied.` (file count will move) |
| Boundary lint | `bun run lint` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| One package's tests | `(cd packages/usage-store && bun test)` | exit 0; `466 pass, 0 fail` across 26 files, about 130 s |
| All tests | `bun run test` | exit 0 |
| Broad gate | `bun run verify` | exit 0 (run once at the end of each packet, not per step) |
| Web e2e | `bun run test:e2e` | exit 0 (P3 and P4 only) |
| Web bundle guard | `bun run build && bun run test:web-bundle` | exit 0 (P3 and P4 only) |
| Autofix formatting | `bun x ultracite fix` | exit 0 |
| Biome binary (dry runs) | `node_modules/@biomejs/cli-linux-x64/biome` | version 2.5.15 |

If this is a fresh worktree, run `bun install --frozen-lockfile --ignore-scripts`
first; without it `bun run check` lints 0 files and workspace imports resolve
to another checkout.

## Git workflow

- One branch per packet, plain descriptive names:
  `chore/enforce-complexity-and-file-size`,
  `refactor/split-usage-store-index`, `refactor/web-src-into-features`,
  `refactor/campaigns-page-controllers`, `refactor/decompose-worst-functions`.
- Conventional commits, matching the log, for example
  `perf(usage-engine): make the minute cycle proportional to what changed (plan 126)`.
- Stage explicit paths only; never `git add -A` (other sessions share
  worktrees). Use `git mv` for moves so history follows.
- No AI or tool attribution in commits, branch names or PR titles.
- Do **not** push or open a pull request unless the operator asks.

## Packet order and ownership

P1 first, alone. Then P2, P3 and P5 may run in parallel **only** with the
exclusive write scopes below; P4 follows P3.

| Packet | Exclusive write scope |
| --- | --- |
| P1 | `biome.json`, one bullet in `AGENTS.md`, plus one inserted comment line per suppressed function or file anywhere in the tree. Run it while no other session has uncommitted edits. |
| P2 | `packages/usage-store/src/**` |
| P3 | `apps/web/src/**` except `lib/features/campaigns/campaigns-page.svelte` script logic (imports in it may be rewritten) |
| P4 | `apps/web/src/lib/features/campaigns/**` |
| P5 | Only the files named in P5, and never a `packages/usage-store` file while P2 is unmerged |

---

## P1 — Turn the limits back on, with the existing debt suppressed in place

### Current state

`biome.json`, under `linter.rules`:

```json
"complexity": {
  "noExcessiveCognitiveComplexity": "off"
},
```

The preset (`node_modules/ultracite/config/biome/core/biome.jsonc:162`) sets the
rule to `error` with `maxAllowedComplexity: 20`. Dry run that reproduces the
baseline without changing any file:

```bash
node_modules/@biomejs/cli-linux-x64/biome lint \
  --only=lint/complexity/noExcessiveCognitiveComplexity \
  --max-diagnostics=none --reporter=summary .
```

Expected at `a1a902be`: `284` diagnostics. By area: `packages/usage-store` 48,
`packages/local-machine` 43, `packages/report-core` 36,
`packages/local-collectors` 35, `apps/web` 32,
`packages/usage-engine-runtime` 27; 3 are in `.svelte` files.

The file-length rule is `lint/style/noExcessiveLinesPerFile` (options
`maxLines`, `skipBlankLines`); it exists in the installed Biome 2.5.15 and is
not configured today.

### Steps

**Step 1 — Enable the complexity rule.** In `biome.json` delete the
`"noExcessiveCognitiveComplexity": "off"` entry. If `complexity` becomes an
empty object, delete the object. Do not add options; the preset's 20 applies.

**Verify**: `bun run check` → exits non-zero and reports 284
`noExcessiveCognitiveComplexity` errors (a different count means drift; record
the new number and continue only if the difference is explained by commits
since `a1a902be`).

**Step 2 — Suppress the existing violations in place.**

```bash
node_modules/@biomejs/cli-linux-x64/biome lint --suppress \
  --reason="legacy, plan 127" \
  --only=lint/complexity/noExcessiveCognitiveComplexity .
bun x ultracite fix
```

**Verify**:
- `bun run check` → exit 0.
- `git grep -c 'biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127' | awk -F: '{s+=$2} END{print s}'` → equals the Step 1 count.
- `git diff --stat` shows only inserted comment lines plus `biome.json`
  (`git diff --numstat | awk '{d+=$2} END{print d}'` → the only deletions are
  the removed `biome.json` lines and formatter re-wraps; inspect any other).

**Step 3 — Enable the file-length rule.** In `biome.json`, add under
`linter.rules.style`:

```json
"noExcessiveLinesPerFile": {
  "level": "error",
  "options": { "maxLines": 1000 }
}
```

and add one override that turns it off for tests:

```json
{
  "includes": ["**/*.test.ts", "**/*.spec.ts"],
  "linter": { "rules": { "style": { "noExcessiveLinesPerFile": "off" } } }
}
```

**Verify**: `bun run check` → fails with one diagnostic per oversized
non-test file. Expected about 39 `.ts`/`.svelte` files; list at `a1a902be`:
`git ls-files -- '*.ts' '*.svelte' | grep -v -E '\.(test|spec)\.ts$' | xargs wc -l | awk '$1>1000 && $2!="total"'`.

**Step 4 — Suppress the existing oversized files.** Run the same `--suppress`
command with `--only=lint/style/noExcessiveLinesPerFile`. Confirm the
suppression landed as a file-level `biome-ignore-all` comment at the top of
each file. If Biome inserted nothing or a non-file-level comment, insert by
hand, as the first line of each listed file:

```ts
// biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127
```

**Verify**: `bun run check` → exit 0; `bun run typecheck` → exit 0;
`bun run test` → exit 0 (comments only; this proves nothing else moved).

**Step 5 — Document the ratchet.** In `AGENTS.md`, section "Code standards",
add one bullet: complexity is capped at 20 and non-test files at 1,000 lines;
`legacy, plan 127` suppressions mark existing debt, are removed when the code
is fixed, and are never added for new code.

### Done criteria (P1)

- [ ] `bun run verify` exits 0.
- [ ] `biome.json` no longer contains `"noExcessiveCognitiveComplexity": "off"`.
- [ ] A new function with complexity above 20, or a new non-test file above
      1,000 lines, fails `bun run check` (prove it once in a scratch file, then
      delete the file).
- [ ] The two `git grep -c … 'legacy, plan 127'` counts are recorded in the
      packet's execution note at the end of this plan.

### STOP conditions (P1)

- `--suppress` rewrites anything other than inserting comments.
- A suppression comment inside a `.svelte` file breaks `svelte-check`
  (`bun run typecheck`) twice after a placement fix.
- Other sessions have uncommitted edits in the tree (the hook's lint-staged
  stash would collide with a 146-file change): wait, do not commit around them.

---

## P2 — Split `packages/usage-store/src/index.ts` (move-only)

### Current state

`packages/usage-store/package.json` exports only `./reader`, `./writer`,
`./testing` and `./performance-testing`. **`src/index.ts` is not a public entry
point**: it is reached through `reader.ts` (`from './index'`), `writer.ts`
(two `from './index'` blocks, lines 122 and 206) and `testing.ts`. The split is
therefore internal to the package, as long as those three files keep exporting
the same names.

There is an import cycle today: `served-report-store.ts:49`,
`skill-observation-store.ts:30`, `provider-quota-store.ts:27` and
`work-fact-store.ts:33` import from `./index`, while `index.ts` imports each of
them. The cause is that `index.ts` lines 336–870 declare the input and result
types of those sibling stores.

Clusters inside `index.ts` at `a1a902be` (re-locate by symbol name if drifted):

| Lines | Content | Target module |
| --- | --- | --- |
| 76–335 | Usage-row import, retire, merge-bundle, fleet, enrichment and generation input/result types | stay with their operations (rows below) |
| 336–429 | Provider-quota types (`ProviderQuotaCheckpointUpdate` … `QueryLatestLocalProviderQuotaObservationsInput`) | `provider-quota-store.ts` |
| 430–557 | Skill-observation types (`ImportSkillObservationsInput` … `RetainSkillObservationsResult`) | `skill-observation-store.ts` |
| 558–712, 827–854 | Served-revision types (`ServedReportRevisionManifest` … `ServedReportReadPhase`) | `served-report-store.ts` |
| 713–826 | Work-fact types (`ImportPullRequestObservationsInput` … `LatestCheckoutStatusObservations`) | `work-fact-store.ts` |
| 855–900 | `ProviderQuotaSourceState`, `RecordProviderQuotaSourceAttemptInput`, `UsageStore` interface | quota types to `provider-quota-store.ts`; `UsageStore` stays in `index.ts` |
| 901–1044 | `SqliteStatement`, `SqliteDatabase`, `RawSqliteDatabase`, `createTrackedSqliteDatabase` | new `sqlite-database.ts` |
| 1045–1115 | `usageStoreError`, `sqliteErrorText`, `readFailureReason`, `usageStore*ReadError` | `errors.ts` (exists) |
| 1116–1224, 3287–3522 | `usageStorePath`, fleet helpers, `queryUsageMachineFleet`, `queryUsageLocalMachine`, `queryUsageSyncFleet` | new `machine-fleet.ts` |
| 1225–1348, 3613–3785 | RTK savings and enrichable rows (`upsertRtkSavingsContributions`, `queryEnrichableUsageRows*`, `queryLocalRowsWatermark`) | new `enrichment.ts` |
| 1349–2032 | `usageLocalMachineSchemaSql`, `migrate` | new `migration.ts` (body byte-identical, decision 5) |
| 2033–2299 | Pragmas, `openUsageStore*Database`, `closeUsageStore*`, `withUsageStore*` | new `connections.ts` |
| 2300–2932 | `initializeUsageStore`, `checkpointUsageStore`, `quiesceUsageStoreForShutdown`, import pipeline, `importLocalRows`, `updateUsageMachineLabel`, `retireLocalRows` | new `local-rows.ts` |
| 2933–3199 | `importPeerMergeBundle`, bundle validation, preview/confirm | new `peer-merge.ts` |
| 3200–3286, 3523–3612, 3786–4076 | `readReportRows`, `queryReportRows`, `queryLocalMergeBundle`, generations, `queryStoredReportCapture`, `exportLocalMergeBundle` | new `report-rows.ts` |
| 4077–4100 | `createUsageStore` | stays in `index.ts` |

The target is an `index.ts` that contains the `UsageStore` interface,
`createUsageStore`, and re-exports — a composition root of a few hundred lines.
The table is the intended decomposition, not a line-exact script: when a helper
is used by two target modules, put it in the lower-level one
(`sqlite-database.ts` < `errors.ts` < `connections.ts` < everything else) and
never create an import from a lower module to a higher one.

Exemplar for a sibling store that owns its types, schema SQL and factory:
`packages/usage-store/src/codex-work-store.ts` (299 lines). Match its layout.

### Steps

**Step 0 — Fingerprint before.** This recipe prints a hash of every non-test
source line in the package with import/export statements and the `export`
keyword stripped. A move-only refactor leaves it unchanged.

```bash
fingerprint() {
  git ls-files 'packages/usage-store/src/*.ts' | grep -v -E '\.test\.ts$' | xargs cat | awk '
    skip { if ($0 ~ /;[[:space:]]*$/) skip=0; next }
    /^(import|export)( type)? [{*]/ || /^import [A-Za-z]/ { if ($0 !~ /;[[:space:]]*$/) skip=1; next }
    { sub(/^export /, ""); if ($0 !~ /^[[:space:]]*$/) print }' | sort
}
fingerprint > <scratch>/before.txt; wc -l < <scratch>/before.txt; sha256sum < <scratch>/before.txt
```

Expected at `a1a902be`: 19,923 lines, hash starting `2a81c42d380fc277`. New
files must be `git add`-ed (intent-to-add is enough) to be seen by
`git ls-files`.

**Step 1 — Break the cycle.** Move the four type families (rows 336–870 of
the table) into the sibling store that implements them. Re-export them from
`index.ts` so `reader.ts`, `writer.ts` and `testing.ts` need no change yet.
Remove the four `from './index'` imports in the sibling stores.

**Verify**: `grep -n "from './index'" packages/usage-store/src/{served-report-store,skill-observation-store,provider-quota-store,work-fact-store}.ts`
→ no output; `(cd packages/usage-store && bun run check)` → exit 0.

**Steps 2–9 — One target module per commit**, bottom-up:
`sqlite-database.ts`, `errors.ts`, `connections.ts`, `migration.ts`,
`machine-fleet.ts`, `enrichment.ts`, `local-rows.ts`, `peer-merge.ts`,
`report-rows.ts`. For each: cut the declarations, paste them unchanged, add
`export` where another module now needs the name, add imports, and keep
`index.ts` re-exporting every name `reader.ts`, `writer.ts`, `testing.ts` and
the tests import.

**Verify after each**: `(cd packages/usage-store && bun run check)` → exit 0,
and `fingerprint | diff <scratch>/before.txt -` → empty.

**Step 10 — Point the entry files at the owners.** Change `reader.ts`,
`writer.ts` and `testing.ts` to export from the owning module instead of
`./index`, then delete the now-unused re-exports from `index.ts`.

**Step 11 — Remove the file-length suppression** from `index.ts` and from any
sibling that P2 brought under 1,000 lines. Do not add the suppression to a new
module; if a target module would exceed 1,000 lines, split it along the next
natural seam and say so in the execution note.

### Done criteria (P2)

- [ ] `fingerprint | diff <scratch>/before.txt -` is empty.
- [ ] `wc -l packages/usage-store/src/index.ts` → under 400.
- [ ] `(cd packages/usage-store && bun test)` → `466 pass, 0 fail` (or the
      count on the starting commit), with **no test file modified**
      (`git diff --stat a1a902be..HEAD -- 'packages/usage-store/src/*.test.ts'`
      shows only import-path lines, ideally nothing).
- [ ] `bun run lint` exits 0 (it runs `tools/check-public-package-exports.ts`
      and `tools/check-package-boundaries.ts`).
- [ ] `git diff a1a902be..HEAD -- packages/usage-store/package.json` is empty.
- [ ] `bun run verify` exits 0.

### STOP conditions (P2)

- The fingerprint differs by anything other than a line you can name and
  justify in one sentence (for example a helper that had to be duplicated —
  which is itself a reason to stop and reconsider the seam).
- A move requires changing SQL text, a schema constant, `migrate`'s body, or
  `USAGE_STORE_SCHEMA_VERSION`.
- Any test needs an assertion change.
- You are about to open a real store. This packet needs none: tests use
  disposable fixtures. Never point a command at `~/.config/ai-usage`.

---

## P3 — Move the flat `apps/web/src` root into `lib/features` and `lib/foundation`

### Current state

`ls apps/web/src/*.ts | wc -l` → 96 (52 modules, 44 tests). Existing owners:
`apps/web/src/lib/features/{campaigns,delegation,observatory,report,sessions,shell,skills,sources,sync,work}`,
`apps/web/src/lib/foundation`, `apps/web/src/lib/query`, `apps/web/src/lib/rpc`,
`apps/web/src/lib/server`. `apps/web/src/lib/CONVENTIONS.md` states: "Feature
and transport modules use direct leaf imports; no feature barrel is added."

Most-imported root modules from `lib/` (relative climbs):
`dashboard-search` 37, `runtime-mode` 30, `report-data` 16,
`source-control-client` 14, `overview-model` 12, `skills-page-model` 12,
`date-range` 11, `campaign-map-fixture` 10, `session-table-schema` 9.

Files that must stay at the root (framework contract): `app.d.ts`, `app.html`,
`hooks.server.ts`, `index.css`, and the `routes/`, `lib/`, `server/`
directories.

### Steps

**Step 1 — Produce the mapping table before moving anything.** For every
root `*.ts` file, list its importers
(`git grep -l "/<basename>'" -- apps/web tools`) and assign a destination by
this rule, in order:

1. imported by exactly one feature → that feature's directory;
2. imported by two or more features, or by `routes/` and a feature →
   `lib/foundation/` (a subdirectory by topic, e.g. `foundation/runtime-mode/`
   is not needed: put the file directly under `foundation/` unless three or
   more files share a topic);
3. a `*.test.ts` moves with the module it tests;
4. a fixture (`*-e2e-fixture.ts`, `campaign-map-fixture.ts`,
   `render-test-module.ts`) moves next to its single non-test consumer and
   keeps its name.

Expected shape of the result (confirm, do not assume): `dashboard-*`,
`overview-model`, `report-*`, `group-panel-presentation`, `project-*`,
`provider-status-*`, `provider-quota-history-model`,
`machine-freshness-presentation`, `web-report-payload` → `features/report`;
`session-*` → `features/sessions`; `skill-*`, `skills-*`,
`project-skill-directories` → `features/skills`; `source-control-*` →
`features/sources`; `manual-transfer-*`, `sync-machine-comparison-model` →
`features/sync`; `campaign-*` → `features/campaigns`; `runtime-mode`,
`browser-runtime-mode`, `date-range`, `time-range-control-state`, `shared` →
`lib/foundation`.

Write the table into this plan's execution note and commit it alone.

**Step 2 — Find path strings.** Some tools and tests name source paths as
strings rather than imports:
`git grep -n -E "apps/web/src/[a-z0-9-]+\.ts|src/[a-z0-9-]+\.ts'" -- tools apps/web docs`.
List every hit that names a file you will move; each is updated in the same
commit as the move. (`tools/check-*.test.ts` hits naming
`apps/web/src/index.ts` are synthetic test inputs — leave them.)

**Step 3 — Move one destination at a time**, one commit each: `git mv` the
files, rewrite the import specifiers (relative paths, no alias), run
`bun x ultracite fix`.

**Verify after each**: `(cd apps/web && bun run check)` → exit 0;
`(cd apps/web && bun run test)` → same pass count as before the commit. Use
the package scripts, not a bare `bun test`: they build the design system and
prepare `.svelte-kit` first, without which the SSR tests fail with a bogus
module-resolution error.

**Step 4 — Whole-app proof**: `bun run verify`, then `bun run test:e2e`, then
`bun run build && bun run test:web-bundle`.

### Done criteria (P3)

- [ ] `ls apps/web/src/*.ts` lists only `app.d.ts` and `hooks.server.ts`.
- [ ] `git grep -c -E "from '(\.\./){4,}" -- apps/web/src | awk -F: '{s+=$2} END{print s+0}'`
      is lower than at the start (record both numbers).
- [ ] `git grep -c -F "from '\$lib/" -- apps/web/src` → no matches (no alias introduced).
- [ ] `bun run verify`, `bun run test:e2e` and `bun run test:web-bundle` exit 0;
      `RECORDED_GZIP_CLOSURE_BYTES` in `apps/web/bundle/client-bundle.test.ts`
      is unchanged.
- [ ] `git log --follow` on three moved files shows their pre-move history.

### STOP conditions (P3)

- The bundle guard reports a closure change outside its tolerance: a move
  changed what is eagerly loaded. Do not move the recorded number; report.
- A module turns out to be imported by both browser code and a `*.server.ts`
  file in a way the move would make cross the browser/server boundary
  (`bun run lint` or `test:web-client-manifest` fails).
- Another session has uncommitted work under `apps/web/src`: this packet
  rewrites hundreds of import lines and must not race it.

---

## P4 — Extract the `campaigns-page.svelte` script into controller modules

### Current state

`apps/web/src/lib/features/campaigns/campaigns-page.svelte`: 1,194 lines,
`<script lang="ts">` from line 2 to line 811, 40 imports, 26 `$state`,
53 `$derived`, 6 `$effect`. Rough regions of the script:

| Lines | Concern |
| --- | --- |
| 66–131 | Clients, replay toggle, ~25 `let` state cells (navigation, virtual lists, focus restore) |
| 132–365 | Queries and derived view state (bootstrap, labels, request, exploration, timeline, map, matching, detail selection, recovery flags) |
| 429–500 | Loading and refresh actions (`loadCampaigns`, `loadMembers`, `refresh`, `restart`) |
| 500–675 | Navigation and selection actions (`navigate`, `selectCampaign`, `selectView`, `applyFilters`, `openSession`, `restoreFocus`, `changeSelection`, `retry`) |
| 675–737 | Scroll capture/restore, `recordedAt`, `sessionCount` |
| 738–811 | Panda style constants |

The feature already keeps pure logic outside the component and tests it:
`campaigns-selection.ts`, `campaigns-query.ts`, `campaign-detail-selection.ts`,
each with a `.test.ts`. Rune-bearing modules use the `.svelte.ts` suffix; the
exemplar is `apps/web/src/lib/features/delegation/delegation-draft.svelte.ts`.

### Steps

1. **Pure derivations first.** Every `$derived` whose body is a pure function
   of other values moves to a plain `.ts` function in an existing or new model
   file next to the component, with a unit test per function. The component
   keeps `const x = $derived(fn(a, b))`.
2. **Style constants** (lines 738–811) move to `campaigns-page.styles.ts`,
   unchanged.
3. **Stateful clusters** move to `.svelte.ts` controllers, one per concern,
   each a factory returning getters and actions: focus restoration
   (`pendingFocus`, `detailOpenerId`, `focusRestoreGeneration`, `restoreFocus`),
   scroll capture/restore (`capture`, `restore`, `anchors`), and
   navigation/selection actions. Do not merge them into one "page controller";
   three narrow modules are the target.
4. Leave the query wiring (`createQuery` calls and their option builders) in
   the component: TanStack Query owns browser server state here and the
   options already live in `campaigns-query.ts`.

**Verify after each step**: `(cd apps/web && bun run check && bun run test)`
→ exit 0.

### Done criteria (P4)

- [ ] The component's `<script>` is under 350 lines
      (`awk '/<script/{f=1;next} /<\/script>/{f=0} f' apps/web/src/lib/features/campaigns/campaigns-page.svelte | wc -l`).
- [ ] Every new `.ts`/`.svelte.ts` module has a test file; no new module
      exceeds complexity 20 or 1,000 lines (`bun run check` exits 0 with no new
      `legacy, plan 127` suppression added).
- [ ] The rendered markup is unchanged: the template part of the file
      (everything after `</script>`) differs only by renamed identifiers.
- [ ] `bun run test:e2e` exits 0, including `campaign-map.spec.ts`,
      `campaign-timeline.spec.ts`, `campaign-replay.spec.ts`,
      `campaign-short-page.spec.ts`, `campaign-label-overrides.spec.ts` and
      `origin-campaign.spec.ts`, with axe checks passing.
- [ ] `bun run build && bun run test:web-bundle` exits 0.

### STOP conditions (P4)

- An extraction changes the order in which effects run and an e2e focus or
  scroll assertion fails twice: keyboard and assistive-technology equivalence
  is an accepted decision in this repository (ADR 0005/0013); report rather
  than adjust the test.
- A controller needs to import a `*.server.ts` module or anything outside the
  oRPC contract.

---

## P5 — Decompose the worst-complexity functions behind their existing tests

### Current state

Highest scores at `a1a902be` (rule maximum is 20):

| Score | Location | What it is |
| --- | --- | --- |
| 245 | `packages/local-machine/src/internal/codex-history.ts:1252` | `visit(line)` — the per-line Codex rollout record handler |
| 125 | `packages/report-core/src/portable-usage.ts:72` | `topLevelArrayExceedsLimit` — hand-written bounded JSON scanner |
| 114 | `packages/local-collectors/src/codex-history.ts:805` | `Effect.gen` body of the Codex collection pass |
| 85 | `packages/local-collectors/src/codex-history.ts:1117` | `Effect.gen` body, same file |
| 102 | `packages/usage-engine-runtime/src/source-adapters.ts:1496` | adapter `try` body |
| 97 | `packages/usage-engine-runtime/src/source-adapters.ts:464` | `Effect.gen` body |
| 85 | `packages/usage-engine-runtime/src/source-adapters.ts:1820` | `Effect.gen` body |

All three files are top churn hotspots and have large characterization suites
(`packages/local-collectors/src/codex-history.test.ts` 4,455 lines,
`packages/usage-engine-runtime/src/source-adapters.test.ts` 3,250 lines).
`portable-usage.ts` has its own test file next to it.

To regenerate the ranked list with line numbers:

```bash
node_modules/@biomejs/cli-linux-x64/biome lint \
  --only=lint/complexity/noExcessiveCognitiveComplexity \
  --max-diagnostics=none --reporter=json . > <scratch>/cc.json
```

After P1 the rule is on and the violations are suppressed, so the command
above reports nothing; list the debt instead with
`git grep -n 'noExcessiveCognitiveComplexity: legacy, plan 127'` and read a
function's score by temporarily deleting its suppression and running
`bun run check`.

### Method (the same for every function)

1. Run the owning package's tests and record the pass count.
2. Extract by **naming what is already there**: each branch of a record-type
   switch or `if` chain becomes a named function taking explicit arguments and
   returning a value; shared mutable locals become one explicit state object
   passed in. For `visit`, the target shape is a dispatch on the record type to
   one handler per type. Do not change evaluation order, do not merge or
   reorder conditions, do not "simplify" a condition.
3. Typed failures stay typed; no `try`/`catch` is added or removed.
4. Delete the `legacy, plan 127` suppression on that function. `bun run check`
   must pass without it — that is the definition of done for the function.
5. One function per commit: `refactor(<package>): decompose <name> (plan 127)`.

**Verify after each function**: the owning package's `bun test` → identical
pass count, zero modified test files; `bun run check` → exit 0.

Order: the two `codex-history.ts` files first (highest churn), then
`source-adapters.ts`, then `portable-usage.ts`.

### Done criteria (P5)

- [ ] The seven functions above carry no suppression and `bun run check` exits 0.
- [ ] `git grep -c 'noExcessiveCognitiveComplexity: legacy, plan 127' | awk -F: '{s+=$2} END{print s}'`
      is at least 7 lower than P1 recorded.
- [ ] `git diff --stat <packet base>..HEAD -- '*.test.ts'` shows only added
      tests, no modified assertion.
- [ ] `bun run verify` exits 0.

### STOP conditions (P5)

- A function cannot get under 20 without changing evaluation order or adding
  an abstraction with a single caller that only moves the branching elsewhere:
  leave its suppression, note the residual score, move on. A lower score that
  keeps the suppression is still worth committing.
- Any existing test fails after a faithful extraction: the test has found a
  behaviour change. Revert the extraction; do not edit the test.
- The work would require reading or writing a real local store.

---

## Global STOP conditions

- A step's verification fails twice after a reasonable fix attempt.
- A fix appears to require touching a file outside the packet's write scope.
- A packet would change a public package export, an oRPC contract, a SQL
  statement, or the usage-store schema.
- `bun run verify` is red on the packet's base commit before any change:
  report the failure instead of building on it.

## Operator actions (not for an executor)

- **Author identities.** `git blame` shows three author names for one person
  across two addresses, and there is no `.mailmap`. A tracked `.mailmap` would
  put names and addresses in a public file, which conflicts with this
  repository's practice of keeping personal details out of tracked content.
  The private equivalent is a local, untracked map:
  `git config mailmap.file .git/info/mailmap`, then one line per alias in that
  file (`Canonical Name <canonical@address> Alias Name <alias@address>`; list
  the identities with `git log --format='%aN <%aE>' | sort -u`).
- **Empty leftover directories.** Directories of removed packages
  (`packages/memory-search`, `packages/replication-client`,
  `packages/postgres-store`, `packages/lan-pairing`, `packages/identity`,
  `packages/authorization`, `apps/server`) still exist on the operator's disk,
  untracked and empty. `find apps packages -maxdepth 1 -type d -empty` lists
  them; removing them is the operator's call.

## Open operator decision (no packet until decided)

**Synthetic data in the production browser closure.**
`apps/web/src/lib/features/work/work-page.svelte:43,60` and
`work-load.ts:13-14` statically import `work-attention-synthetic.ts`
(1,248 lines) and `work-synthetic.ts`; `campaigns-page.svelte`,
`campaigns-load.ts` and `observatory-query.ts` import
`campaign-map-fixture.ts`. The runtime mode (`demo` | `e2e` | `live`) is read
at **run time** from `VITE_AI_USAGE_DEMO` / `VITE_AI_USAGE_E2E`
(`apps/web/src/runtime-mode.ts`; `tools/start-production.ts:141` sets demo to
`'0'`, `tools/run-web-demo.ts:31` sets it to `'1'`), so one build serves all
three modes and the synthetic modules ship to live users.

Removing them from the live closure needs one of: (a) a separate demo build
with a compile-time constant so the bundler drops the synthetic branch, at the
cost of a second build and its gates; (b) a mode-level dynamic `import()` of
the synthetic modules, which the operator has so far ruled out for live UI
components; (c) accept the cost. Recommended first move, before choosing:
measure the gzip bytes these modules contribute to the live route closures
from `apps/web/.svelte-kit/build/private/client-modules.json`. If it is small
relative to the 315,000 B ceiling, (c) is the honest answer.

The server side is **not** a finding: `apps/web/src/server/work-threads.server.ts:103`
loads its e2e fixture through a mode-gated dynamic import.

## Considered and rejected

- **Replace `as Row` / `as Row[]` on SQLite reads with runtime validation**
  (about 117 casts on `.get()` / `.all()` in `packages/usage-store/src`,
  non-test). Rejected: the engine is the store's sole writer and validates the
  schema on open; these casts are the trust boundary, not a shortcut around
  one. Validating every stored row on read costs time on the hot path and
  makes any later tightening of a row schema reject data that is already
  persisted. A generic `query<Row>()` would move the same unchecked assertion
  into a type parameter without making anything safer.
- **Remove the 16 `as unknown as` in non-test source.** Rejected: nine sit at
  the end of hand-written validators in `packages/report-core` (the cast is
  the validator's conclusion), three bridge `bun:sqlite`'s `Database` to the
  package's structural port, the rest are equivalent. Cosmetic.
- **Unify the per-store `SqliteDatabase` interfaces** declared in ten
  `usage-store` files. Rejected for now: they are deliberately different
  subsets (`delegation-store.ts` needs only `exec` and `query`). Revisit only
  if P2's `sqlite-database.ts` makes one port obviously sufficient.
- **Make `git blame` granular again** (five squash commits own 50.6 % of the
  code lines). Rejected as a code change: history cannot be rewritten, and the
  repository merges by squash by choice. Smaller pull requests are the only
  lever, and that is a working habit, not a plan.
- **Reduce documentation volume** (87 ADRs, 143 plans). Rejected: `plans/` is
  append-only history and ADRs are the durable-decision record, both by
  convention.
- **Split every file over 1,000 lines.** Rejected as a goal: P1 freezes the
  list, P2 fixes the worst, and the rest shrinks when its code is next touched.

## Maintenance notes

- After P1, the two `git grep -c … 'legacy, plan 127'` totals are the debt
  counters. They should only go down. A review that sees a new
  `legacy, plan 127` comment on new code should refuse it.
- P2 changes where `usage-store` symbols live. Open branches that touch
  `packages/usage-store/src/index.ts` will conflict; merge or rebase them
  first, or run P2 in a quiet window. The same holds for P3 and `apps/web/src`.
- `docs/public-package-interfaces.md` and `docs/architecture.md` name source
  files in places. After P2 and P3, run
  `git grep -n -E "usage-store/src/index\.ts|apps/web/src/[a-z0-9-]+\.ts" -- docs README.md CONTEXT.md`
  and update current docs; do not edit historical plans.
- The remaining `legacy, plan 127` functions in `packages/usage-store`
  (48 at planning time) are best taken after P2, file by file, with P5's
  method.

## Execution notes

(Executors append dated notes here: the counts recorded by P1, the P3 mapping
table, residual scores left by P5, and any STOP with its evidence.)
