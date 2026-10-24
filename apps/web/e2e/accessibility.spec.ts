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
  'Overview',
  'Sessions',
  'Analysis',
  'Memory',
  'Projects',
  'Skills',
  'Sync',
  'Sources',
] as const;
const routes = [
  { heading: 'Usage overview', path: '/' },
  { heading: 'Memory', path: '/memory' },
  { heading: 'Projects', path: '/projects' },
  { heading: 'Skills', path: '/skills' },
  { heading: 'Sources', path: '/sources' },
  { heading: 'Sync', path: '/sync' },
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
    for (const label of ['Overview', 'Sessions', 'Analysis']) {
      await expect(mobileNavigation.getByRole('link', { exact: true, name: label })).toBeVisible();
    }
    const manageButton = mobileNavigation.getByRole('button', { name: 'Manage' });
    await manageButton.click();
    const manageNavigation = page.getByRole('navigation', { name: 'Manage destinations' });
    for (const label of ['Memory', 'Projects', 'Skills', 'Sync', 'Sources']) {
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

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Rhythm and Punchcard keep their intensity marks in ${colorScheme} forced-colors mode`, async ({ page }) => {
    // Forced colours repaint every authored fill as the canvas colour, which would flatten the
    // intensity both charts draw as a fill. Their marks keep their own paint, so each level stays
    // apart from the canvas and from the other levels, and the legend still matches the marks.
    await page.emulateMedia({ colorScheme, forcedColors: 'active' });
    await openHydratedReport(page);
    await waitForFocusedReportSettled(page);
    const canvas = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);

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
      expect(mark.background).not.toBe(canvas);
      expect(legendBackgroundByLevel.get(mark.level)).toBe(mark.background);
      // The strength lives in the fill, so nothing drawn around a faint day is faded with it.
      expect(mark.opacity).toBe('1');
    }

    // Each day keeps its own paint, so its focus ring has to come from the forced palette.
    const rovingDay = calendar.locator('button[data-heatmap-day][tabindex="0"]');
    await focusByKeyboard(page, rovingDay);
    const dayRing = await expectSolidRing(rovingDay);
    expect(dayRing.color).toBe(await resolveSystemColor(page, 'Highlight'));

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
    await page.emulateMedia({ forcedColors: 'active' });

    const dots = await paintOf(page.locator('[data-punchcard-cell-fill]'));
    const keyDots = await paintOf(page.locator('[data-punchcard-intensity-key] span[style]'));
    expect(dots.length).toBeGreaterThan(0);
    expect(keyDots).toHaveLength(4);
    for (const dot of [...dots, ...keyDots]) {
      expect(dot.background).not.toBe(canvas);
    }
  });
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
  await expect(page.getByRole('heading', { level: 2, name: 'Your session library starts here' })).toBeVisible();
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
