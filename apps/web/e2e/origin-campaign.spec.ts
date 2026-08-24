import { expect, openHydratedReport, test } from './browser-test';

const MAX_SESSION_ROW_TEXT_LENGTH = 600;

test('makes the neutral origin default and keeps singleton campaigns unqualified', async ({ page }) => {
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
  await expect(page.getByText('Campaign · 1 session', { exact: true })).toHaveCount(0);

  const singletonRow = page
    .locator('[data-session-row-id][data-depth="0"]')
    .filter({ hasText: 'Recover Claude history' });
  await expect(singletonRow.getByRole('button', { name: 'Expand campaign Recover Claude history' })).toHaveCount(0);
  await singletonRow.click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();

  await page.locator('[data-session-row-id]').filter({ hasText: 'Build report UI' }).click();
  await expect(drawer.locator('[data-detail-item="Subagent"]')).toContainText('No');
});

test('ignores legacy campaign opt-out URLs and keeps every top-level row bounded and campaign-shaped', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1024 });
  await openHydratedReport(page, '/?campaigns=off&tab=sessions');

  await expect(page.getByRole('checkbox', { name: 'Group campaigns' })).toHaveCount(0);
  await expect(page.getByText('Group campaigns', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Campaign · 3 sessions', { exact: true })).toBeVisible();
  await expect(page.getByText('Campaign · 1 session', { exact: true })).toHaveCount(0);

  const sessionRows = page.locator('[data-session-row-id]');
  await expect(sessionRows.first()).toBeVisible();
  const textLengths = await sessionRows.evaluateAll((rows) => rows.map((row) => row.textContent?.length ?? 0));
  expect(textLengths.every((length) => length <= MAX_SESSION_ROW_TEXT_LENGTH)).toBe(true);
});
