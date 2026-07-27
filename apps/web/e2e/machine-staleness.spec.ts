import { expect, test } from './browser-test';

const serializedSearchValues = (url: string): string => [...new URL(url).searchParams.values()].join(' ');

test('surfaces a stale machine outside sync while preserving its raw filter value', async ({ page }) => {
  await page.goto('/');
  expect(new URL(page.url()).pathname).toBe('/');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Machine' }).click();
  await expect(dateRange.getByTitle('Filter by Fixture Machine · Stale')).toContainText('Fixture Machine · Stale');

  const machineFilter = page.getByRole('combobox', { name: 'Filter by machine' });
  await expect(machineFilter).toBeVisible();
  await machineFilter.click();

  const staleMachineOption = page.getByRole('option', { name: 'Fixture Machine · Stale' });
  await expect(staleMachineOption).toBeVisible();
  await staleMachineOption.click();
  await expect(machineFilter).toContainText('Fixture Machine · Stale');
  await expect.poll(() => serializedSearchValues(page.url())).toContain('fixture-machine');
  expect(serializedSearchValues(page.url())).not.toContain('Stale');
});
