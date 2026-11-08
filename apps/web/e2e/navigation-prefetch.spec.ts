import { expect, test, waitForHydratedReport } from './browser-test';

test('navigation intent starts the destination Query before clicking the link', async ({ page }) => {
  await page.goto('/');
  await waitForHydratedReport(page);
  const rail = page.locator('[data-app-navigation="desktop"]');
  await expect(rail).toHaveAttribute('data-hydrated', 'true');
  const sync = rail.getByRole('link', { name: 'Sync', exact: true });

  // Report/Campaigns are synthetic in this runtime. Sync exercises the same browser-load seam
  // against the isolated e2e fleet fixture, never the operator's store. Assert the request on
  // hover rather than a timing-dependent absence of a single-frame loading placeholder.
  const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/rpc/sync/fleet');
  await sync.hover();
  expect((await response).ok()).toBe(true);
  await expect(page).toHaveURL('/');
  await sync.click();
  await expect(page.getByRole('heading', { name: 'Machine fleet', exact: true })).toBeVisible();
});

test('report timeline state persists between tabs but resets after leaving the report layout', async ({ page }) => {
  await page.goto('/');
  await waitForHydratedReport(page);
  const rail = page.locator('[data-app-navigation="desktop"]');
  const grouping = page.getByRole('combobox', { name: 'Group by', exact: true });
  await grouping.selectOption('model');
  await rail.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true, level: 1 })).toBeVisible();
  await rail.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(grouping).toHaveValue('model');
  await rail.getByRole('link', { name: 'Sync', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Machine fleet', exact: true })).toBeVisible();
  await rail.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(grouping).toHaveValue('harness');
});
