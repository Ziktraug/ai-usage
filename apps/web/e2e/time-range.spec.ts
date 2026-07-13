import { expect, type Locator, type Page, test } from '@playwright/test';

const CHART_VIEW_PATTERN = /^Chart view:/;

const reportRangeValue = (page: Page): string | null => new URL(page.url()).searchParams.get('range');

const dragHorizontally = async (page: Page, locator: Locator, deltaX: number): Promise<void> => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 4 });
  await page.mouse.up();
};

test('separates the report range from optional chart controls', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await expect(dateRange.getByText('Report range', { exact: true })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: 'All' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: 'Today' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '7d' })).toBeVisible();
  await expect(dateRange.getByRole('button', { exact: true, name: '30d' })).toBeVisible();
  await expect(dateRange.getByText(CHART_VIEW_PATTERN)).toBeVisible();

  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await expect(chartOptions).not.toHaveAttribute('open', '');
  await expect(chartOptions.getByText('Harness · Day · API value', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Group', { exact: true })).not.toBeVisible();

  await chartOptions.locator('summary').click();

  await expect(chartOptions).toHaveAttribute('open', '');
  await expect(chartOptions.getByText('Group', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Bucket', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Metric', { exact: true })).toBeVisible();
});

test('commits preset, text, keyboard, and pointer report ranges to the URL', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const startInput = dateRange.getByRole('textbox', { name: 'Start date' });
  const endInput = dateRange.getByRole('textbox', { name: 'End date' });
  const startHandle = dateRange.getByRole('slider', { name: 'Start date' });
  const selectedRange = dateRange.getByRole('button', { name: 'Drag selected date range' });

  await dateRange.getByRole('button', { exact: true, name: '30d' }).click();
  await expect.poll(() => reportRangeValue(page)).not.toBeNull();
  await expect(startInput).toHaveValue('2026-05-12');
  await expect(endInput).toHaveValue('2026-06-11');

  const presetUrl = page.url();
  await startInput.fill('2026-05-25');
  await expect(startInput).toHaveValue('2026-05-25');
  await expect.poll(() => page.url()).not.toBe(presetUrl);

  const textUrl = page.url();
  const keyboardStart = await startHandle.getAttribute('aria-valuenow');
  await startHandle.press('ArrowRight');
  await expect(startHandle).not.toHaveAttribute('aria-valuenow', keyboardStart ?? '');
  await expect(startInput).toHaveValue('2026-05-26');
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

test('keeps keyboard, wheel, pan, resize, and cancellation changes visual-only', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await dateRange.getByRole('button', { exact: true, name: '30d' }).click();
  await expect.poll(() => reportRangeValue(page)).not.toBeNull();
  const reportUrl = page.url();

  await dateRange.getByRole('button', { name: 'Adjust view' }).click();
  const graphStart = dateRange.getByRole('slider', { name: 'Graph view start' });
  const graphEnd = dateRange.getByRole('slider', { name: 'Graph view end' });
  const timeline = dateRange.getByRole('button', { name: 'Inspect timeline bucket' });

  const keyboardStart = await graphStart.getAttribute('aria-valuenow');
  await graphStart.press('ArrowRight');
  await expect(graphStart).not.toHaveAttribute('aria-valuenow', keyboardStart ?? '');
  await expect(page).toHaveURL(reportUrl);

  const wheelStart = await graphStart.getAttribute('aria-valuenow');
  const wheelEnd = await graphEnd.getAttribute('aria-valuenow');
  await timeline.hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, -120);
  await expect
    .poll(
      async () => `${await graphStart.getAttribute('aria-valuenow')}:${await graphEnd.getAttribute('aria-valuenow')}`,
    )
    .not.toBe(`${wheelStart}:${wheelEnd}`);
  await expect(page).toHaveURL(reportUrl);

  await dateRange.getByRole('button', { exact: true, name: '7d' }).last().click();
  const graphRange = dateRange.getByRole('button', { name: 'Drag graph view' });
  const panStart = await graphStart.getAttribute('aria-valuenow');
  await dragHorizontally(page, graphRange, -80);
  await expect(graphStart).not.toHaveAttribute('aria-valuenow', panStart ?? '');
  await expect(page).toHaveURL(reportUrl);

  const resizeStart = await graphStart.getAttribute('aria-valuenow');
  await dragHorizontally(page, graphStart, 35);
  await expect(graphStart).not.toHaveAttribute('aria-valuenow', resizeStart ?? '');
  await expect(page).toHaveURL(reportUrl);

  const graphEndBox = await graphEnd.boundingBox();
  expect(graphEndBox).not.toBeNull();
  if (graphEndBox) {
    const pointerX = graphEndBox.x + graphEndBox.width / 2;
    const pointerY = graphEndBox.y + graphEndBox.height / 2;
    await page.mouse.move(pointerX, pointerY);
    await page.mouse.down();
    await expect(timeline).toHaveAttribute('data-dragging', 'true');
    await graphEnd.dispatchEvent('pointercancel', { button: 0, clientX: pointerX, clientY: pointerY, pointerId: 1 });
    await expect(timeline).toHaveAttribute('data-dragging', 'false');
    await page.mouse.up();
  }
  await expect(page).toHaveURL(reportUrl);
});

test('clamps visual and report ranges after granularity and domain changes', async ({ page }) => {
  await page.goto('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await dateRange.getByRole('button', { name: 'Adjust view' }).click();
  await dateRange.getByRole('button', { exact: true, name: '2d' }).click();

  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Month' }).click();
  await dateRange.getByRole('button', { name: 'Adjust view' }).click();

  const graphStart = dateRange.getByRole('slider', { name: 'Graph view start' });
  const graphEnd = dateRange.getByRole('slider', { name: 'Graph view end' });
  await expect(graphStart).toHaveAttribute('aria-valuenow', '0');
  await expect(graphEnd).toHaveAttribute('aria-valuenow', await graphEnd.getAttribute('aria-valuemax'));

  await chartOptions.getByRole('radio', { exact: true, name: 'Day' }).click();
  await dateRange.getByRole('button', { name: 'Adjust view' }).click();
  await dateRange.getByRole('button', { exact: true, name: '2d' }).click();
  await dateRange.getByTitle('Filter by Codex').click();

  const reportStart = dateRange.getByRole('slider', { name: 'Start date' });
  const reportEnd = dateRange.getByRole('slider', { name: 'End date' });
  await expect(reportStart).toHaveAttribute('aria-valuemax', '0');
  await expect(reportStart).toHaveAttribute('aria-valuenow', '0');
  await expect(reportEnd).toHaveAttribute('aria-valuenow', '0');
  await expect(graphStart).toHaveAttribute('aria-valuemax', '0');
  await expect(graphStart).toHaveAttribute('aria-valuenow', '0');
  await expect(graphEnd).toHaveAttribute('aria-valuenow', '0');
});
