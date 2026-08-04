import type { Page } from '@playwright/test';
import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';

const CALENDAR_NAME_PATTERN = /Daily activity calendar/;
const CHART_VIEW_PATTERN = /Chart view:/;
const DELEGATED_LEGEND_PATTERN = /^Delegated\b/;
const HUMAN_LEGEND_PATTERN = /^Human\b/;
const PUNCHCARD_CELL_BUTTON_PATTERN = /^Filter report to /;
const PUNCHCARD_CELL_LABEL_PATTERN =
  /^Filter report to (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) ([0-9]{2}):00–[0-9]{2}:59, ([0-9,]+) sessions?$/;
const SESSION_SUMMARY_PATTERN = / sessions$/;

// The bug this guards against bound the class to the `'start' | 'end'` edge
// name, so the generated style never applied. Assert the edge name itself never
// reaches the class list rather than pattern-matching a Panda atom, which a
// hyphenated domain value would also satisfy.
const HANDLE_EDGE_NAMES = ['start', 'end'] as const;
// WCAG 2.5.5 Target Size (Enhanced); `timeSliderThumb` is sized for it.
const HANDLE_MINIMUM_TARGET_PX = 44;
const BRUSH_GEOMETRY_VIEWPORTS = [
  { height: 1000, width: 1440 },
  { height: 900, width: 1024 },
  { height: 900, width: 768 },
  // The frozen narrow viewport the responsive suites use elsewhere.
  { height: 800, width: 361 },
] as const;

interface BrushHandleGeometry {
  centerX: number;
  classes: string[];
  height: number;
  label: string | null;
  position: string;
  role: string | null;
  valueText: string | null;
  width: number;
}

interface BrushGeometry {
  handles: BrushHandleGeometry[];
  offsets: number[];
}

const readBrushGeometry = (element: Element): BrushGeometry => {
  const selection = element.querySelector('[aria-label="Selected report window"]');
  if (!selection) {
    throw new Error('Expected the selected report window');
  }
  const selectionBox = selection.getBoundingClientRect();
  const handles = [...element.querySelectorAll('[role="slider"]')].map((handle) => {
    const box = handle.getBoundingClientRect();
    return {
      centerX: box.left + box.width / 2,
      classes: [...handle.classList],
      height: box.height,
      label: handle.getAttribute('aria-label'),
      position: getComputedStyle(handle).position,
      role: handle.getAttribute('role'),
      valueText: handle.getAttribute('aria-valuetext'),
      width: box.width,
    };
  });
  const edgeFor = (label: string): number => (label === 'Start date' ? selectionBox.left : selectionBox.right);
  return {
    handles,
    offsets: handles.map((handle) => Math.round(handle.centerX - edgeFor(handle.label ?? ''))),
  };
};

const reportRangeValue = (page: Page): string | null => new URL(page.url()).searchParams.get('range');

const navigationEntryKey = async (page: Page): Promise<string | null> =>
  await page.evaluate(() => {
    const states = Reflect.get(history.state ?? {}, 'sveltekit:states');
    if (!(states && typeof states === 'object')) {
      return null;
    }
    const key = Reflect.get(states, 'aiUsageNavigationKey');
    return typeof key === 'string' ? key : null;
  });

test('uses one report range for the dashboard and activity chart', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await expect(dateRange.getByRole('button', { exact: true, name: 'All' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: 'Today' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '7d' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '30d' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dateRange.getByRole('textbox', { name: 'Start date' })).toHaveValue('May 12, 2026');
  await expect(dateRange.getByRole('textbox', { name: 'End date' })).toHaveValue('Jun 11, 2026');
  await expect(dateRange.getByText('May 12 → Jun 11, 2026 · 30 days', { exact: true })).toBeVisible();
  await expect(dateRange.getByText('Activity range follows report range', { exact: true })).toBeVisible();
  await expect(dateRange.getByText('Filters the entire report', { exact: true })).toHaveCount(0);
  await expect(dateRange.getByTitle('Filter by Codex')).toHaveCount(1);
  expect(
    await dateRange
      .locator('[data-report-range-part]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-report-range-part'))),
  ).toEqual(['summary', 'total-legend', 'chart', 'chart-axis', 'adjustments', 'brush', 'chart-options']);
  await expect(dateRange.getByText(CHART_VIEW_PATTERN)).toHaveCount(0);
  await expect(dateRange.getByRole('button', { name: 'Zoom chart' })).toHaveCount(0);
  await expect(dateRange.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);

  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await expect(chartOptions).not.toHaveAttribute('open', '');
  await expect(chartOptions.getByText('Harness · Day · Estimated API-equivalent value', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Group by', { exact: true })).not.toBeVisible();

  await chartOptions.locator('summary').click();

  await expect(chartOptions).toHaveAttribute('open', '');
  await expect(chartOptions.getByText('Group by', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Interval', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Metric', { exact: true })).toBeVisible();
});

test('wraps chart options without horizontal clipping below the frozen narrow viewport', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 320 });
  await openHydratedReport(page);

  const summary = page
    .getByRole('region', { name: 'Date range' })
    .locator('details[aria-label="Chart options"] summary');
  const geometry = await summary.evaluate((element) => {
    const current = element.querySelector('span:last-child');
    if (!(current instanceof HTMLElement)) {
      throw new Error('Expected the current chart-options summary');
    }
    const currentStyle = getComputedStyle(current);
    return {
      clientWidth: element.clientWidth,
      currentMinWidth: currentStyle.minWidth,
      currentWhiteSpace: currentStyle.whiteSpace,
      scrollWidth: element.scrollWidth,
    };
  });

  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.currentMinWidth).toBe('0px');
  expect(geometry.currentWhiteSpace).toBe('normal');
});

test('uses clickable heatmap days as Rhythm activity-day controls without a native date input', async ({ page }) => {
  await openHydratedReport(page);

  const calendar = page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN });
  const rhythm = page.locator('section').filter({ has: calendar });
  const heatmapDays = calendar.locator('button[data-heatmap-day]');
  await expect(rhythm.getByRole('heading', { exact: true, name: 'Rhythm' })).toBeVisible();
  await expect(rhythm.locator('input[type="date"]')).toHaveCount(0);
  expect(await heatmapDays.count()).toBeGreaterThan(0);

  await heatmapDays.first().click();
  await waitForFocusedReportSettled(page);
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('filters the report from non-empty Punchcard cells with click and keyboard', async ({ page }) => {
  await openHydratedReport(page);

  const heading = page.getByRole('heading', { exact: true, name: 'Punchcard' });
  const punchcard = heading.locator('xpath=ancestor::section[1]');
  const timeCellButtons = punchcard.getByRole('button', { name: PUNCHCARD_CELL_BUTTON_PATTERN });
  await expect(heading).toBeVisible();
  expect(await timeCellButtons.count()).toBeGreaterThan(0);
  expect(await punchcard.locator('[title*="0 sessions"]').count()).toBeGreaterThan(0);
  await expect(punchcard.locator('button[title*="0 sessions"]')).toHaveCount(0);

  const ariaLabel = await timeCellButtons.first().getAttribute('aria-label');
  if (ariaLabel === null) {
    throw new Error('Expected a Punchcard cell label');
  }
  const match = ariaLabel.match(PUNCHCARD_CELL_LABEL_PATTERN);
  if (!match) {
    throw new Error('Expected a canonical Punchcard cell label');
  }
  const weekday = match[1] ?? '';
  const hour = match[2] ?? '';
  const formattedCount = match[3] ?? '';
  const weekdayCodes = new Map<string, string>([
    ['Monday', 'MON'],
    ['Tuesday', 'TUE'],
    ['Wednesday', 'WED'],
    ['Thursday', 'THU'],
    ['Friday', 'FRI'],
    ['Saturday', 'SAT'],
    ['Sunday', 'SUN'],
  ]);
  const weekdayCode = weekdayCodes.get(weekday);
  if (!(weekdayCode && hour && formattedCount)) {
    throw new Error('Expected a complete Punchcard cell label');
  }
  const timeCellValue = `${weekdayCode}-${hour}`;
  const period = `${weekday} ${hour}:00–${hour}:59`;
  const timePill = page.getByTitle('Clear Time filter');
  const summary = page.locator('[data-active-filters] span[aria-live="polite"]').filter({
    hasText: SESSION_SUMMARY_PATTERN,
  });
  const firstTimeCell = punchcard.getByRole('button', { exact: true, name: ariaLabel });

  await firstTimeCell.focus();
  await firstTimeCell.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBe(timeCellValue);
  await waitForFocusedReportSettled(page);
  await expect(timePill).toHaveText(`Time · ${period} ×`);
  await expect(summary).toContainText(`${formattedCount} / `);

  await timePill.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBeNull();
  await waitForFocusedReportSettled(page);
  await expect(timePill).toHaveCount(0);

  await punchcard.getByRole('button', { exact: true, name: ariaLabel }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBe(timeCellValue);
  await waitForFocusedReportSettled(page);
  await expect(timePill).toHaveText(`Time · ${period} ×`);
  await timePill.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBeNull();
  await waitForFocusedReportSettled(page);
});

test('changes every chart option from its segmented controls', async ({ page }) => {
  await openHydratedReport(page);

  const chartOptions = page.getByRole('region', { name: 'Date range' }).locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();

  for (const option of ['Campaign', 'Machine', 'Origin', 'Model', 'Provider', 'Project', 'Harness']) {
    await chartOptions.getByRole('radio', { exact: true, name: option }).click();
    await expect(chartOptions.getByRole('radio', { exact: true, name: option })).toBeChecked();
  }

  for (const option of ['Week', 'Month', 'Day']) {
    await chartOptions.getByRole('radio', { exact: true, name: option }).click();
    await expect(chartOptions.getByRole('radio', { exact: true, name: option })).toBeChecked();
  }

  for (const option of ['Share', 'Sessions', 'Estimated API-equivalent value']) {
    await chartOptions.getByRole('radio', { exact: true, name: option }).click();
    await expect(chartOptions.getByRole('radio', { exact: true, name: option })).toBeChecked();
  }
  await expect(chartOptions.getByText('Harness · Day · Estimated API-equivalent value', { exact: true })).toBeVisible();
});

test('groups the timeline by campaign, machine, and origin with matching legends', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();

  await chartOptions.getByRole('radio', { exact: true, name: 'Campaign' }).click();
  await expect(
    chartOptions.getByText('Campaign · Day · Estimated API-equivalent value', { exact: true }),
  ).toBeVisible();
  await expect(dateRange.getByTitle('Build report UI', { exact: true })).toContainText('Build report UI');
  await expect(dateRange.getByTitle('Inspect OpenCode root', { exact: true })).toContainText('Inspect OpenCode root');

  await chartOptions.getByRole('radio', { exact: true, name: 'Machine' }).click();
  await expect(chartOptions.getByText('Machine · Day · Estimated API-equivalent value', { exact: true })).toBeVisible();
  await expect(dateRange.getByTitle('Filter by Fixture Machine · Stale')).toContainText('Fixture Machine · Stale');
  await expect(dateRange.getByTitle('Unknown machine')).toContainText('Unknown machine');

  await chartOptions.getByRole('radio', { exact: true, name: 'Sessions' }).click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Origin' }).click();
  await expect(chartOptions.getByText('Origin · Day · Sessions', { exact: true })).toBeVisible();
  await expect(dateRange.getByRole('button', { name: HUMAN_LEGEND_PATTERN })).toContainText('Human');
  await expect(dateRange.getByRole('button', { name: DELEGATED_LEGEND_PATTERN })).toContainText('Delegated');
});

test('commits preset, text, keyboard, and pointer report ranges to the URL', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const startInput = dateRange.getByRole('textbox', { name: 'Start date' });
  const endInput = dateRange.getByRole('textbox', { name: 'End date' });
  const startHandle = dateRange.getByRole('slider', { name: 'Start date' });
  const selectedRange = dateRange.getByRole('button', { name: 'Selected report window' });

  await dateRange.getByRole('button', { exact: true, name: 'All' }).click();
  await expect.poll(() => reportRangeValue(page)).not.toBeNull();
  await waitForFocusedReportSettled(page);
  await dateRange.getByRole('button', { exact: true, name: '30d' }).click();
  await expect.poll(() => reportRangeValue(page)).toBeNull();
  await waitForFocusedReportSettled(page);
  await expect(startInput).toHaveValue('May 12, 2026');
  await expect(endInput).toHaveValue('Jun 11, 2026');

  await dateRange.getByRole('button', { exact: true, name: '7d' }).click();
  await expect(startInput).toHaveValue('Jun 04, 2026');
  await expect(dateRange.getByText('Activity range follows report range', { exact: true })).toBeVisible();

  const presetUrl = page.url();
  await startInput.fill('2026-05-25');
  await expect(startInput).toHaveValue('2026-05-25');
  await expect.poll(() => page.url()).not.toBe(presetUrl);
  await startInput.press('Enter');
  await expect(startInput).toHaveValue('May 25, 2026');
  await expect(startInput).not.toBeFocused();

  const textUrl = page.url();
  const keyboardStart = await startHandle.getAttribute('aria-valuenow');
  await startHandle.press('ArrowRight');
  await expect(startHandle).not.toHaveAttribute('aria-valuenow', keyboardStart ?? '');
  await expect(startInput).toHaveValue('May 26, 2026');
  await expect.poll(() => page.url()).not.toBe(textUrl);

  const keyboardUrl = page.url();
  const pointerStart = await startInput.inputValue();
  const selectedRangeBox = await selectedRange.boundingBox();
  expect(selectedRangeBox).not.toBeNull();
  if (selectedRangeBox) {
    const startX = selectedRangeBox.x + selectedRangeBox.width / 2;
    const startY = selectedRangeBox.y + selectedRangeBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 50, startY, { steps: 4 });
    await expect(selectedRange).toHaveAttribute('data-dragging', 'true');
    await page.mouse.up();
  }
  await expect(startInput).not.toHaveValue(pointerStart);
  await expect.poll(() => page.url()).not.toBe(keyboardUrl);

  await page.reload();
  await waitForFocusedReportSettled(page);
  await expect(startInput).not.toHaveValue(pointerStart);

  const beforeFirstBlurKey = await navigationEntryKey(page);
  await startInput.fill('2026-05-20');
  await endInput.focus();
  await expect(startInput).toHaveValue('May 20, 2026');
  await expect.poll(() => reportRangeValue(page)).toContain('"from":"2026-05-20"');
  await expect.poll(() => navigationEntryKey(page)).not.toBe(beforeFirstBlurKey);
  const firstBlurredEditKey = await navigationEntryKey(page);
  expect(firstBlurredEditKey).not.toBeNull();
  const firstBlurredEditUrl = page.url();

  await startInput.fill('2026-05-21');
  await endInput.focus();
  await expect(startInput).toHaveValue('May 21, 2026');
  await expect.poll(() => reportRangeValue(page)).toContain('"from":"2026-05-21"');
  await expect.poll(() => navigationEntryKey(page)).not.toBe(firstBlurredEditKey);
  const secondBlurredEditKey = await navigationEntryKey(page);
  expect(secondBlurredEditKey).not.toBeNull();
  const secondBlurredEditUrl = page.url();
  expect(secondBlurredEditUrl).not.toBe(firstBlurredEditUrl);

  await page.goBack();
  await expect.poll(() => page.url()).toBe(firstBlurredEditUrl);
  await expect.poll(() => navigationEntryKey(page)).not.toBe(secondBlurredEditKey);
  await waitForFocusedReportSettled(page);
  await expect.poll(() => page.url()).toBe(firstBlurredEditUrl);
  await expect(startInput).toHaveValue('May 20, 2026');
});

test('does not capture wheel scrolling over the activity chart', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const timeline = dateRange.getByRole('button', {
    name: 'Inspect activity timeline. Use arrow keys to inspect days.',
  });
  const initialScrollY = await page.evaluate(() => window.scrollY);
  await timeline.hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => await page.evaluate(() => window.scrollY)).toBeGreaterThan(initialScrollY);
});

test('keeps the report range canonical across granularity and domain changes', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await dateRange.getByRole('button', { exact: true, name: '7d' }).click();
  await waitForFocusedReportSettled(page);
  const startInput = dateRange.getByRole('textbox', { name: 'Start date' });
  const endInput = dateRange.getByRole('textbox', { name: 'End date' });
  const selectedStart = await startInput.inputValue();
  const selectedEnd = await endInput.inputValue();

  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Month' }).click();
  await expect(startInput).toHaveValue(selectedStart);
  await expect(endInput).toHaveValue(selectedEnd);

  await dateRange.getByTitle('Filter by Codex').click();
  await waitForFocusedReportSettled(page);

  const reportStart = dateRange.getByRole('slider', { name: 'Start date' });
  const reportEnd = dateRange.getByRole('slider', { name: 'End date' });
  await expect(reportStart).toHaveAttribute('aria-valuemax', '7');
  await expect(reportStart).toHaveAttribute('aria-valuenow', '0');
  await expect(reportEnd).toHaveAttribute('aria-valuenow', '7');
  await expect(dateRange.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);
});

test('anchors the brush handles to the selected report window at every viewport', async ({ page }) => {
  await openHydratedReport(page);

  const brush = page.getByRole('region', { name: 'Date range' }).locator('[data-report-range-part="brush"]');
  const measureBrush = (): Promise<BrushGeometry> => brush.evaluate(readBrushGeometry);

  for (const viewport of BRUSH_GEOMETRY_VIEWPORTS) {
    await page.setViewportSize(viewport);

    // The handles are positioned from the same percentages as the selection, so
    // their centres must land on its edges however wide the track becomes.
    await expect.poll(async () => (await measureBrush()).offsets).toEqual([0, 0]);

    const geometry = await measureBrush();
    expect(geometry.handles).toHaveLength(2);
    for (const handle of geometry.handles) {
      // An edge name in the class list means a loop binding shadowed the Panda
      // class and the thumb silently lost its absolute positioning.
      expect(handle.classes.filter((token) => HANDLE_EDGE_NAMES.includes(token as 'end' | 'start'))).toEqual([]);
      expect(handle.position).toBe('absolute');
    }
  }

  await page.setViewportSize(BRUSH_GEOMETRY_VIEWPORTS[0]);
  const startHandle = brush.getByRole('slider', { name: 'Start date' });
  const before = await measureBrush();
  await startHandle.press('ArrowRight');
  await expect.poll(async () => (await measureBrush()).offsets).toEqual([0, 0]);
  // One day later must move the thumb rightwards, not merely somewhere else.
  const afterKeyboard = await measureBrush();
  expect(afterKeyboard.handles[0]?.centerX ?? 0).toBeGreaterThan(before.handles[0]?.centerX ?? 0);
});

test('drags a brush handle with the pointer and keeps it on the selection edge', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const brush = dateRange.locator('[data-report-range-part="brush"]');
  const startHandle = brush.getByRole('slider', { name: 'Start date' });
  const startInput = dateRange.getByRole('textbox', { name: 'Start date' });
  // `page.mouse` works in viewport coordinates and does not scroll, so the
  // handle has to be in view before its box is turned into a pointer position.
  await startHandle.scrollIntoViewIfNeeded();
  const before = await startHandle.boundingBox();
  const startedAt = await startInput.inputValue();
  expect(before).not.toBeNull();
  if (!before) {
    return;
  }

  // The handle became a `<button>`; prove pointer capture still drags it.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 - 120, before.y + before.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => await startInput.inputValue()).not.toBe(startedAt);
  await expect.poll(async () => (await brush.evaluate(readBrushGeometry)).offsets).toEqual([0, 0]);
  const after = await startHandle.boundingBox();
  expect(after?.x ?? 0).toBeLessThan(before.x);
  // Dragging must not leave the pointer captured on the thumb.
  await expect(brush.locator('[data-dragging="true"]')).toHaveCount(0);
});

test('announces each brush handle as a slider over the day it selects', async ({ page }) => {
  await openHydratedReport(page);

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const brush = dateRange.locator('[data-report-range-part="brush"]');
  const handles = (await brush.evaluate(readBrushGeometry)).handles;

  expect(handles.map((handle) => handle.label)).toEqual(['Start date', 'End date']);
  for (const handle of handles) {
    expect(handle.role).toBe('slider');
    // A raw bucket index announces nothing useful, so the resolved day must be
    // exposed, and the pointer target must stay reachable on touch.
    expect(handle.valueText).toBe(handle.label === 'Start date' ? 'May 12, 2026' : 'Jun 11, 2026');
    expect(handle.width).toBeGreaterThanOrEqual(HANDLE_MINIMUM_TARGET_PX);
    expect(handle.height).toBeGreaterThanOrEqual(HANDLE_MINIMUM_TARGET_PX);
  }

  await brush.getByRole('slider', { name: 'Start date' }).press('ArrowRight');
  await expect(brush.getByRole('slider', { name: 'Start date' })).toHaveAttribute('aria-valuetext', 'May 13, 2026');
});
