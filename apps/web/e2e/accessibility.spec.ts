import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  openHydratedReport,
  openHydratedSkills,
  reportViewsFor,
  test,
  waitForHydratedReport,
  waitForHydratedSkills,
} from './browser-test';

const TOP_SESSION_PATTERN = /Top session/;
const RGB_COMPONENT_PATTERN = /[\d.]+/g;
const NAVIGATION_DESTINATIONS = ['Overview', 'Sessions', 'Breakdown', 'Skills', 'Sync', 'Sources'] as const;
const routes = [
  { heading: 'Usage report', path: '/' },
  { heading: 'Skill management', path: '/skills' },
  { heading: 'Sources', path: '/sources' },
  { heading: 'Sync', path: '/sync' },
] as const;

const documentOverflow = () =>
  Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth;

const parseRgb = (color: string): [number, number, number] => {
  const components = color.match(RGB_COMPONENT_PATTERN)?.slice(0, 3).map(Number);
  if (components?.length !== 3) {
    throw new Error(`Expected an RGB color, received ${color}.`);
  }
  return [components[0] ?? 0, components[1] ?? 0, components[2] ?? 0];
};

const relativeLuminance = ([red, green, blue]: [number, number, number]): number => {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.040_45 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
};

const focusContrast = async (page: Page, target: Locator): Promise<number> => {
  const tabIndex = await target.evaluate((element) => (element as HTMLElement).tabIndex);
  expect(tabIndex).toBeGreaterThanOrEqual(0);
  await target.focus();
  await expect(target).toBeFocused();
  const focusStyle = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusStyle.style).toBe('solid');
  expect(Number.parseFloat(focusStyle.width)).toBeGreaterThanOrEqual(2);
  const background = await page
    .locator('main')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const foregroundLuminance = relativeLuminance(parseRgb(focusStyle.color));
  const backgroundLuminance = relativeLuminance(parseRgb(background));
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
};

test.use({
  colorScheme: 'light',
  contextOptions: {
    reducedMotion: 'reduce',
  },
  locale: 'en-US',
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
    if (route.path === '/') {
      await waitForHydratedReport(page);
    } else if (route.path.startsWith('/skills')) {
      await waitForHydratedSkills(page);
    }
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();

    const desktopNavigation = page.getByRole('complementary', { name: 'Application navigation' });
    await expect(desktopNavigation).toBeVisible();
    for (const label of NAVIGATION_DESTINATIONS) {
      await expect(desktopNavigation.getByRole('link', { exact: true, name: label })).toBeVisible();
    }
    const firstLink = desktopNavigation.getByRole('link').first();
    await firstLink.focus();
    await expect(firstLink).toBeFocused();
    await expect.poll(() => page.evaluate(documentOverflow)).toBeLessThanOrEqual(0);

    await page.setViewportSize({ height: 844, width: 390 });
    const mobileNavigation = page.locator('[data-app-navigation="mobile"]');
    await expect(mobileNavigation).toBeVisible();
    await expect(desktopNavigation).toHaveCount(0);
    for (const label of ['Overview', 'Sessions', 'Breakdown']) {
      await expect(mobileNavigation.getByRole('link', { exact: true, name: label })).toBeVisible();
    }
    const manageButton = mobileNavigation.getByRole('button', { name: 'Manage' });
    await manageButton.click();
    const manageNavigation = page.getByRole('navigation', { name: 'Manage destinations' });
    for (const label of ['Skills', 'Sync', 'Sources']) {
      await expect(manageNavigation.getByRole('link', { exact: true, name: label })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(manageNavigation).toHaveCount(0);
    await expect(manageButton).toBeFocused();
    await expect.poll(() => page.evaluate(documentOverflow)).toBeLessThanOrEqual(0);
  });
}

test('keeps the active report destination visible after deep scrolling', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await openHydratedReport(page, '/?tab=sessions');

  const navigation = page.getByRole('complementary', { name: 'Application navigation' });
  const activeDestination = navigation.getByRole('link', { exact: true, name: 'Sessions' });
  await expect(activeDestination).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => window.scrollTo({ top: 3000 }));
  await expect(navigation).toBeVisible();
  await expect(activeDestination).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`draws contrasting timeline and dashboard-panel focus indicators in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(() => {
      localStorage.clear();
    });
    await openHydratedReport(page);

    const timeline = page.getByRole('button', { name: 'Inspect activity timeline. Use arrow keys to inspect days.' });
    const dashboardPanel = page.locator('[data-dashboard-panel]');
    expect(await focusContrast(page, timeline)).toBeGreaterThanOrEqual(3);
    await expect(dashboardPanel).toHaveAttribute('tabindex', '0');
    expect(await focusContrast(page, dashboardPanel)).toBeGreaterThanOrEqual(3);

    await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
    await expect(page.locator('[role="tabpanel"]')).toHaveCount(0);
    await expect(dashboardPanel).toHaveAttribute('tabindex', '0');
    expect(await focusContrast(page, dashboardPanel)).toBeGreaterThanOrEqual(3);
  });
}

test('reduced motion keeps drawer feedback while making motion effectively immediate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHydratedReport(page);

  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();

  const motionDurations = await Promise.all([
    drawer.evaluate((element) => getComputedStyle(element).animationDuration),
    page
      .getByRole('complementary', { name: 'Application navigation' })
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
  await openHydratedReport(page);
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await expectNoAxeViolations(page);
});

test('the open session drawer has no detectable accessibility violations', async ({ page }) => {
  await openHydratedReport(page);
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Close session details' })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Skills has no detectable accessibility violations', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');
  await expect(page.getByRole('textbox', { name: 'alpha-skill SKILL.md' })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Sources has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/sources');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Healthy sources' })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Sync has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/sync');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export current machine' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Drop a merge file here or choose a file' })).toBeVisible();

  await expectNoAxeViolations(page);
});
