import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';

const FIXED_VALUE_COLUMN_PATTERN = / 96px$/;
const PARTIALLY_MEASURED_PATTERN = /Partially measured/;

test('renders measured, partially measured, and zero Breakdown bars distinctly', async ({ page }) => {
  await page.setViewportSize({ height: 1200, width: 1440 });
  await openHydratedReport(page, '/?origin=%5B%5D');
  await page
    .getByRole('region', { name: 'Report period' })
    .getByRole('button', { exact: true, name: 'All time' })
    .click();
  await waitForFocusedReportSettled(page);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Breakdown' }).click();
  await waitForFocusedReportSettled(page);

  const breakdown = page.getByRole('tabpanel', { name: 'Models' });
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

  const [panelBox, measuredRowBox] = await Promise.all([breakdown.boundingBox(), measuredRows.first().boundingBox()]);
  expect(measuredRowBox?.width ?? 0).toBeGreaterThanOrEqual((panelBox?.width ?? 0) - 4);
  await expect(measuredRows.first()).toHaveCSS('column-gap', '14px');
  await expect(measuredRows.first()).toHaveCSS('grid-template-columns', FIXED_VALUE_COLUMN_PATTERN);
  await expect(measuredBar).toHaveCSS('height', '6px');
  await expect(measuredBar).toHaveCSS('margin-top', '8px');
  await expect(measuredBar.locator(':scope > div')).toHaveCSS('border-radius', '999px');

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

  await page.setViewportSize({ height: 1200, width: 361 });
  await page.getByRole('tab', { exact: true, name: 'Models' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Models' }).locator('[data-report-sharing-actions]')).toHaveCSS(
    'height',
    '30px',
  );
});
