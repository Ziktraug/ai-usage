import { parseWorkThreadsCommandOutput, workThreadsListInputSchema } from '@ai-usage/web-contract/work-threads';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { parse } from 'valibot';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';

// Each journey creates more tasks than one page holds. playwright.work-pagination.config.ts runs this
// file on its own dev server, so these tasks never push another spec's seeds off the first page.
const createTask = async (request: APIRequestContext, projectLabel: string, title: string): Promise<void> => {
  const response = await request.post('/rpc/workThreads/command', {
    data: encodeRpcResponseBody({
      commandId: crypto.randomUUID(),
      intent: 'analysis',
      links: [],
      objective: 'Synthetic browser journey; analysis can be enough.',
      op: 'create',
      projectLabel,
      title,
    }),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  });
  expect(response.status()).toBe(200);
  const created = parseWorkThreadsCommandOutput(decodeRpcResponseBody(await response.text()));
  if (!created.ok) {
    throw new Error(created.message);
  }
};
const hydrated = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-work-threads][data-work-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
};
const assertAxe = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};

const createPaginatedTasks = async (request: APIRequestContext) => {
  const project = `Scroll ${crypto.randomUUID().slice(0, 8)}`;
  for (let index = 0; index < 55; index += 1) {
    await createTask(request, project, `${project} task ${index}`);
  }
  return { project };
};
test('scrolling appends tasks once, preserves the viewport and restores the loaded list after opening a task', async ({
  page,
  request,
}) => {
  const { project } = await createPaginatedTasks(request);
  let nextPageRequests = 0;
  const { promise: pendingPage, resolve: releasePage } = Promise.withResolvers<void>();
  await page.route('**/rpc/workThreads/list', async (route) => {
    const input = parse(workThreadsListInputSchema, decodeRpcResponseBody(route.request().postData() ?? '{}'));
    if (input.project === project && input.cursor) {
      nextPageRequests += 1;
      await pendingPage;
    }
    await route.continue();
  });
  await page.goto(`/work?project=${encodeURIComponent(project)}`);
  await hydrated(page);
  const tasks = page.locator('[data-work-thread]');
  await expect(tasks).toHaveCount(50);
  expect(nextPageRequests).toBe(0);
  await page.locator('.wt-more').scrollIntoViewIfNeeded();
  await expect.poll(() => nextPageRequests).toBe(1);
  const scroll = await page.evaluate(() => window.scrollY);
  await expect(page.getByRole('button', { name: 'Loading…', exact: true })).toBeDisabled();
  releasePage();
  await expect(tasks).toHaveCount(55);
  expect(nextPageRequests).toBe(1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
  expect(
    await tasks.evaluateAll(
      (elements) => new Set(elements.map((element) => element.getAttribute('data-work-thread'))).size,
    ),
  ).toBe(55);
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  const link = tasks.last().locator('.wt-task-title');
  await link.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => Math.round(window.scrollY));
  await link.click();
  await expect(page.getByRole('link', { name: '← My work', exact: true })).toBeVisible();
  await page.goBack();
  await expect(tasks).toHaveCount(55);
  await expect(link).toBeFocused();
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(savedScroll);
  await page.reload();
  await hydrated(page);
  await expect(tasks).toHaveCount(55);
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill(`${project} task 54`);
  await expect(tasks).toHaveCount(1);
  expect(new URL(page.url()).searchParams.getAll('cursor')).toEqual([]);
  await assertAxe(page);
});

test('infinite scroll keeps loaded tasks on error and resumes only after retry', async ({ page, request }) => {
  const { project } = await createPaginatedTasks(request);
  let failing = true;
  let nextPageRequests = 0;
  await page.route('**/rpc/workThreads/list', async (route) => {
    const input = parse(workThreadsListInputSchema, decodeRpcResponseBody(route.request().postData() ?? '{}'));
    if (input.project === project && input.cursor) {
      nextPageRequests += 1;
      if (failing) {
        await route.fulfill({
          contentType: 'application/json',
          body: encodeRpcResponseBody({ ok: false, error: { tag: 'Unavailable', message: 'Pagination unavailable.' } }),
        });
        return;
      }
    }
    await route.continue();
  });
  await page.goto(`/work?project=${encodeURIComponent(project)}`);
  await hydrated(page);
  await expect(page.locator('[data-work-thread]')).toHaveCount(50);
  await page.locator('.wt-more').scrollIntoViewIfNeeded();
  await expect(page.getByRole('alert')).toContainText('Pagination unavailable.');
  await expect(page.locator('[data-work-thread]')).toHaveCount(50);
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeDisabled();
  await page.locator('.wt-more').scrollIntoViewIfNeeded();
  expect(nextPageRequests).toBe(1);
  failing = false;
  const retry = page.getByRole('button', { name: 'Retry tasks', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-work-thread]')).toHaveCount(55);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(nextPageRequests).toBe(2);
});

test('the explicit load more action remains available from the keyboard', async ({ page, request }) => {
  const { project } = await createPaginatedTasks(request);
  await page.goto(`/work?project=${encodeURIComponent(project)}`);
  await hydrated(page);
  await expect(page.locator('[data-work-thread]')).toHaveCount(50);
  // Keep the sentinel off screen so Enter exercises the explicit action, independently of scrolling.
  await page
    .getByRole('button', { name: 'Load more', exact: true })
    .evaluate((button) => button.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-work-thread]')).toHaveCount(55);
  await expect(page.getByRole('status').filter({ hasText: '55 tasks loaded.' })).toHaveCount(1);
});
