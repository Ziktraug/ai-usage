import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { FOCUSED_REPORT_E2E_CONTROL_KEY, FOCUSED_REPORT_E2E_ENABLED_KEY } from '../src/focused-report-e2e-fixture';
import { REPORT_LAZY_MODULE_E2E_FAILURE_KEY } from '../src/lib/features/report/composition/lazy-module-e2e-fixture';
import { expect, reportViewsFor, test, waitForHydratedNavigation } from './browser-test';
import { encodeRpcResponseBody } from './rpc-test-transport';

const ADVANCED_COLUMNS_PATTERN = /Advanced columns/;
const CALENDAR_NAME_PATTERN = /Daily activity calendar/;
const COLUMN_URL_PATTERN = /cols=/;
const DATE_HEADER_PATTERN = /Date/;
const OPEN_BUILD_REPORT_UI_ACCESSIBLE_NAME_PATTERN = /^Open details for Build report UI\..*Campaign.*\$4\.21/;
const OPEN_BUILD_REPORT_UI_PATTERN = /^Open details for Build report UI\./;
const TOKEN_SESSION_HEADERS = [DATE_HEADER_PATTERN, /Session\s*↑/, /Input/, /Output/, /Cache/, /Fresh/];
const HYDRATION_TIMEOUT_MS = 15_000;
const INSPECT_SESSION_PATTERN = /Inspect session/;
const LEGACY_PROJECT_TAB_URL_PATTERN = /tab=projects/;
const MODELS_TAB_URL_PATTERN = /tab=models/;
const PROVIDER_DETAILS_PATTERN = /^Provider details \(/;
const PUNCHCARD_FILTER_PATTERN = /^Filter report to /;
const PROVIDER_CATEGORY_COUNT_PATTERN = /: (\d+) providers?$/;
const PROVIDER_CATEGORY_TOTAL_PATTERN = /\((\d+) providers?\)$/;
const PROVIDER_CATEGORIES_PATTERN = /^Provider categories/;
const QUERY_URL_PATTERN = /q=ai-usage/;
const RANGE_URL_PATTERN = /range=/;
const RESET_COUNT_PATTERN = /1 reset/;
const GAP_COUNT_PATTERN = /1 collection gap/;
const CLAUDE_SERIES_PATTERN = /^Claude · /;
const SORT_URL_PATTERN = /sort=/;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const HIDDEN_FILTERS_PATTERN = /hidden by filters/;
const NO_SESSIONS_PATTERN = /No sessions/;
const SESSION_COUNTER_PATTERN = /^\d+ \/ \d+ sessions$/;
type FocusedResponseControlAction = 'arm' | 'release' | 'waitUntilBlocked';
const openHydratedReport = async (page: Page, url = '/'): Promise<Awaited<ReturnType<Page['goto']>>> => {
  const response = await page.goto(url);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  return response;
};
const overviewTopSessionTrigger = (page: Page) =>
  page
    .getByRole('heading', { level: 3, name: 'Top sessions' })
    .locator('xpath=ancestor::section[1]')
    .getByRole('button')
    .first();

const controlFocusedResponse = async (page: Page, action: FocusedResponseControlAction): Promise<void> => {
  await page.evaluate(
    async ({ action: requestedAction, controlKey }) => {
      const control = Reflect.get(globalThis, controlKey);
      if (!(control && typeof control === 'object')) {
        throw new Error('Focused E2E response control is unavailable');
      }
      const command = Reflect.get(control, requestedAction);
      if (typeof command !== 'function') {
        throw new Error(`Focused E2E response control cannot ${requestedAction}`);
      }
      await Promise.resolve(Reflect.apply(command, control, []));
    },
    { action, controlKey: FOCUSED_REPORT_E2E_CONTROL_KEY },
  );
};

test('loads a deterministic report overview', async ({ page }) => {
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  const initialHtml = await response?.text();
  expect(initialHtml).not.toContain('Loading report data…');
  expect(initialHtml).toContain('Daily activity calendar');

  await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Report period' })).toBeVisible();
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('locks definitive output while a focused filter response is pending', async ({ browserFailureGate, page }) => {
  await page.goto('/skills');
  await waitForHydratedNavigation(page);
  await page.evaluate((enabledKey) => {
    Reflect.set(globalThis, enabledKey, true);
  }, FOCUSED_REPORT_E2E_ENABLED_KEY);
  const releaseOverviewDataAbort = browserFailureGate.allowRequestAbortOnce({
    pathname: '/__data.json',
    resourceType: 'fetch',
  });
  try {
    await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible({
      timeout: HYDRATION_TIMEOUT_MS,
    });
  } finally {
    releaseOverviewDataAbort();
  }
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  const pendingSurface = page.locator('[data-report-pending]');
  const completeOutput = page.locator('[data-report-complete-output]');
  const overview = page.locator('[data-report-overview]');
  const kpi = page.locator('[data-executive-kpi]');
  const chart = page.locator('[data-executive-chart]');
  const metrics = page.locator('[data-executive-metrics]');
  await expect(pendingSurface).toHaveCount(0);
  const retainedRevision = await overview.getAttribute('data-report-revision');
  const retainedKpi = await kpi.textContent();

  const query = 'pending-filter';
  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await controlFocusedResponse(page, 'arm');
  try {
    await search.fill(query);
    await controlFocusedResponse(page, 'waitUntilBlocked');

    await expect(pendingSurface).toHaveCount(0);
    await expect(completeOutput).toHaveAttribute('aria-busy', 'true');
    await expect(completeOutput).toHaveAttribute('data-report-stale', 'true');
    await expect(overview).toHaveAttribute('data-report-revision', retainedRevision ?? '');
    await expect(kpi).toHaveText(retainedKpi ?? '');
    await expect(chart).toBeVisible();
    await expect(metrics).toBeVisible();
    await expect(page.getByRole('button', { name: `Query: ${query} ×` })).toBeVisible();
    await expect(page.getByText(SESSION_COUNTER_PATTERN)).toHaveCount(0);
    await expect(page.getByText(HIDDEN_FILTERS_PATTERN)).toHaveCount(0);
    await expect(page.getByText(NO_SESSIONS_PATTERN)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Report period' })).toBeVisible();
    // Withholding the counts must not collapse their slot: dropping the boxes threw "Clear all"
    // ~300px sideways for the length of the request. The pills stay, emptied and marked busy.
    const counterSlot = page.locator('[data-active-filters] > span').first();
    await expect(counterSlot).toHaveAttribute('aria-busy', 'true');
    expect((await counterSlot.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  } finally {
    await controlFocusedResponse(page, 'release');
  }

  await expect(pendingSurface).toHaveCount(0);
  await expect(completeOutput).not.toHaveAttribute('aria-busy');
  await expect(page.getByRole('region', { name: 'Report period' })).toBeVisible();
  await expect(page.getByText('0 / 6 sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No sessions match these filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  await expect(kpi).toBeVisible();
});

test('retries a failed report through the Router loading lifecycle', async ({ context, page }) => {
  await context.setExtraHTTPHeaders({ 'x-ai-usage-sveltekit-error': 'once' });
  const failed = await page.goto('/');

  expect(failed?.status()).toBe(503);
  await expect(page.getByRole('heading', { level: 2, name: 'Report unavailable' })).toBeVisible();
  await expect(page.getByText('Report data could not be loaded.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();

  await context.setExtraHTTPHeaders({});
  await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('retries a failed lazy Analysis module without reloading the page', async ({ page }) => {
  await openHydratedReport(page);
  await page.evaluate(
    ({ documentKey, failureKey }) => {
      Reflect.set(globalThis, documentKey, 'retained');
      Reflect.set(globalThis, failureKey, 'breakdown');
    },
    {
      documentKey: '__aiUsageLazyRetryDocument',
      failureKey: REPORT_LAZY_MODULE_E2E_FAILURE_KEY,
    },
  );

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Analysis' }).click();
  await expect(page.getByText('Report view is temporarily unavailable.', { exact: true })).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Retry' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Models' })).toBeVisible();
  await expect(page.getByText('Report view is temporarily unavailable.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { exact: true, name: 'Retry' })).toHaveCount(0);
  await expect(page).toHaveURL(MODELS_TAB_URL_PATTERN);
  expect(await page.evaluate(() => Reflect.get(globalThis, '__aiUsageLazyRetryDocument'))).toBe('retained');
});

test('opens the existing Models deep state from the executive link and preserves history', async ({ page }) => {
  await openHydratedReport(page);
  const modelsLink = page.getByRole('link', { name: 'Open Analysis → Models' });
  await expect(modelsLink).toHaveAttribute('href', MODELS_TAB_URL_PATTERN);
  await modelsLink.click();
  await expect(page).toHaveURL(MODELS_TAB_URL_PATTERN);
  await expect(page.getByRole('tabpanel', { name: 'Models' })).toBeVisible();

  await page.goBack();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.goForward();
  await expect(page.getByRole('tabpanel', { name: 'Models' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tabpanel', { name: 'Models' })).toBeVisible();
});

test('uses one primary navigation while preserving Breakdown deep links behind the Analysis label', async ({
  page,
}) => {
  await openHydratedReport(page, '/?tab=sessions');

  const reportViews = reportViewsFor(page);
  await expect(reportViews).toHaveCount(1);
  await expect(reportViews.getByRole('link')).toHaveText(['Overview', 'Sessions', 'Analysis']);
  await expect(page.getByRole('tablist', { name: 'Dashboard sections' })).toHaveCount(0);
  await expect(reportViews.getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Report period' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity' })).toHaveCount(0);

  await openHydratedReport(page, '/?tab=models');
  await expect(reportViews.getByRole('link', { exact: true, name: 'Analysis' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const breakdownTabs = page.getByRole('tablist', { name: 'Analysis dimension' });
  await expect(breakdownTabs.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { exact: true, name: 'Models' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Report period' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity' })).toHaveCount(0);

  await breakdownTabs.getByRole('tab', { name: 'Projects' }).click();
  await expect(page.getByRole('columnheader', { name: 'Project' })).toBeVisible();
  await expect(page.getByText('Manage project groups', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(LEGACY_PROJECT_TAB_URL_PATTERN);
});

test('copies the exact breakdown URL and exports only visible sorted model rows', async ({ page }) => {
  await openHydratedReport(page, '/?tab=models&breakdownSort=sessions');
  await expect(page.getByRole('heading', { exact: true, name: 'Models' })).toBeVisible();

  const localSearch = page.getByRole('searchbox', { name: 'Search this breakdown' });
  await localSearch.fill('cod');
  const visibleRows = page.getByRole('table', { name: 'Model API-value analysis' }).locator('[data-price-state]');
  await expect(visibleRows).toHaveCount(2);
  await expect(visibleRows.getByRole('button')).toHaveText(['gpt-5.3-codex', 'qwen3-coder']);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  const expectedUrl = page.url();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => await navigator.clipboard.readText())).toBe(expectedUrl);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('ai-usage-models-2026-06-11.csv');
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('The model CSV download has no local path');
  }
  const csv = await readFile(downloadPath, 'utf8');
  expect(csv).toBe(
    [
      'label,sessions,fresh_tokens,cache_read_tokens,cache_hit_percent,api_value_known,api_value_display,api_value_measurement,fully_priced_sessions,total_sessions,unpriced_fresh_tokens,turns,tools',
      'gpt-5.3-codex,1,73500,130000,67.70833333333334,3.2,$3.20,complete,1,1,0,0,0',
      'qwen3-coder,1,48800,72000,63.716814159292035,0.84,$0.84,complete,1,1,0,0,0',
      '',
    ].join('\r\n'),
  );
});

test('shows the executive answer, evidence, four metrics, and investigation in order', async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await openHydratedReport(page);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });

  const kpi = page.locator('[data-executive-kpi]');
  const chart = page.locator('[data-executive-chart]');
  const metrics = page.locator('[data-executive-metrics]');
  const investigation = page.getByRole('heading', { level: 2, name: 'Investigate' });
  await expect(kpi).toBeVisible();
  await expect(kpi).toContainText('Estimated API-equivalent value');
  await expect(page.getByRole('heading', { level: 3, name: 'API value by harness' })).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(metrics.locator(':scope > div')).toHaveCount(4);
  await expect(metrics.locator('dt')).toHaveText([
    'Processed tokens',
    'Cache volume',
    'Output tokens',
    'Pricing coverage',
  ]);
  await expect(investigation).toBeVisible();
  for (const forbiddenCopy of ['Value bases', 'Actual recorded cost', 'Subscription value', 'More report metrics']) {
    await expect(page.getByText(forbiddenCopy, { exact: true })).toHaveCount(0);
  }

  const readingOrder = await page.locator('[data-report-overview]').evaluate((element) => {
    const markers = [
      element.querySelector('[data-executive-kpi]'),
      element.querySelector('[data-executive-chart]'),
      element.querySelector('[data-executive-metrics]'),
      [...element.querySelectorAll('h2')].find((heading) => heading.textContent?.trim() === 'Investigate') ?? null,
      [...element.querySelectorAll('h2')].find((heading) => heading.textContent?.trim() === 'Provider status') ?? null,
    ];
    return markers.map((marker) => marker?.getBoundingClientRect().top ?? -1);
  });
  expect(readingOrder.every((position) => position >= 0)).toBe(true);
  expect(readingOrder).toEqual([...readingOrder].sort((left, right) => left - right));

  const advancedSummary = page.locator('summary').filter({ hasText: 'Advanced analysis' });
  const punchcard = page.getByRole('heading', { level: 4, name: 'Punchcard' });
  await expect(page.getByRole('heading', { level: 3, name: 'Advanced analysis' })).toBeVisible();
  await expect(advancedSummary).toHaveCount(0);
  await expect(punchcard).toBeVisible();
  await expect(page.getByText('Punchcard data', { exact: true })).toHaveCount(0);
  const punchcardTable = page.getByRole('table', { name: 'Punchcard' });
  await expect(punchcardTable).toBeAttached();
  await expect(punchcardTable.getByRole('columnheader')).toHaveText([
    'Weekday',
    'Hour',
    'Sessions',
    'Estimated API-equivalent value',
  ]);
  expect(await punchcardTable.getByRole('row').count()).toBeGreaterThan(1);
  await expect(punchcardTable.getByRole('row', { name: 'Sunday 14:00 1 $0.00' })).toBeAttached();
  const punchcardVisual = page.locator('[data-punchcard-visual]');
  await expect(punchcardVisual).not.toHaveAttribute('aria-hidden', 'true');
  expect(await punchcardVisual.getByRole('button', { name: PUNCHCARD_FILTER_PATTERN }).count()).toBeGreaterThan(0);

  expect(await metrics.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4);

  await page.setViewportSize({ height: 844, width: 390 });
  expect(await metrics.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('prioritizes the selected dashboard view before secondary status on mobile', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 390 });
  await openHydratedReport(page);

  const kpi = page.locator('[data-executive-kpi]');
  const providerStatus = page.getByRole('heading', { level: 2, name: 'Provider status' });
  const [kpiBox, providerBox] = await Promise.all([kpi.boundingBox(), providerStatus.boundingBox()]);

  expect(kpiBox?.y).toBeLessThan(providerBox?.y ?? 0);
  await expect(page.locator('[data-executive-metrics]')).toBeVisible();
  await expect(kpi).toContainText('Estimated API-equivalent value');
});

test('keeps the selected dashboard view ahead of secondary provider status on desktop', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await openHydratedReport(page);

  const kpi = page.locator('[data-executive-kpi]');
  const providerStatus = page.getByRole('heading', { level: 2, name: 'Provider status' });
  const [kpiBox, providerBox] = await Promise.all([kpi.boundingBox(), providerStatus.boundingBox()]);

  await expect(kpi).toBeVisible();
  expect(kpiBox?.y).toBeLessThan(providerBox?.y ?? 0);
});

test('keeps provider details collapsed until they are requested', async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await openHydratedReport(page);

  const providerPanel = page
    .getByRole('heading', { level: 2, name: 'Provider status' })
    .locator('xpath=ancestor::section[1]');
  const providerDetails = page.getByText(PROVIDER_DETAILS_PATTERN);
  const providerDisclosure = providerDetails.locator('xpath=..');
  const noQuotaDetail = page.getByText('No quota windows are available for this provider.').first();
  const attentionProviders = page.getByRole('list', { name: 'Providers requiring attention' });
  const providerCategories = page.getByRole('list', { name: PROVIDER_CATEGORIES_PATTERN });
  const dateRange = page.getByRole('region', { name: 'Report period' });
  const activeFilters = page.locator('[data-active-filters]');
  const overviewHero = page.getByRole('region', { name: 'Estimated API-equivalent value' });
  const executiveMetrics = page.locator('[data-executive-metrics]');

  await expect(providerPanel).toContainText('Quota usage and operational issues at a glance.');
  await expect(providerDisclosure).not.toHaveAttribute('open', '');
  expect(await providerPanel.evaluate((element) => element.closest('[data-report-overview]') !== null)).toBe(true);
  expect(await executiveMetrics.evaluate((element) => element.closest('[data-dashboard-panel]') !== null)).toBe(true);
  expect(await dateRange.evaluate((element) => element.closest('[data-dashboard-panel]') === null)).toBe(true);
  expect(await activeFilters.evaluate((element) => element.closest('[data-dashboard-panel]') === null)).toBe(true);
  const [providerBox, heroBox] = await Promise.all([providerPanel.boundingBox(), overviewHero.boundingBox()]);
  expect(heroBox?.y).toBeLessThan(providerBox?.y ?? 0);

  await expect(providerDetails).toBeVisible();
  await expect(attentionProviders).toBeVisible();
  const categoryLabel = await providerCategories.getAttribute('aria-label');
  const providerTotal = Number(categoryLabel?.match(PROVIDER_CATEGORY_TOTAL_PATTERN)?.[1]);
  const categoryCounts = (await providerCategories.getByRole('listitem').allTextContents()).map((text) =>
    Number(text.match(PROVIDER_CATEGORY_COUNT_PATTERN)?.[1]),
  );
  expect(categoryCounts.every(Number.isFinite)).toBe(true);
  expect(categoryCounts.reduce((total, count) => total + count, 0)).toBe(providerTotal);
  await expect(noQuotaDetail).not.toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await providerDetails.click();
  await expect(providerDisclosure).toHaveAttribute('open', '');
  await expect(noQuotaDetail).toBeVisible();
  expect(await providerPanel.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    await providerPanel.evaluate((element) => element.clientWidth),
  );
});

test('Provider quota history shows reset and gap-aware ranges on desktop and mobile', async ({ page }) => {
  await openHydratedReport(page);

  const historyButton = page.getByRole('button', { name: 'View quota history' });
  await expect(historyButton).toHaveCount(1);
  await historyButton.click();
  const history = page.getByRole('dialog', { name: 'Provider quota history' });
  await expect(history.getByRole('heading', { name: 'Provider quota history' })).toBeVisible();
  await expect(history.getByText('5h', { exact: true }).first()).toBeVisible();
  await expect(history.getByText('Weekly', { exact: true }).first()).toBeVisible();
  await expect(history.getByText(RESET_COUNT_PATTERN).first()).toBeVisible();
  await expect(history.getByText(GAP_COUNT_PATTERN).first()).toBeVisible();

  const providerSelect = history.getByRole('combobox', { name: 'Provider' });
  await expect(providerSelect.locator('option[value="codex"]')).toHaveCount(1);
  await expect(providerSelect.locator('option[value="claude"]')).toHaveCount(1);
  const claudeSeries = history.getByText(CLAUDE_SERIES_PATTERN);
  await expect(claudeSeries.first()).toBeVisible();
  await providerSelect.selectOption('codex');
  await expect(claudeSeries).toHaveCount(0);
  await providerSelect.selectOption('');
  await expect(claudeSeries.first()).toBeVisible();

  await history.getByRole('button', { name: '7d' }).click();
  await expect(history.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();

  await page.setViewportSize({ height: 800, width: 390 });
  await historyButton.click();
  await expect(page.getByRole('dialog', { name: 'Provider quota history' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Provider quota history' })).not.toBeVisible();
});

test('persists exploration state in the URL', async ({ page }) => {
  await openHydratedReport(page);
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads'))).toBeUndefined();
  await page.keyboard.press('/');

  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await search.fill('ai-usage');
  await search.press('Enter');

  await expect(page).toHaveURL(QUERY_URL_PATTERN);
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads'))).toBeUndefined();
  await page.reload();
  await expect(search).toHaveValue('ai-usage');
});

test('shows the text query as a directly removable active filter', async ({ page }) => {
  await openHydratedReport(page);

  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await search.fill('ai-usage');
  await expect(page).toHaveURL(QUERY_URL_PATTERN);

  const queryFilter = page.getByRole('button', { name: 'Query: ai-usage ×' });
  await expect(queryFilter).toBeVisible();
  await queryFilter.click();
  await expect(search).toHaveValue('');
  await expect(page).not.toHaveURL(QUERY_URL_PATTERN);
});

test('updates the date range and opens a session drawer', async ({ page }) => {
  await openHydratedReport(page, '/?origin=%5B%5D');
  const range = page.getByRole('region', { name: 'Report period' });

  await range.getByRole('button', { exact: true, name: 'All time' }).click();
  await expect(page).toHaveURL(RANGE_URL_PATTERN);
  await expect(range.getByText('Apr 12 → Jun 11, 2026 · 60 days', { exact: true })).toBeVisible();

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  await page.locator('tbody tr').first().locator('td').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('opens a session from Overview without leaving the current analysis', async ({ page }) => {
  await openHydratedReport(page);

  const sessionTrigger = overviewTopSessionTrigger(page);
  await expect(sessionTrigger).toHaveAccessibleName(OPEN_BUILD_REPORT_UI_ACCESSIBLE_NAME_PATTERN);
  await expect(page.getByRole('button', { name: OPEN_BUILD_REPORT_UI_PATTERN })).toHaveCount(1);
  await expect(sessionTrigger.locator('span[aria-hidden="true"]', { hasText: '↗' })).toHaveCount(1);
  await sessionTrigger.click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('navigates and closes the selected session with drawer keyboard commands', async ({ page }) => {
  await openHydratedReport(page);
  const sessionTrigger = overviewTopSessionTrigger(page);
  await sessionTrigger.click();

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer.getByText('Build report UI', { exact: true }).first()).toBeVisible();
  const headerActions = [
    drawer.getByRole('button', { name: 'Previous session (k)' }),
    drawer.getByRole('button', { name: 'Next session (j)' }),
    drawer.getByRole('button', { name: 'Close session details' }),
  ];
  for (const action of headerActions) {
    const actionBox = await action.boundingBox();
    expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(actionBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('j');
  await expect(drawer.getByText('Review analytics model', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('k');
  await expect(drawer.getByText('Build report UI', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(sessionTrigger).toBeFocused();
});

test('starts sessions with focused work columns and switches metric presets', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1024 });
  await openHydratedReport(page);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();

  const columnHeaders = page.getByRole('columnheader');
  const workPreset = page.getByRole('button', { exact: true, name: 'Work' });
  await expect(workPreset).toHaveAttribute('aria-pressed', 'true');
  await expect(columnHeaders).toHaveText([
    DATE_HEADER_PATTERN,
    'Session',
    'Harness',
    'Project',
    'Model',
    'API value',
    'Time',
  ]);
  const presetGroup = page.getByRole('group', { name: 'Session column presets' });
  await expect(presetGroup).toHaveCSS('gap', '2px');
  expect(Math.round((await workPreset.boundingBox())?.height ?? 0)).toBe(26);
  const advancedColumns = page.getByRole('button', { name: ADVANCED_COLUMNS_PATTERN });
  expect(Math.round((await advancedColumns.boundingBox())?.height ?? 0)).toBe(30);
  await advancedColumns.click();
  await expect(page.getByText('7 of 25 columns shown', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'RTK token savings' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ height: 1000, width: 1440 });
  const campaignRow = page.getByRole('row').filter({ hasText: 'Build report UI' }).first();
  await expect(campaignRow).not.toContainText('root-session time');
  expect(await campaignRow.evaluate((row) => row.tabIndex === 0 && row.getBoundingClientRect().height >= 44)).toBe(
    true,
  );
  const rowColumnEdges = await page.locator('tbody tr[data-session-row-id]').evaluateAll((rows) =>
    rows.slice(0, 3).map((row) =>
      [...row.children].map((cell) => {
        const { left, right } = cell.getBoundingClientRect();
        return [Math.round(left), Math.round(right)];
      }),
    ),
  );
  expect(rowColumnEdges).toHaveLength(3);
  expect(rowColumnEdges[1]).toEqual(rowColumnEdges[0]);
  expect(rowColumnEdges[2]).toEqual(rowColumnEdges[0]);
  await page.setViewportSize({ height: 900, width: 1024 });

  const sessionHeader = page.getByRole('columnheader', { name: 'Session' });
  await sessionHeader.getByRole('button').click();
  const sessionSortArrow = sessionHeader.locator('[aria-hidden="true"]');
  await expect(sessionSortArrow).toHaveCSS('color', 'rgb(172, 75, 18)');
  await expect(sessionSortArrow).toHaveCSS('font-size', '10px');
  await expect(sessionSortArrow).toHaveCSS('line-height', '10px');
  expect(
    await page.getByRole('table').evaluate((table) => table.scrollWidth <= (table.parentElement?.clientWidth ?? 0)),
  ).toBe(true);

  await page.getByRole('table').evaluate((table) => table.setAttribute('data-stability-marker', 'session-table'));
  await page.getByRole('button', { exact: true, name: 'Tokens' }).click();
  await expect(page.getByRole('button', { exact: true, name: 'Tokens' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('table')).toHaveAttribute('data-stability-marker', 'session-table');
  await expect(page.getByText('Preparing sessions…', { exact: true })).toHaveCount(0);
  await expect(columnHeaders).toHaveText(TOKEN_SESSION_HEADERS);
});

test('renders a human campaign root as not a subagent', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1024 });
  await openHydratedReport(page, '/?tab=sessions');

  const advancedColumns = page.getByRole('button', { name: ADVANCED_COLUMNS_PATTERN });
  await advancedColumns.click();
  await page.getByText('Subagent', { exact: true }).click();
  await expect(page).toHaveURL(COLUMN_URL_PATTERN);
  await advancedColumns.click();
  await expect(page.getByRole('checkbox', { name: 'Subagent' })).toBeChecked();

  const humanCampaignRoot = page.getByRole('row').filter({ hasText: 'Build report UI' }).first();
  await expect(humanCampaignRoot.getByRole('cell').last()).toHaveText('No');
});

test('uses the report range as the only graph viewport', async ({ page }) => {
  await openHydratedReport(page);

  const activity = page.getByRole('region', { name: 'Activity' });
  await expect(activity.getByRole('button', { name: 'Zoom chart' })).toHaveCount(0);
  await expect(activity.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);
  await expect(activity.getByText('Custom chart view', { exact: true })).toHaveCount(0);
  await expect(activity.getByText('Explore activity', { exact: true })).toBeVisible();
});

test('offers keyboard-safe charts and mobile summaries at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 361 });
  await openHydratedReport(page);

  const calendar = page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN });
  const focusedCalendarDay = calendar.locator('button[tabindex="0"]');
  await expect(focusedCalendarDay).toHaveCount(1);
  const initialDayLabel = await focusedCalendarDay.getAttribute('aria-label');
  await focusedCalendarDay.focus();
  await focusedCalendarDay.press('ArrowLeft');
  await expect(calendar.locator('button:focus')).not.toHaveAttribute('aria-label', initialDayLabel ?? '');
  await expect(calendar.locator('button[tabindex="0"]')).toHaveCount(1);

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  const sessionSummaries = page.getByRole('list', { name: 'Session summaries' });
  await expect(sessionSummaries).toBeVisible();
  await expect(page.locator('[data-session-surface="mobile"]')).toHaveCount(1);
  await expect(page.locator('[data-session-surface="desktop"]')).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  const sessionControlGeometry = await page
    .locator('[data-session-surface="mobile"]')
    .locator('button:visible, input:visible, a:visible, select:visible')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          clipped: element.scrollWidth > element.clientWidth + 1,
          height: Math.floor(box.height),
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
          width: Math.floor(box.width),
        };
      }),
    );
  expect(sessionControlGeometry.length).toBeGreaterThan(0);
  expect(sessionControlGeometry.filter(({ clipped, height, width }) => clipped || height < 44 || width < 44)).toEqual(
    [],
  );
  expect(
    await page
      .locator('[data-session-card-height]')
      .evaluateAll((cards) => cards.every((card) => card.scrollHeight <= card.clientHeight)),
  ).toBe(true);
  const mobileSort = page.getByRole('combobox', { name: 'Sort mobile session summaries' });
  expect(Math.round((await mobileSort.boundingBox())?.height ?? 0)).toBe(44);
  const sortDirection = page.getByRole('button', { name: 'Sort ascending' });
  expect(Math.round((await sortDirection.boundingBox())?.height ?? 0)).toBe(48);
  await expect(sessionSummaries).toHaveCSS('border-top-width', '0px');
  await expect(sessionSummaries).toHaveCSS('box-shadow', 'none');
  const firstSummary = sessionSummaries.locator('article').first();
  const firstSummaryWidthDelta = await firstSummary.evaluate(
    (article) =>
      article.parentElement!.parentElement!.getBoundingClientRect().width - article.getBoundingClientRect().width,
  );
  expect(firstSummaryWidthDelta).toBe(0);
  const inspectSession = sessionSummaries.getByRole('button', { name: INSPECT_SESSION_PATTERN }).first();
  expect(Math.round((await inspectSession.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44);
  await mobileSort.selectOption('fresh');
  await expect(mobileSort).toHaveValue('fresh');
  await expect(page).toHaveURL(SORT_URL_PATTERN);
  await inspectSession.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Analysis' }).click();
  const breakdownTabs = page.getByRole('tablist', { name: 'Analysis dimension' });
  await expect(breakdownTabs.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  await breakdownTabs.getByRole('tab', { name: 'Projects' }).click();
  await expect(page.getByRole('list', { name: 'Project summaries' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('keeps compact heatmap geometry at narrow and desktop viewports', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 361 });
  await openHydratedReport(page);

  const calendar = page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN });
  const cell = calendar.locator('button').first();

  const narrowCellBox = await cell.boundingBox();
  expect(Math.round(narrowCellBox?.width ?? 0)).toBe(18);
  expect(Math.round(narrowCellBox?.height ?? 0)).toBe(18);
  await expect(calendar).toHaveCSS('column-gap', '3px');

  await page.setViewportSize({ height: 900, width: 1024 });
  const desktopCellBox = await cell.boundingBox();
  expect(Math.round(desktopCellBox?.width ?? 0)).toBe(12);
  expect(Math.round(desktopCellBox?.height ?? 0)).toBe(12);
  await expect(calendar).toHaveCSS('column-gap', '3px');
});

test('keeps the Top sessions panel readable without horizontal overflow at desktop width', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openHydratedReport(page);

  const topSessionsPanel = page
    .getByRole('heading', { level: 3, name: 'Top sessions' })
    .locator('xpath=ancestor::section[1]');
  await expect(topSessionsPanel).toBeVisible();
  expect(await topSessionsPanel.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    await topSessionsPanel.evaluate((element) => element.clientWidth),
  );
  expect(await topSessionsPanel.getByRole('button').count()).toBeGreaterThan(0);
});

test('selects the same heatmap day with mouse and keyboard', async ({ page }) => {
  const selectedDay = '2026-05-25';
  const assertSelectedDay = async () => {
    await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const range = page.getByRole('region', { name: 'Report period' });
    await range.getByRole('button', { name: 'Choose a custom report period' }).click();
    await expect(page.getByRole('textbox', { name: 'From' })).toHaveValue(selectedDay);
    await expect(page.getByRole('textbox', { name: 'To' })).toHaveValue(selectedDay);
  };
  const selectedCell = () =>
    page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN }).locator(`button[data-heatmap-day="${selectedDay}"]`);

  await openHydratedReport(page);
  await selectedCell().click();
  await assertSelectedDay();

  await openHydratedReport(page);
  await selectedCell().focus();
  await selectedCell().press('Enter');
  await assertSelectedDay();
});

test('mounts one Sessions surface across viewport changes without losing state', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 361 });
  await openHydratedReport(page);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  await page.getByRole('button', { name: 'Show children' }).click();
  const mobileSort = page.getByRole('combobox', { name: 'Sort mobile session summaries' });
  await mobileSort.selectOption('fresh');

  await expect(page.locator('[data-session-surface="mobile"]')).toHaveCount(1);
  await expect(page.locator('[data-session-surface="desktop"]')).toHaveCount(0);
  await page.setViewportSize({ height: 900, width: 1024 });
  await expect(page.locator('[data-session-surface="desktop"]')).toHaveCount(1);
  await expect(page.locator('[data-session-surface="mobile"]')).toHaveCount(0);
  await expect(page.locator('tbody tr[data-depth="1"]')).toHaveCount(2);
  await expect(page).toHaveURL(SORT_URL_PATTERN);
  await page.getByRole('button', { exact: true, name: 'Tokens' }).click();
  await expect(page).toHaveURL(COLUMN_URL_PATTERN);
  await page.locator('tbody tr[data-depth]').first().locator('td').last().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.setViewportSize({ height: 800, width: 361 });
  await expect(page.locator('[data-session-surface="mobile"]')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(SORT_URL_PATTERN);
  await expect(page).toHaveURL(COLUMN_URL_PATTERN);
  await page.setViewportSize({ height: 900, width: 1024 });
  await expect(page.getByRole('button', { exact: true, name: 'Tokens' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('tbody tr[data-depth="1"]')).toHaveCount(2);
  await page.keyboard.press('Escape');

  await expect(page.locator('[data-session-surface="desktop"]')).toHaveCount(1);
});

test('keeps sync limited to explicit file transfers', async ({ page }) => {
  let releaseUpload = (): void => undefined;
  const pendingUpload = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route('**/api/manual-merge/upload', async (route) => {
    await pendingUpload;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          bundle: {
            generatedAt: '2026-07-30T12:00:00.000Z',
            machineId: 'peer-machine',
            machineLabel: 'Peer MacBook',
          },
          bytes: 2,
          confirmationToken: `v1.${'b'.repeat(64)}`,
          documentDigest: 'a'.repeat(64),
          kind: 'merge-preview',
          result: {
            deleted: 0,
            fleetChanged: true,
            inserted: 1,
            superseded: 0,
            unchanged: 0,
            updated: 0,
            warnings: 3,
          },
          rows: 1,
          warningCount: 3,
          warningItems: ['A row was skipped.', 'A second row was skipped.'],
        },
        ok: true,
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/sync');

  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export current machine' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Machine fleet' })).toBeVisible();
  await expect(page.getByLabel('Machine fleet').getByText('Current machine', { exact: true })).toBeVisible();
  await page.setViewportSize({ height: 844, width: 361 });
  const fileInput = page.locator('input[type="file"][accept=".json,application/json"]');
  const dropTarget = fileInput.locator('xpath=following-sibling::button[1]');
  await expect(dropTarget).toBeVisible();
  await expect(dropTarget).toContainText('Drop a merge file here or choose a file');
  // The Cursor export is a second explicit file action next to the merge drop zone. The synthetic
  // runtime cannot execute a real import, so this asserts the affordance, not a completed import.
  await expect(page.getByText('Cursor usage export')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import a Cursor usage CSV' })).toBeEnabled();
  await expect(page.locator('input[type="file"][accept=".csv,text/csv"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Start LAN merge' })).toHaveCount(0);
  await expect(page.getByLabel('Scan host')).toHaveCount(0);
  await expect(page.getByText('Pair nearby machine')).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(UUID_PATTERN);

  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({ buffer: Buffer.from('{}'), mimeType: 'application/json', name: 'peer.json' });
  const progress = page.getByRole('progressbar', { name: 'Manual import upload progress' });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveCSS('height', '6px');
  await expect(progress).toHaveCSS('border-top-width', '1px');
  await expect(progress).toHaveCSS('border-radius', '999px');
  await expect(dropTarget).toContainText('Drop a merge file here or choose a file');
  await expect(dropTarget).toHaveCSS('height', '128px');
  const dropTargetBox = await dropTarget.boundingBox();
  const progressBox = await progress.boundingBox();
  expect(dropTargetBox).not.toBeNull();
  expect(progressBox).not.toBeNull();
  expect(progressBox?.width).toBe(dropTargetBox?.width);
  expect(progressBox?.y).toBeGreaterThan((dropTargetBox?.y ?? 0) + (dropTargetBox?.height ?? 0));
  releaseUpload();
  await expect(page.getByText('Preview ready. Review the changes before confirming.')).toBeVisible();

  await expect(page.getByText('Review merge import')).toBeVisible();
  await expect(page.getByText('From Peer MacBook · generated Jul 30, 2026, 12:00')).toBeVisible();
  const warningSummary = page.locator('summary', { hasText: '3 warnings' });
  await expect(warningSummary).toBeVisible();
  await expect(page.getByText('A row was skipped.', { exact: true })).toBeHidden();
  await warningSummary.click();
  await expect(page.getByText('A row was skipped.', { exact: true })).toBeVisible();
  await expect(page.getByText('A second row was skipped.', { exact: true })).toBeVisible();
  await expect(page.getByText('and 1 more', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm import' })).toBeVisible();
});

/**
 * A merge preview's confirmation token is bound to the store generation, so any sibling mutation —
 * a machine rename, a Cursor import — makes it unconfirmable server-side. The UI's job is not to
 * leave an armed Confirm button in front of a proof that can now only fail.
 */
test('drops an armed merge preview after a sibling mutation invalidates its proof', async ({ page }) => {
  const previewBody = {
    data: {
      bundle: {
        generatedAt: '2026-07-30T12:00:00.000Z',
        machineId: 'peer-machine',
        machineLabel: 'Peer MacBook',
      },
      bytes: 2,
      confirmationToken: `v1.${'b'.repeat(64)}`,
      documentDigest: 'a'.repeat(64),
      kind: 'merge-preview',
      result: {
        deleted: 0,
        fleetChanged: true,
        inserted: 1,
        superseded: 0,
        unchanged: 0,
        updated: 0,
        warnings: 0,
      },
      rows: 1,
      warningCount: 0,
      warningItems: [],
    },
    ok: true,
  };
  await page.route('**/api/manual-merge/upload', async (route) => {
    const action = route.request().headers()['x-ai-usage-merge-action'];
    if (action === 'cursor') {
      await route.fulfill({
        body: JSON.stringify({
          data: { alreadyImported: false, artifactName: 'cursor-import.csv', kind: 'cursor-import' },
          ok: true,
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.fulfill({ body: JSON.stringify(previewBody), contentType: 'application/json', status: 200 });
  });
  await page.route('**/rpc/sync/setMachineLabel', async (route) => {
    await route.fulfill({
      body: encodeRpcResponseBody({ machine: { id: 'e2e-current-machine', label: 'Renamed Machine' } }),
      contentType: 'application/json',
      status: 200,
    });
  });

  const mergeFile = { buffer: Buffer.from('{}'), mimeType: 'application/json', name: 'merge.json' };
  const cursorFile = { buffer: Buffer.from('Date,Model\n'), mimeType: 'text/csv', name: 'cursor.csv' };
  const mergeInput = page.locator('input[type="file"][accept=".json,application/json"]');
  const cursorInput = page.locator('input[type="file"][accept=".csv,text/csv"]');
  const confirmButton = page.getByRole('button', { name: 'Confirm import' });

  await page.goto('/sync');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();

  // Both affordances only arm once the control connection reports itself available; acting
  // before that silently does nothing rather than failing.
  await expect(mergeInput).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();

  // A rename is the mutation furthest from the preview, and the one most likely to be treated as
  // unrelated to it.
  await mergeInput.setInputFiles(mergeFile);
  await expect(confirmButton).toBeVisible();
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Machine label').fill('Renamed Machine');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(confirmButton).toBeHidden();

  // Importing a Cursor export moves the generation too, even though it stages an artifact rather
  // than merging rows.
  await mergeInput.setInputFiles(mergeFile);
  await expect(confirmButton).toBeVisible();
  await cursorInput.setInputFiles(cursorFile);
  await expect(confirmButton).toBeHidden();
  // Dropping the stale preview must not also discard what the user just did. Remounting the
  // whole panel would clear this message along with the preview.
  await expect(
    page.getByText('Import staged as cursor-import.csv. Collection picks it up automatically.'),
  ).toBeVisible();
});
