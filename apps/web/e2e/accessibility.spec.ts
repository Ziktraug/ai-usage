import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  openHydratedReport,
  openHydratedSkills,
  reportViewsFor,
  test,
  waitForFocusedReportSettled,
  waitForHydratedNavigation,
  waitForHydratedReport,
  waitForHydratedSkills,
} from './browser-test';
import { encodeRpcResponseBody } from './rpc-test-transport';

const RGB_COMPONENT_PATTERN = /[\d.]+/g;
const ALL_FILTER_PATTERN = /^All —/;
const HARNESS_FILTER_URL_PATTERN = /[?&]harness=/;
const CUSTOM_RANGE_URL_PATTERN = /[?&]range=\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/;
const EDITED_FROM_RANGE_URL_PATTERN = /[?&]range=2026-05-20\.\./;
const MAX_PROJECT_EXPANSIONS = 12;
const NAVIGATION_DESTINATIONS = [
  'Work',
  'Overview',
  'Sessions',
  'Analysis',
  'Memory',
  'Projects',
  'Skills',
  'Sync',
  'Sources',
  'Delegation',
] as const;
const routes = [
  { heading: 'One thread per task.', path: '/work' },
  { heading: 'Usage overview', path: '/' },
  { heading: 'Memory', path: '/memory' },
  { heading: 'Projects', path: '/projects' },
  { heading: 'Skills', path: '/skills' },
  { heading: 'Sources', path: '/sources' },
  { heading: 'Sync', path: '/sync' },
  { heading: 'Delegation', path: '/delegation' },
] as const;
const REPORT_AXE_DESTINATIONS = [
  { label: 'Overview', path: '/' },
  { label: 'Sessions', path: '/?tab=sessions' },
  { label: 'Analysis', path: '/?tab=models' },
] as const;

interface AccessibilityMedia {
  readonly label: string;
  readonly media: NonNullable<Parameters<Page['emulateMedia']>[0]>;
}

/**
 * Every focus-indicator and axe check runs in both colour schemes as authored, under forced colours
 * (a Windows contrast theme swaps the palette for system colours and drops box-shadows and
 * background images, so anything drawn only with those disappears), and with a raised contrast
 * preference.
 */
const ACCESSIBILITY_MEDIA: readonly AccessibilityMedia[] = (['light', 'dark'] as const).flatMap((colorScheme) => [
  { label: `${colorScheme} mode`, media: { colorScheme } },
  { label: `${colorScheme} forced-colors mode`, media: { colorScheme, forcedColors: 'active' } },
  { label: `${colorScheme} more-contrast mode`, media: { colorScheme, contrast: 'more' } },
]);

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

/**
 * Under forced colours Chromium paints text in the forced system colour, but it resolves the
 * `currentcolor` of `-webkit-text-fill-color`, which axe reads before `color`, against the authored
 * colour. axe would then compare light-on-dark labels' authored text with the forced background and
 * fail them while the page shows CanvasText on Canvas. Pin the fill to the colour Chromium paints.
 * That only holds while no stylesheet or inline style authors a fill colour, so that is asserted.
 */
const pinForcedTextFillToPaintedColor = async (page: Page): Promise<void> => {
  const authoredFills = await page.evaluate(() => {
    const fills = [...document.querySelectorAll('[style*="text-fill-color"]')].map((element) => element.outerHTML);
    const visit = (sheet: CSSStyleSheet): void => {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSImportRule && rule.styleSheet) {
          visit(rule.styleSheet);
        } else if (rule.cssText.includes('text-fill-color')) {
          fills.push(rule.cssText);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      visit(sheet);
    }
    return fills;
  });
  expect(authoredFills).toEqual([]);
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const style = getComputedStyle(element);
      if (style.getPropertyValue('-webkit-text-fill-color') !== style.color) {
        element.style.setProperty('-webkit-text-fill-color', style.color);
      }
    }
  });
};

const expectNoAxeViolations = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  if (await page.evaluate(() => matchMedia('(forced-colors: active)').matches)) {
    await pinForcedTextFillToPaintedColor(page);
  }
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
        await expect(notice).toHaveCSS('border-radius', '6px');
        await expect(notice).toHaveCSS('font-size', '13px');
        const noticeBox = await notice.boundingBox();
        const fleetBox = await fleet.boundingBox();
        expect(noticeBox).not.toBeNull();
        expect(fleetBox).not.toBeNull();
        expect(noticeBox?.x).toBe(fleetBox?.x);
        expect(noticeBox?.width).toBe(fleetBox?.width);
        expect(fleetBox?.y).toBe((noticeBox?.y ?? 0) + (noticeBox?.height ?? 0) + 36);
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
    for (const label of ['Work', 'Overview', 'Sessions', 'Analysis']) {
      await expect(mobileNavigation.getByRole('link', { exact: true, name: label })).toBeVisible();
    }
    const manageButton = mobileNavigation.getByRole('button', { name: 'Manage' });
    await manageButton.click();
    const manageNavigation = page.getByRole('navigation', { name: 'Manage destinations' });
    for (const label of ['Campaigns', 'Memory', 'Projects', 'Skills', 'Sync', 'Sources', 'Delegation']) {
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

for (const { label, media } of ACCESSIBILITY_MEDIA) {
  test(`draws contrasting timeline and dashboard-panel focus indicators in ${label}`, async ({ page }) => {
    await page.emulateMedia(media);
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

for (const { label, media } of ACCESSIBILITY_MEDIA) {
  for (const destination of REPORT_AXE_DESTINATIONS) {
    test(`${destination.label} has no detectable accessibility violations in ${label}`, async ({ page }) => {
      await page.emulateMedia(media);
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

  test(`the open session drawer has no detectable accessibility violations in ${label}`, async ({ page }) => {
    await page.emulateMedia(media);
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

for (const { label, media } of ACCESSIBILITY_MEDIA) {
  test(`Skills has no detectable accessibility violations in ${label}`, async ({ page }) => {
    await page.emulateMedia(media);
    await openHydratedSkills(page, '/skills/global/alpha-skill');
    await expect(page.getByRole('textbox', { name: 'alpha-skill SKILL.md' })).toBeVisible();

    await expectNoAxeViolations(page);
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`a Skill switch keeps its on/off thumb in ${colorScheme} forced-colors mode`, async ({ page }) => {
    // Forced colours repaint backgrounds as Canvas; a thumb drawn only with a background vanishes
    // with the position that carries the state. axe has no rule for that, so the paint is checked.
    await page.emulateMedia({ colorScheme, forcedColors: 'active' });
    await openHydratedSkills(page, '/skills/global/alpha-skill');
    const toggle = page.getByRole('switch', { name: 'Disable alpha-skill' }).first();
    await expect(toggle).toBeVisible();
    const paint = () =>
      toggle.evaluate((element) => ({
        thumb: getComputedStyle(element, '::after').backgroundColor,
        track: getComputedStyle(element).backgroundColor,
      }));

    const on = await paint();
    expect(on.thumb).not.toBe(on.track);
    // The state is styled from aria-checked alone, so flipping it shows the off paint without
    // toggling the shared fixture skill.
    await toggle.evaluate((element) => element.setAttribute('aria-checked', 'false'));
    const off = await paint();
    expect(off.thumb).not.toBe(off.track);
  });
}

/**
 * Forced colours repaint the tint or accent that marks a selection, which would leave the selected
 * item looking like its siblings. It must keep a ring of its own: a solid outline at least 2px wide
 * that no unselected sibling has. Without forced colours the ring is absent, so the authored
 * rendering is unchanged.
 */
const expectForcedSelectionRing = async (page: Page, selected: Locator, siblings: Locator): Promise<void> => {
  await expect(selected).toBeVisible();
  const ring = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(ring.style).toBe('solid');
  expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  const siblingOutlines = await siblings.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
    }),
  );
  expect(siblingOutlines.length).toBeGreaterThan(0);
  for (const outline of siblingOutlines) {
    expect(outline).not.toEqual(ring);
  }
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(selected).toHaveCSS('outline-style', 'none');
  await page.emulateMedia({ forcedColors: 'active' });
};

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`selections stay distinguishable in ${colorScheme} forced-colors mode`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme, forcedColors: 'active' });
    });

    test('the current navigation link, the Skills filter and the open skill row', async ({ page }) => {
      await openHydratedSkills(page, '/skills/global/alpha-skill');
      const rail = page.locator('[data-app-navigation="desktop"]');
      await expectForcedSelectionRing(
        page,
        rail.locator('a[aria-current="page"]'),
        rail.locator('a:not([aria-current])'),
      );
      await expectForcedSelectionRing(
        page,
        page.getByRole('button', { name: ALL_FILTER_PATTERN }),
        page.locator('[data-worktable-filter][aria-pressed="false"]'),
      );
      const openRow = page.locator('tr[data-worktable-row="alpha-skill"]').first();
      const otherRows = page.locator('tr[data-worktable-row]:not([data-worktable-row="alpha-skill"])');
      await expectForcedSelectionRing(page, openRow, otherRows);
      // The sticky name cell paints over the row's ring, so it has to carry its own.
      await expectForcedSelectionRing(page, openRow.locator('th[scope="row"]'), otherRows.locator('th[scope="row"]'));
    });

    test('the current mobile navigation link and the Manage button', async ({ page }) => {
      await page.setViewportSize({ height: 844, width: 390 });
      const mobile = page.locator('[data-app-navigation="mobile"]');
      await openHydratedReport(page);
      await expectForcedSelectionRing(
        page,
        mobile.locator('a[aria-current="page"]'),
        mobile.locator('a:not([aria-current]), button'),
      );
      await openHydratedSkills(page, '/skills');
      await expectForcedSelectionRing(page, mobile.getByRole('button', { name: 'Manage' }), mobile.locator('a'));
    });

    test('the report period, the Analysis tab and a segmented control', async ({ page }) => {
      await openHydratedReport(page, '/?tab=models');
      const period = page.getByRole('region', { name: 'Report period' });
      await expectForcedSelectionRing(
        page,
        period.locator('[aria-pressed="true"]'),
        period.locator('[aria-pressed="false"]'),
      );
      const tabs = page.getByRole('tablist', { name: 'Analysis dimension' });
      await expectForcedSelectionRing(
        page,
        tabs.getByRole('tab', { selected: true }),
        tabs.getByRole('tab', { selected: false }),
      );
      const segments = page.getByRole('radiogroup', { name: 'Sort breakdown' });
      await expectForcedSelectionRing(
        page,
        segments.getByRole('radio', { checked: true }),
        segments.getByRole('radio', { checked: false }),
      );
    });

    test('the session column preset and the selected session row', async ({ page }) => {
      await openHydratedReport(page, '/?tab=sessions');
      const presets = page.getByRole('group', { name: 'Session column presets' });
      await expectForcedSelectionRing(
        page,
        presets.locator('[aria-pressed="true"]'),
        presets.locator('[aria-pressed="false"]'),
      );
      await page.locator('tr[data-session-row-id]').first().click();
      await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible();
      await expectForcedSelectionRing(
        page,
        page.locator('tr[data-selected="true"]'),
        page.locator('tr[data-selected="false"]'),
      );
      // That the ring is painted unbroken over every cell is a render check further down.
    });

    test('the Campaigns view and the selected campaign', async ({ page }) => {
      await page.goto('/campaigns');
      await waitForHydratedNavigation(page);
      const views = page.getByRole('navigation', { name: 'Campaign view' });
      await expectForcedSelectionRing(
        page,
        views.locator('[aria-pressed="true"]'),
        views.locator('[aria-pressed="false"]'),
      );
      await expectForcedSelectionRing(
        page,
        page.locator('[data-campaign-card][aria-pressed="true"]'),
        page.locator('[data-campaign-card][aria-pressed="false"]'),
      );
    });
  });
}

/**
 * Resolves a CSS colour, a system colour keyword or a token variable, against the palette the page
 * currently paints with.
 */
const resolveSystemColor = (page: Page, keyword: string): Promise<string> =>
  page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, keyword);

const focusByKeyboard = async (page: Page, target: Locator): Promise<void> => {
  await expect(target).toBeVisible();
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
};

const outlineOf = (target: Locator) =>
  target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });

/**
 * Expects a solid outline at least 2px wide. Reduced motion still runs every style change as a
 * near-instant transition, so the width is polled until it lands before the ring is read.
 */
const expectSolidRing = async (target: Locator): Promise<{ color: string }> => {
  await expect.poll(async () => (await outlineOf(target)).width).toBeGreaterThanOrEqual(2);
  const ring = await outlineOf(target);
  expect(ring.style).toBe('solid');
  return ring;
};

/**
 * A field draws its authored focus as an accent border with a box-shadow halo. Forced colours drop
 * the halo and repaint the border, which would leave the focused field looking like every other
 * one, so under forced colours it draws a solid outline at least 2px wide. Without forced colours
 * the halo stays and no outline is drawn, so the authored rendering is unchanged.
 */
const expectForcedFieldFocusRing = async (page: Page, field: Locator): Promise<void> => {
  await focusByKeyboard(page, field);
  await expectSolidRing(field);
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(field).toBeFocused();
  await expect(field).toHaveCSS('outline-style', 'none');
  await expect.poll(() => field.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  await page.emulateMedia({ forcedColors: 'active' });
};

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`keyboard focus on a field stays visible in ${colorScheme} forced-colors mode`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme, forcedColors: 'active' });
    });

    test('the report filter fields and the custom period fields', async ({ page }) => {
      await openHydratedReport(page);
      await expectForcedFieldFocusRing(
        page,
        page.getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' }),
      );
      await expectForcedFieldFocusRing(page, page.getByRole('button', { name: 'Filter by harness: All harnesses' }));
      const period = page.getByRole('region', { name: 'Report period' });
      await period.getByRole('button', { exact: true, name: 'Choose a custom report period' }).click();
      await expectForcedFieldFocusRing(page, period.locator('#report-period-from'));
      await expectForcedFieldFocusRing(page, period.locator('#report-period-to'));
    });

    test('the breakdown search field', async ({ page }) => {
      await openHydratedReport(page, '/?tab=models');
      await expectForcedFieldFocusRing(page, page.getByRole('searchbox', { name: 'Search this breakdown' }));
    });
  });
}

/** Opens the harness filter from the keyboard; its first item, the All row, takes focus. */
const openHarnessFilterByKeyboard = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: 'Filter by harness: All harnesses' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { exact: true, name: 'Harness' });
  await expect(dialog.getByRole('button', { name: 'All harnesses' })).toBeFocused();
  return dialog;
};

/** A filter option's visually hidden native checkbox and the box drawn in its place. */
const filterOptionFor = (dialog: Locator, name: string): { box: Locator; input: Locator } => {
  // A `has` locator is resolved inside each candidate item, so it starts from the page, not the dialog.
  const option = dialog.locator('li').filter({ has: dialog.page().getByRole('checkbox', { exact: true, name }) });
  return { box: option.locator('[data-part="control"]'), input: option.getByRole('checkbox') };
};

for (const colorScheme of ['light', 'dark'] as const) {
  for (const forcedColors of ['none', 'active'] as const) {
    const mode = forcedColors === 'active' ? `${colorScheme} forced-colors` : colorScheme;
    test(`keyboard focus on a filter option draws a ring on its checkbox box in ${mode} mode`, async ({ page }) => {
      // Focus lands on the visually hidden native input, so without a ring on the box it mirrors
      // nothing on screen would show which option has focus (WCAG 2.4.7).
      await page.emulateMedia({ colorScheme, forcedColors });
      await openHydratedReport(page);
      const dialog = await openHarnessFilterByKeyboard(page);
      const claude = filterOptionFor(dialog, 'Claude');
      await expect(claude.box).toHaveCSS('outline-style', 'none');

      await page.keyboard.press('Tab');
      await expect(claude.input).toBeFocused();
      const ring = await expectSolidRing(claude.box);
      expect(ring.color).toBe(
        await resolveSystemColor(page, forcedColors === 'active' ? 'Highlight' : 'var(--colors-accent)'),
      );

      await page.keyboard.press('Tab');
      await expect(filterOptionFor(dialog, 'Codex').input).toBeFocused();
      await expect(claude.box).toHaveCSS('outline-style', 'none');
    });
  }
}

/**
 * The desktop Session drawer opens over the right of the page, so only a viewport wider than the
 * centred table and the drawer together, a 4K desktop, leaves the selected row's last cell on screen.
 */
const DRAWER_CLEAR_DESKTOP = { height: 1000, width: 3840 } as const;
/** The ring is 2px wide; the band it is looked for in has a pixel of slack for a fractional row. */
const RING_WIDTH = 2;
const RING_EDGE_BAND = 3;
/** The rounding a translucent ring picks up when it is painted over the cell. */
const RING_COLOR_TOLERANCE = 2;

interface RowRingMisses {
  /** Columns across the last cell where the row's bottom edge is not the full ring width. */
  readonly bottom: number;
  /** Scanlines with a ring pixel along the last cell's own left edge, inside the row. */
  readonly interiorLeft: number;
  /** Scanlines where the row's left edge, the reference the others match, is not the full ring width. */
  readonly left: number;
  /** Scanlines where the row's right edge, which is the last cell's, is not the full ring width. */
  readonly right: number;
  /** Columns across the last cell where the row's top edge is not the full ring width. */
  readonly top: number;
}

/**
 * Reads the ring of a session row from a screenshot of it, as painted. The row draws the ring, a
 * keyboard focus ring or the forced-colours selection ring, so it has to run at full width along the
 * row's edges across the last cell, and the last cell, which carries the row's chevron, must neither
 * paint over it nor draw a line of its own inside the row.
 */
const expectRowRingOverLastCell = async (page: Page, row: Locator, ringColor: string): Promise<void> => {
  const ring = await expectSolidRing(row);
  expect(ring.color).toBe(await resolveSystemColor(page, ringColor));
  const lastCell = row.locator('td:last-child');
  // Nothing may cover the cell, or the screenshot would show what covers it.
  const uncovered = await lastCell.evaluate((cell) => {
    const box = cell.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    return [box.left + 1, box.right - 1].every((x) => cell.contains(document.elementFromPoint(x, middle)));
  });
  expect(uncovered).toBe(true);
  // A translucent ring (the forced palette's Highlight can be) paints differently over the fill the
  // cell shows and over the cell's bottom rule. That fill is the nearest opaque one among the cell
  // and its ancestors, under every translucent one nearer the cell (forced colours keep a fill's
  // alpha, so a transparent cell reads as a transparent Canvas).
  const { fills, rule } = await lastCell.evaluate((cell) => {
    const backgrounds: string[] = [];
    for (let element: Element | null = cell; element; element = element.parentElement) {
      backgrounds.push(getComputedStyle(element).backgroundColor);
    }
    return { fills: backgrounds, rule: getComputedStyle(cell).borderBottomColor };
  });
  const [ringPaint, rulePaint, ...fillPaints] = await paintedColors(page, [ring.color, rule, ...fills]);
  const opaqueFillAt = fillPaints.findIndex((paint) => paint[3] === OPAQUE_ALPHA);
  const opaqueFill = fillPaints[opaqueFillAt];
  const [rowBox, cellBox] = await Promise.all([row.boundingBox(), lastCell.boundingBox()]);
  if (!(ringPaint && rulePaint && opaqueFill && rowBox && cellBox)) {
    throw new Error('Expected the ring and an opaque fill under the cell, and the row and its last cell on screen');
  }
  const fill = fillPaints.slice(0, opaqueFillAt).reduceRight((under, paint) => overCanvas(paint, under), opaqueFill);
  const backdropPaints = [fill, overCanvas(rulePaint, fill)];
  const screenshot = await row.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  const misses = await page.evaluate(
    async ({ band, base64, cellLeft, paints, ringWidth, tolerance }): Promise<RowRingMisses> => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
      if (!context) {
        throw new Error('Expected a 2D canvas context');
      }
      context.drawImage(bitmap, 0, 0);
      const { data, height, width } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const channels = [0, 1, 2] as const;
      const isRing = (x: number, y: number): boolean =>
        paints.some((paint) =>
          channels.every(
            (channel) => Math.abs((data[(y * width + x) * 4 + channel] ?? Number.NaN) - paint[channel]) <= tolerance,
          ),
        );
      const span = (from: number, to: number): number[] =>
        Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
      const ringPixels = (xs: readonly number[], ys: readonly number[]): number =>
        xs.flatMap((x) => ys.filter((y) => isRing(x, y))).length;
      const scanlines = span(band, height - 1 - band);
      const cellColumns = span(cellLeft + band, width - 1 - band);
      return {
        bottom: cellColumns.filter((x) => ringPixels([x], span(height - band, height - 1)) < ringWidth).length,
        interiorLeft: scanlines.filter((y) => ringPixels(span(cellLeft - 1, cellLeft + 2), [y]) > 0).length,
        left: scanlines.filter((y) => ringPixels(span(0, band - 1), [y]) < ringWidth).length,
        right: scanlines.filter((y) => ringPixels(span(width - band, width - 1), [y]) < ringWidth).length,
        top: cellColumns.filter((x) => ringPixels([x], span(0, band - 1)) < ringWidth).length,
      };
    },
    {
      band: RING_EDGE_BAND,
      base64: screenshot.toString('base64'),
      cellLeft: Math.round(cellBox.x - Math.floor(rowBox.x)),
      paints: backdropPaints.map((backdrop) => overCanvas(ringPaint, backdrop)),
      ringWidth: RING_WIDTH,
      tolerance: RING_COLOR_TOLERANCE,
    },
  );
  expect(misses).toEqual({ bottom: 0, interiorLeft: 0, left: 0, right: 0, top: 0 });
};

for (const colorScheme of ['light', 'dark'] as const) {
  for (const forcedColors of ['none', 'active'] as const) {
    const mode = forcedColors === 'active' ? `${colorScheme} forced-colors` : colorScheme;
    test(`a session row paints its ring unbroken over its last cell in ${mode} mode`, async ({ page }) => {
      await page.setViewportSize(DRAWER_CLEAR_DESKTOP);
      await page.emulateMedia({ colorScheme, forcedColors });
      await openHydratedReport(page, '/?tab=sessions');
      const rows = page.locator('tr[data-session-row-id]');
      const focusRing = forcedColors === 'active' ? 'Highlight' : 'var(--colors-accent)';

      await focusByKeyboard(page, rows.first());
      await expect(rows.first()).toHaveAttribute('data-selected', 'false');
      await expectRowRingOverLastCell(page, rows.first(), focusRing);

      // Chosen from the keyboard, the row keeps its focus ring while the desktop drawer opens.
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible();
      await expect(rows.first()).toHaveAttribute('data-selected', 'true');
      await expect(rows.first()).toBeFocused();
      await expectRowRingOverLastCell(page, rows.first(), focusRing);

      if (forcedColors === 'active') {
        // Chosen by pointer, the row has focus but no focus ring; forced colours ring the selection.
        await rows.nth(1).click();
        await page.mouse.move(0, 0);
        await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true');
        await expectRowRingOverLastCell(page, rows.nth(1), 'Highlight');
      }
    });
  }
}

test('a pointer click on a filter option draws no focus ring on its checkbox box', async ({ page }) => {
  await openHydratedReport(page);
  // The keyboard opens the popover, so the pointer click below has to take over the modality.
  const dialog = await openHarnessFilterByKeyboard(page);
  const codex = filterOptionFor(dialog, 'Codex');
  // Choosing an option navigates and the navigation moves focus on, so the box is watched from the
  // click onwards instead of being read once after it.
  await codex.box.evaluate((box) => {
    const states: { focused: boolean; focusVisible: boolean; outlineStyle: string }[] = [];
    new MutationObserver(() => {
      states.push({
        focused: box.hasAttribute('data-focus'),
        focusVisible: box.hasAttribute('data-focus-visible'),
        outlineStyle: getComputedStyle(box).outlineStyle,
      });
    }).observe(box, { attributeFilter: ['data-focus', 'data-focus-visible'] });
    Reflect.set(window, '__codexBoxFocusStates', states);
  });

  await dialog.getByTitle('Codex', { exact: true }).click();
  await expect(page).toHaveURL(HARNESS_FILTER_URL_PATTERN);
  const states = await page.evaluate(() => Reflect.get(window, '__codexBoxFocusStates') as unknown);
  expect(states).toContainEqual({ focused: true, focusVisible: false, outlineStyle: 'none' });
  expect(states).not.toContainEqual(expect.objectContaining({ focusVisible: true }));
  expect(states).not.toContainEqual(expect.objectContaining({ outlineStyle: 'solid' }));
});

test('choosing a custom period moves focus to its From date by keyboard and by pointer', async ({ page }) => {
  await openHydratedReport(page);
  await waitForFocusedReportSettled(page);
  const period = page.getByRole('region', { name: 'Report period' });
  const custom = period.getByRole('button', { exact: true, name: 'Choose a custom report period' });
  const from = period.getByRole('textbox', { exact: true, name: 'From' });
  const to = period.getByRole('textbox', { exact: true, name: 'To' });

  // Custom navigates before its fields exist, so focus is read once the report has settled, after
  // any focus reset the navigation could make.
  await custom.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(CUSTOM_RANGE_URL_PATTERN);
  await waitForFocusedReportSettled(page);
  await expect(from).toBeFocused();

  // A From edit completed by Tab commits a new range and leaves focus on To.
  await from.fill('2026-05-20');
  await page.keyboard.press('Tab');
  await expect(page).toHaveURL(EDITED_FROM_RANGE_URL_PATTERN);
  await waitForFocusedReportSettled(page);
  await expect(to).toBeFocused();

  await period.getByRole('button', { exact: true, name: '30d' }).click();
  await expect(from).toHaveCount(0);
  await custom.click();
  await expect(page).toHaveURL(CUSTOM_RANGE_URL_PATTERN);
  await waitForFocusedReportSettled(page);
  await expect(from).toBeFocused();

  // Once the fields are open, Custom moves focus straight back to From.
  await to.focus();
  await period.getByRole('button', { exact: true, name: 'Choose a custom report period, selected' }).click();
  await expect(from).toBeFocused();
});

interface MarkPaint {
  readonly background: string;
  readonly level: string | null;
  readonly opacity: string;
}

const paintOf = (marks: Locator): Promise<MarkPaint[]> =>
  marks.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        level: element.getAttribute('data-heat-level'),
        opacity: style.opacity,
      };
    }),
  );

const borderOf = (marks: Locator) =>
  marks.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.borderTopColor,
        sides: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
        style: style.borderTopStyle,
      };
    }),
  );

type PaintedColor = readonly [red: number, green: number, blue: number, alpha: number];

/**
 * Each colour as the sRGB bytes a 2D canvas paints for it, so a computed colour in any syntax
 * (`rgb()`, or the `color(srgb …)` a `color-mix()` resolves to) is compared on what reaches the
 * screen. A value the canvas cannot parse fails instead of reading as the previous fill.
 */
const paintedColors = (page: Page, colors: readonly string[]): Promise<PaintedColor[]> =>
  page.evaluate((values) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Expected a 2D canvas context');
    }
    const sentinel = '#010203';
    return values.map((value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = sentinel;
      context.fillStyle = value;
      if (context.fillStyle === sentinel) {
        throw new Error(`The canvas could not paint the colour ${value}`);
      }
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      return [red, green, blue, alpha] as const;
    });
  }, colors);

const contrastRatio = (first: PaintedColor, second: PaintedColor): number => {
  const luminances = [first, second].map(([red, green, blue]) => relativeLuminance([red, green, blue]));
  return (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05);
};

const OPAQUE_ALPHA = 255;
const NON_TEXT_CONTRAST = 3;
const OPPOSITE_THEME = { dark: 'light', light: 'dark' } as const;

/** A mark as it reaches the screen: a translucent fill shows the canvas through it. */
const overCanvas = (mark: PaintedColor, canvas: PaintedColor): PaintedColor => {
  const alpha = mark[3] / OPAQUE_ALPHA;
  const channel = (index: 0 | 1 | 2): number => Math.round(mark[index] * alpha + canvas[index] * (1 - alpha));
  return [channel(0), channel(1), channel(2), OPAQUE_ALPHA];
};

/** Each mark's contrast against the canvas, rounded to hundredths. */
const contrastsOffCanvas = (canvas: PaintedColor, marks: readonly PaintedColor[]): number[] =>
  marks.map((mark) => Math.round(contrastRatio(overCanvas(mark, canvas), canvas) * 100) / 100);

/**
 * Every mark stands at least 3:1 off the canvas and its contrast rises with its level, so the scale
 * reads the same way whichever palette the page is painted with. The marks are opaque: the strength
 * lives in the fill, so nothing drawn around a faint mark is faded with it.
 */
const expectRisingContrast = (canvas: PaintedColor, marks: readonly PaintedColor[]): void => {
  const contrasts = contrastsOffCanvas(canvas, marks);
  expect(Math.min(...contrasts), `contrast by level: ${contrasts.join(', ')}`).toBeGreaterThanOrEqual(
    NON_TEXT_CONTRAST,
  );
  expect(contrasts, 'contrast rises with the level').toEqual(
    [...new Set(contrasts)].sort((left, right) => left - right),
  );
  expect(marks.map((mark) => mark[3])).toEqual(marks.map(() => OPAQUE_ALPHA));
};

for (const colorScheme of ['light', 'dark'] as const) {
  for (const themePin of [null, OPPOSITE_THEME[colorScheme]] as const) {
    const pinned = themePin ? ` with the ${themePin} theme pinned` : '';
    test(`Rhythm and Punchcard keep their intensity marks in ${colorScheme} forced-colors mode${pinned}`, async ({
      page,
    }) => {
      // Forced colours repaint every authored fill as the canvas colour, which would flatten the
      // intensity both charts draw as a fill. Their marks keep their own paint, drawn from the forced
      // palette's system colours: each level stays apart from the canvas and from the other levels,
      // and the legend still matches the marks. A saved theme that disagrees with the forced palette
      // (the theme tokens follow the pin, the canvas follows the palette) must not invert the scale.
      if (themePin) {
        await page.addInitScript((theme) => localStorage.setItem('ai-usage-theme', theme), themePin);
      }
      await page.emulateMedia({ colorScheme, forcedColors: 'active' });
      await openHydratedReport(page);
      await waitForFocusedReportSettled(page);
      if (themePin) {
        await expect(page.locator('html')).toHaveAttribute('data-theme', themePin);
      }
      const canvas = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
      const [canvasPaint] = await paintedColors(page, [canvas]);
      if (!canvasPaint) {
        throw new Error('Expected the canvas colour to paint');
      }
      // The forced palette follows the emulated scheme, so a pin, when set, is the opposite of it.
      const canvasLuminance = relativeLuminance([canvasPaint[0], canvasPaint[1], canvasPaint[2]]);
      if (colorScheme === 'dark') {
        expect(canvasLuminance).toBeLessThan(0.2);
      } else {
        expect(canvasLuminance).toBeGreaterThan(0.8);
      }

      const calendar = page.getByRole('toolbar', {
        name: 'Daily activity calendar. Use arrow keys to move by day or week.',
      });
      const dayMarks = calendar.locator('button[data-heatmap-day]');
      const legendMarks = page.locator('[data-heatmap-legend] [data-heat-level]');
      const days = await paintOf(dayMarks);
      const legend = await paintOf(legendMarks);
      expect(legend.map(({ level }) => level)).toEqual(['0', '1', '2', '3', '4']);
      // The fixture's days are empty or active at one level; the legend carries the whole scale.
      const emptyDay = days.find(({ level }) => level === '0');
      const activeDay = days.find(({ level }) => level !== '0');
      if (!(emptyDay && activeDay)) {
        throw new Error('Expected the fixture calendar to hold both empty and active days');
      }
      expect(emptyDay.background).not.toBe(activeDay.background);
      const legendBackgroundByLevel = new Map(legend.map((mark) => [mark.level, mark.background]));
      expect(new Set(legendBackgroundByLevel.values()).size).toBe(legend.length);
      for (const mark of [...days, ...legend]) {
        expect(legendBackgroundByLevel.get(mark.level)).toBe(mark.background);
        // The strength lives in the fill, so nothing drawn around a faint day is faded with it.
        expect(mark.opacity).toBe('1');
      }
      // Level 1 is the faintest active mark and level 4 the strongest, in either palette.
      const legendPaint = await paintedColors(
        page,
        legend.map(({ background }) => background),
      );
      expectRisingContrast(canvasPaint, legendPaint.slice(1));
      // An empty day is the canvas itself, set apart by a system-colour outline on every side.
      expect(legendPaint[0]).toEqual(canvasPaint);
      const emptyMarks = page.locator('[data-heatmap-legend] [data-heat-level="0"], button[data-heat-level="0"]');
      const emptyBorders = await borderOf(emptyMarks);
      expect(emptyBorders.length).toBeGreaterThan(1);
      const [grayText, ...emptyOutlines] = await paintedColors(page, [
        await resolveSystemColor(page, 'GrayText'),
        ...emptyBorders.map(({ color }) => color),
      ]);
      if (!grayText) {
        throw new Error('Expected GrayText to paint');
      }
      expect(contrastRatio(grayText, canvasPaint)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST);
      for (const [index, border] of emptyBorders.entries()) {
        expect(border.style).toBe('solid');
        expect(border.sides).toEqual(['1px', '1px', '1px', '1px']);
        expect(emptyOutlines[index]).toEqual(grayText);
      }

      // Each day keeps its own paint, so its focus ring has to come from the forced palette.
      const rovingDay = calendar.locator('button[data-heatmap-day][tabindex="0"]');
      await focusByKeyboard(page, rovingDay);
      const dayRing = await expectSolidRing(rovingDay);
      expect(dayRing.color).toBe(await resolveSystemColor(page, 'Highlight'));

      const dotMarks = page.locator('[data-punchcard-cell-fill]');
      const keyMarks = page.locator('[data-punchcard-intensity-key] span[style]');
      const dots = await paintOf(dotMarks);
      const keyDots = await paintOf(keyMarks);
      expect(dots.length).toBeGreaterThan(0);
      expect(keyDots).toHaveLength(4);
      for (const dot of [...dots, ...keyDots]) {
        expect(dot.opacity).toBe('1');
      }
      // The key runs from Low to High, and every dot drawn stands at least 3:1 off the canvas.
      expectRisingContrast(
        canvasPaint,
        await paintedColors(
          page,
          keyDots.map(({ background }) => background),
        ),
      );
      const dotPaint = await paintedColors(
        page,
        dots.map(({ background }) => background),
      );
      expect(Math.min(...contrastsOffCanvas(canvasPaint, dotPaint))).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST);
      expect(dotPaint.map((dot) => dot[3])).toEqual(dotPaint.map(() => OPAQUE_ALPHA));

      // Without forced colours the authored encoding is untouched: one accent fill, faded per level.
      // Reduced motion still runs a near-instant transition, so the switch is polled.
      await page.emulateMedia({ forcedColors: 'none' });
      await expect
        .poll(async () => (await paintOf(legendMarks)).map(({ opacity }) => opacity))
        .toEqual(['1', '0.28', '0.52', '0.76', '1']);
      const authoredLegend = await paintOf(legendMarks);
      expect(new Set(authoredLegend.slice(1).map(({ background }) => background)).size).toBe(1);
      const authoredActiveDay = (await paintOf(dayMarks)).find(({ level }) => level === activeDay.level);
      expect(authoredActiveDay).toEqual(authoredLegend[Number(activeDay.level)]);
      await expect(rovingDay).toHaveCSS('outline-width', '1px');
      expect((await borderOf(emptyMarks)).map(({ sides }) => sides[0])).toEqual(emptyBorders.map(() => '0px'));
      const authoredKey = await paintOf(keyMarks);
      expect(authoredKey.map(({ opacity }) => Number(opacity).toFixed(3))).toEqual([
        '0.259',
        '0.454',
        '0.688',
        '1.000',
      ]);
      expect(new Set(authoredKey.map(({ background }) => background))).toEqual(
        new Set([await resolveSystemColor(page, 'var(--colors-accent)')]),
      );
    });
  }
}

test('a reused project SKILL.md preview tracks whether the current document is scrollable', async ({ page }) => {
  await openHydratedSkills(page, '/skills/projects/project%2Fopaque/skill-name');

  // Hold the preview box at one size across client-side navigation. Its intrinsic content changes,
  // while a stable scrollbar gutter keeps its observed content box unchanged.
  await page.addStyleTag({
    content:
      '[aria-label$=" SKILL.md preview"] { height: 100px !important; max-height: 100px !important; overflow-y: scroll !important; scrollbar-gutter: stable; }',
  });
  const shortPreview = page.getByRole('region', { name: 'skill-name SKILL.md preview' });
  await expect(shortPreview).toBeVisible();
  expect(await shortPreview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(false);
  await expect(shortPreview).not.toHaveAttribute('tabindex', '0');

  const longProjectMarkdown = Array.from(
    { length: 120 },
    (_, index) => `Preview line ${index + 1}: deterministic content.`,
  ).join(' ');
  await page.route('**/rpc/skills/projectMarkdown?*', async (route) => {
    await route.fulfill({
      body: encodeRpcResponseBody({
        content: `# twin-skill\n\n${longProjectMarkdown}\n`,
        path: '/fixture/work/opaque-project-source/.agents/skills/twin-skill/SKILL.md',
        skillName: 'twin-skill',
        truncated: false,
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  // The tree is gone: a project is a worktable row that expands in place, and its skills link into
  // the same drawer this preview lives in.
  await page.getByRole('button', { name: 'Close skill detail' }).click();
  // Expanding one repository turns its own control into Collapse, so the remaining set is re-read
  // each pass rather than indexed into a list that shrinks underneath the loop.
  const expandButtons = page.locator('[data-worktable-project-expand][aria-expanded="false"]');
  await expect(expandButtons.first()).toBeVisible();
  for (let pass = 0; pass < MAX_PROJECT_EXPANSIONS && (await expandButtons.count()) > 0; pass += 1) {
    await expandButtons.first().click();
  }
  await page.getByRole('link', { exact: true, name: 'twin-skill' }).click();

  const longPreview = page.getByRole('region', { name: 'twin-skill SKILL.md preview' });
  await expect(longPreview).toContainText('Preview line 120');
  expect(await longPreview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expectNoAxeViolations(page);
  await expect(longPreview).toHaveAccessibleName('twin-skill SKILL.md preview');
  await expect(longPreview).toHaveAttribute('tabindex', '0');
});

test('the skills worktable has no detectable accessibility violations', async ({ page }) => {
  await openHydratedSkills(page, '/skills');
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('button', { name: ALL_FILTER_PATTERN })).toBeVisible();

  await expectNoAxeViolations(page);
});

test('Memory has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/memory');
  await waitForHydratedNavigation(page);
  await expect(page.getByRole('link', { name: 'Knowledge', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 2, name: 'Search accepted Memory' })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: 'Pending review', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Keep local Memory offline-first' })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Search accepted Memory' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('Projects has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/projects');
  await waitForHydratedNavigation(page);
  await expect(page.getByRole('heading', { level: 2, name: 'checkout:0198f179' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave unassigned' })).toBeVisible();

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

test('Delegation has no detectable accessibility violations in each section', async ({ page }) => {
  await page.goto('/delegation');
  await expect(page.locator('main[data-delegation-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Delegation' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Routes and accounts' })).toBeVisible();
  await expectNoAxeViolations(page);

  const tabs = page.getByRole('tablist', { name: 'Delegation sections' });
  await tabs.getByRole('tab', { name: 'Rules' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Policy simulator' })).toBeVisible();
  await expectNoAxeViolations(page);

  await tabs.getByRole('tab', { name: 'Models' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Model catalog' })).toBeVisible();
  await expectNoAxeViolations(page);
});
