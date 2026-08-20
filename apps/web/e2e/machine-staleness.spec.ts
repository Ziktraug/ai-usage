import { expect, openHydratedReport, test, waitForFocusedReportSettled } from './browser-test';

const serializedSearchValues = (url: string): string => [...new URL(url).searchParams.values()].join(' ');

test('surfaces a stale machine outside sync while preserving its raw filter value', async ({ page }) => {
  await openHydratedReport(page);
  expect(new URL(page.url()).pathname).toBe('/');

  const activity = page.getByRole('region', { name: 'Activity' });
  const chartOptions = activity.locator('details[aria-label="Explore activity"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Machine' }).click();
  await expect(activity.getByTitle('Filter by Fixture Machine · Stale')).toContainText('Fixture Machine · Stale');

  const machineFilter = page.getByRole('combobox', { name: 'Filter by machine' });
  await expect(machineFilter).toBeVisible();
  await machineFilter.click();

  const staleMachineOption = page.getByRole('option', { name: 'Fixture Machine · Stale' });
  await expect(staleMachineOption).toBeVisible();
  await staleMachineOption.click();
  await expect.poll(() => serializedSearchValues(page.url())).toContain('fixture-machine');
  await waitForFocusedReportSettled(page);
  await expect(machineFilter).toContainText('Fixture Machine · Stale');
  expect(serializedSearchValues(page.url())).not.toContain('Stale');
});
