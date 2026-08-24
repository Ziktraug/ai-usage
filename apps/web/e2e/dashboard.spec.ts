import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { FOCUSED_REPORT_E2E_CONTROL_KEY, FOCUSED_REPORT_E2E_ENABLED_KEY } from '../src/focused-report-e2e-fixture';
import { REPORT_LAZY_MODULE_E2E_FAILURE_KEY } from '../src/lib/features/report/composition/lazy-module-e2e-fixture';
import { expect, reportViewsFor, test, waitForFocusedReportSettled, waitForHydratedNavigation } from './browser-test';
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
const PROVIDER_SUMMARY_PATTERN =
  /^(\d+) providers? · (\d+) reporting a usage limit · (\d+) with no limit reading(?: \([^)]*\))?(?: · (\d+) critical)?(?: · \d+ with warnings)?$/;
const PROVIDER_LINE_PATTERN = / — (?:partial|unsupported|ok|stale|auth required|error)/;
const SEPARATOR_SPACING_PATTERN = /\S·|·\S/;
const QUERY_URL_PATTERN = /q=ai-usage/;
const RANGE_URL_PATTERN = /range=/;
const RESET_COUNT_PATTERN = /1 reset/;
const GAP_COUNT_PATTERN = /1 collection gap/;
const CLAUDE_SERIES_PATTERN = /^Claude · /;
const CURSOR_SCORED_AT_PATTERN = /^Scored /;
const SORT_URL_PATTERN = /sort=/;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const HIDDEN_FILTERS_PATTERN = /hidden by filters/;
/** The quota chart's authored viewBox is 600x200; the drawer must present it at that ratio. */
const QUOTA_CHART_ASPECT_RATIO = 3;
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

/**
 * Period scoping through the real tab and the real range URL. The synthetic payload ships a single
 * Cursor row, so this test deliberately does NOT prove per-commit de-duplication -- that is pinned
 * at DOM level in cursor-attribution-panel.ssr.test.ts, which renders three branch rows of one
 * commit plus a same-branch disagreement.
 */
test('scopes the Cursor AI analysis to the report period', async ({ page }) => {
  await openHydratedReport(page, '/?tab=cursor-ai');
  const breakdownTabs = page.getByRole('tablist', { name: 'Analysis dimension' });
  await expect(breakdownTabs.getByRole('tab', { name: 'Cursor AI' })).toHaveAttribute('aria-selected', 'true');
  // The default 30d window (May 12 -> Jun 11, 2026 in the fixture) excludes the Mar 6 fixture commit.
  await expect(page.locator('[data-cursor-empty-state="period"]')).toHaveText(
    'No Cursor commits in this period · 1 scored commit outside it',
  );
  await expect(page.locator('[data-cursor-commit]')).toHaveCount(0);

  await openHydratedReport(
    page,
    `/?${new URLSearchParams({ range: JSON.stringify({ mode: 'all' }), tab: 'cursor-ai' }).toString()}`,
  );
  const commitRows = page.locator('[data-cursor-commit]');
  await expect(commitRows).toHaveCount(1);
  await expect(commitRows.first()).toHaveAttribute('data-cursor-commit', 'da59e06cc4c9627584edec0f8dc06f7e4cdd199d');
  await expect(commitRows.first().locator('[data-cursor-branch-count]')).toHaveText('main');
  await expect(commitRows.first().locator('[data-cursor-date-source]')).toHaveAttribute(
    'data-cursor-date-source',
    'commit',
  );
  // The scoring time and the date rule are readable without hovering a native tooltip.
  await expect(commitRows.first().locator('[data-cursor-scored-at]')).toHaveText(CURSOR_SCORED_AT_PATTERN);
  await expect(page.locator('#cursor-attribution-table-description')).toBeVisible();
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

test('summarizes providers with no limit reading per machine and shows details only when they exist', async ({
  page,
}) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await openHydratedReport(page);

  const providerPanel = page
    .getByRole('heading', { level: 2, name: 'Provider status' })
    .locator('xpath=ancestor::section[1]');
  const dateRange = page.getByRole('region', { name: 'Report period' });
  const activeFilters = page.locator('[data-active-filters]');
  const overviewHero = page.getByRole('region', { name: 'Estimated API-equivalent value' });
  const executiveMetrics = page.locator('[data-executive-metrics]');

  await expect(providerPanel).toContainText('Quota usage and operational issues at a glance.');
  expect(await providerPanel.evaluate((element) => element.closest('[data-report-overview]') !== null)).toBe(true);
  expect(await executiveMetrics.evaluate((element) => element.closest('[data-dashboard-panel]') !== null)).toBe(true);
  expect(await dateRange.evaluate((element) => element.closest('[data-dashboard-panel]') === null)).toBe(true);
  expect(await activeFilters.evaluate((element) => element.closest('[data-dashboard-panel]') === null)).toBe(true);
  const [providerBox, heroBox] = await Promise.all([providerPanel.boundingBox(), overviewHero.boundingBox()]);
  expect(heroBox?.y).toBeLessThan(providerBox?.y ?? 0);

  const summary = providerPanel.locator('[data-provider-status-summary]');
  const lines = providerPanel.getByRole('list', { name: 'Providers with no limit reading' }).getByRole('listitem');
  const glossary = providerPanel.locator('[data-provider-state-glossary]');
  // Pinned to the fixture, not only to its own internal arithmetic: the e2e report infers Codex,
  // Claude and OpenCode on Fixture Machine, Cursor on Fixture Machine Secondary, and a second
  // OpenCode from the row that carries no source at all — which is why the last line has no machine
  // prefix, and why the same label legitimately appears on two lines. Checking the identity alone
  // lets a wrong count agree with itself.
  await expect(summary).toHaveText(
    '5 providers · 0 reporting a usage limit · 5 with no limit reading (4 partial, 1 unsupported)',
  );
  const [, total, withQuota, withoutSource, critical] =
    (await summary.textContent())?.match(PROVIDER_SUMMARY_PATTERN) ?? [];
  expect(Number(withQuota) + Number(withoutSource) + Number(critical ?? 0)).toBe(Number(total));
  const lineTexts = await lines.allTextContents();
  expect(lineTexts).toEqual([
    'Fixture Machine · Codex, OpenCode — partial · Claude — unsupported',
    'Fixture Machine Secondary · Cursor — partial',
    'OpenCode — partial',
  ]);
  // Every provider the sentence counts is named on exactly one machine line.
  const namedProviders = lineTexts.flatMap((line) =>
    ['Codex', 'Claude', 'Cursor', 'OpenCode'].filter((label) => line.includes(label)),
  );
  expect(namedProviders).toHaveLength(Number(withoutSource));
  for (const line of lineTexts) {
    expect(line).toMatch(PROVIDER_LINE_PATTERN);
    expect(line).not.toMatch(SEPARATOR_SPACING_PATTERN);
  }
  await expect(glossary).toContainText('Partial =');
  await expect(glossary).toContainText('Unsupported =');
  // Plan 086's copy rule, over everything the panel renders — not just the glossary.
  expect((await providerPanel.innerText()).toLowerCase()).not.toContain('quota window');
  await expect(page.getByText(PROVIDER_DETAILS_PATTERN)).toHaveCount(0);
  await expect(page.getByText('No usage limit was read for this provider.')).toHaveCount(0);

  await page.setViewportSize({ height: 844, width: 390 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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

  const historyRoot = history.locator('[data-quota-history]');
  await expect(historyRoot).toHaveAttribute('data-quota-window-from', '2026-07-14T10:40:00.000Z');
  await expect(historyRoot).toHaveAttribute('data-quota-window-to', '2026-07-15T10:40:00.000Z');
  const carriedIn = history.locator('[data-quota-carried-in]');
  await expect(carriedIn).toHaveCount(1);
  await expect(carriedIn).toHaveAttribute('cx', '20');

  const chart = history.locator('article', { hasText: RESET_COUNT_PATTERN }).first().locator('[data-quota-chart]');
  await expect(chart.locator('css=text')).toHaveCount(0);
  const geometry = await chart.evaluate((svg) => {
    // `querySelectorAll('*')` is document order, so painting order is index order: a guide drawn
    // before every series path can never be painted over the data it annotates.
    const ordered = [...svg.querySelectorAll('*')];
    const indexesOf = (selector: string) =>
      ordered.flatMap((element, index) => (element.matches(selector) ? [index] : []));
    const rects = (selector: string) => [...svg.querySelectorAll(selector)].map((el) => el.getBoundingClientRect());
    const guideIndexes = indexesOf('[data-quota-break-guide]');
    const pathIndexes = indexesOf('[data-quota-series-path]');
    const markerRects = rects('[data-quota-break-marker]');
    const pointRects = rects('[data-quota-point]');
    const svgRect = svg.getBoundingClientRect();
    const firstPoint = pointRects[0];
    return {
      guideCount: guideIndexes.length,
      lastGuideIndex: guideIndexes.at(-1) ?? -1,
      firstPathIndex: pathIndexes[0] ?? -1,
      markerBottom: markerRects.length > 0 ? Math.max(...markerRects.map((r) => r.bottom)) : -1,
      markerCount: markerRects.length,
      pathCount: pathIndexes.length,
      pointAspectRatio: firstPoint && firstPoint.height > 0 ? firstPoint.width / firstPoint.height : 0,
      pointCount: pointRects.length,
      pointTop: pointRects.length > 0 ? Math.min(...pointRects.map((r) => r.top)) : -1,
      svgAspectRatio: svgRect.height > 0 ? svgRect.width / svgRect.height : 0,
    };
  });
  // Counts first: without them `Math.min(...[])`/`Math.max(...[])` are ±Infinity and every ordering
  // and separation assertion below would pass by an element vanishing from the chart entirely.
  expect(geometry.guideCount).toBeGreaterThan(0);
  expect(geometry.pathCount).toBeGreaterThan(0);
  expect(geometry.markerCount).toBeGreaterThan(0);
  expect(geometry.pointCount).toBeGreaterThan(0);
  expect(geometry.lastGuideIndex).toBeLessThan(geometry.firstPathIndex);
  expect(geometry.markerBottom).toBeLessThanOrEqual(geometry.pointTop);
  // A stretched viewBox renders an r=3 circle as an ellipse (~0.63 wide) and squashes the chart out
  // of the ratio its geometry is drawn in. Uniform scaling keeps both at their authored proportions.
  expect(Math.abs(geometry.pointAspectRatio - 1)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(geometry.svgAspectRatio - QUOTA_CHART_ASPECT_RATIO)).toBeLessThanOrEqual(0.05);

  const controlWidths = await Promise.all(
    ['Provider', 'Machine', 'Account scope'].map(
      async (name) => (await history.getByRole('combobox', { name }).boundingBox())?.width ?? 0,
    ),
  );
  expect(Math.max(...controlWidths) - Math.min(...controlWidths)).toBeLessThanOrEqual(1);
  expect(Math.min(...controlWidths)).toBeGreaterThanOrEqual(120);

  const rangeBox = await history.getByRole('button', { name: '24h' }).boundingBox();
  const selectBox = await history.getByRole('combobox', { name: 'Provider' }).boundingBox();
  expect(rangeBox?.width ?? 0).toBeGreaterThanOrEqual(56);
  expect(Math.abs((rangeBox?.height ?? 0) - (selectBox?.height ?? 0))).toBeLessThanOrEqual(1);

  // The words the SVG no longer carries have to exist somewhere a reader can read them: the legend,
  // the HTML axis under each chart, and the per-series footer. Deleting any of them must fail here.
  const legend = history.locator('[data-quota-legend]');
  await expect(legend).toHaveCount(1);
  await expect(legend).toHaveText('▼ reset boundary · ▽ collection gap · ○ held from before the window');

  const carriedInArticle = history.locator('article', { hasText: RESET_COUNT_PATTERN }).first();
  const axisLabels = carriedInArticle.locator('[data-quota-axis] span');
  await expect(axisLabels).toHaveCount(3);
  const axisAt24h = await axisLabels.allTextContents();
  for (const label of axisAt24h) {
    expect(label.trim()).not.toBe('');
  }
  expect(axisAt24h[0]).not.toBe(axisAt24h[2]);

  const footer = carriedInArticle.locator('[data-quota-series-footer]');
  await expect(footer).toContainText('Latest observation');
  await expect(footer).toContainText('held at 48% since');
  await expect(footer).toContainText('Next reset');
  await expect(history.locator('[data-quota-hold-line]')).toHaveCount(1);
  const carriedInRow = carriedInArticle.locator('[data-quota-carried-in-row]');
  await expect(carriedInRow).toHaveCount(1);
  await expect(carriedInRow).toContainText('held since');
  await expect(carriedInRow).toContainText('48%');

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
  await expect(historyRoot).toHaveAttribute('data-quota-window-from', '2026-07-08T10:40:00.000Z');
  await expect(carriedIn).toHaveCount(0);
  // The held value is in range at 7d, so every trace of carrying it in must be gone with it.
  await expect(history.locator('[data-quota-hold-line]')).toHaveCount(0);
  await expect(history.locator('[data-quota-carried-in-row]')).toHaveCount(0);
  await expect(history.locator('[data-quota-series-footer]').first()).not.toContainText('held at');
  // The axis is bound to the window, not to a fixed caption: a wider range must relabel it.
  await expect
    .poll(async () => (await history.locator('[data-quota-axis]').first().locator('span').allTextContents())[0])
    .not.toBe(axisAt24h[0]);
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();

  await page.setViewportSize({ height: 800, width: 390 });
  await historyButton.click();
  await expect(page.getByRole('dialog', { name: 'Provider quota history' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Provider quota history' })).not.toBeVisible();
});

test('keeps the collection source pill independent of the report filter', async ({ page }) => {
  await openHydratedReport(page);
  const summary = page.locator('[data-source-summary]');
  const status = summary.locator('[data-source-summary-status]');
  await expect(status).toHaveText('Sources ready');
  const generation = await summary.getAttribute('data-source-summary-generation');
  expect(generation).not.toBeNull();
  expect(generation).not.toBe('');

  // The filter is applied and then removed through the search box and its active-filter chip rather
  // than through the harness dropdown: what this guards is that *a report filter transition* leaves
  // the engine-owned pill untouched, and plan 092 replaces the dropdown's mechanic. Both controls
  // used here are already pinned by sibling tests in this file, so the guard survives that change.
  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await search.fill('ai-usage');
  await search.press('Enter');
  await expect(page).toHaveURL(QUERY_URL_PATTERN);
  await waitForFocusedReportSettled(page);

  await expect(status).toHaveText('Sources ready');
  expect(await summary.getAttribute('data-source-summary-generation')).toBe(generation);

  await page.getByRole('button', { name: 'Query: ai-usage ×' }).click();
  await expect(page).not.toHaveURL(QUERY_URL_PATTERN);
  await waitForFocusedReportSettled(page);

  await expect(status).toHaveText('Sources ready');
  expect(await summary.getAttribute('data-source-summary-generation')).toBe(generation);
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
  await expect(range.getByText('Apr 12 → Jun 11, 2026 · 61 days', { exact: true })).toBeVisible();

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
  // The Overview row describes the campaign, so the drawer it opens must describe the
  // same campaign — the same total the trigger's accessible name already pins.
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer.locator('[data-session-drawer-campaign-scope]')).toHaveText('Campaign · 3 sessions');
  await expect(drawer.locator('[data-detail-item="API value"]')).toContainText('$4.21');
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
  expect(Math.round((await sortDirection.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44);
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
    await waitForFocusedReportSettled(page);
    await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const range = page.getByRole('region', { name: 'Report period' });
    await range.getByRole('button', { name: 'Choose a custom report period' }).click();
    await expect(page.getByRole('textbox', { name: 'From' })).toHaveValue(selectedDay);
    await expect(page.getByRole('textbox', { name: 'From' })).toHaveAttribute('placeholder', 'YYYY-MM-DD');
    await expect(page.getByRole('textbox', { name: 'To' })).toHaveValue(selectedDay);
    await expect(page.getByRole('textbox', { name: 'To' })).toHaveAttribute('placeholder', 'YYYY-MM-DD');
    await expect(range.getByText('May 25 → May 25, 2026 · 1 day', { exact: true })).toBeVisible();
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
