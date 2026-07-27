import { expect, test } from './browser-test';

const PARTIALLY_MEASURED_PATTERN = /Partially measured/;

test('renders measured, partially measured, and zero Breakdown bars distinctly', async ({ page }) => {
  await page.goto('/?origin=%5B%5D');
  await page.getByRole('region', { name: 'Date range' }).getByRole('button', { exact: true, name: 'All' }).click();
  await page.getByRole('tab', { name: 'Breakdown' }).click();

  const breakdown = page.getByRole('tabpanel', { name: 'Breakdown' });
  await expect(breakdown).toBeVisible();

  const measuredRows = breakdown.locator('[data-price-state="measured"]');
  const partiallyMeasuredRows = breakdown.locator('[data-price-state="partially measured"]');
  const zeroRows = breakdown.locator('[data-price-state="zero"]');

  await expect(measuredRows.first()).toBeVisible();
  await expect(partiallyMeasuredRows.first()).toBeVisible();
  await expect(zeroRows.first()).toBeVisible();
  await expect(partiallyMeasuredRows.first()).toContainText('Partially measured');

  const measuredBar = measuredRows.first().locator('[data-price-bar]');
  const zeroBar = zeroRows.first().locator('[data-price-bar]');
  const partiallyMeasuredBar = partiallyMeasuredRows.first().locator('[data-price-bar]');
  await expect(zeroBar).toHaveAttribute('data-width-percent', '0');
  await expect(partiallyMeasuredBar).toHaveAttribute('aria-label', PARTIALLY_MEASURED_PATTERN);

  expect(Number(await measuredBar.getAttribute('data-width-percent'))).toBeGreaterThan(0);
  expect(await partiallyMeasuredBar.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('dashed');
  expect(await zeroBar.evaluate((element) => getComputedStyle(element).borderTopStyle)).not.toBe('dashed');
});
