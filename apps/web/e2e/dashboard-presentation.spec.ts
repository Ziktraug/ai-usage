import { FOCUSED_REPORT_E2E_ENABLED_KEY } from '../src/focused-report-e2e-fixture';
import { expect, reportViewsFor, test } from './browser-test';

const PREVIOUS_PERIOD_PATTERN = /vs previous period/i;
const API_VALUE_HINT_PATTERN = /Estimated API-equivalent value at standard prices for \d+ of \d+ fully priced sessions/;
const MAX_DASHBOARD_METRIC_COLUMNS = 4;
const MAX_ALIGNMENT_DRIFT_PX = 1;
const MIN_CONTENT_ABOVE_FOLD_PX = 10;
const MOBILE_VIEWPORT = { height: 844, width: 390 };

test('groups value bases while keeping the remaining metric deltas qualified and aligned', async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.goto('/');

  const region = page.getByRole('region', { name: 'More report metrics' });
  const grid = region.locator('[data-metric-grid]');
  const valueBases = grid.locator('[data-value-bases-panel]');
  const valueRows = valueBases.locator('[data-value-bases-row]');
  const tiles = grid.locator('[data-metric-tile]');
  await expect(grid).toBeVisible();
  await expect(valueBases).toContainText('Value bases');
  await expect(valueRows).toHaveCount(3);
  await expect(valueRows).toContainText([
    'Estimated API-equivalent value',
    'Actual recorded cost',
    'Subscription value',
  ]);
  expect(await tiles.count()).toBeGreaterThan(3);

  const columnCount = await grid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.trim().split(' ').filter(Boolean).length,
  );
  expect(columnCount).toBeLessThanOrEqual(MAX_DASHBOARD_METRIC_COLUMNS);

  const deltas = grid.locator('[data-metric-delta]');
  await expect(deltas.first()).toBeVisible();
  expect(await deltas.count()).toBeGreaterThan(0);
  for (const delta of await deltas.all()) {
    await expect(delta).toContainText(PREVIOUS_PERIOD_PATTERN);
  }

  const valueOffsets = await tiles.evaluateAll((elements) =>
    elements.map((element) => {
      const value = element.querySelector('[data-metric-value]');
      if (!(value instanceof HTMLElement)) {
        throw new Error('Metric value marker is missing');
      }
      return Math.round(value.getBoundingClientRect().top - element.getBoundingClientRect().top);
    }),
  );
  expect(Math.max(...valueOffsets) - Math.min(...valueOffsets)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
});

test('keeps metric provenance visibly interactive and operable by keyboard', async ({ page }) => {
  await page.goto('/');

  const help = page.getByRole('button', { name: 'About API value' });
  const box = await help.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  await expect(help).toHaveCSS('cursor', 'pointer');
  await expect(help).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(help).toHaveAttribute('title', 'About API value');

  const hint = page.getByText(API_VALUE_HINT_PATTERN);
  await help.click();
  await expect(hint).toBeVisible();
  await page.keyboard.press('Escape');
  await help.focus();
  await help.press('Enter');
  await expect(hint).toBeVisible();
});

test('explains unavailable source freshness without replacing its compact pill', async ({ page }) => {
  await page.goto('/skills');
  await page.evaluate((enabledKey) => {
    Reflect.set(globalThis, enabledKey, true);
  }, FOCUSED_REPORT_E2E_ENABLED_KEY);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();

  const freshnessPill = page.getByText('Freshness unavailable', { exact: true });
  await expect(freshnessPill).toBeVisible();
  await freshnessPill.hover();
  await expect(
    page.getByText('No source freshness observation is available for this report revision.', { exact: true }),
  ).toBeVisible();
});

test('keeps spend coverage textual without an Overview segmented bar', async ({ page }) => {
  await page.goto('/');

  const hero = page.getByRole('region', { name: 'Estimated API-equivalent value' });
  const verticalOrder = await hero.evaluate((element) => {
    const amount = element.querySelector('[data-reported-actual-spend]');
    const coverage = element.querySelector('[data-spend-coverage-legend]');
    if (!(amount && coverage)) {
      throw new Error('Spend amount or coverage legend is missing');
    }
    return {
      amountBottom: amount.getBoundingClientRect().bottom,
      coverageTop: coverage.getBoundingClientRect().top,
    };
  });

  expect(verticalOrder.amountBottom).toBeLessThanOrEqual(verticalOrder.coverageTop);
  await expect(hero.getByRole('img', { name: 'Actual-spend reporting coverage by session' })).toHaveCount(0);
});

test('renders Token anatomy as four exact definition rows without a segmented bar', async ({ page }) => {
  await page.goto('/');

  const anatomy = page.getByRole('heading', { level: 2, name: 'Token anatomy' }).locator('xpath=../..');
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
  await expect(page.getByRole('region', { name: 'More report metrics' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Provider status' })).toBeVisible();

  for (const tab of ['sessions', 'models']) {
    await page.goto(`/?tab=${tab}`);
    await expect(page.getByRole('region', { name: 'More report metrics' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Provider status' })).toHaveCount(0);
  }

  await page.goto('/');
  await page.getByRole('link', { exact: true, name: 'Breakdown' }).click();
  await page.getByRole('tablist', { name: 'Breakdown dimension' }).getByRole('tab', { name: 'Projects' }).click();
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

test('uses one fixed-size Punchcard intensity channel with a low/high key', async ({ page }) => {
  await page.goto('/');

  const punchcardKey = page.locator('[data-punchcard-intensity-key]');
  const punchcardCells = page.locator('[data-punchcard-cell-fill]');
  await expect(punchcardKey).toContainText('Low');
  await expect(punchcardKey).toContainText('High');
  expect(await punchcardCells.count()).toBeGreaterThan(0);
  const cellGeometry = await punchcardCells.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { height: Math.round(box.height), width: Math.round(box.width) };
    }),
  );
  expect(new Set(cellGeometry.map((box) => box.width)).size).toBe(1);
  expect(new Set(cellGeometry.map((box) => box.height)).size).toBe(1);
});

test('separates timeline boundary dates and retains no horizontally intersecting tick', async ({ page }) => {
  for (const width of [1440, 900]) {
    await page.setViewportSize({ height: 1000, width });
    await page.goto('/');

    const tickRow = page.locator('[data-timeline-tick-row]');
    const boundaryRow = page.locator('[data-timeline-boundary-row]');
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

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const dateRangeBox = await dateRange.boundingBox();
  expect(MOBILE_VIEWPORT.height - (dateRangeBox?.y ?? MOBILE_VIEWPORT.height)).toBeGreaterThanOrEqual(
    MIN_CONTENT_ABOVE_FOLD_PX,
  );
});
