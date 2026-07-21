import { expect, test } from '@playwright/test';

const BUSINESS_RESOURCE_TYPES = new Set(['eventsource', 'fetch', 'xhr']);
const NON_REPORT_NAVIGATION_PATTERN = /Skills|Sources|Sync/;
const TOP_SESSION_PATTERN = /Top session/;

test('serves only the synthetic report and keeps every local boundary inert', async ({ page, request }) => {
  const businessRequests: string[] = [];
  page.on('request', (browserRequest) => {
    if (BUSINESS_RESOURCE_TYPES.has(browserRequest.resourceType())) {
      businessRequests.push(`${browserRequest.resourceType()}:${browserRequest.url()}`);
    }
  });

  await page.goto('/');
  await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

  const filter = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await filter.fill('Build report UI');
  await expect(page.getByText('1 / 4 sessions', { exact: true })).toBeVisible();
  await filter.fill('');

  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Build report UI', { exact: true }).first()).toBeVisible();
  await expect(drawer.getByText('Total tokens', { exact: true })).toBeVisible();
  await expect(drawer.getByText('203,500', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: NON_REPORT_NAVIGATION_PATTERN })).toHaveCount(0);

  const guardedResponses = await Promise.all([
    request.get('/api/source-control'),
    request.post('/api/source-control/command', {
      data: { command: 'run-all' },
      headers: { 'content-type': 'application/json' },
    }),
    request.post('/sync', { data: { rows: [] }, headers: { 'content-type': 'application/json' } }),
    request.get('/_serverFn/demo-boundary-probe'),
  ]);
  expect(guardedResponses.map((response) => response.status())).toEqual([404, 404, 404, 404]);

  for (const pathname of ['/skills', '/sources', '/sync']) {
    await page.goto(pathname);
    await expect(page).toHaveURL('http://127.0.0.1:4176/');
    await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  }
  expect(businessRequests).toEqual([]);
});
