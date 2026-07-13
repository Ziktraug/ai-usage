# Plan 009: Remove HTML Export End to End

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none; plans 001-008 are complete
- **Category**: product simplification / correctness / architecture / CI
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `refactor/009-remove-html-export`

## Executor instructions

Read this plan completely before editing. Compare the current commit with
`17bcf28`; if an in-scope file changed, re-read it and update the implementation
notes before using any symbol or excerpt below. Preserve unrelated user changes.

The product decision is final: HTML export is removed rather than repaired. Do
not leave a deprecated alias, hidden feature flag, compatibility parser, static
runtime, or replacement file format. Use separate reviewable commits for the
CLI consumer deletion, browser/static-runtime deletion, atomic focused-query and
core deletion, and build/CI/docs cleanup. Do not push or open a pull request
unless the user explicitly asks.

## Why this matters

The current HTML path hangs in its integration test and spans much more than a
renderer. It adds a CLI format, a root export command, a complete focused-query
kind, a public package export, browser globals, hash routing, an asset inliner,
special Vite chunking, a web download action, Playwright configuration, and two
CI jobs. Keeping those seams for an unused feature increases every later report
refactor's state space.

Removing the whole path also resolves the audit's critical HTML failure without
spending effort on a product surface that is no longer wanted.

## Target outcome

1. `--html` is rejected by both the default report and `merge`; the root
   `bun run html export` command no longer exists.
2. The web app has no HTML download action and no static/file runtime.
3. `html-payload` and every HTML-specific focused-query type disappear.
4. `@ai-usage/report-core/html-export` and all asset-inlining code disappear.
5. The root route may use normal route and CSS code splitting.
6. HTML-specific tests and CI jobs disappear; normal served-app coverage stays.
7. Current documentation no longer promises or constrains HTML export.

The following must remain supported:

- table, JSON, CSV, and `--payload-json` CLI output;
- `UsageReportPayload`, `createUsageReportPayload`, and complete internal report
  collection used for revision publication;
- snapshot files, merge bundles, and the file-only `/sync` workspace;
- the normal HTTP web app, its `/skills` and `/sync` routes, and its E2E fixture
  payload mode;
- `setupHTML` and the local setup web page in `apps/cli/src/setup.ts`;
- `MAX_REPORT_RUNNER_ARTIFACT_BYTES` and revision materialization.

Keep `ai-usage-reports/` in `.gitignore`: old local exports can contain private
history and must remain ignored. Do not delete existing report files.

## Current-state evidence

At `17bcf28`:

- root `package.json` exposes `html`, `test:html-export`, and `test:html-file`;
- `apps/cli/src/cli.ts` includes `html` in `OutputFormat` and parses `--html`
  for report and merge;
- `apps/cli/src/html.ts` builds the web app and writes a dated single-file
  report, while `apps/cli/src/render/html.ts` performs build-artifact discovery;
- `apps/web/src/dashboard-export.ts` downloads a self-contained document and
  `dashboard.tsx` requests a complete `html-payload` revision;
- `apps/web/src/report-runtime.ts` recognizes three `__AI_USAGE_REPORT*`
  globals and `router.tsx` switches to hash history for static files;
- `apps/web/vite.config.ts` keeps `/` in the entry chunk and disables CSS code
  splitting for the single-file artifact;
- `packages/report-core/src/html-export.ts` is publicly exported, and
  `focused-report-query.ts` models `FocusedHtmlPayloadResult`;
- report-data and the web server carry that query through an immutable revision;
- `.github/workflows/pr-checks.yml` runs both HTML integration suites.

The failure is already characterized: `apps/cli/src/html.integration.test.ts`
does not complete under short or 30-second timeouts. Do not make that broken
test a precondition for deletion.

## Scope

### In scope

- root `package.json` and `.github/workflows/pr-checks.yml`;
- HTML-related CLI parser, execution, renderer, tests, and scripts;
- HTML/static browser runtime, button, route behavior, build constraints, and
  tests;
- `html-payload` across web, report-data, and report-core;
- the public `./html-export` entry point and its implementation;
- current READMEs, architecture/interface/future-work docs, and other active
  docs that still claim HTML support.

### Out of scope

- deleting or redesigning `UsageReportPayload` or `--payload-json`;
- removing CSV, JSON, snapshots, merge bundles, `/sync`, or setup;
- deleting normal SSR/HTML application documents;
- rewriting completed plans 007/008 or their logs to hide historical behavior;
- repairing the HTML renderer, adding PDF/PNG export, or replacing it with a
  different download format;
- unrelated report refresh, subprocess, or storage fixes covered by later
  plans.

## Commands

Run from the repository root unless stated otherwise.

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- package.json .github apps/cli apps/web \
  packages/report-core packages/report-data README.md CONTEXT.md docs
git status --short -- package.json .github apps/cli apps/web \
  packages/report-core packages/report-data README.md CONTEXT.md docs
bun --version
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
```

STOP if unrelated changes overlap an in-scope file. Record baseline failures;
do not run an unbounded HTML integration command.

## Implementation steps

### Step 1 - Remove all CLI consumers

Delete:

- `apps/cli/src/html.ts`;
- `apps/cli/src/render/html.ts`;
- `apps/cli/src/html.integration.test.ts`.

Then:

1. Remove `html` from `OutputFormat`, both `--html` parser branches, help text,
   and mutual-exclusion text in `apps/cli/src/cli.ts`.
2. Add negative parser tests:
   - report `--html` returns `Unknown option: --html`;
   - `merge mac.json --html` returns `Unknown option for merge: --html`.
3. In `apps/cli/src/report.ts`, remove the HTML import and branches. Collapse
   async wrappers that existed only for HTML; keep payload serialization and
   table/JSON/CSV behavior byte-compatible.
4. In `apps/cli/src/main.ts`, select the complete payload only for `payload`.
   Do not collect a complete payload for normal table/JSON/CSV output.
5. Remove root `html` and `test:html-export` scripts.
6. Correct the CLI help description of `--payload-json`; it is a compatibility
   output, not a dev-server transport.
7. Keep `UsageReportPayload`, `createLocalReportPayload`, and payload runner
   artifacts. Only the HTML rendering/import edges disappear.

Verify:

```sh
bun test apps/cli/src/cli.test.ts apps/cli/src/report.test.ts
bun run --cwd apps/cli check
bun run typecheck

temp_home="$(mktemp -d)"
trap 'rm -rf "$temp_home"' EXIT
HOME="$temp_home" XDG_CONFIG_HOME="$temp_home/.config" \
  bun apps/cli/src/main.ts --payload-json --harness codex --no-cursor \
  > "$temp_home/payload.json"
bun -e '
  const payload = await Bun.file(process.argv[1]).json();
  for (const key of ["rows", "tableRows", "analytics", "filters"]) {
    if (!(key in payload)) throw new Error(`missing ${key}`);
  }
' "$temp_home/payload.json"
rm -rf "$temp_home"
trap - EXIT
```

The smoke must parse the complete stdout JSON; the trap cleans temporary state
on both success and failure.

### Step 2 - Remove the browser export and static runtime

Delete:

- `apps/web/src/dashboard-export.ts`;
- `apps/web/e2e/static-html.spec.ts`;
- `apps/web/playwright.static.config.ts`.

Then:

1. Remove the export action, query, imports, and button from
   `apps/web/src/dashboard.tsx`. At this step, remove the call to
   `fetchFocusedHtmlPayload`; the still-defined server/query kind is deleted
   atomically in step 3.
2. Remove `staticReport`; render Skills and Sync navigation normally.
3. Construct Dashboard's fallback explicitly with
   `toWebReportPayload(demoReportPayload)`. Derive `isDemo` only from the absence
   of `initialPayload` and `servedBootstrap`; retain the `initialPayload`
   component/E2E seam.
4. In `apps/web/src/report-runtime.ts`, remove the injected/static/export
   globals and all readers for them. E2E keeps `{ kind: 'payload' }`; normal
   runtime keeps `{ kind: 'served' }` from the focused bootstrap.
5. Remove the production-dead `mountReportRefreshAction` helper and its tests;
   retain `reportRefreshPayload`, disabled only during SSR and E2E.
6. Remove `resolveInitialReportPayload`; update `routes/index.tsx` to consume the
   loader result directly.
7. Remove static hash history from `router.tsx` and the static perf guard from
   `client-perf.ts`.
8. Delete `toExportReportPayload` and only its tests. Preserve
   `toWebReportPayload`, slice/merge helpers, datasets, and facets.
9. Remove the static-runtime tests and the now-dead `readReportPayload` test.
10. Remove `static-html.spec.ts` from `playwright.config.ts` ignores and remove
   both web/root `test:html-file` scripts.

Verify:

```sh
bun test apps/web/src/report-runtime.test.ts \
  apps/web/src/web-report-payload.test.ts \
  apps/web/src/report-data.test.ts \
  apps/web/src/client-perf.test.ts
bun run --cwd apps/web check
bun run typecheck
```

### Step 3 - Remove `html-payload` and report-core in one atomic change

Do not typecheck between deleting a core type and deleting its consumers. Make
this one commit, proceeding from the outer adapter to the core:

1. In `apps/web/src/focused-report-client.ts`, remove the HTML type-map entries,
   `getHtmlPayload`, `fetchFocusedHtmlPayload`, parser branch, and served source
   adapter. Remove corresponding fakes/assertions from its test.
2. Remove `getFocusedReportHtmlPayload` from
   `apps/web/src/server/report-payload.ts`.
3. Remove the HTML generic entries from
   `apps/web/src/server/focused-report-query-runner.server.ts`.
4. In `packages/report-data/src/focused-report-query-runner.ts`, accept only
   `breakdown`, `overview`, and `support`; delete the HTML-specific result budget
   while retaining all shared artifact budgets.
5. In `packages/report-data/src/focused-report-query-sqlite.ts`, remove HTML
   imports, `readAllRows` if it has no remaining consumer, `runHtmlPayload`, and
   the dispatch branch. Keep bounded Support behavior.
6. In `packages/report-core/src/focused-report-query.ts`, remove
   `FocusedHtmlPayloadResult`, `html-payload` from unions,
   `projectFocusedHtmlPayload`, its fingerprint/parser overloads, and helpers
   that are now proven unreachable. Keep Overview, Breakdown, Support, Session,
   revision, and fingerprint contracts.
7. Delete `packages/report-core/src/html-export.ts` and
   `packages/report-core/src/html-export.test.ts`.
8. Remove `./html-export` from `packages/report-core/package.json` and
   `packages/report-core/src/index.ts`.
9. Update core/report-data/web tests, preserving all non-HTML byte, parser,
   revision, and fingerprint cases.

Verify only after all nine actions:

```sh
bun test packages/report-core/src/focused-report-query.test.ts \
  packages/report-data/src/focused-report-query-sqlite.test.ts \
  apps/web/src/focused-report-client.test.ts
bun run typecheck
```

### Step 4 - Release build constraints that existed only for export

In `apps/web/vite.config.ts`:

1. Keep normal route `defaultBehavior` but remove the `/` split exception.
2. Remove `build.cssCodeSplit: false`; repository history already attributes it
   to the single-file build.
3. Normal HTTP loading may now fetch route and CSS chunks; `file://` is no longer
   a compatibility target. Build plus HTTP E2E is the deterministic gate.

Verify:

```sh
bun run --cwd apps/web build
CI=1 bun run test:e2e
bun run test:e2e-production
```

On a fresh environment, install Chromium first with
`bun x playwright install --with-deps chromium`. STOP if a configured E2E port
is already occupied; `CI=1` must start a fresh server rather than reuse one.

### Step 5 - Remove CI and active-documentation residue

1. Delete the `HTML export integration` and `Static HTML browser test` steps
   from `.github/workflows/pr-checks.yml`.
2. Update `README.md`, `CONTEXT.md`, `apps/web/README.md`,
   `packages/report-data/README.md`, `docs/architecture.md`,
   `docs/future-work.md`, `docs/public-package-interfaces.md`,
   `docs/skills-management-spec.md`, `docs/project-grouping-plan.md`, and
   `docs/provider-status-windows-plan.md` where they describe active HTML
   behavior or constraints.
3. Remove the already-stale claim that the web UI exports the current view as
   CSV while editing those sections. Keep CLI CSV and Cursor CSV ingestion.
4. Mark this plan in `plans/README.md` as superseding the static-export
   constraints recorded by completed plans 007 and 008. Do not rewrite those
   historical plans/logs.
5. If a dated audit document records HTML as a historical fact, leave the fact
   intact and add only a clear superseded note if readers could mistake it for
   current behavior.

Verify scripts explicitly:

```sh
bun -e '
  const root = await Bun.file("package.json").json();
  const web = await Bun.file("apps/web/package.json").json();
  for (const name of ["html", "test:html-export", "test:html-file"]) {
    if (name in root.scripts) throw new Error(`root script remains: ${name}`);
  }
  if ("test:html-file" in web.scripts) throw new Error("web HTML test remains");
'
```

Verify active-code residue:

```sh
rg -n \
  'html-payload|FocusedHtmlPayloadResult|projectFocusedHtmlPayload|getFocusedReportHtmlPayload|fetchFocusedHtmlPayload|inlineReportHTML|inlineAssetsIntoHTML|renderReportAppHTML|toExportReportPayload|downloadCompleteHtml|downloadHTML|isStaticReportRuntime|createHashHistory|__AI_USAGE_REPORT__|__AI_USAGE_REPORT_STATIC__|__AI_USAGE_REPORT_EXPORT_PAYLOAD__|AI_USAGE_REPORT_APP_DIR|RUN_HTML_EXPORT_INTEGRATION|playwright\.static' \
  apps packages package.json .github
```

Expected: no match.

Verify active documentation:

```sh
rg -n -i \
  '\bhtml\b|file://' \
  README.md CONTEXT.md apps/web/README.md packages/report-data/README.md \
  docs/architecture.md docs/future-work.md docs/public-package-interfaces.md \
  docs/skills-management-spec.md docs/project-grouping-plan.md \
  docs/provider-status-windows-plan.md
```

Expected: no match. The negative CLI tests and historical plans are excluded
intentionally.

Verify deletion explicitly:

```sh
test ! -e apps/cli/src/html.ts
test ! -e apps/cli/src/render/html.ts
test ! -e apps/cli/src/html.integration.test.ts
test ! -e apps/web/src/dashboard-export.ts
test ! -e apps/web/e2e/static-html.spec.ts
test ! -e apps/web/playwright.static.config.ts
test ! -e packages/report-core/src/html-export.ts
test ! -e packages/report-core/src/html-export.test.ts
git diff --exit-code 17bcf28 -- bun.lock
```

Expected: every command exits 0.

## Test plan

Run the final supported matrix:

```sh
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:setup-loopback
CI=1 bun run test:e2e
bun run test:e2e-production
```

Do not run `bun run test:web-production` in this plan: its known descendant leak
belongs to plan 010 and an external timeout does not reliably clean that
descendant. `test:e2e-production` supplies the HTTP hydration coverage needed
here. No dependency or lockfile change is needed for this deletion.

## Done criteria

- All target outcomes above are true.
- `--html` has an explicit negative test for report and merge.
- No active code or CI job contains an HTML export/static-report contract.
- Normal HTTP hydration, exact-revision queries, `/skills`, `/sync`, setup,
  table/JSON/CSV/payload output, snapshots, and merge bundles still pass.
- Current docs describe only supported behavior.
- No user data or ignored historical export is deleted.

## STOP conditions

- An in-scope file has drifted and the new ownership cannot be reconciled.
- An `__AI_USAGE_REPORT*` writer is found outside the mapped export path.
- The change appears to require deleting `UsageReportPayload`, snapshots, merge
  bundles, `--payload-json`, or revision publication.
- Overview, Breakdown, Support, Session, revision, fingerprint, or byte-budget
  validation weakens while removing the HTML kind.
- `/` chunking or `cssCodeSplit: false` protects a served-app contract unrelated
  to export; document that evidence and keep only the necessary constraint.
- `bun.lock` changes or a new dependency appears.
- A test proposes restoring a static global, hash router, or `file://` loader.
- The implementation attempts to delete local `ai-usage-reports/` content.

## Maintenance note

Do not add an HTML compatibility layer back through generic payload or revision
APIs. A future export format is a separate product decision with its own bounded
contract, threat model, and tests; it must not revive this static runtime by
accident.
