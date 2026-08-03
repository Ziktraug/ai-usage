import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { FOCUSED_REPORT_E2E_CONTROL_KEY, FOCUSED_REPORT_E2E_ENABLED_KEY } from '../src/focused-report-e2e-fixture';
import { expect, reportViewsFor, test } from './browser-test';

const ADVANCED_COLUMNS_PATTERN = /Advanced columns/;
const CALENDAR_NAME_PATTERN = /Daily activity calendar/;
const COLUMN_URL_PATTERN = /cols=/;
const DATE_HEADER_PATTERN = /Date/;
const ESTIMATED_API_VALUE_HELP_PATTERN =
  /Estimated API-equivalent value at standard prices for \d+ of \d+ fully priced sessions, including usage covered by subscriptions/;
const HYDRATION_TIMEOUT_MS = 15_000;
const INSPECT_SESSION_PATTERN = /Inspect session/;
const LEGACY_PROJECT_TAB_URL_PATTERN = /tab=projects/;
const PROVIDER_DETAILS_PATTERN = /^Provider details \(/;
const PUNCHCARD_FILTER_PATTERN = /^Filter report to /;
const PROVIDER_CATEGORY_COUNT_PATTERN = /: (\d+) providers?$/;
const PROVIDER_CATEGORY_TOTAL_PATTERN = /\((\d+) providers?\)$/;
const PROVIDER_CATEGORIES_PATTERN = /^Provider categories/;
const QUERY_URL_PATTERN = /q=ai-usage/;
const RANGE_URL_PATTERN = /range=/;
const RESET_COUNT_PATTERN = /1 reset/;
const GAP_COUNT_PATTERN = /1 collection gap/;
const SORT_URL_PATTERN = /sort=/;
const TOP_SESSION_PATTERN = /Top session/;
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

const PENDING_CLAIM_AUDIT_KEY = '__aiUsageE2EPendingClaimViolations';
const PENDING_CLAIM_OBSERVER_KEY = '__aiUsageE2EPendingClaimObserver';

const startPendingClaimAudit = async (page: Page, query: string): Promise<void> => {
  await page.evaluate(
    ({ auditKey, observerKey, requestedQuery }) => {
      const violations = new Set<string>();
      Reflect.set(globalThis, auditKey, violations);
      const record = (): void => {
        if (new URLSearchParams(window.location.search).get('q') !== requestedQuery) {
          return;
        }
        const main = document.querySelector('main');
        if (!main) {
          return;
        }
        const text = main.textContent ?? '';
        const hasSessionCounter = [...main.querySelectorAll('span')].some((element) => {
          const value = element.textContent?.trim() ?? '';
          return value.includes(' / ') && value.endsWith(' sessions');
        });
        if (hasSessionCounter) {
          violations.add('session counter');
        }
        if (text.includes('hidden by filters')) {
          violations.add('hidden by filters');
        }
        if (text.includes('No sessions')) {
          violations.add('No sessions');
        }
        if (text.includes('$0.00')) {
          violations.add('$0.00');
        }
        if (main.querySelector('[data-metric-grid]')) {
          violations.add('metric tiles');
        }
      };
      const observer = new MutationObserver(record);
      observer.observe(document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      Reflect.set(globalThis, observerKey, observer);
      record();
    },
    { auditKey: PENDING_CLAIM_AUDIT_KEY, observerKey: PENDING_CLAIM_OBSERVER_KEY, requestedQuery: query },
  );
};

const finishPendingClaimAudit = async (page: Page): Promise<string[]> =>
  await page.evaluate(
    ({ auditKey, observerKey }) => {
      const observer = Reflect.get(globalThis, observerKey);
      if (observer instanceof MutationObserver) {
        observer.disconnect();
      }
      const violations = Reflect.get(globalThis, auditKey);
      if (!(violations instanceof Set)) {
        return ['Pending claim audit unavailable'];
      }
      return [...violations].filter((value): value is string => typeof value === 'string');
    },
    {
      auditKey: PENDING_CLAIM_AUDIT_KEY,
      observerKey: PENDING_CLAIM_OBSERVER_KEY,
    },
  );

test('loads a deterministic report overview', async ({ page }) => {
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  const initialHtml = await response?.text();
  expect(initialHtml).not.toContain('Loading report data…');
  expect(initialHtml).toContain('Daily activity calendar');

  await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Date range' })).toBeVisible();
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('locks definitive output while a focused filter response is pending', async ({ page }) => {
  await page.goto('/skills');
  await page.evaluate((enabledKey) => {
    Reflect.set(globalThis, enabledKey, true);
  }, FOCUSED_REPORT_E2E_ENABLED_KEY);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();

  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  const pendingSurface = page.locator('[data-report-pending]');
  await expect(pendingSurface).toHaveCount(0);

  const query = 'pending-filter';
  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await startPendingClaimAudit(page, query);
  await controlFocusedResponse(page, 'arm');
  let violations: string[] = [];
  try {
    await search.fill(query);
    await controlFocusedResponse(page, 'waitUntilBlocked');

    await expect(pendingSurface).toHaveCount(1);
    await expect(pendingSurface).toHaveText('Loading report…');
    await expect(page.getByRole('button', { name: `Query: ${query} ×` })).toBeVisible();
    await expect(page.getByText(SESSION_COUNTER_PATTERN)).toHaveCount(0);
    await expect(page.getByText(HIDDEN_FILTERS_PATTERN)).toHaveCount(0);
    await expect(page.getByText(NO_SESSIONS_PATTERN)).toHaveCount(0);
    await expect(page.getByText('$0.00', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-metric-grid]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Date range' })).toHaveCount(0);
  } finally {
    violations = await finishPendingClaimAudit(page);
    await controlFocusedResponse(page, 'release');
  }

  expect(violations).toEqual([]);
  await expect(pendingSurface).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Date range' })).toBeVisible();
  await expect(page.getByText('0 / 6 sessions', { exact: true })).toBeVisible();
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

test('uses one primary navigation while preserving Breakdown deep links and sub-tabs', async ({ page }) => {
  await openHydratedReport(page, '/?tab=sessions');

  const reportViews = reportViewsFor(page);
  await expect(reportViews).toHaveCount(1);
  await expect(reportViews.getByRole('link')).toHaveText(['Overview', 'Sessions', 'Breakdown']);
  await expect(page.getByRole('tablist', { name: 'Dashboard sections' })).toHaveCount(0);
  await expect(reportViews.getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('table')).toBeVisible();

  await openHydratedReport(page, '/?tab=models');
  await expect(reportViews.getByRole('link', { exact: true, name: 'Breakdown' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const breakdownTabs = page.getByRole('tablist', { name: 'Breakdown dimension' });
  await expect(breakdownTabs.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('By model', { exact: true })).toBeVisible();

  await breakdownTabs.getByRole('tab', { name: 'Projects' }).click();
  await expect(page.getByRole('columnheader', { name: 'Project' })).toBeVisible();
  await expect(page.getByText('Manage project groups', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(LEGACY_PROJECT_TAB_URL_PATTERN);
});

test('copies the exact breakdown URL and exports only visible sorted model rows', async ({ page }) => {
  await openHydratedReport(page, '/?tab=models&breakdownSort=sessions');
  await expect(page.getByText('By model', { exact: true })).toBeVisible();

  const localSearch = page.getByRole('searchbox', { name: 'Search this breakdown' });
  await localSearch.fill('cod');
  const visibleRows = page.locator('[data-price-state]');
  await expect(visibleRows).toHaveCount(2);
  await expect(visibleRows.getByRole('button')).toHaveText(['qwen3-coder', 'gpt-5.3-codex']);

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
      'qwen3-coder,2,97600,144000,63.716814159292035,1.68,$1.68,complete,2,2,0,0,0',
      'gpt-5.3-codex,1,73500,130000,67.70833333333334,3.2,$3.20,complete,1,1,0,0,0',
      '',
    ].join('\r\n'),
  );
});

test('shows analysis and report metrics without disclosure gates', async ({ page }) => {
  await openHydratedReport(page);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });

  const apiValueHelp = page.getByRole('button', { name: 'About API value' });
  await expect(apiValueHelp).toBeVisible();
  await apiValueHelp.click();
  await expect(page.getByText(ESTIMATED_API_VALUE_HELP_PATTERN)).toBeVisible();

  const advancedSummary = page.locator('summary').filter({ hasText: 'Advanced analysis' });
  const punchcard = page.getByRole('heading', { level: 2, name: 'Punchcard' });
  await expect(page.getByRole('heading', { level: 2, name: 'Advanced analysis' })).toBeVisible();
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
  await expect(punchcardTable.getByRole('row', { name: 'Sunday 14:00 1 $0.84' })).toBeAttached();
  const punchcardVisual = page.locator('[data-punchcard-visual]');
  await expect(punchcardVisual).not.toHaveAttribute('aria-hidden', 'true');
  expect(await punchcardVisual.getByRole('button', { name: PUNCHCARD_FILTER_PATTERN }).count()).toBeGreaterThan(0);

  const reportMetrics = page.getByRole('region', { name: 'More report metrics' });
  await expect(reportMetrics.getByRole('heading', { level: 2, name: 'More report metrics' })).toBeVisible();
  await expect(reportMetrics.getByRole('button', { name: 'More report metrics' })).toHaveCount(0);
  await expect(reportMetrics.getByText('Fresh tokens', { exact: true })).toBeVisible();
});

test('prioritizes the selected dashboard view before secondary status on mobile', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 390 });
  await openHydratedReport(page);

  const dashboardPanel = page.locator('[data-dashboard-panel]');
  const providerStatus = page.getByRole('heading', { level: 2, name: 'Provider status' });
  const [dashboardBox, providerBox] = await Promise.all([dashboardPanel.boundingBox(), providerStatus.boundingBox()]);

  expect(dashboardBox?.y).toBeLessThan(providerBox?.y ?? 0);
  const reportMetrics = page.getByRole('region', { name: 'More report metrics' });
  await expect(reportMetrics).toBeVisible();
  await expect(reportMetrics.getByText('Fresh tokens', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'About API value' })).toBeVisible();
});

test('keeps the selected dashboard view ahead of secondary provider status on desktop', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await openHydratedReport(page);

  const dashboardPanel = page.locator('[data-dashboard-panel]');
  const providerStatus = page.getByRole('heading', { level: 2, name: 'Provider status' });
  const [dashboardBox, providerBox] = await Promise.all([dashboardPanel.boundingBox(), providerStatus.boundingBox()]);

  await expect(page.getByRole('button', { name: 'About API value' })).toBeVisible();
  expect(dashboardBox?.y).toBeLessThan(providerBox?.y ?? 0);
});

test('keeps provider details collapsed until they are requested', async ({ page }) => {
  await openHydratedReport(page);

  const providerDetails = page.getByText(PROVIDER_DETAILS_PATTERN);
  const noQuotaDetail = page.getByText('No quota windows are available for this provider.').first();

  await expect(providerDetails).toBeVisible();
  await expect(page.getByRole('list', { name: 'Providers requiring attention' })).toBeVisible();
  const providerCategories = page.getByRole('list', { name: PROVIDER_CATEGORIES_PATTERN });
  const categoryLabel = await providerCategories.getAttribute('aria-label');
  const providerTotal = Number(categoryLabel?.match(PROVIDER_CATEGORY_TOTAL_PATTERN)?.[1]);
  const categoryCounts = (await providerCategories.getByRole('listitem').allTextContents()).map((text) =>
    Number(text.match(PROVIDER_CATEGORY_COUNT_PATTERN)?.[1]),
  );
  expect(categoryCounts.every(Number.isFinite)).toBe(true);
  expect(categoryCounts.reduce((total, count) => total + count, 0)).toBe(providerTotal);
  await expect(noQuotaDetail).not.toBeVisible();
  await providerDetails.click();
  await expect(noQuotaDetail).toBeVisible();
});

test('Codex quota history shows reset and gap-aware ranges on desktop and mobile', async ({ page }) => {
  await openHydratedReport(page);

  const historyButton = page.getByRole('button', { name: 'View Codex history' });
  await expect(historyButton).toHaveCount(1);
  await historyButton.click();
  const history = page.getByRole('dialog', { name: 'Codex quota history' });
  await expect(history.getByRole('heading', { name: 'Codex quota history' })).toBeVisible();
  await expect(history.getByText('5h', { exact: true }).first()).toBeVisible();
  await expect(history.getByText('Weekly', { exact: true }).first()).toBeVisible();
  await expect(history.getByText(RESET_COUNT_PATTERN).first()).toBeVisible();
  await expect(history.getByText(GAP_COUNT_PATTERN).first()).toBeVisible();
  await history.getByRole('button', { name: '7d' }).click();
  await expect(history.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();

  await page.setViewportSize({ height: 800, width: 390 });
  await historyButton.click();
  await expect(page.getByRole('dialog', { name: 'Codex quota history' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Codex quota history' })).not.toBeVisible();
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
  const range = page.getByRole('region', { name: 'Date range' });

  await range.getByRole('button', { exact: true, name: 'All' }).click();
  await expect(page).toHaveURL(RANGE_URL_PATTERN);
  await expect(range.getByRole('textbox', { name: 'Start date' })).toHaveValue('Apr 12, 2026');

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  await page.locator('tbody tr').first().locator('td').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('opens a session from Overview without leaving the current analysis', async ({ page }) => {
  await openHydratedReport(page);

  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('navigates and closes the selected session with drawer keyboard commands', async ({ page }) => {
  await openHydratedReport(page);
  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer.getByText('Build report UI', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('j');
  await expect(drawer.getByText('Review analytics model', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('k');
  await expect(drawer.getByText('Build report UI', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
});

test('starts sessions with focused work columns and switches metric presets', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1024 });
  await openHydratedReport(page);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();

  const columnHeaders = page.getByRole('columnheader');
  await expect(page.getByRole('button', { exact: true, name: 'Work' })).toHaveAttribute('aria-pressed', 'true');
  await expect(columnHeaders).toHaveText([
    DATE_HEADER_PATTERN,
    'Session',
    'Harness',
    'Project',
    'Model',
    'API value',
    'Time',
  ]);
  expect(
    await page.getByRole('table').evaluate((table) => table.scrollWidth <= (table.parentElement?.clientWidth ?? 0)),
  ).toBe(true);

  await page.getByRole('table').evaluate((table) => table.setAttribute('data-stability-marker', 'session-table'));
  await page.getByRole('button', { exact: true, name: 'Tokens' }).click();
  await expect(page.getByRole('button', { exact: true, name: 'Tokens' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('table')).toHaveAttribute('data-stability-marker', 'session-table');
  await expect(page.getByText('Preparing sessions…', { exact: true })).toHaveCount(0);
  await expect(columnHeaders).toHaveText([DATE_HEADER_PATTERN, 'Session', 'Input', 'Output', 'Cache', 'Fresh']);
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
  await expect(humanCampaignRoot.getByRole('cell', { exact: true, name: 'No' })).toHaveCount(1);
});

test('uses the report range as the only graph viewport', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await expect(dateRange.getByRole('button', { name: 'Zoom chart' })).toHaveCount(0);
  await expect(dateRange.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);
  await expect(dateRange.getByText('Custom chart view', { exact: true })).toHaveCount(0);
  await expect(dateRange.getByText('Activity range follows report range', { exact: true })).toBeVisible();
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
  const mobileSort = page.getByRole('combobox', { name: 'Sort mobile session summaries' });
  await mobileSort.selectOption('fresh');
  await expect(mobileSort).toHaveValue('fresh');
  await expect(page).toHaveURL(SORT_URL_PATTERN);
  await sessionSummaries.getByRole('button', { name: INSPECT_SESSION_PATTERN }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Breakdown' }).click();
  const breakdownTabs = page.getByRole('tablist', { name: 'Breakdown dimension' });
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

test('selects the same heatmap day with mouse and keyboard', async ({ page }) => {
  const selectedDay = '2026-05-25';
  const selectedDayDisplay = 'May 25, 2026';
  const assertSelectedDay = async () => {
    await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const range = page.getByRole('region', { name: 'Date range' });
    await expect(range.getByRole('textbox', { name: 'Start date' })).toHaveValue(selectedDayDisplay);
    await expect(range.getByRole('textbox', { name: 'End date' })).toHaveValue(selectedDayDisplay);
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
  await page.goto('/sync');

  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export current machine' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Machine fleet' })).toBeVisible();
  await expect(page.getByLabel('Machine fleet').getByText('Current machine', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Drop a merge file here or choose a file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start LAN merge' })).toHaveCount(0);
  await expect(page.getByLabel('Scan host')).toHaveCount(0);
  await expect(page.getByText('Pair nearby machine')).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(UUID_PATTERN);
});
