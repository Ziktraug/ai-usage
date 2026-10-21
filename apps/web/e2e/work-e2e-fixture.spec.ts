import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { parseWorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody } from './rpc-test-transport';

/**
 * The Work resume surface in the e2e runtime (no demo header): the page reads `work.attention`
 * through the contract client, and the server answers with the representative seeded registry
 * parsed by the collector's own normalizer and assembled by the production read model
 * (`work-attention-e2e-fixture.server.ts`), held in memory. Only the SQLite round trip and the
 * served-revision join are absent here; the production path is `work-production.spec.ts`.
 *
 * Titles and questions are the generator's; ages read against the fixture's fixed clock
 * (2026-10-20T12:00Z) in UTC.
 */

const WORK_ATTENTION_PATH = '/rpc/work/attention';
/** The oRPC GET shape the browser link emits for an empty input. */
const ROUTING_CONTEXT_URL = '/rpc/workRouting/context?data=%7B%22json%22%3A%7B%7D%7D';
const ROOTS_IN_WINDOW = 21;
const MINIMUM_ROOTS = 20;
const BLOCKED_ROOT_ID = 'local_fixture-blocked-root';
const BLOCKED_TITLE = 'Fixture: investigate checkout 3';
const BLOCKED_QUESTION = 'Confirm whether the fixture should keep checkout 3 or delete it.';
const BLOCKED_CHILD_TITLES = ['Fixture: child two', 'Fixture: grandchild of checkout 3'];
const BLOCKED_DECLARED_AT = 'Oct 20, 2026, 11:00 UTC';
const SATISFIED_TITLE = 'Fixture: collector branch awaiting a pull request';
const PROPOSAL_TITLE = 'Fixture: proposals pending';

const waitForHydratedWork = async (page: Page): Promise<void> => {
  await expect(page.locator('main[data-route-shell="work"][data-work-hydrated="true"]')).toBeVisible({
    timeout: 15_000,
  });
};
const rowNamed = (page: Page, title: string): Locator =>
  page.locator('[data-work-root]').filter({ has: page.getByText(title, { exact: true }) });
const expectAxeClean = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};
const searchParam = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);

test('reads the seeded registry through work.attention and renders its roots, question and detail', async ({
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
  expect(output.data.roots.length).toBe(ROOTS_IN_WINDOW);
  expect(output.data.roots.length).toBeGreaterThanOrEqual(MINIMUM_ROOTS);
  expect(output.data.coverage.desktopSessions).toMatchObject({ filesParsed: 40, filesSeen: 41, unsupported: 1 });

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();
  await expect(main.getByText('Declared outcomes are unavailable')).toHaveCount(0);
  const coverage = main.locator('[data-work-coverage]');
  await expect(coverage).toContainText('Desktop sessions: collected');
  await expect(coverage).toContainText('40 of 41 files parsed · 1 unsupported');
  // The e2e composition is the served read model, not the demo's synthetic dataset.
  await expect(coverage).not.toContainText('Synthetic dataset');
  await expect(
    main.getByRole('status').filter({ hasText: `${ROOTS_IN_WINDOW} of ${ROOTS_IN_WINDOW} roots shown` }),
  ).toBeVisible();
  for (const name of ['Needs you', 'Leads', 'Recent, nothing pending']) {
    await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  await main.locator('[data-work-section="none"] button', { hasText: 'Show all' }).click();
  await expect(main.locator('[data-work-root]')).toHaveCount(ROOTS_IN_WINDOW);
  for (const title of BLOCKED_CHILD_TITLES) {
    await expect(rowNamed(page, title)).toHaveCount(0);
  }
  const blocked = rowNamed(page, BLOCKED_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(blocked)).toHaveCount(1);
  await expect(blocked).toContainText(BLOCKED_QUESTION);
  await expect(blocked).toContainText('blocked · 1 h ago');
  await expect(main.locator('[data-work-section="none"]').locator(rowNamed(page, SATISFIED_TITLE))).toHaveCount(1);
  await expect(main.locator('[data-work-section="optional-lead"]').locator(rowNamed(page, PROPOSAL_TITLE))).toHaveCount(
    1,
  );
  await expectAxeClean(page);

  await blocked.click();
  await expect.poll(() => searchParam(page, 'root')).toBe(BLOCKED_ROOT_ID);
  const aside = main.locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toHaveAttribute('data-work-detail', BLOCKED_ROOT_ID);
  await expect(aside.locator('[data-work-question]')).toHaveText(BLOCKED_QUESTION);
  await expect(aside).toContainText(
    `Declared by the session at ${BLOCKED_DECLARED_AT}; its current state is unobserved.`,
  );
  await expect(aside.getByRole('heading', { level: 4, name: 'Claude Desktop metadata' })).toBeVisible();
  await expect(aside).toContainText('3 child sessions · 0 blocked · 1 review ready · 2 completed');
  // This composition serves no revision, so no root joins a Session: the detail says so instead of
  // offering a transcript or a review target, and the routing simulation stays unreachable here.
  await expect(aside).toContainText('Transcript not collected yet; there is no session detail to open.');
  await expect(aside).toContainText('No collected transcript identifies a review target for this root.');
  await expect(aside.getByRole('button', { name: 'Run simulation' })).toHaveCount(0);
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
