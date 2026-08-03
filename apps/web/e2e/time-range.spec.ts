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

const reportRangeValue = (page: Page): string | null => new URL(page.url()).searchParams.get('range');

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
