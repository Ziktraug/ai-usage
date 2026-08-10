import {
  FOCUSED_REPORT_E2E_ENABLED_KEY,
  FOCUSED_REPORT_E2E_NO_LOCAL_DATA_KEY,
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
const MAX_ALIGNMENT_DRIFT_PX = 1;
const MIN_CONTENT_ABOVE_FOLD_PX = 10;
const MOBILE_VIEWPORT = { height: 844, width: 390 };
const PERIOD_DIRECTION_PATTERN = /higher|lower/u;
const MODEL_ANALYSIS_COLUMNS = [
  'Model',
  'API value',
  'Share',
  'Processed tokens',
  'Pricing coverage',
  'API value / 1M tokens',
] as const;
const FIRST_READ_SCENARIOS = [
  { colorScheme: 'light', name: '1440x900-light', viewport: { height: 900, width: 1440 } },
  { colorScheme: 'light', name: '1280x900-light', viewport: { height: 900, width: 1280 } },
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

  const valueOffsets = await metrics.evaluateAll((elements) =>
    elements.map((element) => {
      const value = element.querySelector('dd');
      if (!(value instanceof HTMLElement)) {
        throw new Error('Executive metric value is missing');
      }
      return Math.round(value.getBoundingClientRect().top - element.getBoundingClientRect().top);
    }),
  );
  expect(Math.max(...valueOffsets) - Math.min(...valueOffsets)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
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
  await expect(punchcardHeader).toHaveCSS('row-gap', '2px');
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
  await page.goto('/');

  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  const harness = page.getByRole('combobox', { name: 'Filter by harness' });
  const origin = page.getByRole('button', { name: 'Filter by origin' });
  const machine = page.getByRole('combobox', { name: 'Filter by machine' });
  const sourceStatus = page.getByRole('region', { name: 'Collection source status' });
  const searchBox = await search.boundingBox();
  const harnessBox = await harness.boundingBox();
  const originBox = await origin.boundingBox();
  const sourceStatusBox = (await sourceStatus.count()) > 0 ? await sourceStatus.boundingBox() : null;

  expect(Math.abs((searchBox?.x ?? 0) - (harnessBox?.x ?? 0))).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
  const harnessCenterY = (harnessBox?.y ?? 0) + (harnessBox?.height ?? 0) / 2;
  const originCenterY = (originBox?.y ?? 0) + (originBox?.height ?? 0) / 2;
  expect(Math.abs(harnessCenterY - originCenterY)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
  expect((originBox?.x ?? 0) + (originBox?.width ?? 0) - (harnessBox?.x ?? 0)).toBeCloseTo(searchBox?.width ?? 0, 0);
  if ((await machine.count()) === 0) {
    if (sourceStatusBox) {
      expect(Math.abs((searchBox?.x ?? 0) - sourceStatusBox.x)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
      expect(Math.abs((searchBox?.width ?? 0) - sourceStatusBox.width)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
    } else {
      expect((originBox?.x ?? 0) + (originBox?.width ?? 0) - (harnessBox?.x ?? 0)).toBeCloseTo(
        searchBox?.width ?? 0,
        0,
      );
    }
  } else {
    const machineBox = await machine.boundingBox();
    expect(Math.abs((harnessBox?.x ?? 0) - (machineBox?.x ?? 0))).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
    expect(Math.abs((harnessBox?.width ?? 0) - (machineBox?.width ?? 0))).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
    if (sourceStatusBox) {
      expect(Math.abs((originBox?.x ?? 0) - sourceStatusBox.x)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
      expect(Math.abs((originBox?.width ?? 0) - sourceStatusBox.width)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
      const machineCenterY = (machineBox?.y ?? 0) + (machineBox?.height ?? 0) / 2;
      const sourceStatusCenterY = sourceStatusBox.y + sourceStatusBox.height / 2;
      expect(Math.abs(machineCenterY - sourceStatusCenterY)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
    } else {
      expect(Math.abs((searchBox?.width ?? 0) - (machineBox?.width ?? 0))).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
    }
  }
  if (sourceStatusBox && searchBox) {
    expect(sourceStatusBox.x + sourceStatusBox.width).toBeLessThanOrEqual(
      searchBox.x + searchBox.width + MAX_ALIGNMENT_DRIFT_PX,
    );
  }
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

for (const scenario of FIRST_READ_SCENARIOS) {
  test(`keeps one responsive Models representation accessible in ${scenario.name}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scenario.colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize(scenario.viewport);
    await openHydratedReport(page, '/?tab=models');

    const panel = page.locator('[data-breakdown-panel="models"]');
    const table = panel.locator('[data-model-analysis-table]');
    const cards = panel.locator('[data-model-analysis-cards]');
    await expect(panel.getByRole('heading', { exact: true, name: 'Models' })).toBeVisible();
    if (scenario.viewport.width >= 1280) {
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
    if (scenario.viewport.width < 1280) {
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
