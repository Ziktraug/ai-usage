import {
  parseWorkThreadsCommandOutput,
  parseWorkThreadsDetailOutput,
  type WorkThreadsCommandInput,
} from '@ai-usage/web-contract/work-threads';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';

// These are the process fixture's stable seeds. Mutating journeys create their own tasks through
// the real command endpoint; browser gestures then change the same server state across tabs.
const ids = {
  payments: '12000000-0000-4000-8000-000000000001',
  analysis: '12000000-0000-4000-8000-000000000004',
  review: '12000000-0000-4000-8000-000000000006',
  longTitle: '12000000-0000-4000-8000-000000000009',
  mergedPr: '12000000-0000-4000-8000-000000000010',
  unknownDuration: '12000000-0000-4000-8000-000000000011',
};
const DONE_TAB = /^Done /;
const FOLLOWING_TAB = /^Following /;
const TIMED_SESSION_MARK = /^\d{2}:\d{2} · Claude · Compare retry approaches$/;
const commandPath = '/rpc/workThreads/command';
const detailPath = '/rpc/workThreads/detail';
const prKey = 'github.example/synthetic/example-shop#1487';

const command = async (request: APIRequestContext, input: WorkThreadsCommandInput) => {
  const response = await request.post(commandPath, {
    data: encodeRpcResponseBody(input),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  });
  expect(response.status()).toBe(200);
  return parseWorkThreadsCommandOutput(decodeRpcResponseBody(await response.text()));
};
const detail = async (request: APIRequestContext, threadId: string) => {
  const response = await request.post(detailPath, {
    data: encodeRpcResponseBody({ threadId }),
    headers: { 'content-type': 'application/json' },
  });
  expect(response.status()).toBe(200);
  const output = parseWorkThreadsDetailOutput(decodeRpcResponseBody(await response.text()));
  if (!output.ok) {
    throw new Error(`${output.error.tag}: ${output.error.message}`);
  }
  return output.data;
};
const createTask = async (
  request: APIRequestContext,
  overrides: Partial<Extract<WorkThreadsCommandInput, { readonly op: 'create' }>> = {},
) => {
  const input: Extract<WorkThreadsCommandInput, { readonly op: 'create' }> = {
    commandId: crypto.randomUUID(),
    intent: 'analysis',
    links: [],
    objective: 'Synthetic browser journey; analysis can be enough.',
    op: 'create',
    projectLabel: 'Example shop',
    title: `Browser analysis ${crypto.randomUUID().slice(0, 8)}`,
    ...overrides,
  };
  const created = await command(request, input);
  if (!created.ok) {
    throw new Error(created.message);
  }
  return { threadId: created.threadId, title: input.title };
};
const hydrated = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-work-threads][data-work-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
};
const open = async (page: Page, threadId?: string): Promise<void> => {
  await page.goto(threadId ? `/work?task=${threadId}` : '/work');
  await hydrated(page);
};
const endFollowUp = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'End follow-up', exact: true }).first().click();
};
const row = (page: Page, threadId: string) => page.locator(`[data-work-thread="${threadId}"]`);
const assertAxe = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};

test('analysis-only task ends, appears in Done, and reopens without changing source facts', async ({
  page,
  request,
}) => {
  const task = await createTask(request);
  await open(page, task.threadId);
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  await expect(page.getByText('Analysis only · no branch, PR or ticket needed', { exact: true })).toBeVisible();
  await endFollowUp(page);
  await expect(
    page.getByText('No GitHub, Jira or session state was changed by ending it.', { exact: true }),
  ).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread.followState).toBe('done');
  await page.getByRole('link', { name: '← My work', exact: true }).click();
  await page.getByRole('tab', { name: DONE_TAB }).click();
  await expect(page.getByRole('tab', { name: DONE_TAB })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill(task.title);
  await expect(row(page, task.threadId)).toBeVisible();
  await row(page, task.threadId)
    .getByRole('link', { name: new RegExp(task.title) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Reopen', exact: true }).first().click();
  await expect(page.locator('[data-follow-state="following"]')).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread).toMatchObject({
    doneAt: null,
    followRevision: 3,
    followState: 'following',
  });
});

test('My work keeps delegation results and human acceptance reachable through session intake', async ({ page }) => {
  const finishedJob = '11111111-1111-4111-8111-111111111111';
  let acceptance: unknown = null;
  // The fixture runtime has no engine writer. Exercise the browser command contract explicitly;
  // engine persistence and operator attribution are covered by the delegation integration tests.
  await page.route('**/rpc/delegation/recordAcceptance', async (route) => {
    acceptance = decodeRpcResponseBody(route.request().postData() ?? '{}');
    await route.fulfill({
      contentType: 'application/json',
      body: encodeRpcResponseBody({ evaluationId: '55555555-5555-4555-8555-555555555555' }),
    });
  });
  await open(page);
  await expect(page.locator('[data-work-thread]')).not.toHaveCount(0);
  await expect(page.locator('[data-work-delegations]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Delegation results ↗', exact: true }).click();
  await expect(page).toHaveURL('/work/sessions#work-delegations-heading');
  const result = page.locator(`[data-work-delegation="${finishedJob}"]`);
  await expect(result).toBeVisible();
  await expect(result.locator('[data-work-delegation-frozen-scope]')).toContainText('Frozen scope');
  await result.getByLabel('Note (optional)', { exact: true }).fill('Reviewed by the operator');
  await result.locator('[data-work-delegation-verdict="accepted"]').click();
  await expect(result.getByRole('status')).toContainText('Recorded as accepted by you');
  expect(acceptance).toEqual({ jobId: finishedJob, note: 'Reviewed by the operator', verdict: 'accepted' });
  await page.goto('/work');
  await hydrated(page);
  await expect(page.locator('[data-work-delegations]')).toHaveCount(0);
});

test('ending despite remainders records the decision and Undo restores follow-up only', async ({ page, request }) => {
  const task = await createTask(request, { intent: 'change', links: [{ key: prKey, kind: 'pull-request' }] });
  const before = await detail(request, task.threadId);
  await open(page, task.threadId);
  await endFollowUp(page);
  const remaining = page.getByRole('region', { name: "What's left", exact: true });
  await expect(remaining.getByRole('heading', { name: 'These remainders will stay' })).toBeVisible();
  await expect(remaining).toContainText('2 review threads to address');
  await remaining.getByLabel('Reason (optional)').fill('Another person owns the remaining review');
  await remaining.getByRole('button', { name: 'End anyway', exact: true }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Follow-up ended' });
  await expect(toast).toBeVisible();
  const ended = await detail(request, task.threadId);
  expect(ended.row.thread).toMatchObject({
    followState: 'done',
    doneReason: 'Another person owns the remaining review',
  });
  const event = ended.events.at(-1);
  expect(event?.kind).toBe('follow-state');
  expect(event?.acknowledgedRemainders.some((value) => value.includes('2 review threads to address'))).toBe(true);
  expect(ended.row.markers).toEqual(before.row.markers);
  expect(ended.episodes).toEqual(before.episodes);
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-follow-state="following"]')).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread.followRevision).toBe(3);
});

test('Undo after ending a waiting task restores its exact wait through two recorded transitions', async ({
  page,
  request,
}) => {
  const task = await createTask(request, { links: [{ key: prKey, kind: 'pull-request' }] });
  await open(page, task.threadId);
  await page.getByRole('button', { name: 'Mark as waiting', exact: true }).click();
  await page.getByLabel('Waiting for', { exact: true }).fill('Human PR review');
  await page.getByRole('combobox', { name: 'Linked PR review (optional)', exact: true }).selectOption(prKey);
  await page.getByRole('button', { name: 'Wait', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Marked as waiting' })).toBeVisible();
  const waiting = (await detail(request, task.threadId)).row.thread;
  await endFollowUp(page);
  await page.getByRole('button', { name: 'End anyway', exact: true }).click();
  const endedToast = page.getByRole('status').filter({ hasText: 'Follow-up ended' });
  await expect(endedToast).toBeVisible();
  const ended = (await detail(request, task.threadId)).row.thread;
  await endedToast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Follow-up restored' })).toBeVisible();
  await expect(page.locator('[data-follow-state="waiting"]')).toBeVisible();
  const restored = await detail(request, task.threadId);
  expect(restored.row.thread).toMatchObject({
    followState: 'waiting',
    followRevision: ended.followRevision + 2,
    waitingFor: waiting.waitingFor,
    waitingOn: waiting.waitingOn,
  });
  expect(
    restored.events
      .filter((event) => event.kind === 'follow-state')
      .slice(-2)
      .map((event) => event.toState),
  ).toEqual(['following', 'waiting']);
});

test('a waiting task can Resume following and Undo restores its wait expectation', async ({ page, request }) => {
  const task = await createTask(request, { links: [{ key: prKey, kind: 'pull-request' }] });
  await open(page, task.threadId);
  await page.getByRole('button', { name: 'Mark as waiting', exact: true }).click();
  await page.getByLabel('Waiting for', { exact: true }).fill('The requested review');
  await page.getByRole('combobox', { name: 'Linked PR review (optional)', exact: true }).selectOption(prKey);
  await page.getByRole('button', { name: 'Wait', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Marked as waiting' })).toBeVisible();
  const waiting = (await detail(request, task.threadId)).row.thread;
  await expect(page.getByRole('button', { name: 'End follow-up', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Resume following', exact: true }).click();
  const resumedToast = page.getByRole('status').filter({ hasText: 'Following resumed' });
  await expect(resumedToast).toBeVisible();
  await expect(page.locator('[data-follow-state="following"]')).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread).toMatchObject({
    followState: 'following',
    followRevision: waiting.followRevision + 1,
    waitingFor: null,
    waitingOn: null,
  });
  await resumedToast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Follow-up restored' })).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread).toMatchObject({
    followState: 'waiting',
    followRevision: waiting.followRevision + 2,
    waitingFor: waiting.waitingFor,
    waitingOn: waiting.waitingOn,
  });
});

test('Undo of Reopen restores the original closure reason and acknowledgements after a later note', async ({
  page,
  request,
}) => {
  const task = await createTask(request, { intent: 'change', links: [{ key: prKey, kind: 'pull-request' }] });
  await open(page, task.threadId);
  await endFollowUp(page);
  const reason = 'Payments team owns the remaining review';
  await page.getByLabel('Reason (optional)').fill(reason);
  await page.getByRole('button', { name: 'End anyway', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Follow-up ended' })).toBeVisible();
  const ended = await detail(request, task.threadId);
  const closure = ended.events.findLast((event) => event.kind === 'follow-state' && event.toState === 'done');
  expect(closure?.acknowledgedRemainders.length).toBeGreaterThan(0);
  await page.locator('summary').filter({ hasText: 'Resume note, if needed' }).click();
  await page.getByLabel('Resume note', { exact: true }).fill('Contact the payments team for any new evidence.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Resume note saved' })).toBeVisible();
  expect((await detail(request, task.threadId)).events.at(-1)?.kind).toBe('note');
  await page.getByRole('button', { name: 'Reopen', exact: true }).first().click();
  const reopenedToast = page.getByRole('status').filter({ hasText: 'Follow-up reopened' });
  await expect(reopenedToast).toBeVisible();
  await reopenedToast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Follow-up restored' })).toBeVisible();
  const restored = await detail(request, task.threadId);
  expect(restored.row.thread).toMatchObject({
    followState: 'done',
    doneReason: reason,
    followRevision: ended.row.thread.followRevision + 2,
  });
  expect(
    restored.events.findLast((event) => event.kind === 'follow-state' && event.toState === 'done')
      ?.acknowledgedRemainders,
  ).toEqual(closure?.acknowledgedRemainders);
});

test('a task exists for a PR with zero sessions and keeps a dated GitHub marker', async ({ page }) => {
  await open(page);
  await expect(row(page, ids.review)).toContainText('PR #1492 · 0 linked sessions');
  await row(page, ids.review).getByRole('link', { name: 'Check cart rounding' }).first().click();
  await expect(page.getByText('0 linked sessions · one task', { exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'GITHUB' }).click();
  await expect(page.getByRole('link', { name: 'Open PR #1492 on GitHub ↗', exact: true })).toHaveAttribute(
    'href',
    'https://github.example/synthetic/example-shop/pull/1492',
  );
  await expect(page.getByText('An agent review is not a human approval.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(
    page.getByText('No linked sessions. A task can exist without a local session.', { exact: true }),
  ).toBeVisible();
});

test('source availability stays on one quiet line until its details are opened with the keyboard', async ({ page }) => {
  await open(page);
  const availability = page.locator('details[aria-label="Source availability"]');
  const summary = availability.locator('summary');
  await expect(summary).toContainText('Jira disabled');
  await expect(availability).not.toHaveAttribute('open');
  const diagnostics = availability.getByText('Unavailable or older evidence does not establish that nothing is left.', {
    exact: true,
  });
  await expect(diagnostics).not.toBeVisible();
  const bounds = await summary.boundingBox();
  expect(bounds?.height).toBeLessThanOrEqual(28);
  const filterBounds = await page.getByRole('combobox', { name: 'Project', exact: true }).boundingBox();
  expect(bounds?.y).toBeGreaterThan(filterBounds?.y ?? 0);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(diagnostics).toBeVisible();
  await expect(availability).toContainText('Jira collection is disabled');
  await page.keyboard.press('Enter');
  await expect(diagnostics).not.toBeVisible();
});

test('task availability only names linked sources while My work retains global availability', async ({ page }) => {
  await open(page, ids.review);
  await expect(page.getByRole('heading', { name: 'Check cart rounding', exact: true })).toBeVisible();
  await expect(page.locator('details[aria-label="Source availability"]')).toHaveCount(0);
  await page.getByRole('link', { name: '← My work', exact: true }).click();
  await expect(page.locator('details[aria-label="Source availability"] summary')).toContainText('Jira disabled');
  await row(page, ids.payments).getByRole('link', { name: 'Prevent duplicate payments', exact: true }).click();
  const availability = page.locator('details[aria-label="Source availability"]');
  await expect(availability.locator('summary')).toContainText('Jira disabled');
  await availability.locator('summary').click();
  await expect(availability).toContainText('Jira collection is disabled');
  await open(page, ids.analysis);
  await expect(page.locator('details[aria-label="Source availability"]')).toHaveCount(0);
});

test('a long desktop task heading keeps its full title in about two lines at a smaller display size', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, ids.payments);
  const normalSize = await page
    .locator('.wt-task-head h1')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const longTitle = (await detail(request, ids.longTitle)).row.thread.title;
  await open(page, ids.longTitle);
  const heading = page.getByRole('heading', { level: 1, name: longTitle, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute('data-title-length', 'long');
  const layout = await heading.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      lines: element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight),
      fits: element.scrollHeight <= element.clientHeight + 1,
      clamp: style.webkitLineClamp,
    };
  });
  expect(layout.fontSize).toBeLessThan(normalSize);
  expect(layout.lines).toBeLessThanOrEqual(2.2);
  expect(layout.fits).toBe(true);
  expect(['none', ''].includes(layout.clamp)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a mixed day shows both chips and lists dated marks before opening the task', async ({ page }) => {
  await open(page);
  const task = row(page, ids.payments);
  const day = task.locator('.wt-day-button:has(.wt-event-mark):has([data-harness])').first();
  await expect(day.locator('[data-harness="claude"]')).toHaveText('Cl');
  await expect(day.locator('.wt-event-mark')).toBeVisible();
  await day.focus();
  await page.keyboard.press('Enter');
  await expect(day).toHaveAttribute('aria-expanded', 'true');
  const marks = task.getByRole('region', { name: 'Activity on 2026-10-19', exact: true });
  await expect(marks.getByText(TIMED_SESSION_MARK)).toBeVisible();
  await expect(marks).toContainText('PR #1487 opened');
  await marks.getByRole('button', { name: 'Close day activity', exact: true }).click();
  await expect(day).toBeFocused();
  await day.click();
  await marks.getByRole('link', { name: 'Open task for this day →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prevent duplicate payments', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('day')).toBe('2026-10-19');
});

test('episode durations and PR fact events use their own evidence dates', async ({ page }) => {
  await open(page, ids.payments);
  const episode = page.locator('[data-session-key="session:fixture-machine/claude/payment-approaches"]');
  await expect(episode.locator('.wt-duration')).toContainText('14 min');
  await expect(episode).toContainText('over 3 days');
  await episode.getByRole('button', { name: 'Compare retry approaches' }).click();
  await expect(episode).toContainText("14 min recorded for this episode · not the task's lifetime");
  await expect(episode).toContainText('first to last activity, pauses included');
  await expect(page.locator('.wt-reason h2')).toHaveText('2 review threads to address');
  await open(page, ids.unknownDuration);
  await expect(page.locator('.wt-duration')).toHaveText('Duration not recorded: —');
  await open(page, ids.mergedPr);
  await expect(page.locator('.wt-id')).toContainText('Since Oct 20');
  await expect(page.locator('.wt-fact-event strong')).toHaveText(['PR #1502 opened', 'PR #1502 merged']);
  await expect(page.locator('.wt-fact-event .wt-event-source')).toHaveText(['GitHub', 'GitHub']);
  await expect(page.getByText('Task created', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Source linked', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.locator('.wt-fact-event')).toHaveCount(0);
});

test('delegation groups reveal five children at a time without losing keyboard focus', async ({ page }) => {
  await open(page, ids.longTitle);
  const parent = page.locator('[data-session-key="session:fixture-machine/claude/ownership-design"]');
  const children = parent.locator(':scope > .wt-children > .wt-episode');
  const toggle = parent.locator(':scope > .wt-delegations');
  const all = page.getByRole('checkbox', { name: 'Expand all delegations', exact: true });
  const handoff = page.locator('[data-session-key="session:fixture-machine/claude/ownership-check"]');
  const handoffChildren = handoff.locator(':scope > .wt-children > .wt-episode');
  await expect(all).not.toBeChecked();
  await expect(children).toHaveCount(0);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(children).toHaveCount(5);
  await expect(children.last()).toContainText('Review ownership scenario 5');
  const more = parent.getByRole('button', { name: 'Show 12 more delegated sessions', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(children).toHaveCount(17);
  const fewer = parent.getByRole('button', { name: 'Show fewer delegated sessions', exact: true });
  await expect(fewer).toBeFocused();
  await expect(fewer).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(children).toHaveCount(5);
  await expect(more).toBeFocused();
  await toggle.click();
  await expect(children).toHaveCount(0);

  await all.check();
  await expect(children).toHaveCount(5);
  await expect(handoffChildren).toHaveCount(1);
  await expect(more).toBeVisible();
  await all.uncheck();
  await expect(children).toHaveCount(0);
  await expect(handoffChildren).toHaveCount(0);
});

test('overnight episodes name the next day in both the row and the inspector', async ({ page }) => {
  await open(page, ids.longTitle);
  const episode = page.locator('[data-session-key="session:fixture-machine/claude/ownership-check"]');
  await expect(episode.locator(':scope > .wt-session-button')).toContainText('22:06–02:19 +1d');
  await episode.locator(':scope > .wt-session-button').click();
  const range = episode.locator('.wt-inspector .wt-context > div').filter({ hasText: 'Activity range' });
  await expect(range.locator('dd')).toHaveText('22:06–02:19 +1d');
  await expect(episode).toContainText('first to last activity, pauses included');
});

test('ready-to-merge tasks show the merge-state evidence on the GitHub summary', async ({ page }) => {
  await open(page, ids.longTitle);
  await expect(page.locator('.wt-reason h2')).toHaveText('Ready to merge');
  const github = page.locator('summary').filter({ hasText: 'GITHUB' });
  await expect(github).toContainText('Mergeable');
  await expect(github).toContainText('Checks success');
  await expect(github).toContainText('0 review threads open');
});

test('links a recent served session of the project, detaches it, and can undo the detach', async ({
  page,
  request,
}) => {
  const task = await createTask(request, { projectLabel: 'ai-usage' });
  await open(page, task.threadId);
  await page.getByRole('button', { name: 'Link an earlier session', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Link an earlier session', exact: true });
  await expect(picker.getByRole('heading', { name: 'Recent sessions · ai-usage', exact: true })).toBeVisible();
  await picker.getByRole('button', { name: 'Link Build report UI', exact: true }).click();
  await expect(page.getByText('1 linked session · one task', { exact: true })).toBeVisible();
  const linkedEvent = page.locator('.wt-event').filter({ hasText: 'Source linked' });
  await expect(linkedEvent.getByText('Build report UI · Codex', { exact: true })).toHaveAttribute(
    'title',
    'session:fixture-machine/codex/campaign-root',
  );
  await expect(linkedEvent).not.toContainText('session:fixture-machine/codex/campaign-root');
  const linked = await detail(request, task.threadId);
  expect(linked.episodes.map((entry) => entry.sourceSessionId)).toContain('campaign-root');
  const episode = page.locator('[data-session-key="session:fixture-machine/codex/campaign-root"]');
  await episode.getByRole('button', { name: 'Build report UI' }).click();
  await expect(episode.getByText('Resume unavailable: Synthetic demo')).toBeVisible();
  await episode.getByRole('button', { name: 'Detach session', exact: true }).click();
  await expect(page.getByText('0 linked sessions · one task', { exact: true })).toBeVisible();
  const detachedEvent = page.locator('.wt-event').filter({ hasText: 'Source detached' });
  await expect(detachedEvent.getByText('a session (no longer readable)', { exact: true })).toHaveAttribute(
    'title',
    'session:fixture-machine/codex/campaign-root',
  );
  await expect(detachedEvent).not.toContainText('session:fixture-machine/codex/campaign-root');
  const detached = await detail(request, task.threadId);
  expect(detached.detachedLinks).toHaveLength(1);
  expect(detached.events.at(-1)?.kind).toBe('link-detached');
  await page
    .getByRole('status')
    .filter({ hasText: 'Session detached' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.getByText('1 linked session · one task', { exact: true })).toBeVisible();
  expect((await detail(request, task.threadId)).detachedLinks).toHaveLength(1);
});

test('a second tab receives a revision conflict and reloads without overwriting the first tab', async ({
  page,
  context,
  request,
}) => {
  const task = await createTask(request);
  const other = await context.newPage();
  await open(page, task.threadId);
  await open(other, task.threadId);
  await other.getByRole('button', { name: 'Mark as waiting', exact: true }).click();
  await other.getByLabel('Waiting for', { exact: true }).fill('A product decision');
  await endFollowUp(page);
  await expect(page.locator('[data-follow-state="done"]')).toBeVisible();
  const conflicted = other.waitForResponse((candidate) => new URL(candidate.url()).pathname === commandPath);
  await other.getByRole('button', { name: 'Wait', exact: true }).click();
  const response = await conflicted;
  expect(parseWorkThreadsCommandOutput(decodeRpcResponseBody(await response.text()))).toMatchObject({
    ok: false,
    failure: 'revision-conflict',
    currentRevision: 2,
  });
  await expect(other.getByRole('alert')).toContainText('This task changed in another tab — reloaded');
  await expect(other.locator('[data-follow-state="done"]')).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread).toMatchObject({ followRevision: 2, followState: 'done' });
  await other.close();
});

test('searches PR and session titles and preserves filters through task navigation', async ({ page }) => {
  await open(page);
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('1487');
  await expect(row(page, ids.payments)).toBeVisible();
  await expect(row(page, ids.payments)).toContainText('4 linked sessions · 1 delegated');
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('Compare retry approaches');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Compare retry approaches');
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('Example shop');
  await expect(row(page, ids.payments)).toBeVisible();
  const listUrl = page.url();
  await row(page, ids.payments).getByRole('link', { name: 'Prevent duplicate payments' }).first().click();
  await expect(page.getByRole('heading', { name: 'Prevent duplicate payments', exact: true })).toBeVisible();
  await expect(page.getByText('4 linked sessions · 1 delegated · one task', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ 1 delegated session', exact: true }).click();
  await expect(page.getByRole('button', { name: '− 1 delegated session', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Check the retry invariant' })).toBeVisible();
  await page.getByRole('link', { name: '← My work', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('Compare retry approaches');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('Example shop');
  expect(new URL(page.url()).searchParams.get('q')).toBe(new URL(listUrl).searchParams.get('q'));
  expect(new URL(page.url()).searchParams.get('project')).toBe('Example shop');
});

test('keyboard path opens a task, ends follow-up, and operates the tablist', async ({ page, request }) => {
  const task = await createTask(request);
  await open(page);
  const search = page.getByRole('searchbox', { name: 'Search tasks' });
  await search.fill(task.title);
  const taskLink = row(page, task.threadId)
    .getByRole('link', { name: new RegExp(task.title) })
    .first();
  await taskLink.focus();
  await expect(taskLink).toBeFocused();
  await page.keyboard.press('Enter');
  const end = page.getByRole('button', { name: 'End follow-up', exact: true }).first();
  await end.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-follow-state="done"]')).toBeVisible();
  const back = page.getByRole('link', { name: '← My work', exact: true });
  await back.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: FOLLOWING_TAB }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: DONE_TAB })).toBeFocused();
  await expect(page.getByRole('tab', { name: DONE_TAB })).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, task.threadId)).toBeVisible();
});

test('wait records its linked PR expectation and resume note survives reload', async ({ page, request }) => {
  const task = await createTask(request, { links: [{ key: prKey, kind: 'pull-request' }] });
  await open(page, task.threadId);
  await page.getByRole('button', { name: 'Mark as waiting', exact: true }).click();
  await page.getByLabel('Waiting for', { exact: true }).fill('Human PR review');
  await page.getByRole('combobox', { name: 'Linked PR review (optional)', exact: true }).selectOption(prKey);
  await page.getByRole('button', { name: 'Wait', exact: true }).click();
  await expect(page.locator('[data-follow-state="waiting"]')).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread.waitingOn).toMatchObject({
    kind: 'pull-request-review',
    linkKey: prKey,
  });
  await page.locator('summary').filter({ hasText: 'Resume note, if needed' }).click();
  await page.getByLabel('Resume note', { exact: true }).fill('Check the review response before continuing.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Resume note saved' })).toBeVisible();
  await page.reload();
  await hydrated(page);
  await page.locator('summary').filter({ hasText: 'Resume note, if needed' }).click();
  await expect(page.getByLabel('Resume note', { exact: true })).toHaveValue(
    'Check the review response before continuing.',
  );
});

test('session intake creates a task through the inline form and opens its linked episode', async ({
  page,
  request,
}) => {
  await page.goto('/work/sessions');
  await expect(page.locator('main[data-route-shell="work"][data-work-hydrated="true"]')).toBeVisible({
    timeout: 15_000,
  });
  const served = page.locator('details[data-work-served-roots]');
  await served.locator('> summary').click();
  const session = served.locator('[data-work-session]').filter({
    has: page.getByRole('heading', { name: 'Build report UI', exact: true }),
  });
  await session.getByRole('button', { name: 'Follow as a task', exact: true }).click();
  await expect(session.getByLabel('Task title', { exact: true })).toHaveValue('Build report UI');
  const title = `Intake analysis ${crypto.randomUUID().slice(0, 8)}`;
  await session.getByLabel('Task title', { exact: true }).fill(title);
  await session.getByRole('combobox', { name: 'Intent', exact: true }).selectOption('analysis');
  const createdResponse = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === commandPath);
  await session.getByRole('button', { name: 'Create task', exact: true }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(200);
  const created = parseWorkThreadsCommandOutput(decodeRpcResponseBody(await response.text()));
  if (!created.ok) {
    throw new Error(created.message);
  }
  await expect(session.getByRole('status')).toContainText('Task created.');
  await session.getByRole('link', { name: 'Open task', exact: true }).click();
  await hydrated(page);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('task')).toBe(created.threadId);
  await expect(page.getByText('1 linked session · one task', { exact: true })).toBeVisible();
  await expect(page.locator('[data-session-key="session:fixture-machine/codex/campaign-root"]')).toContainText(
    'Build report UI',
  );
  const saved = await detail(request, created.threadId);
  expect(saved.row.thread).toMatchObject({
    title,
    intent: 'analysis',
    projectLabel: 'ai-usage',
    followState: 'following',
  });
  expect(saved.row.links).toHaveLength(1);
  expect(saved.row.links[0]).toMatchObject({
    key: 'session:fixture-machine/codex/campaign-root',
    kind: 'session',
    detachedAt: null,
  });
  expect(saved.episodes[0]?.sourceSessionId).toBe('campaign-root');
});

test('list and task layouts are accessible without overflow at desktop, tablet and mobile widths', async ({
  page,
  request,
}, testInfo) => {
  const longTitle = (await detail(request, ids.longTitle)).row.thread.title;
  for (const width of [1440, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const taskLink = row(page, ids.longTitle).getByRole('link', { name: longTitle, exact: true });
    await expect(taskLink).toHaveAttribute('title', longTitle);
    expect(await taskLink.locator('strong').evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe('2');
    const taskBounds = await row(page, ids.longTitle).boundingBox();
    expect(taskBounds?.height).toBeLessThanOrEqual(width > 780 ? 100 : 150);
    if (width === 375) {
      const titleBounds = await taskLink.boundingBox();
      const weekControl = row(page, ids.longTitle).locator('.wt-day-button').first();
      const weekBounds = await weekControl.boundingBox();
      if (!(taskBounds && titleBounds && weekBounds)) {
        throw new Error('The mobile task title and week activity must remain visible.');
      }
      expect(titleBounds.width / taskBounds.width).toBeGreaterThanOrEqual(0.48);
      expect(titleBounds.width / taskBounds.width).toBeLessThanOrEqual(0.6);
      expect(weekBounds.width).toBeGreaterThanOrEqual(20);
      await expect(weekControl).toBeVisible();
    }
    await assertAxe(page);
    await page.screenshot({ path: testInfo.outputPath(`work-list-${width}.png`), fullPage: true });
    await open(page, ids.payments);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await assertAxe(page);
    await page.screenshot({ path: testInfo.outputPath(`work-task-${width}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await assertAxe(page);
});
