import { expect, openHydratedReport, test } from './browser-test';

const MAX_SESSION_ROW_TEXT_LENGTH = 600;

test('makes the neutral origin default and singleton campaigns explicit', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1024 });
  await openHydratedReport(page, '/?tab=sessions');

  const originFilter = page.getByRole('button', { name: 'Filter by origin' });
  await expect(originFilter).toContainText('Origin: all');
  await originFilter.click();
  for (const origin of ['Human', 'Delegated', 'Automated review']) {
    await expect(page.getByText(origin, { exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await expect(page.getByText('Campaign · 3 sessions', { exact: true })).toBeVisible();
  await expect(page.getByText('Campaign · 1 session', { exact: true })).toHaveCount(2);

  await page.locator('[data-session-row-id]').filter({ hasText: 'Build report UI' }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer.locator('[data-detail-item="Subagent"]')).toContainText('No');
  // The campaign header and the metric grid state one aggregation, not two.
  // All four header values come from the campaign row, not a re-aggregation of the member page:
  // 3.20+0.17+0.84, 73,500+32,600+48,800, 22+11+16, 64+18+27.
  const campaignTotals = drawer.locator('[data-campaign-totals]');
  await expect(campaignTotals).toHaveText('$4.21 API · 155k fresh tokens · 49 turns · 109 tools');
  await expect(drawer.locator('[data-detail-item="API value"]')).toContainText('$4.21');
  const campaignScope = drawer.locator('[data-session-drawer-campaign-scope]');
  await expect(campaignScope).toHaveText('Campaign · 3 sessions');
  // The qualifier must describe the whole campaign, not just what the list below shows.
  await expect(campaignScope).toHaveAttribute(
    'title',
    "Values below cover the whole campaign: every session matching the current filters plus its rolled-up automated reviews, including any not listed below. Analyze root opens the root session's chronology.",
  );
  // "Tune collector fixtures" is the automated review and it is one of the three listed
  // rows, so nothing is unaccounted for and no rollup suffix may claim otherwise.
  const campaignCounts = drawer.locator('[data-campaign-session-counts]');
  await expect(campaignCounts).toContainText('3 / 3 sessions shown');
  await expect(campaignCounts).not.toContainText('automated review');
  await expect(drawer.getByText('Tune collector fixtures', { exact: true })).toBeVisible();
});

test('ignores legacy campaign opt-out URLs and keeps every top-level row bounded and campaign-shaped', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1024 });
  await openHydratedReport(page, '/?campaigns=off&tab=sessions');

  await expect(page.getByRole('checkbox', { name: 'Group campaigns' })).toHaveCount(0);
  await expect(page.getByText('Group campaigns', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Campaign · 3 sessions', { exact: true })).toBeVisible();
  await expect(page.getByText('Campaign · 1 session', { exact: true })).toHaveCount(2);

  const sessionRows = page.locator('[data-session-row-id]');
  await expect(sessionRows.first()).toBeVisible();
  const textLengths = await sessionRows.evaluateAll((rows) => rows.map((row) => row.textContent?.length ?? 0));
  expect(textLengths.every((length) => length <= MAX_SESSION_ROW_TEXT_LENGTH)).toBe(true);
});
