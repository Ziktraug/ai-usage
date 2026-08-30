import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  openHydratedReport,
  openHydratedSkills,
  reportViewsFor,
  test,
  waitForHydratedNavigation,
  waitForHydratedReport,
  waitForHydratedSkills,
} from './browser-test';

const RGB_COMPONENT_PATTERN = /[\d.]+/g;
const NAVIGATION_DESTINATIONS = ['Overview', 'Sessions', 'Analysis', 'Skills', 'Sync', 'Sources'] as const;
const routes = [
  { heading: 'Usage report', path: '/' },
  { heading: 'Skill management', path: '/skills' },
  { heading: 'Sources', path: '/sources' },
  { heading: 'Sync', path: '/sync' },
] as const;
const REPORT_AXE_DESTINATIONS = [
  { label: 'Overview', path: '/' },
  { label: 'Sessions', path: '/?tab=sessions' },
  { label: 'Analysis', path: '/?tab=models' },
] as const;

const overviewTopSessionTrigger = (page: Page): Locator =>
  page
    .getByRole('heading', { level: 3, name: 'Top sessions' })
    .locator('xpath=ancestor::section[1]')
    .getByRole('button')
    .first();

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
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
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
  test(`${route.heading} exposes shared navigation without narrow overflow`, async ({ browser, page }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    await page.goto(route.path);
    // Both rails are server-rendered, so their presence no longer implies a live router: the Manage
    // popover asserted below is driven by client state and stays inert until the navigation hydrates.
    await waitForHydratedNavigation(page);
    if (route.path === '/') {
      await waitForHydratedReport(page);
    } else if (route.path.startsWith('/skills')) {
      await waitForHydratedSkills(page);
    }
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();

    if (route.path === '/sync') {
      const syncShell = page.locator('[data-route-shell="sync"]').locator('..');
      await expect(syncShell).toHaveCSS('max-width', '1380px');
      await expect(syncShell).toHaveCSS('padding-left', '36px');
      await expect(syncShell).toHaveCSS('padding-right', '36px');
      await expect(syncShell).toHaveCSS('padding-top', '32px');
      await expect(syncShell).toHaveCSS('padding-bottom', '32px');

      const ssrContext = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        javaScriptEnabled: false,
        viewport: { height: 900, width: 1024 },
      });
      try {
        const ssrPage = await ssrContext.newPage();
        await ssrPage.goto('/sync');
        const notice = ssrPage.getByRole('status').filter({ hasText: 'Connecting to the usage engine.' });
        const fleet = ssrPage.getByRole('heading', { level: 2, name: 'Machine fleet' }).locator('..');
        await expect(notice).toHaveCSS('display', 'grid');
        await expect(notice).toHaveCSS('padding', '10px 12px');
        await expect(notice).toHaveCSS('border-top-width', '1px');
        await expect(notice).toHaveCSS('border-radius', '8px');
        await expect(notice).toHaveCSS('font-size', '13px');
        const noticeBox = await notice.boundingBox();
        const fleetBox = await fleet.boundingBox();
        expect(noticeBox).not.toBeNull();
        expect(fleetBox).not.toBeNull();
        expect(noticeBox?.x).toBe(fleetBox?.x);
        expect(noticeBox?.width).toBe(fleetBox?.width);
        expect(fleetBox?.y).toBe((noticeBox?.y ?? 0) + (noticeBox?.height ?? 0) + 16);
      } finally {
        await ssrContext.close();
      }
    }

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
    if (route.path === '/sync') {
      const syncShell = page.locator('[data-route-shell="sync"]').locator('..');
      await expect(syncShell).toHaveCSS('padding-left', '20px');
      await expect(syncShell).toHaveCSS('padding-right', '20px');
      await expect(syncShell).toHaveCSS('padding-top', '24px');
      await expect(syncShell).toHaveCSS('padding-bottom', '24px');
    }
    const mobileNavigation = page.locator('[data-app-navigation="mobile"]');
    await expect(mobileNavigation).toBeVisible();
    await expect(desktopNavigation).toHaveCount(0);
    for (const label of ['Overview', 'Sessions', 'Analysis']) {
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

test('shows the report panel focus indicator only for keyboard navigation', async ({ page }) => {
  await openHydratedReport(page);

  const dashboardPanel = page.locator('[data-dashboard-panel]');
  await dashboardPanel.locator(':scope *').evaluateAll((elements) => {
    for (const element of elements) {
      (element as HTMLElement).style.pointerEvents = 'none';
    }
  });
  await dashboardPanel.click();
  await expect(dashboardPanel).toBeFocused();
  await expect(dashboardPanel).toHaveCSS('outline-style', 'none');

  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(dashboardPanel).toBeFocused();
  await expect(dashboardPanel).toHaveCSS('outline-style', 'solid');
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

  await overviewTopSessionTrigger(page).click();
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

for (const colorScheme of ['light', 'dark'] as const) {
  for (const destination of REPORT_AXE_DESTINATIONS) {
    test(`${destination.label} has no detectable accessibility violations in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.addInitScript(() => localStorage.clear());
      await openHydratedReport(page, destination.path);
      await expect(reportViewsFor(page).getByRole('link', { exact: true, name: destination.label })).toHaveAttribute(
        'aria-current',
        'page',
      );
      if (destination.label === 'Overview') {
        await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
      } else if (destination.label === 'Sessions') {
        await expect(page.getByRole('table')).toBeVisible();
      } else {
        await expect(page.getByRole('table', { name: 'Model API-value analysis' })).toBeVisible();
      }

      await expectNoAxeViolations(page);
    });
  }

  test(`the open session drawer has no detectable accessibility violations in ${colorScheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(() => localStorage.clear());
    await page.setViewportSize({ height: 844, width: 390 });
    await openHydratedReport(page);
    await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
    await overviewTopSessionTrigger(page).click();
    const drawer = page.getByRole('dialog', { name: 'Session details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Close session details' })).toBeVisible();

    await expectNoAxeViolations(page);
  });
}

test('Skills has no detectable accessibility violations', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');
  await expect(page.getByRole('textbox', { name: 'alpha-skill SKILL.md' })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Skill observations have no detectable accessibility violations', async ({ page }) => {
  await openHydratedSkills(page, '/skills/matrix');
  await expect(page.getByRole('heading', { level: 2, name: 'Skill observations' })).toBeVisible();

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
