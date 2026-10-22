import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { parseWorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';

/**
 * The Work resume surface in the e2e runtime (no demo header): the page reads `work.attention`
 * through the contract client, and the server answers the representative seeded registry
 * parsed by the collector's own normalizer and assembled by the production read model
 * (`work-attention-e2e-fixture.server.ts`), held in memory, with synthetic external facts shaped
 * as the engine's producers store them: an open pull request awaiting review, one merged after
 * the request that asked for it, a dirty shared worktree, a pull request GitHub refused to read,
 * and three Jira issues (a reply that arrived, a status that differs, a read that failed), plus
 * three served Codex families shaped as the store read returns them (ADR 0059). Only the SQLite
 * round trip and the Desktop served-revision join are absent here; the production path is
 * `work-production.spec.ts`.
 *
 * Titles and questions are the generator's; ages read against the fixture's fixed clock
 * (2026-10-20T12:00Z) in UTC.
 */

const WORK_ATTENTION_PATH = '/rpc/work/attention';
/** The oRPC GET shape the browser link emits for an empty input. */
const ROUTING_CONTEXT_URL = '/rpc/workRouting/context?data=%7B%22json%22%3A%7B%7D%7D';
/** 30 seeded roots; the one older root without a pending declaration stays behind the 30-day window. */
const DESKTOP_ROOTS_SHOWN = 29;
/** Three served Codex families, after every Desktop root, wait unknown. */
const CODEX_ROOTS = 3;
const ROOTS_SHOWN = DESKTOP_ROOTS_SHOWN + CODEX_ROOTS;
const HIDDEN_ROOTS = 1;
const MINIMUM_ROOTS = 20;
/**
 * Five current blocks and six older declarations to reconsider: three something later may have
 * answered, three untouched for more than a week (ADR 0056 age tier). The answered and handled
 * roots rest.
 */
const NEEDS_YOU_ROOTS = 13;
const RECONSIDER_ROOTS = 7;
const WAITING_ROOTS = 1;
const LEAD_ROOTS = 2;
const RESTING_ROOTS = DESKTOP_ROOTS_SHOWN - NEEDS_YOU_ROOTS - WAITING_ROOTS - LEAD_ROOTS;
const RESTING_TITLE = 'Recent · no pending declaration read';
const CODEX_TITLE = 'Codex · no declared wait read';
const CODEX_ROOT_TITLE = 'Fixture Codex: refactor the collector';
const CODEX_WORKTREE_TITLE = 'Fixture Codex: checkout 3 follow-up';
const CODEX_ORPHAN_TITLE = 'Fixture Codex: orphaned delegate';
const CODEX_COVERAGE =
  'Codex · sessions only, no declared waits: 3 of 3 Codex campaigns shown, active in the last 30 days (served report)';
const CODEX_CHIP_PATTERN = /^Codex\s*3$/;
const BLOCKED_ROOT_ID = 'local_fixture-blocked-root';
const BLOCKED_TITLE = 'Fixture: investigate checkout 3';
const BLOCKED_QUESTION = 'Confirm whether the fixture should keep checkout 3 or delete it.';
const BLOCKED_CHILD_TITLES = ['Fixture: child two', 'Fixture: grandchild of checkout 3'];
const BLOCKED_DECLARED_AT = 'Oct 20, 2026, 11:00 UTC';
const DIRTY_WORKTREE_INTERPRETATION =
  '2 modified · 1 untracked · 1 ahead, observed at 2026-10-20T11:20:00.000Z on fixture/checkout-3 in checkout-3; since when is unknown; validation and delivery unobserved. Checkout shared by 5 roots.';
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
const CONTINUED_TITLE = 'Fixture: toolbar refresh';

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
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The page load's one read is the server-rendered one: the collection-facts policy refetches on
  // mount only a stale answer, so hydration does not post work.attention a second time.
  const browserReads: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && new URL(sent.url()).pathname === WORK_ATTENTION_PATH) {
      browserReads.push(sent.url());
    }
  });
  await page.goto('/work');
  await waitForHydratedWork(page);
  const response = await request.post(WORK_ATTENTION_PATH, {
    data: encodeRpcResponseBody({ limit: 100, machineId: null }),
    headers: { 'content-type': 'application/json' },
  });
  expect(response.status()).toBe(200);
  const output = parseWorkAttentionOutput(decodeRpcResponseBody(await response.text()));
  if (!output.ok) {
    throw new Error(`work.attention answered ${output.error.tag}: ${output.error.message}`);
  }
  expect(output.data.roots.length).toBe(ROOTS_SHOWN);
  expect(output.data.roots.length).toBeGreaterThanOrEqual(MINIMUM_ROOTS);
  expect(output.data.coverage.desktopSessions).toMatchObject({ filesParsed: 49, filesSeen: 50, unsupported: 1 });
  expect(output.data.coverage.pullRequests).toMatchObject({ disabled: false, failed: 1, observed: 4 });
  expect(output.data.coverage.checkouts).toMatchObject({ failed: 0, observed: 1 });
  expect(output.data.coverage.jira).toMatchObject({ disabled: false, failed: 1, observed: 2 });
  expect(output.data.coverage.window).toEqual({ excludedRoots: HIDDEN_ROOTS, sinceDays: 30 });

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();
  await expect(main.getByText('Declared outcomes are unavailable')).toHaveCount(0);
  const coverage = main.locator('[data-work-coverage]');
  await expect(coverage).toContainText('Claude Desktop registry · declared waits: collected');
  await expect(coverage.locator('[data-work-harness-coverage="codex"]')).toHaveText(CODEX_COVERAGE);
  await expect(coverage).toContainText('49 of 50 files parsed · 1 unsupported');
  await expect(coverage).toContainText('Pull requests: 4 observed, 1 failed 30 min ago');
  await expect(coverage).toContainText('Checkouts: 1 observed 40 min ago');
  await expect(coverage.locator('[data-work-jira-coverage]')).toContainText('Jira: 2 observed, 1 failed 30 min ago');
  await expect(coverage.locator('[data-work-window]')).toContainText(
    `${HIDDEN_ROOTS} older root without pending declarations hidden (30-day window)`,
  );
  // The e2e composition is the served read model, not the demo's synthetic dataset.
  await expect(coverage).not.toContainText('Synthetic dataset');
  await expect(main.getByRole('status').filter({ hasText: `${ROOTS_SHOWN} roots shown` })).toBeVisible();
  for (const name of ['Needs you', 'Waiting on others', 'Leads', RESTING_TITLE, CODEX_TITLE]) {
    await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  // Hydrated and rendered from the server's answer: the browser has not read the dataset again.
  expect(browserReads).toEqual([]);
  await expect(main.locator('[data-work-section="human-request"] header')).toContainText(
    'Older declarations to reconsider follow: something later may have answered them, without proof, or nothing happened in their session for over 7 days.',
  );
  await expect(main.locator('[data-work-section="none"] header')).toContainText(
    'Nothing pending was read here; that is not proof that nothing is pending.',
  );
  await expect(sectionRows(page, 'human-request')).toHaveCount(NEEDS_YOU_ROOTS);
  await expect(sectionRows(page, 'external-wait')).toHaveCount(WAITING_ROOTS);
  await expect(sectionRows(page, 'optional-lead')).toHaveCount(LEAD_ROOTS);
  await expect(sectionRows(page, 'not-observable')).toHaveCount(CODEX_ROOTS);
  await main
    .locator('[data-work-section="none"] button', { hasText: `Show all ${RESTING_ROOTS} in ${RESTING_TITLE}` })
    .click();
  await expect(main.locator('[data-work-root]')).toHaveCount(ROOTS_SHOWN);
  for (const title of BLOCKED_CHILD_TITLES) {
    await expect(rowNamed(page, title)).toHaveCount(0);
  }

  // A question is never demoted: the requests something later may have answered stay in "Needs
  // you", under their own heading after the current blocks, and so do the ones nothing touched for
  // more than a week, dated; a 40-day-old question is kept, last.
  const needsYou = sectionRows(page, 'human-request');
  await expect(main.locator('[data-work-reconsider] [data-work-root]')).toHaveCount(RECONSIDER_ROOTS);
  await expect(main.locator('[data-work-reconsider-heading]')).toHaveText(
    `Older declarations to reconsider · ${RECONSIDER_ROOTS}`,
  );
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 4)).toContainText(CONTINUED_TITLE);
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 4)).toContainText('work continued in a linked session');
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 6)).toContainText(SATISFIED_TITLE);
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 6)).toContainText('possibly answered · PR #117');
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 6)).toContainText(
    'PR #117 read failed (unauthenticated) · observed 30 min ago',
  );
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 5)).toContainText(MERGED_BEFORE_TITLE);
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 5)).toContainText('possibly answered · PR #90');
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 5)).toContainText('PR #90 merged · observed 1 h ago');
  await expect(needsYou.nth(NEEDS_YOU_ROOTS - 5)).toContainText('Jira XLB-2101 · To Do · observed 1 h ago');
  await expect(main.locator('[data-work-reconsider]').locator(rowNamed(page, STALE_TITLE))).toHaveCount(1);
  await expect(needsYou.last()).toContainText(STALE_TITLE);
  await expect(rowNamed(page, STALE_TITLE)).toContainText('blocked · 40 d ago, no activity since');
  await expect(rowNamed(page, STALE_TITLE)).toContainText(
    'Next: Nothing happened in it for over 7 days; answer or archive the session in Claude Desktop to settle it.',
  );
  await expect(rowNamed(page, STALE_TITLE)).not.toContainText('possibly answered');
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
  await expect(blocked).toContainText('checkout 2 modified · 1 untracked · 1 ahead · observed 40 min ago');
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
  await expect(aside).toContainText('on fixture/checkout-3: 2 modified · 1 untracked · 1 ahead');
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

const CAPTURES_DIRECTORY_ENV = 'AI_USAGE_WORK_CAPTURES_DIR';
/** Screenshots are a review artefact, written only where the operator asks; the assertions never read them. */
const capture = async (page: Page, name: string, fullPage = true): Promise<void> => {
  const directory = process.env[CAPTURES_DIRECTORY_ENV];
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  await page.screenshot({ fullPage, path: path.join(directory, name) });
};

const ANSWERED_ROOT_ID = 'local_fixture-answered-root';
const ANSWERED_TITLE = 'Fixture: settle the layout';
const ANSWERED_CURRENT_QUESTION = 'Delete the superseded layout branch now?';
const ANSWERED_EARLIER_INTERPRETATION =
  'Declaration replaced: the question “Keep the compact layout or the airy one?” (asked 2026-10-20T07:00:00.000Z) was replaced by the session’s declaration at 2026-10-20T09:00:00.000Z.';
const REPLIED_TITLE = 'Fixture: export column wording';
const UNRELATED_TITLE = 'Fixture: settings panel naming';
const OFFERS_TITLE = 'Fixture: follow-ups after the import';
const HANDLED_ROOT_ID = 'local_fixture-handled-root';
const HANDLED_TITLE = 'Fixture: release checklist';
const OLD_SUBJECT_QUERY = 'routine session 11';

test('reads what Claude Desktop recorded after a request: answered, handled, to reconsider, superseded offers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  // Per harness, what was read: declared waits from the Desktop registry only (ADR 0059).
  await expect(main.locator('[data-work-coverage] [data-work-harness-coverage="claude-desktop"]')).toContainText(
    'Claude Desktop registry · declared waits: collected',
  );
  await expect(main.locator('[data-work-coverage] [data-work-harness-coverage="codex"]')).toHaveText(CODEX_COVERAGE);
  await expect(main.locator('[data-work-coverage] [data-work-harness-coverage="other"]')).toHaveText(
    'Other harnesses: not read here',
  );

  // Q1 was answered in the harness, then Q2 was asked: Q2 is the current request, Q1 the last decision.
  const answered = rowNamed(page, ANSWERED_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(answered)).toHaveCount(1);
  await expect(answered).toHaveAttribute('data-work-standing', 'current');
  await expect(answered).toContainText(ANSWERED_CURRENT_QUESTION);
  await expect(answered.locator('[data-work-decision]')).toHaveCount(0);
  await expect(answered.locator('[data-work-observed-activity]')).toContainText(ANSWERED_EARLIER_INTERPRETATION);
  await expect(answered.locator('[data-work-next]')).toHaveText('Next: Answer in Claude Desktop.');

  // An unrelated pull request merged after the question changes nothing: a current block.
  const unrelated = rowNamed(page, UNRELATED_TITLE);
  await expect(unrelated).toHaveAttribute('data-work-standing', 'current');
  await expect(unrelated).toContainText('PR #131 merged · observed 1 h ago');
  await expect(main.locator('[data-work-reconsider]').locator(unrelated)).toHaveCount(0);

  // A dated message and a completed linked session do not establish an answer.
  const replied = rowNamed(page, REPLIED_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(replied)).toHaveCount(1);
  await expect(replied).toHaveAttribute('data-work-standing', 'current');
  await expect(replied.locator('[data-work-decision]')).toHaveCount(0);
  await expect(replied.locator('[data-work-observed-activity]')).toContainText('2026-10-20T11:00:00.000Z');
  const handled = rowNamed(page, HANDLED_TITLE);
  await expect(main.locator('[data-work-reconsider]').locator(handled)).toHaveCount(1);
  await expect(handled.locator('[data-work-standing-marker]')).toHaveText('Older declaration to reconsider');
  await expect(handled.locator('[data-work-decision]')).toHaveCount(0);

  // The offer made before a later message and the expired offer are not pending; the last one is.
  const offers = rowNamed(page, OFFERS_TITLE);
  await expect(main.locator('[data-work-section="optional-lead"]').locator(offers)).toHaveCount(1);
  await expect(offers).toContainText('proposals 2 open / 0 resolved / 1 no longer pending');
  await capture(page, 'work-e2e-1440-arrival.png');
  await expectAxeClean(page);

  // The detail reads request, context, last decision and next action before the diagnostics.
  const aside = await openWorkRoot(page, ANSWERED_ROOT_ID);
  await expect(aside.locator('[data-work-request]')).toHaveAttribute('data-work-request', 'current');
  await expect(aside.locator('[data-work-question]')).toHaveText(ANSWERED_CURRENT_QUESTION);
  await expect(aside.locator('[data-work-decision]')).toHaveCount(0);
  await expect(aside).toContainText(ANSWERED_EARLIER_INTERPRETATION);
  await expect(aside).toContainText('Earlier declaration, blocked: Keep the compact layout or the airy one?');
  const order = await aside.evaluate((element) =>
    [
      '[data-work-question]',
      '[data-work-context]',
      '[data-work-observed-activity]',
      '[data-work-next]',
      '#work-detail-facts',
    ].map((selector) => element.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN),
  );
  expect(order.every((top) => Number.isFinite(top))).toBe(true);
  expect([...order].sort((left, right) => left - right)).toEqual(order);
  await capture(page, 'work-e2e-1440-detail-answered.png');
  const handledDetail = await openWorkRoot(page, HANDLED_ROOT_ID);
  await expect(handledDetail.locator('[data-work-request]')).toHaveAttribute('data-work-request', 'reconsider');
  await expect(handledDetail).toContainText(
    'Older declaration to reconsider: work continued after the question in “Fixture: fix the flaky export test”',
  );
  await expect(handledDetail).toContainText('Linked session declared completed: Finished the requested change.');
  await expectAxeClean(page);
});

test('shows Codex sessions apart: wait unknown, never folded under a Desktop root, never a request (ADR 0059)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  const section = main.locator('[data-work-section="not-observable"]');
  await expect(section.getByRole('heading', { level: 2, name: CODEX_TITLE, exact: true })).toBeVisible();
  await expect(section.locator('header')).toContainText(
    'Whether one waits on you is unknown — not declared by this harness, which is not the same as nothing pending.',
  );
  await expect(section.locator('header')).not.toContainText('Declared by the session; current state unobserved.');
  // Most recently active first; every row says its wait is unknown, in words.
  await expect(sectionRows(page, 'not-observable')).toHaveCount(CODEX_ROOTS);
  await expect(sectionRows(page, 'not-observable').nth(0)).toContainText(CODEX_WORKTREE_TITLE);
  await expect(sectionRows(page, 'not-observable').nth(1)).toContainText(CODEX_ROOT_TITLE);
  await expect(sectionRows(page, 'not-observable').nth(2)).toContainText(CODEX_ORPHAN_TITLE);
  for (const index of [0, 1, 2]) {
    const row = sectionRows(page, 'not-observable').nth(index);
    await expect(row).toHaveAttribute('data-work-standing', 'not-declared');
    await expect(row.locator('[data-work-not-declared]')).toHaveText('wait not declared');
    await expect(row).toContainText('wait unknown · not declared by Codex');
  }
  // The dirty shared worktree is a fact on the Codex row too; it does not make it a request.
  const worktree = rowNamed(page, CODEX_WORKTREE_TITLE);
  // Codex records the directory alone: the row is labelled by it, no origin checkout is inferred.
  await expect(worktree).toContainText('checkout-3 · fixture/checkout-3');
  await expect(worktree).toContainText('checkout 2 modified · 1 untracked · 1 ahead · observed 40 min ago');
  await expect(main.locator('[data-work-section="human-request"]').locator(worktree)).toHaveCount(0);
  await expect(rowNamed(page, CODEX_ROOT_TITLE)).toContainText('children 2');
  await capture(page, 'work-e2e-1440-codex-section.png');
  await expectAxeClean(page);

  // The harness filter narrows to Codex alone and says what it searched.
  await main.locator('[data-work-filters]').getByRole('button', { name: CODEX_CHIP_PATTERN }).click();
  await expect.poll(() => searchParam(page, 'harness')).toBe('codex');
  await expect(main.locator('[data-work-root]')).toHaveCount(CODEX_ROOTS);
  await expect(main.locator('[data-work-search-coverage]')).toContainText(
    `${CODEX_ROOTS} of ${ROOTS_SHOWN} roots match,`,
  );

  // The detail: unknown standing, the children Codex linked, the gap of a parent never collected.
  await rowNamed(page, CODEX_ROOT_TITLE).click();
  const aside = main.locator('[data-work-aside]');
  await expect(aside.locator('[data-work-request]')).toHaveAttribute('data-work-request', 'not-declared');
  await expect(aside).toContainText('Request · Unknown — not declared by this harness');
  await expect(aside.locator('[data-work-not-declared-detail]')).toContainText(
    'Codex records no turn declaration for its sessions: whether this one waits on you is unknown — not declared by this harness.',
  );
  await expect(aside).toContainText(
    '2 child sessions · linked by their declared parent in Codex; their outcomes are not declared',
  );
  await expect(aside).not.toContainText('0 blocked · 0 review ready');
  await expect(aside.locator('[data-work-next]')).toHaveText(
    'Next: Check the session in Codex; this view cannot tell whether it waits on you.',
  );
  await expect(aside.getByRole('link', { name: 'Open session detail' })).toBeVisible();
  await capture(page, 'work-e2e-1440-codex-detail.png');
  await expectAxeClean(page);
  await rowNamed(page, CODEX_ORPHAN_TITLE).click();
  await expect(aside).toContainText(
    'Started from a Codex session that is not in the served report; it stands as its own root.',
  );
});

test('a search covers the ranking and says what it did not search; earlier questions are searchable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  const status = main.locator('[data-work-search-coverage]');
  await expect(status).toHaveText(`${ROOTS_SHOWN} roots shown · ${HIDDEN_ROOTS} older root hidden (30-day window).`);

  // The old subject sits behind the window: the empty result is a statement about the ranking.
  await page.getByRole('searchbox').fill(OLD_SUBJECT_QUERY);
  await expect.poll(() => searchParam(page, 'q')).toBe(OLD_SUBJECT_QUERY);
  await expect(status).toHaveText(
    `0 of ${ROOTS_SHOWN} roots match, searched among the ${ROOTS_SHOWN} shown · not searched: ${HIDDEN_ROOTS} older root hidden (30-day window).`,
  );
  await expect(
    main.getByText('No root in this ranking matches these filters; what was not searched is listed above.'),
  ).toBeVisible();
  await capture(page, 'work-e2e-1440-search-old-subject.png', false);

  // A question answered in the harness is still found by its own words, and the address keeps it.
  await page.getByRole('searchbox').fill('compact layout');
  await expect(status).toContainText(`1 of ${ROOTS_SHOWN} roots match,`);
  await expect(rowNamed(page, ANSWERED_TITLE)).toHaveCount(1);

  // Keyboard: from the last current block, ArrowDown continues into the roots to reconsider.
  await page.getByRole('searchbox').fill('');
  await expect(status).toContainText(`${ROOTS_SHOWN} roots shown`);
  const current = main.locator('[data-work-section="human-request"] [data-work-standing="current"]');
  await current.last().focus();
  await page.keyboard.press('ArrowDown');
  await expect(main.locator('[data-work-reconsider] [data-work-root]').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => searchParam(page, 'root')).not.toBeNull();
  await expect(main.locator('[data-work-aside] [data-work-request]')).toHaveAttribute(
    'data-work-request',
    'reconsider',
  );
  await capture(page, 'work-e2e-1440-detail-reconsider.png');
});
