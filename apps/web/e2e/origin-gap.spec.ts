import { expect, openHydratedReport, test, waitForFocusedReportSettled } from './browser-test';

const expectedGapDescription =
  'Not classified: 3 sessions · Origin unsupported: 1 session · Origin not declared: 1 session · Origin unavailable: 1 session';

test('renders undeclared origin outside the stack with its three causes', async ({ page }) => {
  await openHydratedReport(page, '/?origin=[]');

  const dateRange = page.getByRole('region', { name: 'Date range' });
  await dateRange.getByRole('button', { exact: true, name: 'All' }).click();
  await waitForFocusedReportSettled(page);

  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Origin' }).click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Sessions' }).click();

  const legend = dateRange.locator('[data-report-range-part=total-legend]');
  await expect(legend).toContainText('Human');
  await expect(legend).toContainText('Delegated');
  await expect(legend).toContainText('Automated review');
  const gapLegend = legend.locator('[data-origin-unclassified-legend]');
  await expect(gapLegend).toHaveAttribute('title', expectedGapDescription);

  const stack = dateRange.locator('[data-origin-series-stack]');
  const gapBands = dateRange.locator('[data-origin-unclassified-band]');
  await expect(stack).toBeVisible();
  await expect(gapBands).toBeVisible();
  expect(
    await gapBands.evaluate(
      (bands, seriesStack) => {
        const stackElement = seriesStack as HTMLElement;
        return bands.parentElement === stackElement.parentElement && !stackElement.contains(bands);
      },
      await stack.elementHandle(),
    ),
  ).toBe(true);
  await expect(gapBands.locator('[data-origin-gap-sessions="1"]')).toHaveCount(3);

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme;
    }, theme);
    const appearance = await gapBands
      .locator('[data-origin-gap-sessions="1"]')
      .first()
      .evaluate((band) => {
        const style = getComputedStyle(band);
        return { backgroundImage: style.backgroundImage, borderColor: style.borderColor };
      });
    expect(appearance.backgroundImage).not.toBe('none');
    expect(appearance.borderColor).not.toBe('rgba(0, 0, 0, 0)');
  }
});
