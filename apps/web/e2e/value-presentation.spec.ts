import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';

const MODEL_ANALYSIS_COLUMNS = [
  'Model',
  'API value',
  'Share',
  'Processed tokens',
  'Pricing coverage',
  'API value / 1M tokens',
] as const;
const LOWER_BOUND_PATTERN = /^≥/;

test('renders measured, partially measured, and zero Analysis values distinctly', async ({ page }) => {
  await page.setViewportSize({ height: 1200, width: 1440 });
  await openHydratedReport(page, '/?origin=%5B%5D');
  await page
    .getByRole('region', { name: 'Report period' })
    .getByRole('button', { exact: true, name: 'All time' })
    .click();
  await waitForFocusedReportSettled(page);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Analysis' }).click();
  await waitForFocusedReportSettled(page);

  const breakdown = page.getByRole('tabpanel', { name: 'Models' });
  await expect(breakdown).toBeVisible();

  const modelTable = breakdown.getByRole('table', { name: 'Model API-value analysis' });
  await expect(modelTable).toBeVisible();
  await expect(modelTable.getByRole('columnheader')).toHaveText(MODEL_ANALYSIS_COLUMNS);
  await expect(breakdown.locator('[data-model-analysis-cards]')).toBeHidden();

  const measuredRows = modelTable.locator('[data-price-state="measured"]');
  const partiallyMeasuredRows = modelTable.locator('[data-price-state="partially measured"]');
  const zeroRows = modelTable.locator('[data-price-state="zero"]');

  await expect(measuredRows.first()).toBeVisible();
  await expect(partiallyMeasuredRows.first()).toBeVisible();
  await expect(zeroRows.first()).toBeVisible();
  await expect(partiallyMeasuredRows.first()).toContainText('Partially measured');
  await expect(partiallyMeasuredRows.first().getByText(LOWER_BOUND_PATTERN).first()).toBeVisible();
  await expect(zeroRows.first().getByText('$0.00', { exact: true }).first()).toBeVisible();
  const desktopModelRowCount = await modelTable.locator('[data-price-state]').count();

  await page.getByRole('tab', { exact: true, name: 'Harnesses & providers' }).click();
  const harnessBreakdown = page.getByRole('tabpanel', { name: 'Harnesses & providers' });
  const harnessOrder = await harnessBreakdown
    .locator('[data-harness-total]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-harness-total')));
  expect(harnessOrder.slice(0, 4)).toEqual(['Codex', 'OpenCode', 'Claude', 'Cursor']);

  const harnessFillColor = async (harness: string): Promise<string> =>
    harnessBreakdown
      .locator(`[data-harness-total="${harness}"] [data-price-bar] > div`)
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await harnessFillColor('Codex')).toBe('rgb(14, 117, 105)');
  expect(await harnessFillColor('OpenCode')).toBe('rgb(32, 97, 180)');
  expect(await harnessFillColor('Claude')).toBe('rgb(140, 62, 116)');
  expect(await harnessFillColor('Cursor')).toBe('rgb(106, 71, 200)');

  const harnessShares = await harnessBreakdown
    .locator('[data-price-state] > :last-child > :last-child')
    .allTextContents();
  expect(harnessShares.slice(0, 4)).toEqual(['66%', '34%', '0.0%', '0.0%']);

  await page.setViewportSize({ height: 844, width: 390 });
  await page.getByRole('tab', { exact: true, name: 'Models' }).click();
  const mobileModels = page.getByRole('tabpanel', { name: 'Models' });
  const modelCards = mobileModels.getByRole('list', { name: 'Model API-value analysis' });
  await expect(modelCards).toBeVisible();
  await expect(mobileModels.locator('[data-model-analysis-table]')).toBeHidden();
  await expect(modelCards.getByRole('article')).toHaveCount(desktopModelRowCount);
  await expect(
    modelCards.locator('[data-price-state="partially measured"]').first().getByText(LOWER_BOUND_PATTERN).first(),
  ).toBeVisible();
  await expect(
    modelCards.locator('[data-price-state="zero"]').first().getByText('$0.00', { exact: true }).first(),
  ).toBeVisible();

  const actionHeights = await mobileModels
    .locator('[data-report-sharing-actions] button, [data-report-sharing-actions] a')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(actionHeights.length).toBeGreaterThan(0);
  expect(actionHeights.every((height) => height >= 44)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
});
