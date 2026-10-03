import { expect, reportViewsFor, test, waitForHydratedNavigation, waitForHydratedReport } from './browser-test';
import { MANUAL_MERGE_DOWNLOAD_PATH, MANUAL_MERGE_UPLOAD_PATH } from './rpc-test-transport';

const BUSINESS_RESOURCE_TYPES = new Set(['eventsource', 'fetch', 'xhr']);
const KNOWN_RPC_PROBE_PATH = '/rpc/report/revisionManifest';
const NON_REPORT_NAVIGATION_PATTERN = /Skills|Sources|Sync/;
const OPEN_BUILD_REPORT_UI_PATTERN = /^Open details for Build report UI\./;
const STANDALONE_CAMPAIGN_PATTERN = /^Review release notes /;
const INCOMPLETE_CAMPAIGN_PATTERN = /^Explore dashboard layout /;
const UNKNOWN_RPC_PROBE_PATH = '/rpc/demo-boundary-probe';

test('explores Campaigns and individual session details without local data or business requests', async ({ page }) => {
  const businessRequests: string[] = [];
  page.on('request', (browserRequest) => {
    if (BUSINESS_RESOURCE_TYPES.has(browserRequest.resourceType())) {
      businessRequests.push(`${browserRequest.resourceType()}:${browserRequest.url()}`);
    }
  });

  await page.goto('/campaigns');
  await waitForHydratedNavigation(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic demonstration · no local history is read.', { exact: true })).toBeVisible();
  const map = page.getByRole('region', { name: 'Agent Map', exact: true });
  await expect(map.getByRole('heading', { name: 'Build forecast model', exact: true })).toBeVisible();
  await expect(page.locator('[data-campaign-node]')).toHaveCount(5);
  await page.getByRole('button', { name: 'Open session Verify ingestion edge cases', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-detail-item="Total tokens"]')).toContainText('160k');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  const campaigns = page.getByRole('region', { name: 'Recent campaigns', exact: true });
  await campaigns.getByRole('button', { name: STANDALONE_CAMPAIGN_PATTERN }).click();
  await expect(map.getByRole('heading', { name: 'Review release notes', exact: true })).toBeVisible();
  await expect(page.locator('[data-campaign-node]')).toHaveCount(1);
  await campaigns.getByRole('button', { name: INCOMPLETE_CAMPAIGN_PATTERN }).click();
  await expect(map.getByRole('heading', { name: 'Explore dashboard layout', exact: true })).toBeVisible();
  await expect(map).toContainText('Timing is incomplete.');
  expect(businessRequests).toEqual([]);
});

test('isolates the synthetic demo from every local data and control capability', async ({ page, request }) => {
  const businessRequests: string[] = [];
  page.on('request', (browserRequest) => {
    if (BUSINESS_RESOURCE_TYPES.has(browserRequest.resourceType())) {
      businessRequests.push(`${browserRequest.resourceType()}:${browserRequest.url()}`);
    }
  });

  await page.goto('/');
  await waitForHydratedReport(page);
  await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Usage overview' })).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const filter = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await filter.fill('Build report UI');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Build report UI');
  await expect(page.getByText('1 / 6 sessions', { exact: true })).toBeVisible();
  await filter.fill('');

  await page.getByRole('button', { name: OPEN_BUILD_REPORT_UI_PATTERN }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Build report UI', { exact: true }).first()).toBeVisible();
  await expect(drawer.getByText('Total tokens', { exact: true })).toBeVisible();
  await expect(drawer.locator('[data-detail-item="Total tokens"]')).toContainText('401k');
  await expect(page.getByRole('link', { name: NON_REPORT_NAVIGATION_PATTERN })).toHaveCount(0);

  const guardedResponses = await Promise.all([
    request.get('/api/source-control'),
    request.post('/api/source-control/command', {
      data: { command: 'run-all' },
      headers: { 'content-type': 'application/json' },
    }),
    request.get(KNOWN_RPC_PROBE_PATH),
    request.get(UNKNOWN_RPC_PROBE_PATH),
    request.post(MANUAL_MERGE_DOWNLOAD_PATH),
    request.post(MANUAL_MERGE_UPLOAD_PATH, { data: {}, headers: { 'content-type': 'application/json' } }),
  ]);
  expect(guardedResponses.map((response) => response.status())).toEqual([404, 404, 404, 404, 404, 404]);

  for (const pathname of ['/skills', '/sources', '/sync']) {
    await page.goto(pathname);
    await expect(page).toHaveURL('http://127.0.0.1:4176/');
    await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  }
  expect(businessRequests).toEqual([]);
});
