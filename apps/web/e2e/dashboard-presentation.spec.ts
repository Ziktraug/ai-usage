import {
  FOCUSED_REPORT_E2E_ENABLED_KEY,
  FOCUSED_REPORT_E2E_NO_LOCAL_DATA_KEY,
  FOCUSED_REPORT_E2E_SESSION_SHAPE_KEY,
} from '../src/focused-report-e2e-fixture';
import {
  expect,
  openHydratedReport,
  reportViewsFor,
  test,
  waitForFocusedReportSettled,
  waitForHydratedNavigation,
  waitForHydratedReport,
} from './browser-test';

const MAX_DASHBOARD_METRIC_COLUMNS = 4;
/** Panda's `md` breakpoint, where `[data-model-analysis-table]` replaces the card list. */
const MODEL_TABLE_MIN_WIDTH_PX = 768;
const MAX_ALIGNMENT_DRIFT_PX = 1;
const MIN_CONTENT_ABOVE_FOLD_PX = 10;
const MOBILE_VIEWPORT = { height: 844, width: 390 };
const PERIOD_DIRECTION_PATTERN = /higher|lower/u;
const RHYTHM_CALENDAR_PATTERN = /Daily activity calendar/;
const RHYTHM_FIRST_MONTH_PATTERN = /^[A-Z][a-z]{2} '\d{2}$/;
const RHYTHM_MONTH_PATTERN = /^[A-Z][a-z]{2}( '\d{2})?$/;
const RHYTHM_READOUT_PATTERN = / — [\d,]+ sessions? · /;
const MODEL_ANALYSIS_COLUMNS = [
  'Model',
  'API value',
  'Share',
  'Processed tokens',
  'Rates known',
  'API value / 1M tokens',
] as const;
// 1080x900 sits in the md-but-not-xl band and 1080x1920 is the portrait display. Both are daily
// working viewports that no scenario covered, so layout drift there used to ship unnoticed.
const FIRST_READ_SCENARIOS = [
  { colorScheme: 'light', name: '1440x900-light', viewport: { height: 900, width: 1440 } },
  { colorScheme: 'light', name: '1280x900-light', viewport: { height: 900, width: 1280 } },
  { colorScheme: 'light', name: '1080x900-light', viewport: { height: 900, width: 1080 } },
  { colorScheme: 'light', name: '1080x1920-light', viewport: { height: 1920, width: 1080 } },
  { colorScheme: 'light', name: '390x844-light', viewport: MOBILE_VIEWPORT },
  { colorScheme: 'dark', name: '390x844-dark', viewport: MOBILE_VIEWPORT },
] as const;

for (const scenario of FIRST_READ_SCENARIOS) {
  test(`keeps the decision-first Overview in the initial ${scenario.name} viewport`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scenario.colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize(scenario.viewport);
    await openHydratedReport(page);

    const period = page.getByRole('region', { name: 'Report period' });
    const kpi = page.locator('[data-executive-kpi]');
    const chart = page.locator('[data-executive-chart]');
    const metrics = page.locator('[data-executive-metrics]');
    await expect(period).toBeVisible();
    await expect(kpi).toBeVisible();
    await expect(chart).toBeVisible();
    await expect(metrics).toBeVisible();
    await expect(kpi).toContainText('Standard API-price estimate');
    await expect(page.locator('[data-period-insight]')).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);

    const kpiSize = Number.parseFloat(
      await kpi
        .locator('strong')
        .first()
        .evaluate((element) => getComputedStyle(element).fontSize),
    );
    const metricSize = Number.parseFloat(
      await metrics
        .locator('dd')
        .first()
        .evaluate((element) => getComputedStyle(element).fontSize),
    );
    expect(kpiSize).toBeGreaterThan(metricSize);
    expect(
      await kpi
        .locator('strong')
        .first()
        .evaluate((element) => element.getClientRects().length),
    ).toBe(1);
    expect(await kpi.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    if (scenario.viewport.width >= 1280) {
      expect(kpiSize).toBeGreaterThanOrEqual(44);
      for (const surface of [kpi, chart, metrics]) {
        const box = await surface.boundingBox();
        expect(Math.ceil((box?.y ?? Number.POSITIVE_INFINITY) + (box?.height ?? 0))).toBeLessThanOrEqual(
          scenario.viewport.height,
        );
      }
    } else {
      const mobileNavigation = page.locator('[data-app-navigation="mobile"]');
      const navigationBox = await mobileNavigation.boundingBox();
      const periodBox = await period.boundingBox();
      const kpiBox = await kpi.boundingBox();
      const chartBox = await chart.boundingBox();
      const chartHeadingBox = await chart.getByRole('heading', { level: 3, name: 'Activity' }).boundingBox();
      const chartPlotBox = await chart.locator('[data-report-range-part="chart"]').boundingBox();
      const navigationTop = navigationBox?.y ?? scenario.viewport.height - 64;
      expect((periodBox?.y ?? -1) + (periodBox?.height ?? 0)).toBeLessThanOrEqual(navigationTop);
      expect((kpiBox?.y ?? -1) + (kpiBox?.height ?? 0)).toBeLessThanOrEqual(navigationTop);
      expect(chartBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(navigationTop);
      expect((chartHeadingBox?.y ?? -1) + (chartHeadingBox?.height ?? 0)).toBeLessThanOrEqual(navigationTop);
      expect((chartPlotBox?.y ?? Number.POSITIVE_INFINITY) + 24).toBeLessThanOrEqual(navigationTop);
    }

    // The quota rail's own data query is gated to live mode (`provider-quota-query-shell.svelte`),
    // so it renders nothing under e2e and cannot be asserted here — a guarded block would assert
    // nothing at all. Its compact-percentage behaviour is covered in provider-quota-rail.ssr.test.ts
    // instead. What this spec still owns at every width is that the shell reserves the rail column
    // without pushing content off-screen, which the overflow assertion above already pins.

    const screenshot = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      ...(process.env.AI_USAGE_PLAN073_SMOKE_DIR
        ? { path: `${process.env.AI_USAGE_PLAN073_SMOKE_DIR}/ai-usage-plan073-step5-${scenario.name}.png` }
        : {}),
    });
    await testInfo.attach(`plan073-step5-${scenario.name}`, {
      body: screenshot,
      contentType: 'image/png',
    });
  });
}

test('keeps the four executive metrics aligned below a visually dominant KPI', async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.goto('/');

  const kpi = page.locator('[data-executive-kpi]');
  const grid = page.locator('[data-executive-metrics]');
  const metrics = grid.locator(':scope > div');
  await expect(kpi).toBeVisible();
  await expect(grid).toBeVisible();
  await expect(metrics).toHaveCount(4);
  await expect(grid.locator('dt')).toHaveText([
    'Processed tokens',
    'Cache volume',
    'Output tokens',
    'Pricing coverage',
  ]);

  const columnCount = await grid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.trim().split(' ').filter(Boolean).length,
  );
  expect(columnCount).toBe(MAX_DASHBOARD_METRIC_COLUMNS);

  const valueOffsetsOf = () =>
    metrics.evaluateAll((elements) =>
      elements.map((element) => {
        const value = element.querySelector('dd');
        if (!(value instanceof HTMLElement)) {
          throw new Error('Executive metric value is missing');
        }
        return Math.round(value.getBoundingClientRect().top - element.getBoundingClientRect().top);
      }),
    );
  const valueOffsets = await valueOffsetsOf();
  expect(Math.max(...valueOffsets) - Math.min(...valueOffsets)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
  await waitForHydratedReport(page);
  await page
    .getByRole('region', { name: 'Report period' })
    .getByRole('button', { exact: true, name: 'All time' })
    .click();
  await waitForFocusedReportSettled(page);
  const coverage = metrics.filter({ hasText: 'Pricing coverage' });
  await expect(coverage).toContainText('Partially measured');
  expect(await coverage.locator('dd').count()).toBe(3);
  expect(await metrics.first().locator('dd').count()).toBe(2);
  const qualifiedOffsets = await valueOffsetsOf();
  expect(Math.max(...qualifiedOffsets) - Math.min(...qualifiedOffsets)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
  const kpiSize = Number.parseFloat(
    await kpi
      .locator('strong')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
  );
  const metricSize = Number.parseFloat(
    await metrics
      .first()
      .locator('dd')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
  );
  expect(kpiSize).toBeGreaterThan(metricSize);
});

test('keeps partial pricing qualification visible without a disclosure', async ({ page }) => {
  await openHydratedReport(page);
  const kpi = page.locator('[data-executive-kpi]');
  await expect(kpi).not.toContainText(PERIOD_DIRECTION_PATTERN);
  await page
    .getByRole('region', { name: 'Report period' })
    .getByRole('button', { exact: true, name: 'All time' })
    .click();
  await waitForFocusedReportSettled(page);

  const coverage = page.locator('[data-executive-metrics] > div').filter({ hasText: 'Pricing coverage' });
  await expect(kpi).toContainText('Partially measured');
  await expect(kpi.locator('strong').first()).toContainText('≥');
  await expect(coverage).toContainText('5 / 6');
  await expect(coverage).toContainText('fully priced');
  await expect(coverage).toContainText('Partially measured');
  await expect(page.locator('[data-period-insight]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'About API value' })).toHaveCount(0);
});

test('keeps a fully unpriced selection unknown instead of presenting an exact zero', async ({ page }) => {
  await openHydratedReport(page, '/?origin=%5B%5D');
  await page
    .getByRole('region', { name: 'Report period' })
    .getByRole('button', { exact: true, name: 'All time' })
    .click();
  await waitForFocusedReportSettled(page);
  await page
    .getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' })
    .fill('Explore report sketch');
  await waitForFocusedReportSettled(page);

  const kpi = page.locator('[data-executive-kpi]');
  await expect(page.getByText('1 / 6 sessions', { exact: true })).toBeVisible();
  await expect(kpi.locator('strong').first()).toHaveText('—');
  await expect(kpi).toContainText('Partially measured');
  await expect(kpi).not.toContainText('$0.00');
  await expect(page.locator('[data-period-insight]')).toHaveCount(0);
});

test('distinguishes no local usage from a filtered empty result', async ({ page }) => {
  await page.addInitScript(
    ({ enabledKey, noLocalDataKey }) => {
      Reflect.set(globalThis, enabledKey, true);
      Reflect.set(globalThis, noLocalDataKey, true);
    },
    {
      enabledKey: FOCUSED_REPORT_E2E_ENABLED_KEY,
      noLocalDataKey: FOCUSED_REPORT_E2E_NO_LOCAL_DATA_KEY,
    },
  );
  await openHydratedReport(page);

  await expect(page.getByRole('heading', { level: 2, name: 'No local usage yet' })).toBeVisible();
  await expect(page.getByText('0 / 0 sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { exact: true, name: 'Open Sources' })).toHaveAttribute('href', '/sources');
  await expect(page.getByRole('button', { exact: true, name: 'Clear filters' })).toHaveCount(0);
  await expect(page.locator('[data-executive-kpi]')).toHaveCount(0);
  await expect(page.locator('[data-period-insight]')).toHaveCount(0);
});

test('explains unavailable source freshness without replacing its compact pill', async ({
  browserFailureGate,
  page,
}) => {
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
    await waitForHydratedReport(page);
  } finally {
    releaseOverviewDataAbort();
  }

  const freshnessPill = page.getByText('Freshness unavailable', { exact: true });
  await expect(freshnessPill).toBeVisible();
  await freshnessPill.hover();
  await expect(
    page.getByText('No source freshness observation is available for this report revision.', { exact: true }),
  ).toBeVisible();
});

test('keeps pricing coverage textual without presenting actual spend or subscription value', async ({ page }) => {
  await page.goto('/');

  const coverage = page.locator('[data-executive-metrics] > div').filter({ hasText: 'Pricing coverage' });
  await expect(coverage).toContainText('5 / 5');
  await expect(coverage).toContainText('100%');
  await expect(coverage).toContainText('fully priced');
  for (const forbiddenCopy of ['Actual recorded cost', 'Reported actual spend', 'Subscription value']) {
    await expect(page.getByText(forbiddenCopy, { exact: true })).toHaveCount(0);
  }
});

test('renders Token anatomy as four exact definition rows without a segmented bar', async ({ page }) => {
  await page.goto('/');

  const anatomy = page.getByRole('heading', { level: 3, name: 'Token anatomy' }).locator('xpath=../..');
  const rows = anatomy.locator('[data-token-anatomy-row]');
  await expect(rows).toHaveCount(4);
  await expect(anatomy.getByRole('img', { name: 'Token anatomy' })).toHaveCount(0);
  await expect(rows.locator('[data-token-exact-value]')).toHaveCount(4);
  await expect(rows.locator('[data-token-percentage]')).toHaveCount(4);

  const boxes = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    }),
  );
  expect(new Set(boxes.map((box) => box.left)).size).toBe(1);
  expect(boxes.map((box) => box.top)).toEqual([...boxes.map((box) => box.top)].sort((left, right) => left - right));
});

test('renders secondary status only on Overview and puts Projects before closed group management', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-executive-metrics]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Provider status' })).toBeVisible();

  for (const tab of ['sessions', 'models']) {
    await page.goto(`/?tab=${tab}`);
    await expect(page.locator('[data-executive-metrics]')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Provider status' })).toHaveCount(0);
  }

  await page.goto('/');
  await page.getByRole('link', { exact: true, name: 'Analysis' }).click();
  await page.getByRole('tablist', { name: 'Analysis dimension' }).getByRole('tab', { name: 'Projects' }).click();
  const projectsPanel = page.locator('[data-projects-panel]');
  const projectSummary = projectsPanel.getByRole('table');
  const management = projectsPanel.locator('details');
  await expect(projectSummary).toBeVisible();
  await expect(management.locator('summary')).toHaveText('Manage project groups');
  await expect(management).not.toHaveAttribute('open', '');
  expect(
    await projectsPanel.evaluate((element) => {
      const summary = element.querySelector('table');
      const details = element.querySelector('details');
      const orderedElements = [...element.querySelectorAll('table, details')];
      return summary !== null && details !== null && orderedElements[0] === summary && orderedElements[1] === details;
    }),
  ).toBe(true);
  await expect(projectsPanel.locator('[data-project-quality-label]')).toHaveCount(0);

  const projectHeader = projectsPanel.getByRole('columnheader', { name: 'Project' });
  const sessionsHeader = projectsPanel.getByRole('columnheader', { name: 'Sessions' });
  const firstRowHeader = projectsPanel.getByRole('rowheader').first();
  await expect(projectHeader).toHaveCSS('text-align', 'left');
  await expect(projectHeader).toHaveCSS('padding-left', '12px');
  await expect(firstRowHeader).toHaveCSS('text-align', 'left');
  await expect(firstRowHeader).toHaveCSS('padding-left', '12px');
  await expect(sessionsHeader).toHaveCSS('text-align', 'right');
  await expect(projectsPanel.getByRole('columnheader', { name: 'Lines changed' })).toBeVisible();

  const search = projectsPanel.getByRole('searchbox', { name: 'Search this breakdown' });
  await expect(search).toBeVisible();
  await search.fill('no-such-project');
  await expect(projectsPanel.getByRole('table').getByRole('status')).toHaveText('No breakdown rows match this search');
  await expect(projectsPanel.locator('[data-project-name]')).toHaveCount(0);
  await search.fill('');
  await expect(projectsPanel.locator('[data-project-name]').first()).toBeVisible();
});

test('keeps the tablet Projects table inside its horizontal scroll surface', async ({ page }) => {
  await page.setViewportSize({ height: 1024, width: 768 });
  await page.goto('/');
  await page.getByRole('link', { exact: true, name: 'Analysis' }).click();
  await page.getByRole('tablist', { name: 'Analysis dimension' }).getByRole('tab', { name: 'Projects' }).click();

  const projectsPanel = page.locator('[data-breakdown-panel="projects"]');
  const tableViewport = projectsPanel.getByRole('table').locator('..');
  await expect(projectsPanel).toBeVisible();
  await expect
    .poll(
      async () =>
        await tableViewport.evaluate((element) => ({
          documentFitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ownsHorizontalOverflow: element.scrollWidth > element.clientWidth,
          panelFitsViewport:
            (element.closest('[data-breakdown-panel]')?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY) <=
            document.documentElement.clientWidth + 1,
        })),
    )
    .toEqual({
      documentFitsViewport: true,
      ownsHorizontalOverflow: true,
      panelFitsViewport: true,
    });
});

test('uses compact circular Punchcard marks inside accessible targets with a low/high key', async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();

  const advancedAnalysis = page.locator('[data-overview-advanced-analysis]');
  const punchcardPanel = page
    .getByRole('heading', { level: 4, name: 'Punchcard' })
    .locator('xpath=ancestor::section[1]');
  const punchcardHeader = punchcardPanel.locator(':scope > header');
  const punchcardKey = page.locator('[data-punchcard-intensity-key]');
  const punchcardVisual = page.locator('[data-punchcard-visual]');
  const punchcardTargets = page.locator('[data-punchcard-cell]');
  const punchcardCells = page.locator('[data-punchcard-cell-fill]');
  await expect(punchcardKey).toContainText('Low');
  await expect(punchcardKey).toContainText('High');
  await expect(punchcardKey).toContainText('session count');
  await expect(punchcardKey).toHaveAttribute('aria-label', 'Punchcard session-count intensity');
  await expect(punchcardKey).toHaveAttribute('role', 'img');
  await expect(punchcardKey).toHaveCSS('justify-content', 'flex-end');
  await expect(punchcardVisual).toHaveCSS('column-gap', '2px');
  await expect(punchcardVisual).toHaveCSS('row-gap', '2px');
  await expect(punchcardVisual).toHaveCSS('overflow-y', 'hidden');
  await expect(punchcardHeader).toHaveCSS('display', 'grid');
  await expect(punchcardHeader).toHaveCSS('row-gap', '5px');
  expect(await punchcardCells.count()).toBeGreaterThan(0);

  const hoveredTarget = punchcardTargets.last();
  const hoveredDot = hoveredTarget.locator('[data-punchcard-cell-fill]');
  await expect(hoveredDot).toHaveCSS('transition-duration', '0.16s');
  const dotBeforeHover = await hoveredDot.boundingBox();
  const scrollBeforeHover = await punchcardVisual.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  await hoveredTarget.hover();
  await expect(hoveredTarget).toHaveCSS('outline-style', 'none');
  await expect.poll(async () => Math.round((await hoveredDot.boundingBox())?.width ?? 0)).toBe(16);
  expect(await punchcardVisual.evaluate((element) => element.scrollHeight)).toBe(scrollBeforeHover.scrollHeight);
  expect(scrollBeforeHover.scrollHeight).toBe(scrollBeforeHover.clientHeight);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await hoveredDot.boundingBox())?.width ?? 0).toBe(dotBeforeHover?.width ?? 0);

  const tuesdayEveningCell = punchcardPanel.locator('button[data-weekday="1"][data-hour="18"]');
  await tuesdayEveningCell.focus();
  await tuesdayEveningCell.press('ArrowDown');
  await expect(tuesdayEveningCell).toBeFocused();
  await expect(tuesdayEveningCell).toHaveCSS('outline-offset', '-2px');

  const targetGeometry = await punchcardTargets.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { height: Math.round(box.height), width: Math.round(box.width) };
    }),
  );
  expect(new Set(targetGeometry.map((target) => target.width))).toEqual(new Set([24]));
  expect(new Set(targetGeometry.map((target) => target.height))).toEqual(new Set([24]));
  await expect(punchcardTargets.first().locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  const presentation = await punchcardCells.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        borderRadius: getComputedStyle(element).borderRadius,
        height: Math.round(box.height),
        width: Math.round(box.width),
      };
    }),
  );
  expect(new Set(presentation.map((cell) => cell.width))).toEqual(new Set([10]));
  expect(new Set(presentation.map((cell) => cell.height))).toEqual(new Set([10]));
  expect(new Set(presentation.map((cell) => cell.borderRadius))).toEqual(new Set(['999px']));

  const [advancedBox, punchcardBox] = await Promise.all([advancedAnalysis.boundingBox(), punchcardPanel.boundingBox()]);
  expect(punchcardBox?.width ?? 0).toBeGreaterThanOrEqual((advancedBox?.width ?? 0) - 32);
});

test('keeps every Punchcard hour visible beside Session shape across the desktop band', async ({ page }) => {
  await page.addInitScript(
    ({ enabledKey, shapeKey }) => {
      Reflect.set(globalThis, enabledKey, true);
      Reflect.set(globalThis, shapeKey, true);
    },
    { enabledKey: FOCUSED_REPORT_E2E_ENABLED_KEY, shapeKey: FOCUSED_REPORT_E2E_SESSION_SHAPE_KEY },
  );
  for (const { sideBySide, width } of [
    { sideBySide: false, width: 1024 },
    { sideBySide: false, width: 1280 },
    { sideBySide: true, width: 1920 },
  ]) {
    await page.setViewportSize({ height: 1000, width });
    await openHydratedReport(page);
    await waitForFocusedReportSettled(page);
    const shape = page.locator('[data-session-shape]');
    const punchcard = page.getByRole('heading', { level: 4, name: 'Punchcard' }).locator('xpath=ancestor::section[1]');
    const visual = page.locator('[data-punchcard-visual]');
    await expect(shape, `${width}px`).toBeVisible();
    await expect(punchcard, `${width}px`).toBeVisible();
    expect(
      await visual.evaluate((element) => element.scrollWidth - element.clientWidth),
      `${width}px: hidden Punchcard hours`,
    ).toBeLessThanOrEqual(0);
    const [shapeBox, punchcardBox] = await Promise.all([shape.boundingBox(), punchcard.boundingBox()]);
    const sameRow = Math.abs((shapeBox?.y ?? 0) - (punchcardBox?.y ?? Number.POSITIVE_INFINITY)) < 1;
    expect(sameRow, `${width}px: side by side`).toBe(sideBySide);
  }
});

test('labels the Rhythm month axis with the year and leads the day readout with sessions', async ({ page }) => {
  await openHydratedReport(page);
  const calendar = page.getByRole('toolbar', { name: RHYTHM_CALENDAR_PATTERN });
  const rhythm = page.locator('section').filter({ has: calendar });
  const labels = (await rhythm.locator('[data-heatmap-months] > span').allTextContents()).filter(Boolean);
  expect(labels.length).toBeGreaterThan(0);
  expect(labels[0]).toMatch(RHYTHM_FIRST_MONTH_PATTERN);
  for (const label of labels.slice(1)) {
    expect(label).toMatch(RHYTHM_MONTH_PATTERN);
  }
  expect(labels.filter((label) => label.includes("'"))).toHaveLength(1);
  await expect(rhythm.locator('[data-heatmap-readout]')).toHaveText(RHYTHM_READOUT_PATTERN);
});

test('never orphans a record tile: three tiles are 3-up from md and 1-up below', async ({ page }) => {
  await page.setViewportSize({ height: 1024, width: 768 });
  await openHydratedReport(page);
  const grid = page.locator('[data-records-grid]');
  await expect(grid).toHaveAttribute('data-record-count', '3');
  const trackCount = () =>
    grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(' ').filter(Boolean).length);
  expect(await trackCount()).toBe(3);
  const tops = await grid
    .locator(':scope > button')
    .evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);

  await page.setViewportSize({ height: 844, width: 390 });
  expect(await trackCount()).toBe(1);
  const widths = await grid.evaluate((element) => ({
    grid: element.getBoundingClientRect().width,
    cards: [...element.querySelectorAll(':scope > button')].map((card) => card.getBoundingClientRect().width),
  }));
  expect(widths.cards.every((width) => Math.abs(width - widths.grid) < 1)).toBe(true);
});

test('separates timeline boundary dates and retains no horizontally intersecting tick', async ({ page }) => {
  for (const width of [1440, 900]) {
    await page.setViewportSize({ height: 1000, width });
    await page.goto('/');

    const tickRow = page.locator('[data-timeline-tick-row]');
    const boundaryRow = page.locator('[data-timeline-boundary-row]');
    await expect(page.locator('[data-timeline-labels-settled="true"]')).toBeVisible();
    const ticks = tickRow.locator('[data-timeline-tick]:visible');
    const boundaries = boundaryRow.locator('[data-timeline-boundary]');
    await expect(tickRow).toBeVisible();
    await expect(boundaryRow).toBeVisible();
    await expect(boundaries).toHaveCount(2);

    const tickBoxes = await ticks.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { bottom: box.bottom, left: box.left, right: box.right };
      }),
    );
    const boundaryBoxes = await boundaries.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top };
      }),
    );

    expect(Math.max(...tickBoxes.map((box) => box.bottom))).toBeLessThanOrEqual(
      Math.min(...boundaryBoxes.map((box) => box.top)),
    );
    for (const tick of tickBoxes) {
      for (const boundary of boundaryBoxes) {
        expect(tick.right <= boundary.left || tick.left >= boundary.right).toBe(true);
      }
    }
  }
});

test('keeps the mobile filter stack coherent with content above the fold', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openHydratedReport(page);
  const toolbar = page.locator('[data-dashboard-filter-stack]');
  const search = page.getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' });
  const toggle = page.getByRole('button', { name: 'Filters', exact: true });
  await expect(page.getByRole('button', { name: 'Filter by harness' })).toBeHidden();
  const [searchBox, toggleBox, toolbarBox, heroBox] = await Promise.all([
    search.boundingBox(),
    toggle.boundingBox(),
    toolbar.boundingBox(),
    page.locator('[data-executive-kpi]').boundingBox(),
  ]);
  expect(Math.abs((searchBox?.y ?? 0) - (toggleBox?.y ?? 0))).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
  expect(toolbarBox?.height).toBeLessThanOrEqual(64);
  expect(heroBox?.y).toBeLessThan(360);
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Filter by harness' })).toBeVisible();
  expect(searchBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(MOBILE_VIEWPORT.width - 32);
  const filterControlGeometry = await page
    .locator('[data-dashboard-filter-stack]')
    .locator('input:visible, button:visible, a:visible, [role="combobox"]:visible')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          clipped: element.scrollWidth > element.clientWidth + 1,
          height: Math.floor(box.height),
          left: Math.floor(box.left),
          right: Math.ceil(box.right),
        };
      }),
    );
  expect(filterControlGeometry.length).toBeGreaterThan(0);
  expect(
    filterControlGeometry.every(
      ({ clipped, height, left, right }) => !clipped && height >= 44 && left >= 0 && right <= MOBILE_VIEWPORT.width,
    ),
  ).toBe(true);

  const dateRange = page.getByRole('region', { name: 'Report period' });
  const dateRangeBox = await dateRange.boundingBox();
  expect(MOBILE_VIEWPORT.height - (dateRangeBox?.y ?? MOBILE_VIEWPORT.height)).toBeGreaterThanOrEqual(
    MIN_CONTENT_ABOVE_FOLD_PX,
  );
});

for (const width of [1280, 1080]) {
  test(`keeps the complete filter bar bounded and readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ height: 900, width });
    await openHydratedReport(page);

    const toolbar = page.locator('[data-dashboard-filter-stack]');
    const controls = [
      page.getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' }),
      page.getByRole('button', { name: 'Filter by harness' }),
      page.getByRole('button', { name: 'Filter by origin' }),
      page.getByRole('button', { name: 'Filter by machine' }),
      page.getByRole('region', { name: 'Collection source status' }),
    ];
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    const tops = boxes.flatMap((box) => (box === null ? [] : [Math.round(box.y)]));

    expect(tops).toHaveLength(controls.length);
    if (width >= 1280) {
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
    } else {
      expect(new Set(tops).size).toBeLessThanOrEqual(2);
      expect(boxes[0]?.width).toBeGreaterThanOrEqual(180);
    }
    expect(await toolbar.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
      await toolbar.evaluate((element) => element.clientWidth),
    );
  });
}

for (const scenario of FIRST_READ_SCENARIOS) {
  test(`keeps one responsive Models representation accessible in ${scenario.name}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scenario.colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize(scenario.viewport);
    await openHydratedReport(page, '/?tab=models');

    const panel = page.locator('[data-breakdown-panel="models"]');
    const table = panel.locator('[data-model-analysis-table]');
    const cards = panel.locator('[data-model-analysis-cards]');
    await expect(panel.getByRole('heading', { exact: true, name: 'Models' })).toBeVisible();
    // The table swaps in at Panda's `md`, not at `xl`. Nothing between 390 and 1280 was covered
    // before, so this branch could pin the wrong threshold without any scenario contradicting it.
    if (scenario.viewport.width >= MODEL_TABLE_MIN_WIDTH_PX) {
      await expect(table).toBeVisible();
      await expect(cards).toBeHidden();
      await expect(table.getByRole('columnheader')).toHaveText(MODEL_ANALYSIS_COLUMNS);
      expect(await table.locator('[data-price-state]').count()).toBeGreaterThan(0);
    } else {
      await expect(table).toBeHidden();
      await expect(cards).toBeVisible();
      expect(await cards.getByRole('article').count()).toBeGreaterThan(0);
      const targetHeights = await panel
        .locator('input:visible, button:visible, a:visible')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      expect(targetHeights.length).toBeGreaterThan(0);
      expect(targetHeights.every((height) => height >= 44)).toBe(true);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
    const clippedActionCount = await panel
      .locator('input:visible, button:visible, a:visible')
      .evaluateAll((elements) => elements.filter((element) => element.scrollWidth > element.clientWidth + 1).length);
    expect(clippedActionCount).toBe(0);
    const sourceStatusLabel = page
      .getByRole('region', { name: 'Collection source status' })
      .locator('a > span:not([aria-hidden])')
      .first();
    if ((await sourceStatusLabel.count()) > 0) {
      expect(
        await sourceStatusLabel.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(0);
    }

    const screenshot = await page.screenshot({ animations: 'disabled' });
    await testInfo.attach(`analysis-${scenario.name}`, { body: screenshot, contentType: 'image/png' });
    const smokeDirectory = process.env.AI_USAGE_PLAN073_SMOKE_DIR;
    if (smokeDirectory) {
      await page.screenshot({
        animations: 'disabled',
        path: `${smokeDirectory}/ai-usage-plan073-step6-analysis-${scenario.name}.png`,
      });
    }
    if (scenario.viewport.width < MODEL_TABLE_MIN_WIDTH_PX) {
      await cards.getByRole('article').first().scrollIntoViewIfNeeded();
      const cardsScreenshot = await page.screenshot({ animations: 'disabled' });
      await testInfo.attach(`analysis-${scenario.name}-cards`, {
        body: cardsScreenshot,
        contentType: 'image/png',
      });
      if (smokeDirectory) {
        await page.screenshot({
          animations: 'disabled',
          path: `${smokeDirectory}/ai-usage-plan073-step6-analysis-${scenario.name}-cards.png`,
        });
      }
    }
  });
}
