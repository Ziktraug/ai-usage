import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './browser-test';

const TOP_SESSION_PATTERN = /Top session/;
const routes = [
  { heading: 'Usage report', path: '/' },
  { heading: 'Skill management', path: '/skills' },
  { heading: 'Sources', path: '/sources' },
  { heading: 'Sync', path: '/sync' },
] as const;

const documentOverflow = () =>
  Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth;

test.use({
  colorScheme: 'light',
  locale: 'en-US',
  reducedMotion: 'reduce',
  timezoneId: 'Europe/Paris',
});

const expectNoAxeViolations = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }));
  expect(violations).toEqual([]);
};

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

test('Overview has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByText('3 / 4 sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

  await expectNoAxeViolations(page);
});

test('the open session drawer has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('3 / 4 sessions', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Close session details' })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Skills has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'alpha-skill SKILL.md' })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Sources has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/sources');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Codex sessions' })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Sync has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/sync');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export file' })).toBeVisible();
  await expect(page.getByLabel('Import file')).toBeVisible();

  await expectNoAxeViolations(page);
});
