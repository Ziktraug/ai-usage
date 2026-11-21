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
| P1 | Turn the complexity and file-size limits back on, with the existing debt suppressed in place | S | — | DONE |
| P2 | Split `packages/usage-store/src/index.ts` into owned modules (move-only) | L | P1 | DONE (merged into the integration branch at `8bc3be99`) |
| P3 | Move the flat `apps/web/src/*.ts` root into `lib/features` and `lib/foundation` | M–L | P1 | DONE (merged into the integration branch at `9bf9a653`) |
| P4 | Extract the `campaigns-page.svelte` script into tested controller modules | M | P3 | DONE with one criterion missed: script 808 → 450 lines, not under 350 (accepted, see the execution note) |
| P5 | Decompose the worst-complexity functions behind their existing tests | L | P1; P2 for any `usage-store` file | DONE (merged into the integration branch; 271 → 264 suppressed functions) |

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
   lines; long characterization suites are not the problem being solved).
   Amended after P1 (2026-11-21): tests are also exempt from the complexity
   rule, because the Ultracite preset turns it off for `*.{test,spec}.*`. That
   is accepted as is; no override re-enables it. The enforced baseline is
   therefore 271 suppressed functions, not 284. The file-length rule does not
   count lines inside multi-line template literals and counts only the
   `<script>` block of a `.svelte` file, so P2 and P4 use `wc -l` and the
   `awk` script count in their done criteria, not the rule.

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

### 2026-11-21 — P1 executed (branch `chore/enforce-complexity-and-file-size`)

No drift since `a1a902be`. Recorded debt counters (exclude `plans/`, which
quotes the pattern):

- `git grep -c 'biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127' -- ':!plans'` → **271**
- `git grep -c 'biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127' -- ':!plans'` → **34**

Files with a file-length suppression (34): `apps/usage-engine/src/engine-lock.ts`,
`apps/web/src/lib/features/work/work-attention-synthetic.ts`,
`apps/web/src/lib/features/work/work-thread-model.ts`,
`apps/web/src/lib/features/work/work-threads.css`,
`apps/web/src/lib/features/work/work-timeline-model.ts`,
`apps/web/src/server/work-threads-e2e-fixture.server.ts`,
`packages/local-collectors/src/codex-history.ts`,
`packages/local-machine/src/claude-session-facts.ts`,
`packages/local-machine/src/codex-skill-observation.ts`,
`packages/local-machine/src/internal/codex-history.ts`,
`packages/report-core/src/delegation-job.ts`,
`packages/report-core/src/delegation-policy.ts`,
`packages/report-core/src/delegation-qualification.ts`,
`packages/report-core/src/focused-report-query.ts`,
`packages/report-core/src/provider-quota.ts`,
`packages/report-core/src/session-detail.ts`,
`packages/report-core/src/session-query.ts`,
`packages/report-core/src/work-attempts.ts`,
`packages/report-core/src/work-attention.ts`,
`packages/report-core/src/work-routing.ts`,
`packages/report-data/src/work-attention-read.ts`,
`packages/report-data/src/work-thread-read.ts`,
`packages/usage-engine-control/src/contracts.ts`,
`packages/usage-engine-runtime/src/delegation.ts`,
`packages/usage-engine-runtime/src/input-file.ts`,
`packages/usage-engine-runtime/src/live.ts`,
`packages/usage-engine-runtime/src/source-adapters.ts`,
`packages/usage-store/src/delegation-store.ts`,
`packages/usage-store/src/index.ts`,
`packages/usage-store/src/served-report-store.ts`,
`packages/usage-store/src/work-fact-store.ts`,
`packages/usage-store/src/work-thread-store.ts`,
`tools/check-web-production-start.ts`,
`tools/measure-usage-runtime-io.ts`.

Deviations, all explained by tool semantics rather than drift:

- **Complexity: 271, not 284.** The 284 dry-run diagnostics are 271 errors plus
  13 infos, all in test files. The Ultracite core preset has its own test-file
  override that sets `noExcessiveCognitiveComplexity` to `off`; `--only` forces
  the rule back on there, so `--suppress` wrote 13 comments that the real
  configuration reports as `suppressions/unused`. Those 13 were removed. So,
  contrary to design decision 6, test files *are* exempt from the complexity
  rule, through the preset. No override was added to change that.
- **File length: 34 files, not ~39.** Biome counts lines through syntax trivia,
  so newlines inside multi-line template literals (the SQL strings) do not
  count, and for `.svelte` files it counts only the script block. As a result
  `focused-report-query-sqlite.ts`, `session-query-sqlite.ts`,
  `claude-desktop-session-store.ts`, `provider-quota-store.ts`,
  `work-attention-model.ts`, `work-disk-model.ts` and `campaigns-page.svelte`
  are over 1,000 `wc -l` lines but not flagged. Biome does flag one CSS file,
  `work-threads.css`, which got a `/* biome-ignore-all … */` block comment.
- **Step 4 by hand.** `--suppress --only=lint/style/noExcessiveLinesPerFile`
  wrote plain `biome-ignore` comments, not `biome-ignore-all`, and also touched
  test files (78 files). Its output was reverted and the file-level comment was
  inserted as line 1 of the 34 flagged files. None of them has a shebang or a
  leading license comment.
- Some complexity comments sit where Biome reports the diagnostic, not on the
  enclosing declaration. Examples: before an `Effect.gen(function* …)` or
  `try: () =>` callback, before a `return rows.map(…)`, and once inside a
  parameter list before `): ImportResult =>`. Each one is effective: `bun run
  check` reports no unused suppression.

Ratchet proven: a scratch function with complexity above 20 and a scratch
1,005-line non-test file under `tools/` made `bun run check` exit 1 with
exactly those two errors. Both files were then deleted. Final gate:
`check`, `lint`, `typecheck`, `test` and `build` each exited 0.

### 2026-11-21 — P2 executed (branch `refactor/split-usage-store-index`)

Base `184b1610` (integration branch with P1). No drift in the symbols the plan
cites; line numbers had moved by the P1 suppression comments only.

Baseline at the base: `(cd packages/usage-store && bun test)` → 466 pass,
0 fail, 26 files. Fingerprint at the base: 19,975 lines, sha256
`7cb5bdaa7fd27044…` (differs from the plan's 19,923 / `2a81c42d…` because P1
added suppression comments).

Method: each step moved whole top-level statements, with their leading
comments and suppressions, using a TypeScript-AST script that computed the
new imports and refused any move that would need an import from `index.ts`
(upward). After every step: Ultracite fix/check on the package,
`(cd packages/usage-store && bun run check)` (tsc), the fingerprint diff
(empty for every step through Step 10), and an import-cycle check.

`index.ts`: 4,107 → 305 lines. It now holds the `UsageStore` interface,
`createUsageStore`, the `createXStore(...)` compositions of the sibling stores
(they read best next to the dependencies they inject) and the named
re-exports that the package tests still import from `./index`.

New modules, bottom-up (dependency order):

| Module | Lines | Content |
| --- | --- | --- |
| `sqlite-database.ts` | 58 | `SqliteStatement`, `SqliteDatabase`, `RawSqliteDatabase`, `createTrackedSqliteDatabase` |
| `errors.ts` (existing) | 119 | + `usageStoreError`, `readFailureReason`, `usageStore*ReadError`, `previewStaleError` |
| `stored-usage-row.ts` | 8 | `StoredUsageRowStatus`, `StoredSourceAuthority`, `StoredRowRecord` |
| `rtk-savings.ts` | 141 | RTK savings constants, guards, hash, enrichment statements, `upsertRtkContribution` |
| `machine-fleet-order.ts` | 126 | `fleetMetadataForStoredRow`, `rebuildUsageMachineFleetOrder`, `usageMachineFleetOrderChanged` |
| `migration.ts` | 711 | `USAGE_STORE_SCHEMA_VERSION`, `usage_local_machine` schema SQL, `migrate` |
| `connections.ts` | 369 | pragmas, open/close/with helpers, `initializeUsageStore`, `checkpointUsageStore`, `quiesceUsageStoreForShutdown` |
| `machine-fleet.ts` | 292 | fleet types, `usageStorePath`, fleet/local-machine/sync-fleet queries, local projection fault injector |
| `local-rows.ts` | 699 | import pipeline, `importLocalRows`, `updateUsageMachineLabel`, `retireLocalRows` |
| `enrichment.ts` | 254 | enrichable-row queries, `queryLocalRowsWatermark`, `upsertRtkSavingsContributions` |
| `peer-merge.ts` | 311 | `importPeerMergeBundle`, preview/confirm, bundle validation, `canonicalJson` |
| `report-rows.ts` | 350 | `readReportRows`, `queryReportRows`, `queryLocalMergeBundle`, generations, `queryStoredReportCapture`, `exportLocalMergeBundle` |

Deviations from the plan's table, all forced by the dependency graph or by
cohesion, none by behaviour:

- **Bottom-up order is not the plan's.** `openUsageStoreWriterDatabase` calls
  `migrate`, so `migration.ts` sits below `connections.ts`, not above it.
- **Three extra low-level modules.** `migrate` uses the fleet-order helpers,
  the RTK savings helpers and the row status vocabulary, while the fleet and
  enrichment *queries* need `connections.ts`, which needs `migrate`. Keeping
  the helpers inside `machine-fleet.ts` / `enrichment.ts` would have created
  the cycle `connections → migration → machine-fleet → connections`. So the
  helpers live in `machine-fleet-order.ts`, `rtk-savings.ts` and
  `stored-usage-row.ts`, below `migration.ts`.
- **Store lifecycle in `connections.ts`.** `initializeUsageStore`,
  `checkpointUsageStore` and `quiesceUsageStoreForShutdown` (planned for
  `local-rows.ts`) are WAL/connection management, not row imports.
- **`UsageStoreGenerations` owned by `report-rows.ts`**, created in Step 1 with
  that type alone so `served-report-store.ts` could stop importing `./index`.
- **`chunkRows` lives in `local-rows.ts`** (its lowest user); `enrichment.ts`
  and `peer-merge.ts` import it from there.

Step 1 grew three sibling stores that were already over 1,000 `wc -l` lines;
they were not split, because Step 1 places the types in the store that
implements them (the `codex-work-store.ts` exemplar): `provider-quota-store.ts`
1,005 → 1,095 (Biome does not flag it: SQL template lines are not counted, so
no suppression was needed or added), `work-fact-store.ts` 1,362 → 1,460 and
`served-report-store.ts` 1,505 → 1,666 (both keep their existing P1
suppression). `skill-observation-store.ts` is 941.

Final evidence:

- Fingerprint: one differing line, the removed
  `// biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127`
  of `index.ts` (Step 11). `migrate` body and its leading suppression comment
  compared byte-identical with the base by AST extraction.
- `reader.ts`, `writer.ts`, `testing.ts`, `performance-testing.ts`: export
  lists (runtime `Object.keys` and the TypeScript checker's export list with
  value/type kinds, 480 entries) identical before and after.
  `packages/usage-store/package.json` unchanged.
- Import cycles among the package's 37 non-test modules: none (the base had
  four: `index.ts` ↔ each of `provider-quota-store`, `served-report-store`,
  `skill-observation-store`, `work-fact-store`).
- No test file changed (`git diff --stat 184b1610..HEAD -- 'packages/usage-store/src/*.test.ts'` is empty).
- Package tests: 466 pass, 0 fail after Step 1, after Step 9 (machine fleet)
  and at the end.
- Debt counters: complexity suppressions 271 (unchanged; the six from
  `index.ts` travelled to `migration.ts` 1, `local-rows.ts` 4,
  `enrichment.ts` 1); file-length suppressions 34 → 33.
- Docs: `docs/local-store-upgrade.md` now cites `migration.ts` for the
  "newer than supported schema" refusal.

Orchestrator review of P2 (2026-11-21): an independent AST comparison of every
top-level statement in the package's non-test files found 885 statements at
the base and 885 at the head, with an identical multiset once the `export`
keyword is ignored. The adversarial review (agent plus Codex) returned no
confirmed finding: no value import cycle, one fault-injector binding, the
migration region byte-identical, entry-point name lists identical. The one
failing test in the implementer's full run
(`usage-engine-runtime` "a restart with the review still running keeps the
target reserved") timed out at 30 s while three agents loaded the machine and
passes alone in about 9 s on both the branch and the main checkout; it is
recorded as load-related, not caused by the diff.

### 2026-11-21 — P3 executed (branch `refactor/web-src-into-features`)

Written before any move. Base: `refactor/structural-cleanliness` @ 184b1610.

#### Baseline (before any move)

- `ls apps/web/src/*.ts | wc -l` → 96 (52 modules, 44 tests); 94 move, `app.d.ts` and `hooks.server.ts` stay.
- `(cd apps/web && bun run test)` → 2395 pass, 0 fail, 280 files, exit 0.
- `from '(../){4,}` climbs in apps/web/src → 173. `from '$lib/` → 0.
- `bun run build` exit 0; `bun run test:web-bundle` 6 pass exit 0; `bun run test:web-client-manifest` exit 0.
- Measured initial gzip closure (same computation as `gzipClosureBytes` in `apps/web/bundle/client-bundle.test.ts`): 309,001 B (= `RECORDED_GZIP_CLOSURE_BYTES`).

#### Assignment rule as applied

1. Non-test importers only are counted (tests follow their module, rule 3).
2. Exactly one feature among the non-test importers → that feature's directory (root of the feature).
3. Two or more features (or routes + a feature) → `lib/foundation/`.
4. **Layering closure (added, decision):** at the base no non-test module under `lib/foundation/` imports
   anything from `lib/features/`. To keep that true, any root module imported by a module bound for
   `lib/foundation/` (or by an existing `lib/foundation` module) also goes to `lib/foundation/`. Without it
   the move would create foundation → feature edges (and directory cycles feature → foundation → feature):
   `session-analysis-target` → `dashboard-model`, `time-range-control-state` → `overview-model`,
   `lib/foundation/navigation/svelte/skills-url.ts` → `skills-page-model`.
   `lib/query`, `lib/rpc`, `lib/server` and `src/server` importers are not features and are not counted.
5. Topic subdirectory only where three or more foundation files share a topic: `foundation/dashboard/`
   (4 `dashboard-*`), `foundation/session/` (3 `session-*`).
6. Fixtures: `focused-report-e2e-fixture` has one non-test consumer
   (`lib/features/report/composition/synthetic-report-destination.svelte`) → next to it.
   `provider-quota-e2e-fixture` has that same feature consumer plus `src/server/provider-quota-resolver.server.ts`
   → same directory. `campaign-map-fixture` has non-test consumers in `campaigns` and `observatory` → foundation.
   `render-test-module` has no importer at all → foundation.
7. Modules with no feature importer, placed by topic: `browser-runtime-mode` (no importer) → foundation next to
   `runtime-mode`; `project-skill-directories` (only `src/server/skills-contracts.ts`) → skills;
   `skill-markdown-editor-model`, `skills-query-operations` (test-only) → skills;
   `session-neighbor-request-controller` (test-only) → sessions; `source-control-presentation` (test-only) → sources;
   `shared` (re-export, imported only by tests now in foundation and report) → foundation.
8. Tests without a same-named module: `campaign-display-label.test` (tests `campaign-label-overrides`) → foundation;
   `session-analysis.test` (tests `session-analysis-model`) → `foundation/session`; `api-value.test`
   (tests `lib/foundation/presentation/report-value`) and `provenance-marker.test` (tests the design-system glyph,
   used by report, sessions and work) → `foundation/presentation`; `report-design-tokens.test` (scans
   `lib/features/report`) → `features/report` (its `import.meta.dir`-relative paths are re-based, no assertion change).

#### Differences from the plan's hypothesis

| File | Hypothesis | Actual | Why |
| --- | --- | --- | --- |
| `dashboard-search`, `dashboard-model`, `dashboard-analytics`, `dashboard-metric-model` | features/report | foundation/dashboard | `dashboard-search`: campaigns+report+shell; the other three are imported by foundation-bound `session-analysis-target` / `overview-model` (closure) |
| `dashboard-sort` | features/report | features/sessions | only importers are `lib/features/sessions/**` |
| `overview-model` | features/report | foundation | imported by foundation-bound `time-range-control-state` (closure) |
| `machine-freshness-presentation` | features/report | foundation | report + sync (`manual-transfer-model`) |
| `report-data` | features/report | foundation | observatory + report + work |
| `source-control-client` | features/sources | foundation | report + sources + sync + work |
| `source-control-presentation-model` | features/sources | foundation | sources + work (`work-sources.svelte`) |
| `campaign-label-overrides`, `campaign-map-fixture` | features/campaigns | foundation | campaigns + report / campaigns + observatory |
| `session-analysis-target`, `session-analysis-model`, `session-table-schema` | features/sessions | foundation/session | campaigns+report+sessions / report+sessions / report+sessions |
| `skills-page-model` | features/skills | foundation | imported by `lib/foundation/navigation/svelte/skills-url.ts` (closure) |
| `focused-report-e2e-fixture`, `provider-quota-e2e-fixture` | features/report | features/report/composition | rule 4: next to the non-test consumer |

#### Gates and path strings that name a moved file (Step 2)

- `apps/web/bundle/client-bundle.test.ts`: imports `../src/focused-report-e2e-fixture` (keys asserted absent from
  production scripts) and a comment naming `src/report-data.ts`. Import and comment path updated; number untouched.
- `apps/web/src/lib/foundation/presentation/presentation-closure.test.ts`: `entryPaths` (src-relative strings) for
  7 moved modules and `'../../../shared'` resolved from `format.ts`. Updated to new paths.
- `apps/web/src/lib/foundation/navigation/svelte/dashboard-url.test.ts`: dynamic-import module-ID strings for
  `dashboard-search`, `dashboard-filter-navigation`, `session-table-schema`. Updated.
- `tools/measure-usage-runtime-io.ts:2669`: HMR target `src/dashboard-model.ts`. Updated.
- e2e specs importing `../src/focused-report-e2e-fixture` / `../src/campaign-map-fixture`: rewritten as imports.
- `docs/adr/0004`, `0005`, `0046` link to root paths: ADRs are history, not edited.
- `tools/check-*.test.ts` synthetic `apps/web/src/*.ts` inputs: untouched.

#### Mapping table (source → destination; non-test importers at the base)

| File | Destination | Importers at base (all, incl. tests in lib) |
| --- | --- | --- |
| `manual-transfer-contract.ts` | `lib/features/sync/` | lib/features/sync/manual-transfer-client.ts, server/manual-merge-upload.server.ts, server/sync-data.server.ts |
| `manual-transfer-model.ts` | `lib/features/sync/` | lib/features/sync/machine-fleet.svelte, lib/features/sync/manual-transfer-progress.svelte, lib/features/sync/manual-transfer.svelte, lib/features/sync/sync-root.svelte, sync-machine-comparison-model.ts |
| `manual-transfer-model.test.ts` | `lib/features/sync/` | (none) |
| `sync-machine-comparison-model.ts` | `lib/features/sync/` | lib/features/sync/sync-root.svelte, manual-transfer-model.test.ts |
| `source-control-presentation.ts` | `lib/features/sources/` | (none) |
| `source-control-presentation.test.ts` | `lib/features/sources/` | (none) |
| `project-skill-directories.ts` | `lib/features/skills/` | server/skills-contracts.ts |
| `skill-document-inspector-model.ts` | `lib/features/skills/` | lib/features/skills/presentation.ts |
| `skill-document-inspector-model.test.ts` | `lib/features/skills/` | (none) |
| `skill-markdown-editor-model.ts` | `lib/features/skills/` | (none) |
| `skill-markdown-editor-model.test.ts` | `lib/features/skills/` | (none) |
| `skills-client-contracts.ts` | `lib/features/skills/` | lib/features/skills/management/operation-episode.svelte.ts, lib/features/skills/shell/model.ts, lib/features/skills/shell/snapshot-controller.test.ts, skills-query-operations.ts |
| `skills-client-contracts.test.ts` | `lib/features/skills/` | (none) |
| `skills-query-operations.ts` | `lib/features/skills/` | (none) |
| `skills-query-operations.test.ts` | `lib/features/skills/` | (none) |
| `dashboard-sort.ts` | `lib/features/sessions/` | lib/features/sessions/detail/session-drawer.svelte, lib/features/sessions/table/session-cell-projection.ts, lib/features/sessions/table/session-columns.ts |
| `dashboard-sort.test.ts` | `lib/features/sessions/` | (none) |
| `session-analysis-error.ts` | `lib/features/sessions/` | lib/features/sessions/detail/rounds-reader.svelte, lib/features/sessions/detail/session-analysis.svelte, lib/features/sessions/detail/session-detail-query-slot.svelte, lib/features/sessions/detail/types.ts, lib/rpc/session-client.test.ts |
| `session-analysis-error.test.ts` | `lib/features/sessions/` | (none) |
| `session-analysis-presentation.ts` | `lib/features/sessions/` | lib/features/sessions/detail/session-analysis.svelte |
| `session-analysis-presentation.test.ts` | `lib/features/sessions/` | (none) |
| `session-list-label.ts` | `lib/features/sessions/` | lib/features/sessions/detail/highlighted-text.svelte, lib/features/sessions/table/session-cell-projection.ts |
| `session-list-label.test.ts` | `lib/features/sessions/` | (none) |
| `session-neighbor-request-controller.ts` | `lib/features/sessions/` | (none) |
| `session-neighbor-request-controller.test.ts` | `lib/features/sessions/` | (none) |
| `session-row-window.ts` | `lib/features/sessions/` | lib/features/sessions/table/session-table.svelte, lib/features/sessions/table/session-virtualization.ts |
| `session-row-window.test.ts` | `lib/features/sessions/` | (none) |
| `session-surface-mode.ts` | `lib/features/sessions/` | lib/features/sessions/table/session-table.fixture.svelte, lib/features/sessions/table/session-table.svelte |
| `session-surface-mode.test.ts` | `lib/features/sessions/` | (none) |
| `dashboard-breakdown-export.ts` | `lib/features/report/` | lib/features/report/composition/sessions-destination.ssr.test.ts, lib/features/report/composition/sessions-destination.svelte |
| `dashboard-breakdown-export.test.ts` | `lib/features/report/` | (none) |
| `dashboard-filter-navigation.ts` | `lib/features/report/` | lib/features/report/breakdown/navigation.ts |
| `dashboard-filter-navigation.test.ts` | `lib/features/report/` | (none) |
| `group-panel-presentation.ts` | `lib/features/report/` | lib/features/report/breakdown/harness-provider-model.ts, lib/features/report/breakdown/model.ts, project-presentation.ts |
| `group-panel-presentation.test.ts` | `lib/features/report/` | (none) |
| `project-group-actions.ts` | `lib/features/report/` | lib/features/report/actions/project-group-editor.svelte |
| `project-group-actions.test.ts` | `lib/features/report/` | (none) |
| `project-group-control.ts` | `lib/features/report/` | lib/features/report/composition/live-report-destination.svelte |
| `project-group-control.test.ts` | `lib/features/report/` | (none) |
| `project-presentation.ts` | `lib/features/report/` | lib/features/report/breakdown/project-summary.svelte, lib/features/report/breakdown/projects-panel.svelte |
| `project-presentation.test.ts` | `lib/features/report/` | (none) |
| `provider-quota-history-model.ts` | `lib/features/report/` | lib/features/report/actions/quota-history-owner.svelte, lib/features/report/actions/quota-history-panel.svelte, lib/features/report/actions/quota-history-series.svelte |
| `provider-quota-history-model.test.ts` | `lib/features/report/` | (none) |
| `provider-status-model.ts` | `lib/features/report/` | lib/features/report/composition/live-report-destination.svelte, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/overview/overview-components.test.ts, lib/features/report/overview/overview-page.fixture.svelte, lib/features/report/overview/overview-page.svelte, lib/features/report/overview/provider-status.ssr.test.ts, lib/features/report/overview/provider-status.svelte, provider-status-panel-model.test.ts, provider-status-panel-model.ts, server/usage-read-model.server.test.ts |
| `provider-status-model.test.ts` | `lib/features/report/` | (none) |
| `provider-status-panel-model.ts` | `lib/features/report/` | lib/features/report/overview/provider-status.svelte |
| `provider-status-panel-model.test.ts` | `lib/features/report/` | (none) |
| `provider-status-progress.ts` | `lib/features/report/` | lib/features/report/overview/provider-status.svelte |
| `provider-status-progress.test.ts` | `lib/features/report/` | (none) |
| `report-design-tokens.test.ts` | `lib/features/report/` | (none) |
| `report-export.ts` | `lib/features/report/` | lib/features/report/actions/sharing.ts |
| `report-export.test.ts` | `lib/features/report/` | (none) |
| `web-report-payload.ts` | `lib/features/report/` | focused-report-e2e-fixture.ts, lib/features/report/breakdown/dashboard-breakdown.svelte, lib/features/report/breakdown/projects-panel.svelte, lib/features/report/composition/live-report-destination.svelte, lib/features/report/core/report-bootstrap.ts, lib/features/report/core/report-components.test.ts, lib/features/report/core/report-view-model.test.ts, lib/features/report/core/report-view-model.ts, server/report-payload.server.test.ts, server/report-payload.server.ts, server/revision-query-runner.server.ts |
| `web-report-payload.test.ts` | `lib/features/report/` | (none) |
| `focused-report-e2e-fixture.ts` | `lib/features/report/composition/` | bundle/client-bundle.test.ts, e2e/dashboard-presentation.spec.ts, e2e/dashboard.spec.ts, e2e/sources.spec.ts, e2e/time-range.spec.ts, lib/features/report/composition/synthetic-report-destination.svelte |
| `provider-quota-e2e-fixture.ts` | `lib/features/report/composition/` | lib/features/report/composition/synthetic-report-destination.svelte, server/provider-quota-resolver.server.test.ts, server/provider-quota-resolver.server.ts |
| `dashboard-analytics.ts` | `lib/foundation/dashboard/` | dashboard-breakdown-export.ts, dashboard-model.ts, lib/features/report/breakdown/dashboard-breakdown.svelte, lib/features/report/breakdown/project-summary.svelte, lib/features/report/breakdown/projects-panel.ssr.test.ts, lib/features/report/breakdown/projects-panel.svelte, project-presentation.test.ts, project-presentation.ts, report-export.test.ts |
| `dashboard-metric-model.ts` | `lib/foundation/dashboard/` | dashboard-model.ts |
| `dashboard-model.ts` | `lib/foundation/dashboard/` | lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/composition/synthetic-report-destination.test.ts, lib/features/report/overview/executive-overview-model.ts, lib/features/report/overview/overview-result-scope.ts, lib/features/report/overview/period-comparison-presentation.test.ts, lib/features/report/overview/period-comparison-presentation.ts, overview-model.test.ts, overview-model.ts, session-analysis-target.test.ts, session-analysis-target.ts |
| `dashboard-model.test.ts` | `lib/foundation/dashboard/` | (none) |
| `dashboard-search.ts` | `lib/foundation/dashboard/` | dashboard-filter-navigation.test.ts, dashboard-filter-navigation.ts, dashboard-model.ts, group-panel-presentation.ts, lib/features/campaigns/campaign-timeline-model.test.ts, lib/features/campaigns/campaign-timeline-model.ts, lib/features/campaigns/campaigns-continuity.test.ts, lib/features/campaigns/campaigns-page.svelte, lib/features/campaigns/campaigns-query.test.ts, lib/features/campaigns/campaigns-query.ts, lib/features/campaigns/campaigns-selection.test.ts, lib/features/report/actions/actions.test.ts, lib/features/report/actions/campaign.ts, lib/features/report/breakdown/active-filters.svelte, lib/features/report/breakdown/dashboard-breakdown.svelte, lib/features/report/breakdown/filter-bar.svelte, lib/features/report/breakdown/harness-provider-model.ts, lib/features/report/breakdown/harness-provider-panel.svelte, lib/features/report/breakdown/model-analysis-table.svelte, lib/features/report/breakdown/model.ts, lib/features/report/breakdown/navigation.test.ts, lib/features/report/breakdown/navigation.ts, lib/features/report/breakdown/origin-filter.svelte, lib/features/report/composition/active-timeline-series.test.ts, lib/features/report/composition/active-timeline-series.ts, lib/features/report/composition/live-report-destination.svelte, lib/features/report/composition/report-destination-owner.svelte, lib/features/report/composition/report-search.test.ts, lib/features/report/composition/report-search.ts, lib/features/report/composition/report-tab-target.ts, lib/features/report/composition/sessions-destination.ssr.test.ts, lib/features/report/composition/sessions-destination.svelte, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/overview/overview-page.fixture.svelte, lib/features/report/overview/overview-result-scope.test.ts, lib/features/report/overview/overview-result-scope.ts, lib/features/report/range/activity-explorer.svelte, lib/features/report/range/range-brush.svelte, lib/features/report/range/report-period-control.svelte, lib/features/report/range/report-range-model.ts, lib/features/shell/navigation.ts |
| `dashboard-search.test.ts` | `lib/foundation/dashboard/` | (none) |
| `session-analysis-model.ts` | `lib/foundation/session/` | lib/features/report/overview/records.svelte, lib/features/sessions/detail/rounds-reader.svelte, lib/features/sessions/detail/session-analysis.svelte, lib/features/sessions/detail/session-drawer.svelte, lib/features/sessions/table/session-cell-projection.ts, session-analysis.test.ts |
| `session-analysis.test.ts` | `lib/foundation/session/` | (none) |
| `session-analysis-target.ts` | `lib/foundation/session/` | lib/features/campaigns/campaign-detail-selection.ts, lib/features/report/composition/live-report-destination.svelte, lib/features/report/composition/sessions-destination.svelte, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/sessions/detail/detail-selection.ts, lib/features/sessions/detail/session-analysis.svelte, lib/features/sessions/detail/session-detail-query-slot.svelte, lib/features/sessions/detail/types.ts, session-analysis-presentation.test.ts, session-analysis-presentation.ts |
| `session-analysis-target.test.ts` | `lib/foundation/session/` | (none) |
| `session-table-schema.ts` | `lib/foundation/session/` | dashboard-model.ts, dashboard-search.ts, dashboard-sort.ts, lib/features/report/composition/sessions-destination.svelte, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/sessions/table/session-anchor.fixture.svelte, lib/features/sessions/table/session-cell-projection.ts, lib/features/sessions/table/session-cell.svelte, lib/features/sessions/table/session-columns.ts, lib/features/sessions/table/session-table-model.test.ts, lib/features/sessions/table/session-table.fixture.svelte, lib/features/sessions/table/session-table.svelte |
| `session-table-schema.test.ts` | `lib/foundation/session/` | (none) |
| `api-value.test.ts` | `lib/foundation/presentation/` | (none) |
| `provenance-marker.test.ts` | `lib/foundation/presentation/` | (none) |
| `browser-runtime-mode.ts` | `lib/foundation/` | (none) |
| `campaign-display-label.test.ts` | `lib/foundation/` | (none) |
| `campaign-label-overrides.ts` | `lib/foundation/` | campaign-display-label.test.ts, lib/features/campaigns/campaigns-page.svelte, lib/features/report/composition/live-report-destination.svelte, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/composition/synthetic-report-destination.test.ts |
| `campaign-label-overrides.test.ts` | `lib/foundation/` | (none) |
| `campaign-map-fixture.ts` | `lib/foundation/` | e2e/campaign-period-continuity.scale.ts, lib/features/campaigns/campaign-detail-selection.test.ts, lib/features/campaigns/campaign-timeline-model.test.ts, lib/features/campaigns/campaigns-load.test.ts, lib/features/campaigns/campaigns-load.ts, lib/features/campaigns/campaigns-page.svelte, lib/features/campaigns/campaigns-query.test.ts, lib/features/campaigns/campaigns-selection.test.ts, lib/features/campaigns/campaigns-synthetic.test.ts, lib/features/campaigns/campaigns-synthetic.ts, lib/features/observatory/observatory-query.ts |
| `campaign-map-fixture.test.ts` | `lib/foundation/` | (none) |
| `date-range.ts` | `lib/foundation/` | dashboard-model.test.ts, dashboard-model.ts, dashboard-search.ts, lib/features/campaigns/campaign-timeline-model.test.ts, lib/features/campaigns/campaign-timeline-model.ts, lib/features/report/overview/activity-heatmap.svelte, lib/features/report/overview/executive-overview-model.ts, lib/features/report/overview/overview-components.test.ts, lib/features/report/overview/overview-result-scope.ts, lib/features/report/overview/timeline-window.ts, lib/features/report/range/activity-explorer.svelte, lib/features/report/range/range-brush.svelte, lib/features/report/range/report-period-control.svelte, lib/features/report/range/report-range-model.ts, overview-model.test.ts, overview-model.ts |
| `date-range.test.ts` | `lib/foundation/` | (none) |
| `machine-freshness-presentation.ts` | `lib/foundation/` | lib/features/report/composition/live-report-destination.svelte, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/composition/synthetic-report-destination.test.ts, manual-transfer-model.ts |
| `machine-freshness-presentation.test.ts` | `lib/foundation/` | (none) |
| `overview-model.ts` | `lib/foundation/` | dashboard-filter-navigation.ts, lib/features/report/breakdown/navigation.ts, lib/features/report/composition/active-timeline-series.ts, lib/features/report/composition/live-report-destination.svelte, lib/features/report/composition/report-tab-target.ts, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/overview/activity-heatmap.svelte, lib/features/report/overview/activity-timeline.svelte, lib/features/report/overview/punchcard.svelte, lib/features/report/overview/timeline-model.ts, lib/features/report/overview/timeline-window.ts, lib/features/report/range/activity-explorer.svelte, lib/features/report/range/report-range-model.ts, time-range-control-state.ts |
| `overview-model.test.ts` | `lib/foundation/` | (none) |
| `render-test-module.ts` | `lib/foundation/` | (none) |
| `report-data.ts` | `lib/foundation/` | campaign-label-overrides.test.ts, dashboard-model.test.ts, focused-report-e2e-fixture.ts, lib/features/campaigns/campaigns-load.test.ts, lib/features/observatory/observatory-query.ts, lib/features/report/actions/campaign-session-controls-binding.test.ts, lib/features/report/composition/report-destination.test.ts, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/composition/synthetic-report-destination.test.ts, lib/features/report/core/report-bootstrap.test.ts, lib/features/report/core/report-bootstrap.ts, lib/features/report/core/report-components.test.ts, lib/features/report/core/report-view-model.test.ts, lib/features/report/overview/overview-components.test.ts, lib/features/report/overview/overview-result-scope.test.ts, lib/features/work/work-attention-synthetic.test.ts, lib/features/work/work-attention-synthetic.ts, lib/features/work/work-load.test.ts, lib/features/work/work-synthetic.ts, server/report-payload.server.test.ts, session-analysis-presentation.test.ts, session-analysis-target.test.ts, web-report-payload.test.ts |
| `runtime-mode.ts` | `lib/foundation/` | app.d.ts, browser-runtime-mode.ts, lib/features/campaigns/campaigns-load.ts, lib/features/observatory/observatory-load.ts, lib/features/observatory/observatory-query.ts, lib/features/report/actions/quota-history-owner.svelte, lib/features/report/actions/report-mutation-availability.ts, lib/features/report/composition/live-report-destination.svelte, lib/features/report/composition/report-destination-owner.svelte, lib/features/report/composition/synthetic-report-destination.svelte, lib/features/report/core/report-bootstrap.ts, lib/features/report/core/report-intent.ts, lib/features/shell/app-navigation.svelte, lib/features/shell/app-shell.svelte, lib/features/shell/demo-policy.server.ts, lib/features/shell/navigation.ts, lib/features/shell/provider-quota-query-rail.svelte, lib/features/shell/provider-quota-query-shell.svelte, lib/features/skills/shell/data.ts, lib/features/skills/shell/skills-shell.svelte, lib/features/sources/endpoint.server.ts, lib/features/sources/source-control-provider.svelte, lib/features/sync/server/manual-merge-endpoints.server.ts, lib/features/work/work-attention-detail.svelte, lib/features/work/work-delegations.svelte, lib/features/work/work-load.ts, lib/features/work/work-routing.svelte, lib/features/work/work-sources.svelte, lib/features/work/work-thread-load.ts, lib/query/observatory-prefetch.ts, lib/server/rpc/context.server.ts, lib/server/rpc/in-process-client.server.ts, lib/server/rpc/request-policy-handler.ts, server/delegation.server.ts, server/demo-boundary.server.ts, server/provider-quota-resolver.server.ts, server/runtime-mode.server.ts, server/sync-upload.server.ts, server/usage-engine-control-resolver.server.ts, server/usage-read-model-resolver.server.ts, server/work-attempts.server.ts, server/work-attention.server.ts, server/work-routing-context.server.ts, server/work-threads.server.ts, source-control-client.ts |
| `runtime-mode.test.ts` | `lib/foundation/` | (none) |
| `shared.ts` | `lib/foundation/` | campaign-label-overrides.test.ts, dashboard-model.test.ts, overview-model.test.ts, provider-status-model.test.ts |
| `skills-page-model.ts` | `lib/foundation/` | lib/features/skills/management/model.ts, lib/features/skills/management/operation-episode.svelte.ts, lib/features/skills/management/skill-diagnostics.svelte, lib/features/skills/management/skills-consolidate.svelte, lib/features/skills/management/skills-health-slot.svelte, lib/features/skills/presentation.ts, lib/features/skills/shell/model.ts, lib/features/skills/worktable/model.ts, lib/features/skills/worktable/skill-drawer.svelte, lib/features/skills/worktable/skills-worktable.svelte, lib/foundation/navigation/svelte/skills-url.test.ts, lib/foundation/navigation/svelte/skills-url.ts |
| `skills-page-model.test.ts` | `lib/foundation/` | (none) |
| `source-control-client.ts` | `lib/foundation/` | lib/features/report/actions/report-mutation-availability.ts, lib/features/sources/context.svelte.ts, lib/features/sources/model.ts, lib/features/sources/service.test.ts, lib/features/sources/service.ts, lib/features/sources/source-control-provider.svelte, lib/features/sources/source-control-summary-model.test.ts, lib/features/sources/source-control-summary-model.ts, lib/features/sources/source-controls.fixture.svelte, lib/features/sync/sync-root.svelte, lib/features/work/work-jira-sync-model.test.ts, lib/features/work/work-jira-sync-model.ts, lib/query/options/source-control.test.ts, lib/query/options/source-control.ts, manual-transfer-model.ts |
| `source-control-client.test.ts` | `lib/foundation/` | (none) |
| `source-control-presentation-model.ts` | `lib/foundation/` | lib/features/sources/model.ts, lib/features/sources/presentation-model.test.ts, lib/features/sources/presentation.ts, lib/features/sources/source-control-summary-model.ts, lib/features/work/work-sources.svelte, source-control-presentation.test.ts, source-control-presentation.ts |
| `time-range-control-state.ts` | `lib/foundation/` | lib/features/report/overview/activity-timeline.svelte, lib/features/report/overview/timeline-window.ts, lib/features/report/range/activity-explorer.svelte, lib/features/report/range/range-brush.svelte, lib/features/report/range/report-range-model.ts, lib/features/work/work-timeline-brush.svelte |
| `time-range-control-state.test.ts` | `lib/foundation/` | (none) |

#### Outcome (after the moves)

- Correction made during execution: `report-design-tokens.test.ts` went to `lib/foundation/presentation/`, not
  `features/report/`. Inside `features/report` it scanned its own doc comment (`token(colors.x)`) and failed.
  Its `import.meta.dir` paths were re-based; no assertion changed.
- `ls apps/web/src/*.ts` → `app.d.ts`, `hooks.server.ts`.
- Four-or-more-level climbs: 173 → 0. `$lib/` imports: 0 → 0. `import(` count: 104 → 104. `legacy, plan 127`: 34 → 34.
- Web tests: 2395 pass before and after (280 files).
- Gzip closure: 309,001 B → 309,003 B (guard tolerance 2%); `RECORDED_GZIP_CLOSURE_BYTES` unchanged.
- Root check/lint/typecheck/test/build/test:web-bundle/test:web-client-manifest all exit 0; e2e 411 + 3 passed, exit 0.
- Lib invariant still holds: no non-test `lib/foundation` module imports `lib/features`.

Orchestrator review of P3 (2026-11-21): the diff holds renames only (no file
added or deleted) and every changed line outside import specifiers is a path
string in a test, tool or comment. The adversarial review (agent plus Codex)
returned no code defect. Three points are recorded here on its advice:

- The mapping table was kept out of the plan during execution on purpose,
  because three packets ran in parallel; it is the table above.
- Path-only rewrites inside test files were accepted as part of P3 Step 2,
  including one `expect(...)` argument in `presentation-closure.test.ts`
  (`'../../../shared'` became `'../shared'`, the same file). Design decision 3
  stands for every other kind of assertion change.
- The rule "foundation never imports a feature" covers non-test modules. One
  test, `lib/foundation/session/session-table-schema.test.ts`, imports
  `features/sessions/table/session-columns`, as it did from the root.
- Where the baseline section above says `report-design-tokens.test` goes to
  `features/report`, the outcome section is the truth: it lives in
  `lib/foundation/presentation`.
- ADRs 0004, 0005 and 0046 still link to the old root paths; ADRs are records
  and were not edited. `browser-runtime-mode.ts` and `render-test-module.ts`
  have no importer and were moved, not deleted.

### 2026-11-21 — P5 executed (branch `refactor/decompose-worst-functions`)

Base: `184b1610` (P1 outcome). The integration branch `refactor/structural-cleanliness`
has since gained `ffacf003` (plan doc) and the P2 merge `8bc3be99`; P5 touches none of
their files and `git merge-tree` against it is clean.

All seven targets now pass `bun run check` without their `legacy, plan 127` suppression.
Scores were read with the repository Biome 2.5.15 (score of the function at the former
suppression site; "largest new" is the highest-scoring function the extraction created).

| # | Target | Before | After | Largest new | Commit |
| --- | --- | --- | --- | --- | --- |
| 1 | `local-machine` `visit` | 245 | 7 | `classifyStartedTask` 20 | `85c2f4b0` |
| 2 | `local-collectors` `readCodexSessions` use body | 114 | 6 (`readAndRetainCodexRollouts`) | `readListedCodexRollouts` 17 | `9bb3c1b6` |
| 3 | `local-collectors` `readCodexUsageSessionsResultWith` body | 85 | 7 | `codexCollectedSession` 15 | `7b197676` |
| 4 | `usage-engine-runtime` pull request source run | 102 | 20 (`runPullRequestSource`) | `discoverAccountPullRequests` 15 | `822e17a2` |
| 5 | `usage-engine-runtime` session source run | 97 | 10 (`runSessionSource`) | `retireDeclaredSessions` 14 | `2bc44d62` |
| 6 | `usage-engine-runtime` Jira source run | 85 | 13 (`runJiraIssueSource`) | `observeJiraCandidates` 17 | `046e7b86` |
| 7 | `report-core` `topLevelArrayExceedsLimit` | 125 | 13 | `scanArrayCharacter` 20 | `4f714d36` |

Debt counter: 271 → 264 (`git grep -c '…legacy, plan 127' -- ':!plans'`).

Method notes:

- Biome adds one nesting level per enclosing function, so a body nested inside
  `withPerfSpan(…, Effect.gen(…))` or `run: (context) => Effect.gen(…)` pays 3–4 per `if`.
  Targets 2–6 were therefore hoisted to module level with explicit arguments; the mutable
  locals of target 2 became one `CodexSessionReadPass` object plus a read-only
  `CodexSessionReadContext`, created once per pass. Target 1 kept the parser's existing
  closure style (every helper there already closes over the parser's `let` state); the new
  handlers are created once per parser, never per line.
- New per-call allocations: one `Effect.gen` per rollout read that misses the cache
  (target 2) and one per phase per source run (targets 4–6). None per history line. Target 7
  allocates one state object per keyed-array scan and calls a function per array character.
- One structural, not behavioural, deviation: in `visit` the two early `return`s of the
  `task_started` branch now return from `startTask`; `visitTaskRecord` then tests
  `payload.type` against `task_complete`/`turn_aborted`/`token_count`, which a
  `task_started` payload (a JSON-parsed plain object) cannot match. In target 7 the
  `else if` chain became early-returning `if`s with the same conditions in the same order.

Characterization tests added first (each passed on unchanged code, committed separately):

- `87a904cf` `packages/local-machine/src/internal/codex-history-parser.test.ts` (new): the
  open-task capacity branch of `task_started` (evict oldest without context, drop when all
  have context, restart an open task).
- `732e6dc3` `packages/usage-engine-runtime/src/source-adapters.test.ts`, describe
  `source run branches (plan 127 characterization)`: rejected Codex work observations fail the
  session pass; a pull request source whose `gh` vanished returns the unavailable result
  without running `gh`; a Jira pass whose detail reads find no `acli` records a disabled run.
- `fb9cd03e` `packages/report-core/src/portable-usage.test.ts`: one case covering element
  shapes, the close-time limit, unreadable strings, unterminated arrays and the key position.

Branches still without line coverage (all moved verbatim): `visit`'s undated-catalogue and
unreadable-exposure branches are covered only by `local-machine` tests; in target 2 the
`Effect.sleep(0)` slice yield (timing-dependent); in target 3 the `lastObservedAt` fallback
for a rejected session without `lastRejectedMetricAt`; in targets 4–6 the wait-truncated,
wait-unproven, branch-reconcile truncated/failed, identity-uncertain and
`rowRetirement.storeRefused` warning ternaries, and the non-Codex `collection` spread.

Test counts (base → after): `local-machine` 382 → 385, `local-collectors` 613 → 613,
`usage-engine-runtime` 390 → 393, `report-core` 886 → 887, all 0 fail. One full
`usage-engine-runtime` run after target 5 had a 30 s timeout in
`review-attempts.test.ts` ("a restart with the review still running…"); that file does not
import `source-adapters` and passed 17/17 when rerun alone.

Orchestrator review of P5 (2026-11-21): the diff touches only the four source
files and their three test files; the test diff is additions only (zero
removed lines); no suppression was added. The three characterization test
commits were checked out at their own commits, where the code under test is
still the unrefactored base, and pass there (3/3, 3/3, 3/3). Two adversarial
reviews (agent plus Codex per refactor commit) returned no confirmed finding.
Codex's differential runs against each parent commit matched: 1,608 parser
comparisons for `visit`, 295 + 288 + 273 in-memory scenarios for the three
source runs, and 600,030 scanner comparisons. Branches that remain protected
by reading only, not by a test: the `Effect.sleep(0)` slice yield and the
`lastObservedAt` fallback in the Codex collector; in the source adapters the
wait-truncated and wait-unproven warnings, branch reconciliation truncated or
failed, identity-uncertain, the `rowRetirement.storeRefused` warning and the
non-Codex work-observation `collection` spread.

### Plan 127 P4 — execution note

Branch `refactor/campaigns-page-controllers` (worktree `ai-usage-wt/plan127-p4`), based on
`refactor/structural-cleanliness` @ `46f2bcba` (P1–P3 merged). Not pushed.

#### Baseline (before any change)

- `(cd apps/web && bun run check)` exit 0 (svelte-check 0 errors).
- `(cd apps/web && bun run test)` exit 0: 2395 pass / 280 files.
- Script lines (plan awk): 808.

#### Result

- Script lines: 808 -> 450. Target (< 350) NOT reached; see "Why 450".
- Web tests: 2395 pass / 280 files -> 2460 pass / 286 files (65 added cases, 0 modified).
- Five commits, one per step (step 3 = three controllers; the last also carries the clients module
  and the refresh composition helper).

#### New modules (apps/web/src/lib/features/campaigns)

| Module | Lines | Test | Cases |
| --- | --- | --- | --- |
| campaigns-page-model.ts (pure derivations, helpers) | 256 | campaigns-page-model.test.ts | 28 |
| campaigns-page.styles.ts (style constants, unchanged values) | 79 | campaigns-page.styles.test.ts | 2 |
| campaigns-page-clients.ts (report/session client construction) | 30 | campaigns-page-clients.test.ts | 4 |
| campaigns-focus-restoration.svelte.ts (controller 1) | 140 | campaigns-focus-restoration.test.ts | 8 |
| campaigns-exploration-state.svelte.ts (controller 2: snapshot capture/restore, anchors, positions) | 267 | campaigns-exploration-state.test.ts | 9 |
| campaigns-navigation-actions.svelte.ts (controller 3: URL navigation/selection actions) | 160 | campaigns-navigation-actions.test.ts | 14 |
| campaigns-rune-modules.fixture.ts (test support: client compile plugin, as delegation-draft.test.ts) | 44 | — | — |
| campaigns-reactivity.fixture.svelte.ts (test support: `$effect.root` observer) | 23 | — | — |

#### Effects

All six `$effect`s stay in the component, same order, same bodies except access paths; none had or
gained a cleanup. The scope-reset effect now calls `explorationState.followScope(scope)`, whose
body is the original one moved verbatim; it reads `scope` (the only dependency before and after;
`previousScope` is a plain variable) and writes state inside the same effect. Controllers create
only `$state`, no effects. `beforeNavigate`, `afterNavigate`, `onDestroy` and `snapshot` are still
registered by the component, after the effects, in the original relative order.

#### Template

Only access-path changes (`x` -> `explorationState.x` / `focusRestoration.x` /
`campaignNavigation.navigationError`), the two shorthand binds expanded
(`bind:expansion` -> `bind:expansion={explorationState.expansion}`), and two `<button>` opening
tags re-wrapped by the formatter because the longer paths exceed the line width (attribute
whitespace only; same attributes, same order, same text nodes).

#### Why 450

What remains: ~85 lines of imports (Biome puts one name per line), the query wiring Step 4 keeps
(`createQuery` x5 and their option deriveds), ~180 lines of `$derived` view state interleaved
with those queries, the six effects (~55 lines, must stay for ordering), the lazy replay toggle
(kept as is by instruction), the loading/retry guards over the query objects, and controller
wiring. Going further would need a fourth rune module of interleaved deriveds/queries (a "page
controller" by another name) or moving effects/queries, both excluded by the packet rules.

#### Final verification (worktree root, shim on PATH)

| Command | Result |
| --- | --- |
| `bun run check` | exit 0 (1716 files, no fixes) |
| `bun run lint` | exit 0 |
| `bun run typecheck` | exit 0 |
| `bun run test` | exit 0, 31/31 tasks; web 2460 pass / 286 files |
| `bun run build` | exit 0 |
| `bun run test:web-bundle` | exit 0 (6 pass; `RECORDED_GZIP_CLOSURE_BYTES` untouched) |
| `bun run test:web-client-manifest` | exit 0 |
| `flock … bun run test:e2e` | exit 0, 411 passed + 3 passed |

Campaign specs (campaign-map, campaign-timeline, campaign-replay, campaign-short-page,
campaign-label-overrides, origin-campaign) run after each controller: 28 passed each time.

#### Deviations and residual risk

- `navigate` became a sync function settling the shell goto through `.catch` (Biome forbids both
  floating promises and `void` in `.ts`); only a goto that throws synchronously would differ, and
  the shell goto is an `async` function.
- `detailRows` went from `$derived.by(() => { … })` to `$derived(mergeRowsById(rows, matchedRows))`
  as the plan's Step 1 prescribes; the two forms compile to the same derived with the same reads.
- The refresh payload is now computed before it is written (originally `matchingRestoration` was
  written before the anchors were read); no read in that click handler depends on those writes.
- The navigation-actions commit also carries the clients module and `campaignRefreshFor`
  (amended in so that no commit is left unbuildable).

Orchestrator review of P4 (2026-11-21): only the 15 campaign files changed, no
existing test file was modified, no suppression was added, the component still
holds exactly six `$effect`s and the controllers hold none. The adversarial
review (agent plus Codex) returned no confirmed finding. On the one flagged
change, `navigate` becoming synchronous: none of its eight original call sites
awaited it or chained on it, the shell `goto` is an `async` function so it
cannot throw synchronously, and a rejection is still handled one microtask
after it occurs.

Decision on the missed criterion. The plan asked for a script under 350 lines;
it is 450. The reviewer found about 60 to 70 further lines that could move
without breaking a rule (three load guards as pure predicates, the
`requestedCampaign` initialiser, a destructuring, a repeated fallback), which
would land near 380 to 390, and confirmed that going under 350 requires an
aggregate "page controller" or moving effects and queries, both forbidden by
this plan. Two of the suggested cuts (`selectedLookupRequest` and
`compatibleMemberRows` as plain `$derived(fn(...))`) were deliberately left as
`$derived.by` with early returns by the implementer to keep their conditional
reads. The remaining safe gain is about 30 lines, which does not justify
another extraction, e2e and review round on focus-sensitive code. The
criterion is therefore recorded as missed and the 350 figure as a wrong
estimate in the plan, not as open work.

Two latent points noted by the review, neither a defect today:
`campaigns-focus-restoration.test.ts` fails loudly at load if an earlier test
file in the same process leaves `document`, `CSS` or `getComputedStyle` on
`globalThis`; and the test compile plugin keeps the campaign rune modules
client-compiled for the rest of the process, so a future Bun test that renders
`campaigns-page.svelte` through Bun's loader would mix runtimes.
