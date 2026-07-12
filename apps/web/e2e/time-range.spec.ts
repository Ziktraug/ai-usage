import { expect, test } from '@playwright/test';

const CHART_VIEW_PATTERN = /^Chart view:/;

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
