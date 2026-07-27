import { expect, test } from './browser-test';

const PREVIOUS_PERIOD_PATTERN = /vs previous period/i;
const API_VALUE_HINT_PATTERN = /Estimated cost at standard API prices for \d+ of \d+ fully priced sessions/;
const MAX_DASHBOARD_METRIC_COLUMNS = 4;
const MAX_ALIGNMENT_DRIFT_PX = 1;
const MIN_CONTENT_ABOVE_FOLD_PX = 10;
const MOBILE_VIEWPORT = { height: 844, width: 390 };

test('keeps metric deltas qualified, aligned, and in a balanced grid', async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.goto('/');

  // Include the one origin excluded by the non-neutral default so this
  // presentation test exercises the synthetic fixture's period comparisons.
  const originFilter = page.getByRole('button', { name: 'Filter by origin' });
  await originFilter.click();
  await page.getByText('Automated review', { exact: true }).click();
  await expect(originFilter).toContainText('Origin: all');
  await page.keyboard.press('Escape');

  const region = page.getByRole('region', { name: 'More report metrics' });
  const grid = region.locator('[data-metric-grid]');
  const tiles = grid.locator('[data-metric-tile]');
  await expect(grid).toBeVisible();
  expect(await tiles.count()).toBeGreaterThan(4);

  const columnCount = await grid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.trim().split(' ').filter(Boolean).length,
  );
  expect(columnCount).toBeLessThanOrEqual(MAX_DASHBOARD_METRIC_COLUMNS);

  const rowCounts = await tiles.evaluateAll((elements) => {
    const counts = new Map<number, number>();
    for (const element of elements) {
      const rowTop = Math.round(element.getBoundingClientRect().top);
      counts.set(rowTop, (counts.get(rowTop) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) => left - right).map(([, count]) => count);
  });
  expect(rowCounts.at(-1)).toBeGreaterThan(1);

  const deltas = tiles.locator('[data-metric-delta]');
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

test('pairs the dashboard Token anatomy legend in a two-by-two grid', async ({ page }) => {
  await page.goto('/');

  const items = page.locator('[data-overview-token-legend] [data-token-legend-item]');
  await expect(items).toHaveCount(4);
  const boxes = await items.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    }),
  );

  expect(boxes[0]?.top).toBe(boxes[1]?.top);
  expect(boxes[2]?.top).toBe(boxes[3]?.top);
  expect(boxes[0]?.left).toBe(boxes[2]?.left);
  expect(boxes[1]?.left).toBe(boxes[3]?.left);
  expect(boxes[2]?.top ?? 0).toBeGreaterThan(boxes[0]?.top ?? 0);
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
