# Plan 087: Fix the Skills Editor Stuck on "Loading…" After Client-Side Navigation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/query/hydration-context.svelte.ts apps/web/src/lib/query/provider.svelte apps/web/src/lib/features/skills/shell/skills-shell.svelte apps/web/src/routes/+layout.svelte apps/web/src/routes/+layout.server.ts apps/web/src/routes/skills/+layout.svelte apps/web/src/routes/skills/+layout.server.ts apps/web/src/lib/features/skills/shell/data.ts apps/web/src/lib/features/skills/shell/INTEGRATION.md apps/web/src/lib/query/client.test.ts apps/web/e2e/skills.spec.ts apps/web/e2e/browser-test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S–M
- **Risk**: LOW–MED (the fix enables Skills query observers in live mode for
  the first time; see "Maintenance notes" for the one behavioural interaction
  to watch)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U01

## Why this matters

The 2026-08-23 fresh-eyes audit (Chrome headless via CDP, live dev app)
reproduced this 2/2: open `/skills/global`, click a skill, and the SKILL.md
editor shows "Loading…" for 8 s and never resolves — no console error, no
network request for the document. A full reload of `/skills/global/<skill>`
renders the editor ("Saved" pill + textarea). Skills is the one place in the
app where the reader *writes*, and the most natural path into it (browse the
tree, click) is dead. This is a P0.

The root cause is not a mount-only effect and not a stale query key. It is a
**hydration gate that compares two signatures computed from two different
states**. The root layout feeds `WebQueryProvider` a *merged* hydration state
(the quota-rail query it prefetches itself + the route's state); the Skills
layout feeds `SkillsShell` only its *own* `queryState`. In live mode the root
always contributes the quota-rail query, so the two signatures never match,
`queriesEnabled` is `false` for the whole session, and any Skills query that
the SSR document did not already put in the cache (the SKILL.md of a skill
chosen by client navigation) is never fetched. A full reload "works" only
because SSR pre-seeds the cache for that exact URL — the observers are still
disabled. The e2e suite never saw it because in `e2e` runtime mode the root
layout dehydrates nothing, so both signatures are equal (or both empty after
navigation). The design contract in ADR 0012 and
`lib/features/skills/shell/INTEGRATION.md` ("a data request returns an empty
hydration delta … mounted observers revalidate stale or missing entries")
depends on those observers being enabled. They are not.

## Current state

All paths are relative to `apps/web/` unless noted. Excerpts were read from
the worktree at `51815b70`.

**The gate and its two inputs**

- `src/lib/query/hydration-context.svelte.ts:4-22` — the context exposes one
  string and one pure function:
  ```ts
  interface WebQueryHydrationContext {
    readonly appliedSignature: string;
  }
  …
  export const webQueryHydrationSignature = (state: WebQueryHydrationState | undefined): string =>
    state?.dehydratedState.queries
      .map((query) => `${query.queryHash}:${query.state.dataUpdatedAt}`)
      .sort()
      .join('|') ?? '';
  ```
- `src/lib/query/provider.svelte:22-27` and `:37-43` — the provider computes
  `appliedHydrationSignature` from **its own** `hydrationState` prop
  (`let appliedHydrationSignature = $state(webQueryHydrationSignature(observedHydrationState));`)
  and re-hydrates + re-signs in an `$effect` when the prop object changes.
- `src/routes/+layout.svelte:12` — the provider's prop is a **merge**:
  `const hydrationState = $derived(mergeWebQueryHydrationStates(data.quotaQueryState, page.data.queryState));`
- `src/routes/+layout.server.ts:9-24` — a live **document** request prefetches
  the quota rail (`prefetchQuotaRail`) into `quotaQueryState`; a data request
  or a non-live mode returns `emptyQueryState` (line 12-14). So in live mode
  the merged state always carries `["web","finite-swr","quota","rail"]`.
- `src/routes/skills/+layout.svelte:76-85` — the shell gets only the Skills
  layout's state: `<SkillsShell … hydrationState={data.queryState} … pathname={page.url.pathname} …/>`.
- `src/routes/skills/+layout.server.ts:14-24` and `:30` —
  `const result = isDataRequest ? deferredSkillsShellRoute() : await loadSkillsShellRoute({…, pathname: url.pathname })`
  → `return { queryState: result.queryState, source: result.source };`.
  `url.pathname` is tracked, so the first client navigation under `/skills`
  re-runs this load as a data request.
- `src/lib/features/skills/shell/data.ts:25-29` — the data-request result is
  an empty delta:
  `queryState: { dehydratedState: { mutations: [], queries: [] } }, source: 'not configured'`.
- `src/lib/features/skills/shell/skills-shell.svelte:71-73`:
  ```ts
  const hydrationContext = useWebQueryHydrationContext();
  const hydrationApplied = $derived(hydrationContext.appliedSignature === webQueryHydrationSignature(hydrationState));
  const queriesEnabled = $derived(mounted && hydrationApplied && runtimeMode !== 'demo');
  ```
  Lines 74-91 create the snapshot / known-paths / inventories queries with
  `enabled: queriesEnabled…`; lines 166-172 create the document query:
  ```ts
  const managedSkillName = $derived(view?.selection.type === 'global-skill' ? view.selection.skillName : undefined);
  const managedDocumentQuery = createQuery(() =>
    managedSkillMarkdownQueryOptions(client, managedSkillName ?? '', {
      browser: mounted,
      enabled: queriesEnabled && managedSkillName !== undefined,
    }),
  );
  ```
  Line 197-199: `selectedDocument` is `managedDocumentQuery.data` for a global
  skill; line 215: `const hydrated = $derived(hydrationApplied && queryContractReady);`
  (rendered as `data-skills-hydrated` by `skills-workspace.svelte:264`).
- `src/lib/query/options/skills.ts:73-83` — `managedSkillMarkdownQueryOptions`
  sets `enabled: context.browser && context.enabled`; a disabled observer still
  *reads* cache (which is why SSR-seeded pages render) but never fetches.

**Why the symptom is "Loading…" with no self-healing**

- `src/lib/features/skills/editor/skills-editor-slot.svelte:16-19`, `:61`,
  `:67-69` — the editor's only document source is `context.document`
  (`slot.synchronizeDocument(managedDocument())` in an `$effect`); the slot is
  created with `document: untrack(managedDocument)`.
- `src/lib/features/skills/editor/controller.ts:56` —
  `loading: initialDocument === undefined`; `:77-98` —
  `acceptDocument(undefined)` publishes `loading: true, skillName: ''`;
  `:147-150` — `refresh()` returns early when `state.skillName === ''`, so
  "Reload from disk" cannot recover either.
- `src/lib/features/skills/editor/skill-markdown-editor.svelte:126-128` —
  `if (next.loading || (next.document === undefined && next.error === null)) return { … label: 'Loading…' … }`;
  `:198-199` — the textarea's accessible name is
  `` aria-label={`${editorState.skillName} SKILL.md`} ``; `:180-187` — the
  section carries `aria-busy="true"` while loading.

**Evidence captured from the live dev server on 2026-08-23 (document request
to `/skills/global`)**: the SSR payload carried `quotaQueryState` with one
dehydrated query (hash `["web","finite-swr","quota","rail"]`) and `queryState`
with three (`…"skills","snapshot"`, `…"skills","known-project-paths"`,
`…"skills","project-inventories"`); the Skills layout node was marked
`uses:{parent:1,url:1}`. The data request
`/skills/global/<skill>/__data.json?x-sveltekit-invalidated=010` returned the
Skills node with `queries:[]`, `source:"not configured"` and `uses:{parent:1}`.
Merged signature (4 entries) ≠ Skills signature (3 entries) on load; after
navigation, quota-only signature ≠ empty signature. The gate is false in both
states.

**Why existing tests do not catch it**

- `src/lib/features/skills/shell/skills-shell.hydration.fixture.svelte:21-22`
  passes the *same* object to both sides:
  `<WebQueryProvider {hydrationState}><SkillsShell {hydrationState} …/></WebQueryProvider>`.
- `src/lib/features/skills/shell/skills-workspace.ssr.test.ts` renders on the
  server only (`render(...)`, no `$effect`/`onMount`).
- `e2e/browser-test.ts:96-104` — `waitForHydratedSkills` /
  `openHydratedSkills` wait for `[data-skills-workspace][data-skills-hydrated="true"]`
  — which is reachable only in `e2e` mode (no root-level dehydrated query).
- `e2e/skills.spec.ts:274-276` and `:569-573` click the `beta-skill` link
  after a client-side navigation but assert only the heading / focus, never
  the editor textbox.
- `e2e/skills.spec.ts:42-70` is the editor assertion pattern to reuse
  (`getByRole('region', { name: 'Selected skill detail' })`,
  `getByRole('textbox', { name: 'alpha-skill SKILL.md' })`, `'Saved'`).
- `src/server/skills-e2e-fixture.server.ts:288-296` — `readE2ESkillMarkdown`
  returns `` `# ${skillName}\n\nDeterministic Playwright fixture.\n` `` for
  `alpha-skill` / `beta-skill`.
- `src/lib/query/client.test.ts:258-279` — pattern for building hydration
  states in a unit test (`createWebQueryClient()`, `setQueryData(key, data, { updatedAt })`,
  `dehydrateWebQueryClient`, `mergeWebQueryHydrationStates`).
- `src/lib/features/report/core/report-identity-context.test.ts:1-2` — proof
  that a `.svelte.ts` module importing `getContext/setContext` is importable
  from `bun test`.
- Source-text pins are an accepted repo pattern
  (`src/lib/features/report/overview/timeline-model.test.ts:213-232`).

**Contract this plan restores**: ADR 0012
(`docs/adr/0012-tanstack-query-browser-server-state-ownership.md:38-41`) and
`src/lib/features/skills/shell/INTEGRATION.md:9-11` — "A SvelteKit data
request returns an empty hydration delta. The persistent root Query client
serves fresh Skills data immediately and revalidates stale or missing entries
through the mounted observers".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format + lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| One unit file | `cd apps/web && bun test src/lib/query/hydration-context.test.ts` | all pass |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| One e2e spec | `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` | all pass |
| Full e2e | `bun run --cwd apps/web test:e2e` | all pass |
| Live dev app (final manual check) | `bun run dev` at the repo root, then open `http://127.0.0.1:5173/skills/global` | see Step 7 |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary before
running e2e (`--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify):
- `apps/web/src/lib/query/hydration-context.svelte.ts`
- `apps/web/src/lib/query/provider.svelte`
- `apps/web/src/lib/features/skills/shell/skills-shell.svelte` (one import, one `$derived`)
- `apps/web/src/lib/query/hydration-context.test.ts` (new)
- `apps/web/e2e/skills.spec.ts` (one new test, one import, one constant)
- `apps/web/src/lib/features/skills/shell/INTEGRATION.md` (one sentence)

**Out of scope** (do NOT touch):
- `apps/web/src/routes/+layout.svelte`, `+layout.server.ts`,
  `routes/skills/+layout.svelte`, `routes/skills/+layout.server.ts`,
  `lib/features/skills/shell/data.ts` — the root merge, the quota-rail
  prefetch, and the empty data-request delta are all correct and documented
  (ADR 0012). Do not "fix" this by passing the merged state into
  `SkillsShell` from the Skills layout: that duplicates the root's merge
  expression and breaks again with the next root-level query.
- The editor, slot controller, and `skill-markdown-editor.svelte` — their
  loading logic is correct; the document simply never arrives.
- The "Skills reloaded." toast, tree truncation, and other Skills surface
  items — plan 096 (U24–U26). The adopt action — plan 083.
- Quota rail presentation and the e2e quota fixture — plan 080 / 074.

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` (this
  worktree). One commit for this plan; stage by explicit path, never
  `git add -A` (peer sessions write to this repository live).
- Commit style (from `git log`): `fix(web): enable Skills queries when the root hydration state covers the route delta`
  or shorter `fix(web): unstick the Skills editor after client-side navigation`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the equality gate with a coverage predicate

Edit `apps/web/src/lib/query/hydration-context.svelte.ts`. Replace the
`appliedSignature` string contract with a `covers(state)` predicate that is
true when every query carried by `state` has been hydrated into the shared
client with the same hash and a same-or-newer `dataUpdatedAt`. An empty or
absent `state` is vacuously covered (that is exactly the data-request delta).
Delete `webQueryHydrationSignature` (after this plan it has no callers).

```ts
import { getContext, setContext } from 'svelte';
import type { WebQueryHydrationState } from './client';

interface WebQueryHydrationContext {
  /**
   * True once every query carried by `state` has been hydrated into the shared client
   * (same query hash, same-or-newer dataUpdatedAt). An empty or absent `state` is always
   * covered: a SvelteKit data request hands a route an empty hydration delta while the
   * root provider may have applied more (for example the quota rail) than the route knows.
   */
  readonly covers: (state: WebQueryHydrationState | undefined) => boolean;
}

const webQueryHydrationContextKey = Symbol('web-query-hydration');

const hydrationEntries = (state: WebQueryHydrationState | undefined): ReadonlyMap<string, number> => {
  const entries = new Map<string, number>();
  for (const query of state?.dehydratedState.queries ?? []) {
    const current = entries.get(query.queryHash);
    if (current === undefined || query.state.dataUpdatedAt > current) {
      entries.set(query.queryHash, query.state.dataUpdatedAt);
    }
  }
  return entries;
};

export const webQueryHydrationCovers = (
  applied: WebQueryHydrationState | undefined,
  expected: WebQueryHydrationState | undefined,
): boolean => {
  const appliedEntries = hydrationEntries(applied);
  for (const [queryHash, dataUpdatedAt] of hydrationEntries(expected)) {
    const appliedAt = appliedEntries.get(queryHash);
    if (appliedAt === undefined || appliedAt < dataUpdatedAt) {
      return false;
    }
  }
  return true;
};

export const installWebQueryHydrationContext = (
  readAppliedState: () => WebQueryHydrationState | undefined,
): void => {
  setContext<WebQueryHydrationContext>(webQueryHydrationContextKey, {
    covers: (state) => webQueryHydrationCovers(readAppliedState(), state),
  });
};

export const useWebQueryHydrationContext = (): WebQueryHydrationContext => {
  /* unchanged */
};
```

**Verify**: `grep -rn "appliedSignature\|webQueryHydrationSignature" apps/web/src` → only the two remaining call sites in `provider.svelte` and `skills-shell.svelte` (fixed in Steps 2–3).

### Step 2: Make the provider publish the applied state, not a string

Edit `apps/web/src/lib/query/provider.svelte`. Keep the prop API and the
`queryClient` construction exactly as they are. Replace lines 25–27 and the
`$effect` at 37–43:

```svelte
  let observedHydrationState = untrack(() => hydrationState);
  let appliedHydrationState = $state.raw(observedHydrationState);
  installWebQueryHydrationContext(() => appliedHydrationState);
  …
  $effect(() => {
    if (hydrationState && hydrationState !== observedHydrationState) {
      observedHydrationState = hydrationState;
      hydrateWebQueryClient(queryClient, hydrationState);
      appliedHydrationState = hydrationState;
    }
  });
```

and drop `webQueryHydrationSignature` from the import on line 11 (keep
`installWebQueryHydrationContext`). Use `$state.raw` — the dehydrated state is
a large plain object and must not be deep-proxied.

**Verify**: `grep -n "appliedHydrationSignature\|webQueryHydrationSignature" apps/web/src/lib/query/provider.svelte` → no matches; `grep -n "state.raw(observedHydrationState)" apps/web/src/lib/query/provider.svelte` → 1 hit.

### Step 3: Gate the Skills shell on coverage

Edit `apps/web/src/lib/features/skills/shell/skills-shell.svelte`:

- line 14: `import { useWebQueryHydrationContext } from '../../../query/hydration-context.svelte';`
- line 72: `const hydrationApplied = $derived(hydrationContext.covers(hydrationState));`

Nothing else in the file changes: `queriesEnabled` (73), the five
`createQuery` calls, `queryContractReady` (201–214) and `hydrated` (215) all
derive from `hydrationApplied` and now flip to `true` once the root provider
has applied a state that includes the route's delta — on a live document
load (merged ⊇ route state) and on every client navigation (empty delta).

**Verify**: `bun run typecheck` → exit 0; `grep -n "hydrationContext.covers(hydrationState)" apps/web/src/lib/features/skills/shell/skills-shell.svelte` → 1 hit.

### Step 4: Unit-test the predicate against the real production composition

Create `apps/web/src/lib/query/hydration-context.test.ts` (mirror
`client.test.ts:258-279` for building states). Cases, each a `test(...)`:

1. **live document load** — `quota = dehydrated([quotaRailKey(), {…}, 100])`,
   `skills = dehydrated([skillsSnapshotKey(), …, 200], [skillsKnownProjectPathsKey(), …, 200], [managedSkillMarkdownKey('alpha-skill'), …, 200])`,
   `merged = mergeWebQueryHydrationStates(quota, skills)`. Assert
   `merged.dehydratedState.queries` has length 4 (the extra root query is the
   condition that broke the old equality) and
   `webQueryHydrationCovers(merged, skills) === true`.
2. **client-side navigation** — `webQueryHydrationCovers(quota, deferredSkillsShellRoute().queryState) === true`
   and `webQueryHydrationCovers(undefined, deferredSkillsShellRoute().queryState) === true`
   (import `deferredSkillsShellRoute` from `../features/skills/shell/data`; if
   that import drags in too much for `bun test`, inline
   `{ dehydratedState: { mutations: [], queries: [] } }` and say so in the
   commit message).
3. **not yet applied** — `webQueryHydrationCovers(quota, skills) === false`
   and `webQueryHydrationCovers(undefined, skills) === false`.
4. **older copy is not coverage** — same key applied at `updatedAt: 100`,
   expected at `200` → `false`; applied at `300` → `true`.
5. **composition pin (source text)** — read the three Svelte files with
   `Bun.file(new URL(…, import.meta.url)).text()` and assert:
   - `../../routes/+layout.svelte` contains
     `mergeWebQueryHydrationStates(data.quotaQueryState, page.data.queryState)`;
   - `../../routes/skills/+layout.svelte` contains `hydrationState={data.queryState}`;
   - `../features/skills/shell/skills-shell.svelte` contains
     `hydrationContext.covers(hydrationState)` and does **not** contain
     `webQueryHydrationSignature`.
   This pins the two-sided composition that makes coverage (not equality) the
   correct gate; if a later refactor passes the merged state to the shell the
   test tells the maintainer which assumption moved.

Keys: `quotaRailKey` from `./options/quota`, the Skills keys from
`./identities/skills`. Data values can be any plain object; the predicate
reads hashes and timestamps only.

**Verify**: `cd apps/web && bun test src/lib/query/hydration-context.test.ts` → 5 tests pass.
Honesty note on what fails before the fix: cases 1–4 exercise a function that
did not exist, and the pre-fix gate was an inline expression in a component
(no DOM test runner exists in this repo — see `skills-workspace.ssr.test.ts`,
server render only), so the pre-fix behaviour is pinned by case 5 (source
text) here, by the e2e flow in Step 5, and by the live check in Step 7. Sanity:
with Steps 1–3 stashed (`git stash push -- apps/web/src/lib/query apps/web/src/lib/features/skills/shell/skills-shell.svelte`),
the file fails (import of `webQueryHydrationCovers` and case 5); `git stash pop`
→ 5 pass.

### Step 5: Add the e2e navigation regression

In `apps/web/e2e/skills.spec.ts`:

- extend the import on line 2 to `import { expect, openHydratedSkills, test, waitForHydratedSkills } from './browser-test';`
- add `const BETA_SKILL_CONTENT = '# beta-skill\n\nDeterministic Playwright fixture.\n';`
  next to `ALPHA_SKILL_CONTENT` (line 5);
- add one test (place it after the first editor test, line 70):

```ts
test('loads the SKILL.md editor after client-side navigation into and between skills', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global');
  await page.evaluate(() => document.documentElement.setAttribute('data-spa-probe', 'kept'));

  await page.getByRole('link', { exact: true, name: 'beta-skill' }).first().click();
  await expect(page).toHaveURL(BETA_SKILL_URL);
  // A full document navigation would replace <html> and drop the probe.
  await expect(page.locator('html[data-spa-probe="kept"]')).toHaveCount(1);
  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const betaEditor = detail.getByRole('textbox', { name: 'beta-skill SKILL.md' });
  await expect(betaEditor).toBeVisible();
  await expect(betaEditor).toHaveValue(BETA_SKILL_CONTENT);
  await expect(detail.getByText('Loading…', { exact: true })).toHaveCount(0);
  await expect(detail.getByText('Saved', { exact: true })).toBeVisible();
  await waitForHydratedSkills(page);

  await page.getByRole('link', { exact: true, name: 'alpha-skill' }).first().click();
  await expect(page).toHaveURL(ALPHA_SKILL_URL);
  const alphaEditor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await expect(alphaEditor).toBeVisible();
  await expect(alphaEditor).toHaveValue(ALPHA_SKILL_CONTENT);
  await expect(detail.getByText('Loading…', { exact: true })).toHaveCount(0);
  await waitForHydratedSkills(page);
});
```

Be explicit in the commit message about what this e2e proves: it pins the
client-navigation editor flow (scope → skill, skill → skill, no "Loading…",
hydration marker restored). It does **not** reproduce the live-mode signature
mismatch, because the e2e runtime dehydrates no root-level query; the unit
file in Step 4 is the assertion that fails on the defect and passes on the
fix. Do not attempt to add a root-level dehydrated query to e2e mode here
(quota fixture in the rail changes every dashboard spec and the visual
snapshots — plan 080's territory).

**Verify**: `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` → all pass, including the new test.

### Step 6: Document the gate in one sentence

In `apps/web/src/lib/features/skills/shell/INTEGRATION.md`, after line 11
("…through the mounted observers without a route-owned client."), add:

> The shell enables those observers once the root provider's applied
> hydration state *covers* the Skills route delta (every route query present
> with same-or-newer data); the root state may legitimately contain more
> (e.g. the quota rail), and a data request's delta is empty.

**Verify**: `grep -n "covers" apps/web/src/lib/features/skills/shell/INTEGRATION.md` → 1 hit.

### Step 7: Gates, then one live check

Run `bun x ultracite fix`, `bun run check`, `bun run typecheck`,
`bun run --cwd apps/web test`, `bun run --cwd apps/web test:e2e`.

Then the live check the audit performed (the e2e runtime cannot): start the
app in live mode (`bun run dev` at the repo root; requires a configured
Skills source on the machine — if the tree shows no global skills, record
that and rely on Steps 4–5), open `http://127.0.0.1:5173/skills/global`,
wait for the tree, click any global skill. Expected within ~2 s: the textarea
is present and the pill reads "Saved". In DevTools console both must be true:

```js
document.querySelector('[data-skills-workspace]')?.dataset.skillsHydrated === 'true'
document.querySelector('[data-skill-markdown-editor] textarea') !== null
```

Click a second skill and check again. Before this plan, the first expression
is `'false'` even after a full reload in live mode, and the second is `false`
after any client navigation.

**Verify**: both expressions `true` after two consecutive client-side skill
selections; no console errors.

## Test plan

- New `apps/web/src/lib/query/hydration-context.test.ts` (Step 4): four
  predicate cases built with the real `mergeWebQueryHydrationStates` /
  `dehydrateWebQueryClient` and the real route keys, plus one composition pin
  that fails on the pre-fix `skills-shell.svelte` line 72.
- New e2e case in `apps/web/e2e/skills.spec.ts` (Step 5): scope → skill and
  skill → skill client navigation renders the editor for the new skill, no
  `Loading…` text in the detail region, `data-skills-hydrated="true"` again.
- Existing `skills-workspace.ssr.test.ts` (SSR render; untouched) and every
  other `skills.spec.ts` case keep passing — they exercise the same gate in
  e2e mode where both old and new predicates are true.
- Live manual check (Step 7) recorded in the commit message or execution log.

## Done criteria

- [ ] `grep -rn "appliedSignature\|webQueryHydrationSignature" apps/web/src` → no matches
- [ ] `grep -n "hydrationContext.covers(hydrationState)" apps/web/src/lib/features/skills/shell/skills-shell.svelte` → 1 hit
- [ ] `grep -n "state.raw(observedHydrationState)" apps/web/src/lib/query/provider.svelte` → 1 hit
- [ ] `cd apps/web && bun test src/lib/query/hydration-context.test.ts` → 5 pass
- [ ] `grep -n "loads the SKILL.md editor after client-side navigation" apps/web/e2e/skills.spec.ts` → 1 hit and `cd apps/web && bun run test:e2e -- e2e/skills.spec.ts` exits 0
- [ ] `bun run typecheck` exits 0; `bun run check` exits 0
- [ ] `bun run --cwd apps/web test` exits 0
- [ ] Live check (Step 7) performed or explicitly recorded as not possible (no configured Skills source)
- [ ] `git status` shows only the six in-scope files modified/added
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts for `provider.svelte:22-43`,
  `hydration-context.svelte.ts`, `skills-shell.svelte:71-73` or
  `routes/+layout.svelte:12` do not match the working tree (another plan may
  have moved the gate).
- After Step 3, `data-skills-hydrated` still reads `"false"` in the live app
  after a full reload of `/skills/global/<skill>` (would mean a second
  gate — report `queryContractReady`'s inputs from `skills-shell.svelte:201-214`
  rather than loosening the predicate).
- Enabling the observers makes Step 7 show a visible refetch storm (network
  tab: the four Skills RPCs firing more than once per 30 s without user
  action) — report; do not change `webQueryPolicies.finiteSwr`.
- Any existing `skills.spec.ts` test starts failing on the `Skills reloaded.`
  / `Skills refreshed.` notices (`skills-health-slot.svelte:286-304`) — that
  interaction belongs to plan 096; report instead of patching the toast.
- The e2e harness cannot launch Chrome on this machine even with
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` set.

## Maintenance notes

- The gate is now "applied ⊇ route delta". If a future route needs a
  *different* provider (it must not — ADR 0012: one root client), or if the
  root layout stops merging, the composition pin in
  `hydration-context.test.ts` is the first thing to read.
- Interaction to watch: live mode now actually revalidates Skills queries on
  mount when SSR data is older than `FINITE_SWR_STALE_TIME_MS` (30 s), which
  can legitimately trigger the "Skills reloaded." notice
  (`skills-health-slot.svelte:286-304`). Plan 096 (U24) owns that notice's
  conditions; point it at this change.
- Deferred, deliberately: making the e2e runtime dehydrate one root-level
  query so Playwright exercises the live composition. Coordinate with plan
  080 (quota rail) — it is the natural candidate — and then the Step 5 e2e
  becomes the failing-before assertion too.
- Reviewer should scrutinize: that `covers` compares by `queryHash` and
  `dataUpdatedAt` exactly as `hydrate()` decides what to apply (newer wins),
  and that `$state.raw` (not `$state`) holds the applied state in the
  provider.
