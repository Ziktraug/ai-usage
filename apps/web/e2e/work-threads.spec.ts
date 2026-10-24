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
};
const DONE_TAB = /^Done /;
const FOLLOWING_TAB = /^Following /;
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
  await expect(page.getByText('Nothing in GitHub, Jira or any session was changed.', { exact: true })).toBeVisible();
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

test('ending despite remainders records the decision and Undo restores follow-up only', async ({ page, request }) => {
  const task = await createTask(request, { intent: 'change', links: [{ key: prKey, kind: 'pull-request' }] });
  const before = await detail(request, task.threadId);
  await open(page, task.threadId);
  await endFollowUp(page);
  const remaining = page.getByRole('region', { name: "What's left", exact: true });
  await expect(remaining.getByRole('heading', { name: 'These remainders will stay' })).toBeVisible();
  await expect(remaining).toContainText('The linked PR is still open');
  await expect(remaining).toContainText('Review changes to address');
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
  expect(event?.acknowledgedRemainders.some((value) => value.includes('still open'))).toBe(true);
  expect(ended.row.markers).toEqual(before.row.markers);
  expect(ended.episodes).toEqual(before.episodes);
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-follow-state="following"]')).toBeVisible();
  expect((await detail(request, task.threadId)).row.thread.followRevision).toBe(3);
});

test('a task exists for a PR with zero sessions and keeps a dated GitHub marker', async ({ page }) => {
  await open(page);
  await expect(row(page, ids.review)).toContainText('PR #1492 · 0 sessions');
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
  const linked = await detail(request, task.threadId);
  expect(linked.episodes.map((episode) => episode.sourceSessionId)).toContain('campaign-root');
  const episode = page.locator('[data-session-key="session:fixture-machine/codex/campaign-root"]');
  await episode.getByRole('button', { name: 'Build report UI' }).click();
  await expect(episode.getByText('Resume unavailable: Synthetic demo')).toBeVisible();
  await episode.getByRole('button', { name: 'Detach session', exact: true }).click();
  await expect(page.getByText('0 linked sessions · one task', { exact: true })).toBeVisible();
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
  const conflicted = other.waitForResponse((response) => new URL(response.url()).pathname === commandPath);
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
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('Compare retry approaches');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Compare retry approaches');
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('Example shop');
  await expect(row(page, ids.payments)).toBeVisible();
  const listUrl = page.url();
  await row(page, ids.payments).getByRole('link', { name: 'Prevent duplicate payments' }).first().click();
  await expect(page.getByRole('heading', { name: 'Prevent duplicate payments', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ 1 delegated session', exact: true }).click();
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
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === commandPath);
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
}, testInfo) => {
  for (const width of [1440, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
