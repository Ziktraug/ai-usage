import { expect, reportViewsFor, test } from './browser-test';

const CALENDAR_NAME_PATTERN = /Daily activity calendar/;
const COLUMN_URL_PATTERN = /cols=/;
const DATE_HEADER_PATTERN = /Date/;
const ESTIMATED_API_VALUE_HELP_PATTERN =
  /Estimated cost at standard API prices for \d+ of \d+ fully priced sessions, including usage covered by subscriptions/;
const HYDRATION_TIMEOUT_MS = 15_000;
const INSPECT_SESSION_PATTERN = /Inspect session/;
const LEGACY_PROJECT_TAB_URL_PATTERN = /tab=projects/;
const PROVIDER_DETAILS_PATTERN = /^Provider details \(/;
const PROVIDER_CATEGORY_COUNT_PATTERN = /: (\d+) providers?$/;
const PROVIDER_CATEGORY_TOTAL_PATTERN = /\((\d+) providers?\)$/;
const PROVIDER_CATEGORIES_PATTERN = /^Provider categories/;
const QUERY_URL_PATTERN = /q=ai-usage/;
const RANGE_URL_PATTERN = /range=/;
const RESET_COUNT_PATTERN = /1 reset/;
const GAP_COUNT_PATTERN = /1 collection gap/;
const SORT_URL_PATTERN = /sort=/;
const TOP_SESSION_PATTERN = /Top session/;

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

test('retries a failed report through the Router loading lifecycle', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    Reflect.set(globalThis, '__aiUsageE2EDisableReportPublicationRetry', true);
    Reflect.set(globalThis, '__aiUsageE2EReportLoadFailures', 1);
    const router = Reflect.get(globalThis, '__TSR_ROUTER__');
    const invalidate = router && typeof router === 'object' ? Reflect.get(router, 'invalidate') : undefined;
    if (typeof invalidate !== 'function') {
      throw new Error('TanStack Router test handle is unavailable.');
    }
    try {
      await Reflect.apply(invalidate, router, [
        { filter: (match: { routeId?: unknown }) => match.routeId === '/', forcePending: true },
      ]);
    } catch {
      // The route error boundary owns the synthetic loader failure.
    }
  });

  await expect(page.getByRole('heading', { level: 2, name: 'Report unavailable' })).toBeVisible();
  await expect(page.getByText('Synthetic report load failed for retry coverage.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads'))).toBe(2);
});

test('uses one primary navigation while preserving Breakdown deep links and sub-tabs', async ({ page }) => {
  await page.goto('/?tab=sessions');

  const reportViews = reportViewsFor(page);
  await expect(reportViews).toHaveCount(1);
  await expect(reportViews.getByRole('link')).toHaveText(['Overview', 'Sessions', 'Breakdown']);
  await expect(page.getByRole('tablist', { name: 'Dashboard sections' })).toHaveCount(0);
  await expect(reportViews.getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('table')).toBeVisible();

  await page.goto('/?tab=models');
  await expect(reportViews.getByRole('link', { exact: true, name: 'Breakdown' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const breakdownTabs = page.getByRole('tablist', { name: 'Breakdown dimension' });
  await expect(breakdownTabs.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('By model', { exact: true })).toBeVisible();

  await breakdownTabs.getByRole('tab', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Project groups' })).toBeVisible();
  await expect(page).toHaveURL(LEGACY_PROJECT_TAB_URL_PATTERN);
});

test('shows analysis and report metrics without disclosure gates', async ({ page }) => {
  await page.goto('/');
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
    'API-equivalent value',
  ]);
  expect(await punchcardTable.getByRole('row').count()).toBeGreaterThan(1);
  await expect(punchcardTable.getByRole('row', { name: 'Sunday 14:00 1 $0.84' })).toBeAttached();
  await expect(page.locator('[data-punchcard-visual]')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('[data-punchcard-visual]').getByRole('button')).toHaveCount(0);

  const reportMetrics = page.getByRole('region', { name: 'More report metrics' });
  await expect(reportMetrics.getByRole('heading', { level: 2, name: 'More report metrics' })).toBeVisible();
  await expect(reportMetrics.getByRole('button', { name: 'More report metrics' })).toHaveCount(0);
  await expect(reportMetrics.getByText('Fresh tokens', { exact: true })).toBeVisible();
});

test('prioritizes the selected dashboard view before secondary status on mobile', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 390 });
  await page.goto('/');

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
  await page.goto('/');

  const dashboardPanel = page.locator('[data-dashboard-panel]');
  const providerStatus = page.getByRole('heading', { level: 2, name: 'Provider status' });
  const [dashboardBox, providerBox] = await Promise.all([dashboardPanel.boundingBox(), providerStatus.boundingBox()]);

  await expect(page.getByRole('button', { name: 'About API value' })).toBeVisible();
  expect(dashboardBox?.y).toBeLessThan(providerBox?.y ?? 0);
});

test('keeps provider details collapsed until they are requested', async ({ page }) => {
  await page.goto('/');

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
  await page.goto('/');

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
  await page.goto('/');
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
  await page.goto('/');

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
  await page.goto('/?origin=%5B%5D');
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
  await page.goto('/');

  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('navigates and closes the selected session with drawer keyboard commands', async ({ page }) => {
  await page.goto('/');
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
  await page.goto('/');
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

test('uses the report range as the only graph viewport', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await expect(dateRange.getByRole('button', { name: 'Zoom chart' })).toHaveCount(0);
  await expect(dateRange.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);
  await expect(dateRange.getByText('Custom chart view', { exact: true })).toHaveCount(0);
  await expect(dateRange.getByText('Follows report range', { exact: true })).toBeVisible();
});

test('offers keyboard-safe charts and mobile summaries at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 361 });
  await page.goto('/');

  const calendar = page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN });
  const dayControl = page.getByLabel('Select activity day');
  const focusedCalendarDay = calendar.locator('button[tabindex="0"]');
  await expect(focusedCalendarDay).toHaveCount(1);
  await expect(dayControl).toHaveValue((await focusedCalendarDay.getAttribute('data-heatmap-day')) ?? '');
  const initialDayLabel = await focusedCalendarDay.getAttribute('aria-label');
  await focusedCalendarDay.focus();
  await focusedCalendarDay.press('ArrowLeft');
  await expect(calendar.locator('button:focus')).not.toHaveAttribute('aria-label', initialDayLabel ?? '');
  await expect(dayControl).toHaveValue((await calendar.locator('button:focus').getAttribute('data-heatmap-day')) ?? '');
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

test('keeps compact heatmap geometry beside an equivalent touch control', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 361 });
  await page.goto('/');

  const calendar = page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN });
  const dayControl = page.getByLabel('Select activity day');
  const cell = calendar.locator('button').first();

  // The labelled 36px date control provides the equivalent target-size path;
  // the GitHub-style visual cells intentionally remain compact and non-overlapping.
  const narrowCellBox = await cell.boundingBox();
  const narrowControlBox = await dayControl.boundingBox();
  expect(Math.round(narrowCellBox?.width ?? 0)).toBe(18);
  expect(Math.round(narrowCellBox?.height ?? 0)).toBe(18);
  expect(Math.round(narrowControlBox?.height ?? 0)).toBeGreaterThanOrEqual(24);
  await expect(calendar).toHaveCSS('column-gap', '3px');

  await page.setViewportSize({ height: 900, width: 1024 });
  const desktopCellBox = await cell.boundingBox();
  expect(Math.round(desktopCellBox?.width ?? 0)).toBe(12);
  expect(Math.round(desktopCellBox?.height ?? 0)).toBe(12);
  await expect(calendar).toHaveCSS('column-gap', '3px');
});

test('selects the same heatmap day with mouse, keyboard, and the equivalent control', async ({ page }) => {
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

  await page.goto('/');
  await selectedCell().click();
  await assertSelectedDay();

  await page.goto('/');
  await selectedCell().focus();
  await selectedCell().press('Enter');
  await assertSelectedDay();

  await page.goto('/');
  await page.getByLabel('Select activity day').fill(selectedDay);
  await assertSelectedDay();
});

test('mounts one Sessions surface across viewport changes without losing state', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 361 });
  await page.goto('/');
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
  await expect(page.getByText('Current machine', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Drop a merge file here or choose a file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start LAN merge' })).toHaveCount(0);
  await expect(page.getByLabel('Scan host')).toHaveCount(0);
  await expect(page.getByText('Pair nearby machine')).toHaveCount(0);
});
