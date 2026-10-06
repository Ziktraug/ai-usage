import AxeBuilder from '@axe-core/playwright';
import { expect, openHydratedReport, test } from './browser-test';

const SOURCES_URL = /\/sources$/;

test.use({ hasTouch: true });

test('opens collection details on hover and keyboard without shifting focus, and keeps one stream across routes', async ({
  page,
}) => {
  let streams = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'eventsource') {
      streams += 1;
    }
  });
  await openHydratedReport(page);
  const header = page.locator('[data-workspace-topbar]');
  const trigger = header.getByRole('button', { name: 'Collection status' });
  const details = page.getByRole('dialog', { name: 'Collection details' });
  const search = page.getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' });
  await search.focus();
  await trigger.hover();
  await expect(details).toBeVisible();
  await expect(search).toBeFocused();
  await details.hover();
  await expect(details.getByRole('link', { name: 'View sources' })).toBeVisible();
  await expect(details.locator('[data-source-summary-attribution]')).toContainText('Source status checked at');
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(search).toBeFocused();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(details).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(details.getByRole('link', { name: 'View sources' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(details.getByRole('link', { name: 'View sources' })).toBeFocused();
  const { violations } = await new AxeBuilder({ page })
    .include('[data-workspace-topbar]')
    .include('[data-source-card]')
    .analyze();
  expect(violations).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(SOURCES_URL);
  await expect(details).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Collection status' })).toBeVisible();
  expect(streams).toBe(1);
  await expect(page.getByText('Local workspace', { exact: true })).toHaveCount(0);
});

test('keeps the mobile header compact and collection actions usable by touch', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHydratedReport(page);
  const header = page.locator('[data-workspace-topbar]');
  const trigger = header.getByRole('button', { name: 'Collection status' });
  const details = page.getByRole('dialog', { name: 'Collection details' });
  await trigger.tap();
  await expect(details).toBeVisible();
  const runAll = details.getByRole('button', { name: 'Collect now' });
  await expect(runAll).toBeEnabled();
  const release = Promise.withResolvers<void>();
  await page.route('**/api/source-control/command', async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await runAll.tap();
    await expect(runAll).toBeDisabled();
    await expect(runAll).toHaveAttribute('aria-busy', 'true');
    release.resolve();
    await expect(runAll).toBeEnabled();
    expect(await header.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(54);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const { violations } = await new AxeBuilder({ page })
      .include('[data-workspace-topbar]')
      .include('[data-source-card]')
      .analyze();
    expect(violations).toEqual([]);
    // The panel overlays the heading; use the page margin outside its bounded surface.
    await page.touchscreen.tap(8, 200);
    await expect(details).toHaveCount(0);
  } finally {
    release.resolve();
  }
});
