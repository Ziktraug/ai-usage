import type { Page } from '@playwright/test';
import { expect, test } from './browser-test';

const CHART_VIEW_PATTERN = /Chart view:/;
const DELEGATED_LEGEND_PATTERN = /^Delegated\b/;
const HUMAN_LEGEND_PATTERN = /^Human\b/;

const reportRangeValue = (page: Page): string | null => new URL(page.url()).searchParams.get('range');

test('uses one report range for the dashboard and activity chart', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await expect(dateRange.getByRole('button', { exact: true, name: 'All' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: 'Today' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '7d' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '30d' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dateRange.getByRole('textbox', { name: 'Start date' })).toHaveValue('May 12, 2026');
  await expect(dateRange.getByRole('textbox', { name: 'End date' })).toHaveValue('Jun 11, 2026');
  await expect(dateRange.getByText('May 12 → Jun 11, 2026 · 30 days', { exact: true })).toBeVisible();
  await expect(dateRange.getByText('Follows report range', { exact: true })).toBeVisible();
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
  await expect(chartOptions.getByText('Harness · Day · Estimated API value', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Group by', { exact: true })).not.toBeVisible();

  await chartOptions.locator('summary').click();

  await expect(chartOptions).toHaveAttribute('open', '');
  await expect(chartOptions.getByText('Group by', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Interval', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Metric', { exact: true })).toBeVisible();
});

test('changes every chart option from its segmented controls', async ({ page }) => {
  await page.goto('/');

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

  for (const option of ['Share', 'Sessions', 'Estimated API value']) {
    await chartOptions.getByRole('radio', { exact: true, name: option }).click();
    await expect(chartOptions.getByRole('radio', { exact: true, name: option })).toBeChecked();
  }
  await expect(chartOptions.getByText('Harness · Day · Estimated API value', { exact: true })).toBeVisible();
});

test('groups the timeline by campaign, machine, and origin with matching legends', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();

  await chartOptions.getByRole('radio', { exact: true, name: 'Campaign' }).click();
  await expect(chartOptions.getByText('Campaign · Day · Estimated API value', { exact: true })).toBeVisible();
  await expect(dateRange.getByTitle('Build report UI')).toContainText('Build report UI');
  await expect(dateRange.getByTitle('Tune collector fixtures')).toContainText('Tune collector fixtures');

  await chartOptions.getByRole('radio', { exact: true, name: 'Machine' }).click();
  await expect(chartOptions.getByText('Machine · Day · Estimated API value', { exact: true })).toBeVisible();
  await expect(dateRange.getByTitle('Filter by Fixture Machine · Stale')).toContainText('Fixture Machine · Stale');
  await expect(dateRange.getByTitle('Unknown machine')).toContainText('Unknown machine');

  await chartOptions.getByRole('radio', { exact: true, name: 'Sessions' }).click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Origin' }).click();
  await expect(chartOptions.getByText('Origin · Day · Sessions', { exact: true })).toBeVisible();
  await expect(dateRange.getByRole('button', { name: HUMAN_LEGEND_PATTERN })).toContainText('Human');
  await expect(dateRange.getByRole('button', { name: DELEGATED_LEGEND_PATTERN })).toContainText('Delegated');
});

test('commits preset, text, keyboard, and pointer report ranges to the URL', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const startInput = dateRange.getByRole('textbox', { name: 'Start date' });
  const endInput = dateRange.getByRole('textbox', { name: 'End date' });
  const startHandle = dateRange.getByRole('slider', { name: 'Start date' });
  const selectedRange = dateRange.getByRole('button', { name: 'Drag selected date range' });

  await dateRange.getByRole('button', { exact: true, name: 'All' }).click();
  await expect.poll(() => reportRangeValue(page)).not.toBeNull();
  await dateRange.getByRole('button', { exact: true, name: '30d' }).click();
  await expect.poll(() => reportRangeValue(page)).toBeNull();
  await expect(startInput).toHaveValue('May 12, 2026');
  await expect(endInput).toHaveValue('Jun 11, 2026');

  await dateRange.getByRole('button', { exact: true, name: '7d' }).click();
  await expect(startInput).toHaveValue('Jun 04, 2026');
  await expect(dateRange.getByText('Follows report range', { exact: true })).toBeVisible();

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
  await expect(startInput).not.toHaveValue(pointerStart);
});

test('does not capture wheel scrolling over the activity chart', async ({ page }) => {
  await page.goto('/');

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
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await dateRange.getByRole('button', { exact: true, name: '7d' }).click();
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

  const reportStart = dateRange.getByRole('slider', { name: 'Start date' });
  const reportEnd = dateRange.getByRole('slider', { name: 'End date' });
  await expect(reportStart).toHaveAttribute('aria-valuemax', '7');
  await expect(reportStart).toHaveAttribute('aria-valuenow', '0');
  await expect(reportEnd).toHaveAttribute('aria-valuenow', '7');
  await expect(dateRange.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);
});
