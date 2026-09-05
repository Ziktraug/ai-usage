import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';

const EXPAND_PROVIDERS_PATTERN = /Expand providers for/;

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

  const harnessFilter = page.getByRole('button', { name: 'Filter by harness' });
  await harnessFilter.click();
  const harnessOptions = page.getByRole('dialog', { name: 'Harness' });
  await expect(harnessOptions.getByRole('button', { name: 'All harnesses' })).toHaveAttribute('aria-pressed', 'true');
  const harnessSnapshot = await harnessPanel.evaluate<CategorySnapshot, string[]>(
    (panel, options) => {
      const categories: string[] = [];
      for (const row of panel.querySelectorAll('[data-price-state]')) {
        const label = row.querySelector('button:not([aria-expanded])')?.textContent?.trim();
        if (label) {
          categories.push(label);
        }
      }
      return { categories, options };
    },
    await harnessOptions
      .locator('li')
      .allTextContents()
      .then((labels) => labels.slice(1).map((label) => label.replace('✓', '').trim())),
  );

  expect(harnessSnapshot.options.length).toBeGreaterThan(0);
  expect(sortedCategoryLabels(harnessSnapshot.categories)).toEqual(sortedCategoryLabels(harnessSnapshot.options));
  await page.keyboard.press('Escape');

  const breakdownSearch = harnessPanel.getByRole('searchbox', { name: 'Search this breakdown' });
  await breakdownSearch.fill('claude sub');
  await expect(harnessPanel.locator('[data-harness-total]')).toHaveCount(1);
  await expect(harnessPanel.locator('[data-harness-total="Claude"]')).toBeVisible();
  const soleClaudeProvider = harnessPanel.locator('[data-harness-total="Claude"] [data-sole-provider="Claude sub"]');
  await expect(soleClaudeProvider).toBeVisible();
  await expect(soleClaudeProvider).toHaveText('· Claude sub');
  await expect(harnessPanel.locator('[data-provider-child]')).toHaveCount(0);
  await expect(harnessPanel.getByRole('button', { name: EXPAND_PROVIDERS_PATTERN })).toHaveCount(0);
  await breakdownSearch.clear();

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();
  await waitForFocusedReportSettled(page);
  const activity = page.getByRole('region', { name: 'Activity' });
  const chartOptions = activity.locator('details[aria-label="Explore activity"]');
  await chartOptions.locator('summary').click();
  const groupBy = activity.getByLabel('Group by');
  await groupBy.selectOption({ label: 'Machine' });
  await expect(groupBy).toHaveValue('machine');
  const sessionsButton = activity
    .getByRole('group', { name: 'Activity metric' })
    .getByRole('button', { exact: true, name: 'Sessions' });
  await sessionsButton.click();
  await expect(sessionsButton).toHaveAttribute('aria-pressed', 'true');
  await expect(activity.getByText('Machine · Day · Sessions', { exact: true })).toBeVisible();

  const machineFilter = page.getByRole('button', { name: 'Filter by machine' });
  await machineFilter.click();
  const machineOptions = page.getByRole('dialog', { name: 'Machine' });
  await expect(machineOptions.getByRole('button', { name: 'All machines' })).toHaveAttribute('aria-pressed', 'true');
  const machineSnapshot = await activity.evaluate<CategorySnapshot, string[]>(
    (range, options) => {
      const legend = range.querySelector('[aria-label="machine timeline legend"]');
      if (!legend) {
        throw new Error('Machine timeline legend is missing');
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
    },
    await machineOptions
      .locator('li')
      .allTextContents()
      .then((labels) => labels.slice(1).map((label) => label.replace('✓', '').trim())),
  );

  expect(machineSnapshot.options.length).toBeGreaterThan(1);
  expect(sortedCategoryLabels(machineSnapshot.categories)).toEqual(sortedCategoryLabels(machineSnapshot.options));
});
