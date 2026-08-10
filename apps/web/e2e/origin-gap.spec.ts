import { expect, openHydratedReport, test, waitForFocusedReportSettled } from './browser-test';

const expectedGapDescription =
  'Not classified: 3 sessions · Origin unsupported: 1 session · Origin not declared: 1 session · Origin unavailable: 1 session';

test('renders undeclared origin outside the stack with its three causes', async ({ page }) => {
  await openHydratedReport(page, '/?origin=[]');

  const reportPeriod = page.getByRole('region', { name: 'Report period' });
  await reportPeriod.getByRole('button', { exact: true, name: 'All time' }).click();
  await waitForFocusedReportSettled(page);

  const activity = page.getByRole('region', { name: 'Activity' });
  const chartOptions = activity.locator('details[aria-label="Explore activity"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Origin' }).click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Sessions' }).click();

  const legend = activity.locator('[data-report-range-part=total-legend]');
  await expect(legend).toContainText('Human');
  await expect(legend).toContainText('Delegated');
  await expect(legend).toContainText('Automated review');
  const gapLegend = legend.locator('[data-origin-unclassified-legend]');
  await expect(gapLegend).toHaveAttribute('title', expectedGapDescription);

  const stack = activity.locator('[data-origin-series-stack]');
  const gapBands = activity.locator('[data-origin-unclassified-band]');
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
