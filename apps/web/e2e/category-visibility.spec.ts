import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';

interface CategorySnapshot {
  categories: string[];
  options: string[];
}

const sortedCategoryLabels = (labels: readonly string[]): string[] =>
  [...labels].sort((left, right) => left.localeCompare(right));

test('keeps every populated harness and machine visible with default dimension filters', async ({ page }) => {
  await openHydratedReport(page, '/?tab=harnesses');

  const reportPeriod = page.getByRole('region', { name: 'Report period' });
  // Use the all-time fixture range so every synthetic category is in scope while
  // origin, harness, and machine retain their dashboard defaults.
  await reportPeriod.getByRole('button', { exact: true, name: 'All time' }).click();
  await waitForFocusedReportSettled(page);

  const breakdownTabs = page.getByRole('tablist', { name: 'Analysis dimension' });
  await expect(breakdownTabs.getByRole('tab', { name: 'Harnesses & providers' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const harnessPanel = page.getByRole('tabpanel', { name: 'Harnesses & providers' });
  await expect(harnessPanel).toBeVisible();

  const harnessFilter = page.getByRole('combobox', { name: 'Filter by harness' });
  await harnessFilter.click();
  const harnessListboxId = await harnessFilter.getAttribute('aria-controls');
  const harnessSnapshot = await harnessPanel.evaluate<CategorySnapshot, string | null>((panel, listboxId) => {
    const listbox = listboxId ? document.getElementById(listboxId) : null;
    if (!listbox) {
      throw new Error('Harness filter listbox is missing');
    }
    const options: string[] = [];
    for (const option of listbox.querySelectorAll('[role=option]')) {
      const label = (option.querySelector('[data-part=item-text]')?.textContent ?? option.textContent ?? '')
        .replace('✓', '')
        .trim();
      if (label) {
        options.push(label);
      }
    }
    const categories: string[] = [];
    for (const row of panel.querySelectorAll('[data-price-state]')) {
      const label = row.querySelector('button:not([aria-expanded])')?.textContent?.trim();
      if (label) {
        categories.push(label);
      }
    }
    return { categories, options };
  }, harnessListboxId);

  expect(harnessSnapshot.options.length).toBeGreaterThan(0);
  expect(sortedCategoryLabels(harnessSnapshot.categories)).toEqual(sortedCategoryLabels(harnessSnapshot.options));
  await page.keyboard.press('Escape');

  const breakdownSearch = harnessPanel.getByRole('searchbox', { name: 'Search this breakdown' });
  await breakdownSearch.fill('claude sub');
  await expect(harnessPanel.locator('[data-harness-total]')).toHaveCount(1);
  await expect(harnessPanel.locator('[data-harness-total="Claude"]')).toBeVisible();
  await expect(harnessPanel.locator('[data-provider-child="Claude sub"]')).toBeVisible();
  await expect(harnessPanel.locator('[data-provider-child]')).toHaveCount(1);
  await breakdownSearch.clear();

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();
  await waitForFocusedReportSettled(page);
  const activity = page.getByRole('region', { name: 'Activity' });
  const chartOptions = activity.locator('details[aria-label="Explore activity"]');
  await chartOptions.locator('summary').click();
  const machineRadio = chartOptions.getByRole('radio', { exact: true, name: 'Machine' });
  await machineRadio.click();
  await expect(machineRadio).toBeChecked();
  const sessionsRadio = chartOptions.getByRole('radio', { exact: true, name: 'Sessions' });
  await sessionsRadio.click();
  await expect(sessionsRadio).toBeChecked();
  await expect(activity.getByText('Machine · Day · Sessions', { exact: true })).toBeVisible();

  const machineFilter = page.getByRole('combobox', { name: 'Filter by machine' });
  await machineFilter.click();
  const machineListboxId = await machineFilter.getAttribute('aria-controls');
  const machineSnapshot = await activity.evaluate<CategorySnapshot, string | null>((range, listboxId) => {
    const listbox = listboxId ? document.getElementById(listboxId) : null;
    const legend = range.querySelector('[aria-label="machine timeline legend"]');
    if (!(listbox && legend)) {
      throw new Error('Machine filter listbox or timeline legend is missing');
    }
    const options: string[] = [];
    for (const option of listbox.querySelectorAll('[role=option]')) {
      const label = (option.querySelector('[data-part=item-text]')?.textContent ?? option.textContent ?? '')
        .replace('✓', '')
        .trim();
      if (label) {
        options.push(label);
      }
    }
    const categories: string[] = [];
    const titlePrefixes = ['Filter by ', 'Clear or replace '];
    for (const button of legend.querySelectorAll('button:not([disabled])')) {
      let label = button.getAttribute('title') ?? '';
      for (const prefix of titlePrefixes) {
        if (label.startsWith(prefix)) {
          label = label.slice(prefix.length);
          break;
        }
      }
      label = label.trim();
      if (label) {
        categories.push(label);
      }
    }
    return { categories, options };
  }, machineListboxId);

  expect(machineSnapshot.options.length).toBeGreaterThan(1);
  expect(sortedCategoryLabels(machineSnapshot.categories)).toEqual(sortedCategoryLabels(machineSnapshot.options));
});
