import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { parseWorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody } from './rpc-test-transport';

/**
 * The Work resume surface in the e2e runtime (no demo header): the page reads `work.attention`
 * through the contract client, and the server answers the representative seeded registry
 * parsed by the collector's own normalizer and assembled by the production read model
 * (`work-attention-e2e-fixture.server.ts`), held in memory, with synthetic external facts shaped
 * as the engine's producers store them: an open pull request awaiting review, one merged after
 * the request that asked for it, a dirty shared worktree, a pull request GitHub refused to read,
 * and three Jira issues (a reply that arrived, a status that differs, a read that failed). Only
 * the SQLite round trip and the served-revision join are absent here; the production path is
 * `work-production.spec.ts`.
 *
 * Titles and questions are the generator's; ages read against the fixture's fixed clock
 * (2026-10-20T12:00Z) in UTC.
 */

const WORK_ATTENTION_PATH = '/rpc/work/attention';
/** The oRPC GET shape the browser link emits for an empty input. */
const ROUTING_CONTEXT_URL = '/rpc/workRouting/context?data=%7B%22json%22%3A%7B%7D%7D';
/** 24 seeded roots; the one older root without a pending declaration stays behind the 30-day window. */
const ROOTS_SHOWN = 23;
const HIDDEN_ROOTS = 1;
const MINIMUM_ROOTS = 20;
const NEEDS_YOU_ROOTS = 8;
const WAITING_ROOTS = 1;
const LEAD_ROOTS = 1;
const RESTING_ROOTS = ROOTS_SHOWN - NEEDS_YOU_ROOTS - WAITING_ROOTS - LEAD_ROOTS;
const RESTING_TITLE = 'Recent · no pending declaration read';
const BLOCKED_ROOT_ID = 'local_fixture-blocked-root';
const BLOCKED_TITLE = 'Fixture: investigate checkout 3';
const BLOCKED_QUESTION = 'Confirm whether the fixture should keep checkout 3 or delete it.';
const BLOCKED_CHILD_TITLES = ['Fixture: child two', 'Fixture: grandchild of checkout 3'];
const BLOCKED_DECLARED_AT = 'Oct 20, 2026, 11:00 UTC';
const DIRTY_WORKTREE_INTERPRETATION =
  '2 modified, 1 untracked observed at 2026-10-20T11:20:00.000Z on fixture/checkout-3 in checkout-3; since when is unknown; validation and delivery unobserved. Checkout shared by 4 roots.';
const STALE_TITLE = 'Fixture: stale declaration';
const COMPLETED_TITLE = 'Fixture: ship the collector';
const COMPLETED_INTERPRETATION =
  'fixture/ai-usage#118 is open and awaiting review (no review decision; checks pending) as of 2026-10-20T10:00:00.000Z.';
const MERGED_BEFORE_ROOT_ID = 'local_fixture-merged-before-root';
const MERGED_BEFORE_TITLE = 'Fixture: push the merged fix';
const MERGED_BEFORE_INTERPRETATION =
  'Possibly answered elsewhere: fixture/ai-usage#90 (MERGED, merged at 2026-10-20T10:00:00.000Z) observed on GitHub at 2026-10-20T11:00:00.000Z, after the question.';
const RECONSIDERED_UNCERTAINTY = 'This does not prove it is the same work; the question stays yours until you confirm.';
const MERGED_INTERPRETATION =
  'fixture/ai-usage#90 merged at 2026-10-20T10:00:00.000Z; merge does not prove deployment.';
const JIRA_DIFFERS_INTERPRETATION =
  'XLB-2101 is still To Do (Jira status To Do, observed 2026-10-20T11:00:00.000Z) while fixture/ai-usage#90 is MERGED (GitHub 2026-10-20T10:00:00.000Z); a different status is not automatically an error.';
const SATISFIED_TITLE = 'Fixture: collector branch awaiting a pull request';
const SATISFIED_INTERPRETATION =
  'Possibly answered elsewhere: fixture/ai-usage#117 (OPEN) listed by a child session (last active at 2026-10-20T09:00:00.000Z), after the question.';
const REVIEW_READY_ROOT_ID = 'local_fixture-review-ready-root';
const REVIEW_READY_TITLE = 'Fixture: review the store migration';
const JIRA_REPLY_INTERPRETATION =
  "1 comment arrived on XLB-2090 after this session family's last activity (2026-10-20T01:00:00.000Z); no resumption observed.";
const PROPOSAL_TITLE = 'Fixture: proposals pending';

const waitForHydratedWork = async (page: Page): Promise<void> => {
  await expect(page.locator('main[data-route-shell="work"][data-work-hydrated="true"]')).toBeVisible({
    timeout: 15_000,
  });
};
const rowNamed = (page: Page, title: string): Locator =>
  page.locator('[data-work-root]').filter({ has: page.getByText(title, { exact: true }) });
const sectionRows = (page: Page, kind: string): Locator =>
  page.getByRole('main').locator(`[data-work-section="${kind}"] [data-work-root]`);
const expectAxeClean = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};
const searchParam = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);
const openWorkRoot = async (page: Page, rootId: string): Promise<Locator> => {
  await page.goto(`/work?root=${rootId}`);
  await waitForHydratedWork(page);
  const aside = page.getByRole('main').locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toHaveAttribute('data-work-detail', rootId);
  return aside;
};

test('reads the seeded registry through work.attention and renders its roots, facts, question and detail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The collection policy revalidates on every mount, so the browser itself posts the request even
  // though the server-rendered page already carried the dataset.
  const attentionRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === WORK_ATTENTION_PATH,
  );
  await page.goto('/work');
  await waitForHydratedWork(page);
  const response = await (await attentionRequest).response();
  expect(response?.status()).toBe(200);
  const output = parseWorkAttentionOutput(decodeRpcResponseBody((await response?.text()) ?? ''));
  if (!output.ok) {
    throw new Error(`work.attention answered ${output.error.tag}: ${output.error.message}`);
  }
  expect(output.data.roots.length).toBe(ROOTS_SHOWN);
  expect(output.data.roots.length).toBeGreaterThanOrEqual(MINIMUM_ROOTS);
  expect(output.data.coverage.desktopSessions).toMatchObject({ filesParsed: 40, filesSeen: 41, unsupported: 1 });
  expect(output.data.coverage.pullRequests).toMatchObject({ disabled: false, failed: 1, observed: 3 });
  expect(output.data.coverage.checkouts).toMatchObject({ failed: 0, observed: 1 });
  expect(output.data.coverage.jira).toMatchObject({ disabled: false, failed: 1, observed: 2 });
  expect(output.data.coverage.window).toEqual({ excludedRoots: HIDDEN_ROOTS, sinceDays: 30 });

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();
  await expect(main.getByText('Declared outcomes are unavailable')).toHaveCount(0);
  const coverage = main.locator('[data-work-coverage]');
  await expect(coverage).toContainText('Desktop sessions: collected');
  await expect(coverage).toContainText('40 of 41 files parsed · 1 unsupported');
  await expect(coverage).toContainText('Pull requests: 3 observed, 1 failed 30 min ago');
  await expect(coverage).toContainText('Checkouts: 1 observed 40 min ago');
  await expect(coverage.locator('[data-work-jira-coverage]')).toContainText('Jira: 2 observed, 1 failed 30 min ago');
  await expect(coverage.locator('[data-work-window]')).toContainText(
    `${HIDDEN_ROOTS} older root without pending declarations hidden (30-day window)`,
  );
  // The e2e composition is the served read model, not the demo's synthetic dataset.
  await expect(coverage).not.toContainText('Synthetic dataset');
  await expect(
    main.getByRole('status').filter({ hasText: `${ROOTS_SHOWN} of ${ROOTS_SHOWN} roots shown` }),
  ).toBeVisible();
  for (const name of ['Needs you', 'Waiting on others', 'Leads', RESTING_TITLE]) {
    await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  await expect(main.locator('[data-work-section="human-request"] header')).toContainText(
    'A root marked “possibly answered” has a later pull request that may be the answer; it ranks last and stays yours until you confirm.',
  );
  await expect(main.locator('[data-work-section="none"] header')).toContainText(
    'Nothing pending was read here; that is not proof that nothing is pending.',
  );
  await expect(sectionRows(page, 'human-request')).toHaveCount(NEEDS_YOU_ROOTS);
  await expect(sectionRows(page, 'external-wait')).toHaveCount(WAITING_ROOTS);
  await expect(sectionRows(page, 'optional-lead')).toHaveCount(LEAD_ROOTS);
  await main
    .locator('[data-work-section="none"] button', { hasText: `Show all ${RESTING_ROOTS} in ${RESTING_TITLE}` })
    .click();
  await expect(main.locator('[data-work-root]')).toHaveCount(ROOTS_SHOWN);
  for (const title of BLOCKED_CHILD_TITLES) {
    await expect(rowNamed(page, title)).toHaveCount(0);
  }

  // A question is never demoted: the two requests a later pull request may have answered stay in
  // "Needs you", ranked last and marked; a 40-day-old question is kept past the window.
  const needsYou = sectionRows(page, 'human-request');
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 2)).toContainText(SATISFIED_TITLE);
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 2)).toContainText('possibly answered · PR #117');
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 2)).toContainText(
    'PR #117 read failed (unauthenticated) · observed 30 min ago',
  );
  await expect(needsYou.last()).toContainText(MERGED_BEFORE_TITLE);
  await expect(needsYou.last()).toContainText('possibly answered · PR #90');
  await expect(needsYou.last()).toContainText('PR #90 merged · observed 1 h ago');
  await expect(needsYou.last()).toContainText('Jira XLB-2101 · To Do · observed 1 h ago');
  await expect(main.locator('[data-work-section="human-request"]').locator(rowNamed(page, STALE_TITLE))).toHaveCount(1);
  await expect(rowNamed(page, STALE_TITLE)).toContainText('blocked · 40 d ago');
  await expect(rowNamed(page, REVIEW_READY_TITLE)).toContainText(
    'Jira XLB-2090 · In Progress · 1 new reply · newest reply 6 h ago',
  );

  // The pull request GitHub showed awaiting review waits on others; the dirty worktree marks its roots.
  const completed = rowNamed(page, COMPLETED_TITLE);
  await expect(main.locator('[data-work-section="external-wait"]').locator(completed)).toHaveCount(1);
  await expect(completed).toContainText('PR #118 checks pending · observed 2 h ago');
  const blocked = rowNamed(page, BLOCKED_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(blocked)).toHaveCount(1);
  await expect(blocked).toContainText(BLOCKED_QUESTION);
  await expect(blocked).toContainText('blocked · 1 h ago');
  await expect(blocked).toContainText('checkout dirty (2 modified) · observed 40 min ago');
  await expect(blocked).not.toContainText('auto title');
  await expect(main.locator('[data-work-section="optional-lead"]').locator(rowNamed(page, PROPOSAL_TITLE))).toHaveCount(
    1,
  );
  await expect(rowNamed(page, PROPOSAL_TITLE)).toContainText(
    'Jira XLB-1998 read failed (unauthenticated) · observed 30 min ago',
  );
  await expectAxeClean(page);

  await blocked.click();
  await expect.poll(() => searchParam(page, 'root')).toBe(BLOCKED_ROOT_ID);
  const aside = main.locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toHaveAttribute('data-work-detail', BLOCKED_ROOT_ID);
  await expect(aside.getByText('title: automatic', { exact: true })).toBeVisible();
  await expect(aside.locator('[data-work-question]')).toHaveText(BLOCKED_QUESTION);
  await expect(aside).toContainText(
    `Declared by the session at ${BLOCKED_DECLARED_AT}; its current state is unobserved.`,
  );
  await expect(aside).toContainText(DIRTY_WORKTREE_INTERPRETATION);
  await expect(aside.getByRole('heading', { level: 4, name: 'Claude Desktop metadata' })).toBeVisible();
  await expect(aside.getByRole('heading', { level: 4, name: 'Local checkout' })).toBeVisible();
  await expect(aside).toContainText('on fixture/checkout-3: dirty, 2 modified, 1 untracked, 1 ahead');
  await expect(aside).toContainText('3 child sessions · 0 blocked · 1 review ready · 2 completed');
  // This composition serves no revision, so no root joins a Session: the detail says so instead of
  // offering a transcript or a review target, and the routing simulation stays unreachable here.
  await expect(aside).toContainText('Transcript not collected yet; there is no session detail to open.');
  await expect(aside).toContainText('No collected transcript identifies a review target for this root.');
  await expect(aside.getByRole('button', { name: 'Run simulation' })).toHaveCount(0);
  await expectAxeClean(page);
});

test('names the pull requests and Jira issues that may answer, wait on or contradict a declaration', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const main = page.getByRole('main');

  // GitHub showed the merge after the request to push and merge: a possible answer, never a closure.
  const mergedBefore = await openWorkRoot(page, MERGED_BEFORE_ROOT_ID);
  await expect(mergedBefore.getByRole('heading', { level: 2, name: MERGED_BEFORE_TITLE })).toBeVisible();
  await expect(mergedBefore).toContainText('The session stopped on a question: Push the fix and merge it.');
  await expect(mergedBefore).toContainText(MERGED_BEFORE_INTERPRETATION);
  await expect(mergedBefore).toContainText(RECONSIDERED_UNCERTAINTY);
  await expect(mergedBefore).toContainText(MERGED_INTERPRETATION);
  await expect(mergedBefore).toContainText(JIRA_DIFFERS_INTERPRETATION);
  await expect(mergedBefore.getByRole('heading', { level: 4, name: 'GitHub' })).toBeVisible();
  await expect(mergedBefore.getByRole('heading', { level: 4, name: 'Jira' })).toBeVisible();
  await expect(mergedBefore).toContainText(
    'Declared PR #90 merged on fixture/ai-usage (fix/XLB-2101/earlier-merged-fix)',
  );
  await expect(mergedBefore).toContainText('PR #90 merged, checks success, approved');
  await expect(mergedBefore).toContainText('Jira XLB-2101 To Do, 0 comments');
  await expect(main.locator('[data-work-section="human-request"] [data-work-root][aria-current="true"]')).toHaveCount(
    1,
  );

  // A child declared the pull request the root asked for, after the question.
  await rowNamed(page, SATISFIED_TITLE).click();
  const aside = main.locator('[data-work-aside]');
  await expect(aside).toContainText(SATISFIED_INTERPRETATION);
  await expect(aside).toContainText(
    'GitHub rejected the read of fixture/ai-usage#117 as unauthenticated at 2026-10-20T11:30:00.000Z.',
  );
  await expect(aside).toContainText('PR #117 read failed: unauthenticated');

  // A reply arrived on the issue the review-ready branch names, after the family's last activity.
  const reviewReady = await openWorkRoot(page, REVIEW_READY_ROOT_ID);
  await expect(reviewReady).toContainText(JIRA_REPLY_INTERPRETATION);
  await expect(reviewReady).toContainText(
    'Jira XLB-2090 In Progress, 2 comments, 1 new reply since the latest activity on this key',
  );

  // The open pull request awaiting review, with GitHub's own state beside the declaration.
  await rowNamed(page, COMPLETED_TITLE).click();
  await expect(aside).toContainText(COMPLETED_INTERPRETATION);
  await expect(aside).toContainText('PR #118 open, checks pending');
  await expectAxeClean(page);
});

test('serves the e2e routing context with one declared, signed-in Claude Code route', async ({ request }) => {
  const response = await request.get(ROUTING_CONTEXT_URL);
  expect(response.status()).toBe(200);
  const context = parseWorkRoutingContext(decodeRpcResponseBody(await response.text()));
  expect(context.declarations).toHaveLength(1);
  expect(context.declarations[0]).toMatchObject({
    authorization: 'allowed',
    capabilities: ['read-only-review'],
    harness: 'claude-code',
    quality: 'review-capable',
    subscription: 'verified',
  });
  expect(context.executorObservations).toHaveLength(1);
  expect(context.executorObservations[0]).toMatchObject({ authState: 'logged-in', harness: 'claude-code' });
  expect(context.declarationErrors).toEqual([]);
});
