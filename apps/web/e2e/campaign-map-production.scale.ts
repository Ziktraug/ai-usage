import {
  HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL,
  HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL,
  HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
} from '@ai-usage/local-machine/testing/harness-home';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForHydratedNavigation } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody, rpcStringFieldValues } from './rpc-test-transport';
import { createServerStateNetworkTrace } from './server-state-network';
import { freezeSessionScrollCollectionSources } from './session-scroll-source-control';

const OPEN_SESSION_PATTERN = /^Open session/;
const ANALYSE_SESSION_PATTERN = /Analyze session chronology/;
const EXPAND_CAMPAIGN_PATTERN = /^Expand sessions for/;

const scrollThroughBoundary = async (page: Page, surface: Locator): Promise<void> => {
  const box = await surface.boundingBox();
  if (!box) {
    throw new Error('The campaign viewport must be visible');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(150, box.height / 2));
  await page.mouse.wheel(0, 10_000);
};

const SECRET_SENTINELS = [
  HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL,
  HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL,
  HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
];

test('serves and pages bounded campaigns from the production SQLite revision', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
  const trace = createServerStateNetworkTrace(page);
  const startedAt = performance.now();
  const response = await page.goto('/campaigns?range=all');
  expect(response?.ok()).toBe(true);
  const html = await response!.text();
  for (const secret of SECRET_SENTINELS) {
    expect(html).not.toContain(secret);
  }
  expect(html).toContain('data-campaign-card');
  expect(html).toContain('data-campaign-map');
  expect(html).not.toContain('Synthetic demonstration');
  await waitForHydratedNavigation(page);
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  await expect(page.locator('[data-campaign-list]')).toContainText('40 of');
  expect(await page.locator('[data-campaign-card]').count()).toBeLessThan(40);
  await expect(page.locator('[data-campaign-node]')).toHaveCount(1);
  const initialMs = performance.now() - startedAt;
  const main = page.locator('main[data-route-shell="campaigns"]');
  const revision = await main.getAttribute('data-report-revision');
  expect(revision).toBeTruthy();
  await expect(page.locator('[data-map-revision]')).toHaveAttribute('data-map-revision', revision!);

  const nextPageResponse = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === '/rpc/session/page',
  );
  await scrollThroughBoundary(page, page.locator('[data-campaign-list]'));
  const body = await (await nextPageResponse).text();
  for (const secret of SECRET_SENTINELS) {
    expect(body).not.toContain(secret);
  }
  expect(new Set(rpcStringFieldValues(body, 'revision'))).toEqual(new Set([revision]));
  expect(new TextEncoder().encode(body).byteLength).toBeLessThan(2 * 1024 * 1024);
  await expect(page.locator('[data-campaign-list]')).toContainText('80 of');
  expect(await page.locator('[data-campaign-card]').count()).toBeLessThan(40);
  await expect(page.locator('[data-campaign-node]')).toHaveCount(1);

  const reportCalls = trace.records().filter(({ operation }) => operation?.startsWith('report.'));
  expect(reportCalls.every(({ operation }) => operation === 'report.revisionBootstrap')).toBe(true);
  const observation = {
    acquiredCampaigns: 80,
    mountedCampaignCards: await page.locator('[data-campaign-card]').count(),
    initialDocumentBytes: new TextEncoder().encode(html).byteLength,
    initialMapNodes: 1,
    initialMs: Math.round(initialMs),
    nextPageBytes: new TextEncoder().encode(body).byteLength,
    requests: trace.counts(),
  };
  await testInfo.attach('campaign-query-measurements', {
    body: JSON.stringify(observation, null, 2),
    contentType: 'application/json',
  });
  process.stdout.write(`${JSON.stringify({ type: 'campaign-query-measurements', ...observation })}\n`);
  await page.setViewportSize({ width: 390, height: 900 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  trace.dispose();
});

test('opens the canonical child details from a production campaign without losing its revision', async ({
  page,
  request,
  baseURL,
}) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
  const response = await page.goto('/campaigns?range=all&q=Implement%20fixture%20root');
  const html = await response!.text();
  for (const secret of SECRET_SENTINELS) {
    expect(html).not.toContain(secret);
  }
  await waitForHydratedNavigation(page);
  await expect(page.locator('[data-campaign-node]')).toHaveCount(2);
  await expect(page.locator('[data-campaign-node][data-depth="1"]')).toHaveCount(1);
  const revision = await page.locator('[data-map-revision]').getAttribute('data-map-revision');
  const child = page
    .locator('[data-campaign-node][data-depth="1"]')
    .getByRole('button', { name: OPEN_SESSION_PATTERN });
  await child.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  const detailsResponse = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === '/rpc/session/detail',
  );
  await drawer.getByRole('button', { name: ANALYSE_SESSION_PATTERN }).click();
  const details = await (await detailsResponse).text();
  expect(new Set(rpcStringFieldValues(details, 'revision'))).toEqual(new Set([revision]));
  await expect(drawer).toContainText('Implement fixture child');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(child).toBeFocused();
});

test('retains the visible campaign on a mismatched response and recovers through Retry', async ({
  page,
  request,
  baseURL,
}) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
  await page.goto('/campaigns?range=all');
  await waitForHydratedNavigation(page);
  const revision = await page.locator('[data-map-revision]').getAttribute('data-map-revision');
  await page.route('**/rpc/session/page**', async (route) => {
    const response = await route.fetch();
    const decoded = decodeRpcResponseBody(await response.text());
    if (!(typeof decoded === 'object' && decoded !== null && 'revision' in decoded)) {
      throw new Error('The real Session response must expose its exact revision');
    }
    await route.fulfill({ response, body: encodeRpcResponseBody({ ...decoded, revision: 'mismatched-revision' }) });
  });
  await page.getByRole('searchbox', { name: 'Find a campaign', exact: true }).fill('Implement fixture root');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(
    page.getByText('session query server result has a mismatched revision or request fingerprint', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Showing last loaded campaigns.', { exact: false })).toBeVisible();
  await expect(page.locator('[data-campaign-list]')).toContainText('40 of');
  await expect(page.locator('[data-map-revision]')).toHaveAttribute('data-map-revision', revision!);
  await page.unroute('**/rpc/session/page**');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-campaign-card]')).toHaveCount(1);
  await expect(page.locator('[data-campaign-node]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-map-revision]')).toHaveAttribute('data-map-revision', revision!);
});

test('serves bounded project chronology without fetching every campaign hierarchy', async ({
  page,
  request,
  baseURL,
}) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
  const trace = createServerStateNetworkTrace(page);
  await page.goto('/campaigns?range=all&campaignView=timeline');
  await waitForHydratedNavigation(page);
  await expect(page.getByText('40 of', { exact: false })).toBeVisible();
  expect(await page.locator('[data-timeline-campaign]').count()).toBeLessThan(40);
  await expect(page.locator('[data-timeline-session]')).toHaveCount(1);
  expect(trace.counts().operations['session.campaignChildren'] ?? 0).toBe(0);
  const nextCampaign = page.locator('[data-timeline-campaign]').nth(1);
  const key = await nextCampaign.getAttribute('data-campaign-key');
  const response = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === '/rpc/session/campaignChildren',
  );
  await nextCampaign.getByRole('button', { name: EXPAND_CAMPAIGN_PATTERN }).click();
  const body = await (await response).text();
  const revision = await page.locator('main[data-route-shell="campaigns"]').getAttribute('data-report-revision');
  expect(new Set(rpcStringFieldValues(body, 'revision'))).toEqual(new Set([revision]));
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBe(key);
  await expect(page.locator('[data-timeline-session]')).toHaveCount(1);
  expect(trace.counts().operations['session.campaignChildren']).toBe(1);
  expect(trace.counts().operations['session.page'] ?? 0).toBe(0);

  const session = page.locator('[data-timeline-session]').getByRole('button', { name: OPEN_SESSION_PATTERN });
  await session.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  const detailResponse = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === '/rpc/session/detail',
  );
  await drawer.getByRole('button', { name: ANALYSE_SESSION_PATTERN }).click();
  const detail = await (await detailResponse).text();
  expect(new Set(rpcStringFieldValues(detail, 'revision'))).toEqual(new Set([revision]));
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(session).toBeFocused();
  trace.dispose();
});

test('keeps the retained timeline on its original period until a failed filter can be retried', async ({
  page,
  request,
  baseURL,
}) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
  await page.goto('/campaigns?range=all&q=Implement%20fixture%20root&campaignView=timeline');
  await waitForHydratedNavigation(page);
  await expect(page.locator('[data-timeline-session]')).toHaveCount(2);
  const timeline = page.locator('[data-project-timeline]');
  const start = await timeline.getAttribute('data-axis-start');
  const end = await timeline.getAttribute('data-axis-end');
  expect(start).toBeTruthy();
  await page.route('**/rpc/session/page**', async (route) => {
    const response = await route.fetch();
    const decoded = decodeRpcResponseBody(await response.text());
    if (!(typeof decoded === 'object' && decoded !== null && 'revision' in decoded)) {
      throw new Error('The real Session response must expose its exact revision');
    }
    await route.fulfill({ response, body: encodeRpcResponseBody({ ...decoded, revision: 'mismatched-revision' }) });
  });
  await page.getByRole('combobox', { name: 'Period', exact: true }).selectOption('today');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByText('Showing last loaded campaigns.', { exact: false })).toBeVisible();
  await expect(timeline).toHaveAttribute('data-axis-start', start!);
  await expect(timeline).toHaveAttribute('data-axis-end', end!);
  await expect(page.locator('[data-timeline-session]')).toHaveCount(2);
  await page.unroute('**/rpc/session/page**');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-timeline-campaign]')).toHaveCount(0);
  await expect(page.getByText('No campaigns match this period and search.', { exact: false })).toBeVisible();
});
