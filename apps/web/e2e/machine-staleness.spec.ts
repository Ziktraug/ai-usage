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

  const machineFilter = page.getByRole('button', { name: 'Filter by machine' });
  await expect(machineFilter).toBeVisible();
  await machineFilter.click();

  const machineOptions = page.getByRole('dialog', { name: 'Machine' });
  const staleMachineOption = machineOptions.getByRole('checkbox', { name: 'Fixture Machine · Stale' });
  await expect(staleMachineOption).toBeVisible();
  await expect(staleMachineOption).not.toBeChecked();
  const longMachineLabel = machineOptions.getByTitle('Fixture Machine Secondary · Freshness unavailable');
  expect(
    await longMachineLabel.evaluate(
      (element) =>
        getComputedStyle(element).whiteSpace === 'nowrap' &&
        element.getClientRects().length === 1 &&
        element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await machineOptions.getByTitle('Fixture Machine · Stale').click();
  await expect.poll(() => serializedSearchValues(page.url())).toContain('fixture-machine');
  await machineFilter.click();
  await expect(
    page.getByRole('dialog', { name: 'Machine' }).getByRole('checkbox', { name: 'Fixture Machine · Stale' }),
  ).toBeChecked();
  await waitForFocusedReportSettled(page);
  await expect(machineFilter).toContainText('Fixture Machine · Stale');
  expect(serializedSearchValues(page.url())).not.toContain('Stale');
});
