import { expect, test } from '@playwright/test';

const TOP_SESSION_PATTERN = /Top session/;
const routes = [
  { heading: 'Usage report', path: '/' },
  { heading: 'Skill management', path: '/skills' },
  { heading: 'Sources', path: '/sources' },
  { heading: 'Sync', path: '/sync' },
] as const;

const documentOverflow = () =>
  Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth;

for (const route of routes) {
  test(`${route.heading} exposes shared navigation without narrow overflow`, async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    await page.goto(route.path);
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();

    const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(navigation).toHaveCount(1);
    const firstLink = navigation.getByRole('link').first();
    await firstLink.focus();
    await expect(firstLink).toBeFocused();
    expect(await page.evaluate(documentOverflow)).toBeLessThanOrEqual(0);

    await page.setViewportSize({ height: 844, width: 390 });
    await expect(navigation).toBeVisible();
    expect(await page.evaluate(documentOverflow)).toBeLessThanOrEqual(0);
  });
}

test('reduced motion keeps drawer feedback while making motion effectively immediate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();

  const motionDurations = await Promise.all([
    drawer.evaluate((element) => getComputedStyle(element).animationDuration),
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link')
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ]);
  const durationSeconds = motionDurations.flatMap((value) =>
    value.split(',').map((entry) => {
      const duration = Number.parseFloat(entry);
      return entry.trim().endsWith('ms') ? duration / 1000 : duration;
    }),
  );
  expect(durationSeconds.every((duration) => duration <= 0.000_02)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
});
