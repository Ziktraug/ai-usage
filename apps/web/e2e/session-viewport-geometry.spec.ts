import type { Locator, Page } from '@playwright/test';
import { expect, openHydratedReport, test } from './browser-test';
import { capturePlan073Smoke } from './plan073-smoke';

const SESSION_VIEWPORT_BOTTOM_INSET = 24;
const MOBILE_DRAWER_VIEWPORT = { height: 844, width: 390 } as const;
const DESKTOP_DRAWER_VIEWPORT = { height: 900, width: 1280 } as const;

type SessionDrawerViewport = 'desktop' | 'mobile';

const openBuildReportRootSession = async (page: Page, viewport: SessionDrawerViewport): Promise<Locator> => {
  const surface = page.locator(`[data-session-surface="${viewport}"]`);
  const campaignRow = surface
    .locator('[data-depth="0"][data-session-row-id]')
    .filter({ hasText: 'Build report UI' })
    .first();
  await expect(campaignRow).toBeVisible();
  const trigger =
    viewport === 'mobile'
      ? campaignRow.getByRole('button', { exact: true, name: 'Inspect session: Build report UI' })
      : campaignRow;
  await trigger.focus();
  await trigger.click();
  return trigger;
};

const visibleDrawerControls = (drawer: Locator): Locator =>
  drawer.locator(
    'button:visible:not([disabled]), a[href]:visible, summary:visible, input:visible:not([disabled]), select:visible:not([disabled]), textarea:visible:not([disabled]), [tabindex]:visible:not([tabindex="-1"])',
  );

const captureLifecycleWarnings = (page: Page): (() => readonly string[]) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (!message.text().includes('derived_inert')) {
      return;
    }
    const location = message.location();
    warnings.push(`${location.url}:${location.lineNumber}:${location.columnNumber} ${message.text()}`);
  });
  return () => warnings;
};

const startSelectionCloseCounter = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const slot = document.querySelector('[data-session-detail-slot]');
    if (!slot) {
      throw new Error('Session detail slot is unavailable');
    }
    const closeState = { count: 0 };
    Reflect.set(globalThis, '__aiUsageSessionCloseState', closeState);
    new MutationObserver(() => {
      if (!slot.hasAttribute('data-selected-row-id')) {
        closeState.count += 1;
      }
    }).observe(slot, { attributeFilter: ['data-selected-row-id'], attributes: true });
  });
};

const selectionCloseCount = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    const closeState: unknown = Reflect.get(globalThis, '__aiUsageSessionCloseState');
    if (!(typeof closeState === 'object' && closeState !== null && 'count' in closeState)) {
      throw new Error('Session close counter is unavailable');
    }
    return Number(Reflect.get(closeState, 'count'));
  });

const viewportCases = [
  {
    height: 900,
    maximumRowHeight: 96,
    minimumRowHeight: 43,
    mode: 'desktop',
    rowSelector: 'tr[data-index]',
    width: 1024,
  },
  {
    height: 844,
    maximumRowHeight: 188,
    minimumRowHeight: 188,
    mode: 'mobile',
    rowSelector: 'li[data-index]',
    width: 390,
  },
] as const;

test('anchors the virtual Session viewport inside the screen on desktop and mobile', async ({ page }) => {
  for (const viewportCase of viewportCases) {
    await page.setViewportSize({ height: viewportCase.height, width: viewportCase.width });
    await openHydratedReport(page, '/?tab=sessions');

    const surface = page.locator(`[data-session-surface="${viewportCase.mode}"]`);
    const regionStart = page.locator('[data-session-region-start]');
    await expect(surface).toBeVisible();
    await expect(regionStart).toBeVisible();

    await expect
      .poll(
        async () =>
          await surface.evaluate((element, bottomInset) => {
            const rect = element.getBoundingClientRect();
            const regionRect = document.querySelector('[data-session-region-start]')?.getBoundingClientRect();
            // The height follows the viewport alone. Deriving it from `rect.top`
            // — as this assertion did until 2026-08-05 — is what let the surface
            // grow as the page was scrolled and the document stretch away.
            const expectedHeight = Math.max(1, window.innerHeight - bottomInset);
            return {
              activeElementInsideRegion: Boolean(document.activeElement?.closest('[data-session-region-start]')),
              fillsViewportHeight: Math.abs(element.clientHeight - expectedHeight) <= 2,
              maxHeight: getComputedStyle(element).maxHeight,
              minHeight: getComputedStyle(element).minHeight,
              overflowAnchor: getComputedStyle(element).overflowAnchor,
              regionStartsInViewport: Boolean(
                regionRect && regionRect.top >= -1 && regionRect.top < window.innerHeight * 0.2,
              ),
              surfaceStartsInViewport: rect.top >= 0 && rect.top < window.innerHeight * 0.25,
              windowScrolledPastChrome: window.scrollY > 0,
            };
          }, SESSION_VIEWPORT_BOTTOM_INSET),
      )
      .toEqual({
        activeElementInsideRegion: false,
        fillsViewportHeight: true,
        maxHeight: 'none',
        minHeight: '0px',
        overflowAnchor: 'none',
        regionStartsInViewport: true,
        surfaceStartsInViewport: true,
        windowScrolledPastChrome: true,
      });

    const rowHeight = await surface
      .locator(viewportCase.rowSelector)
      .first()
      .evaluate((row) => Math.round(row.getBoundingClientRect().height));
    expect(rowHeight).toBeGreaterThanOrEqual(viewportCase.minimumRowHeight);
    expect(rowHeight).toBeLessThanOrEqual(viewportCase.maximumRowHeight);

    await page.setViewportSize({
      height: viewportCase.mode === 'desktop' ? 220 : 300,
      width: viewportCase.width,
    });
    await expect
      .poll(async () => await surface.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const outerScrollPosition = await page.evaluate(() => window.scrollY);
    expect(outerScrollPosition).toBeGreaterThan(0);
    await surface.evaluate((element) => {
      element.scrollTop = Math.min(40, element.scrollHeight - element.clientHeight);
    });
    await expect.poll(async () => await surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScrollPosition);
  }
});

test('keeps the document height still while the Session surface is scrolled past', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await openHydratedReport(page);
  await page.getByRole('link', { exact: true, name: 'Sessions' }).first().click();
  await expect(page.locator('[data-session-region-start]')).toBeAttached();

  const measure = () =>
    page.evaluate(() => {
      const surface = [...document.querySelectorAll<HTMLElement>('*')].find((node) =>
        node.style.getPropertyValue('--session-surface-height'),
      );
      return {
        documentHeight: document.documentElement.scrollHeight,
        scrollY: Math.round(window.scrollY),
        surfaceHeight: surface ? Math.round(surface.getBoundingClientRect().height) : null,
      };
    });

  const initial = await measure();
  expect(initial.surfaceHeight).not.toBeNull();

  // Sizing the surface from its own viewport-relative top was circular: each
  // pixel scrolled grew the page by a pixel, so the reader never advanced and the
  // bottom stayed out of reach. One viewport must yield one document height.
  for (const target of [120, 320, 560, 800, 320, 0]) {
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await page.waitForTimeout(200);
    const reading = await measure();
    expect(reading.documentHeight, `at ${target}`).toBe(initial.documentHeight);
    expect(reading.surfaceHeight, `at ${target}`).toBe(initial.surfaceHeight);
    // The requested position is reachable, rather than being clamped by a page
    // that grew while the scroll was applied.
    expect(reading.scrollY, `at ${target}`).toBe(Math.min(target, initial.documentHeight - 900));
  }
});

test('keeps the mobile Session drawer modal, trapped, safe, and restorable', async ({ page }, testInfo) => {
  const lifecycleWarnings = captureLifecycleWarnings(page);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize(MOBILE_DRAWER_VIEWPORT);
  await openHydratedReport(page, '/?tab=sessions');

  const sessionTrigger = await openBuildReportRootSession(page, 'mobile');

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  const backdrop = page.locator('[data-scope="drawer"][data-part="backdrop"][data-state="open"]');
  const closeButton = drawer.getByRole('button', { name: 'Close session details' });
  const drawerHeader = drawer.locator('[data-session-drawer-header]');
  const drawerBody = drawer.locator('[data-session-drawer-body]');
  const drawerNavigation = drawer.locator('[data-session-drawer-navigation]');
  await expect(drawer).toBeVisible();
  await expect(page.locator('[data-scope="drawer"][data-part="content"][data-state="open"]')).toHaveCount(1);
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(backdrop).toBeVisible();
  await expect(closeButton).toBeFocused();
  await expect(drawer).toHaveCSS('animation-name', 'none');
  expect(lifecycleWarnings(), 'after the initial mobile Drawer opens').toEqual([]);

  const geometry = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      right: Math.round(rect.right),
      width: Math.round(rect.width),
    };
  });
  expect(geometry).toEqual({
    bottom: MOBILE_DRAWER_VIEWPORT.height,
    left: 0,
    pageHasHorizontalOverflow: false,
    right: MOBILE_DRAWER_VIEWPORT.width,
    width: MOBILE_DRAWER_VIEWPORT.width,
  });

  const layers = await page.evaluate(() => {
    const zIndexOf = (selector: string): number => {
      const element = document.querySelector(selector);
      return element ? Number(getComputedStyle(element).zIndex) : Number.NaN;
    };
    return {
      backdrop: zIndexOf('[data-scope="drawer"][data-part="backdrop"][data-state="open"]'),
      content: zIndexOf('[data-scope="drawer"][data-part="content"][data-state="open"]'),
      navigation: zIndexOf('[data-app-navigation="mobile"]'),
    };
  });
  expect(layers.backdrop).toBeGreaterThan(layers.navigation);
  expect(layers.content).toBeGreaterThan(layers.navigation);

  const headerGeometry = await drawerHeader.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(headerGeometry.scrollWidth).toBeLessThanOrEqual(headerGeometry.clientWidth + 1);
  const navigationGeometry = await drawerNavigation.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  expect(navigationGeometry.scrollWidth).toBeLessThanOrEqual(navigationGeometry.clientWidth + 1);
  expect(navigationGeometry.whiteSpace).toBe('nowrap');
  const headerControlGeometry = await drawerHeader.locator('button:visible').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { height: Math.round(rect.height), width: Math.round(rect.width) };
    }),
  );
  expect(headerControlGeometry.length).toBeGreaterThanOrEqual(3);
  expect(headerControlGeometry.every(({ height, width }) => height >= 44 && width >= 44)).toBe(true);
  const bodyControlGeometry = await drawerBody
    .locator('button:visible, a[href]:visible, summary:visible, input:visible, select:visible, textarea:visible')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: Math.round(rect.height),
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
          ordinaryAction: element.matches('button, a[href]'),
          tagName: element.tagName,
          width: Math.round(rect.width),
        };
      }),
    );
  expect(bodyControlGeometry.length).toBeGreaterThan(0);
  expect(
    bodyControlGeometry.filter(({ height, ordinaryAction, width }) =>
      ordinaryAction ? height < 44 || width < 44 : height < 44,
    ),
  ).toEqual([]);
  expect(
    await drawerBody.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        hasSafeAreaSyntax: CSS.supports('padding-bottom', 'env(safe-area-inset-bottom)'),
        minimumBottomPadding: Number.parseFloat(style.paddingBottom) >= 16,
        scrollableOverflow: style.overflowY === 'auto' || style.overflowY === 'scroll',
      };
    }),
  ).toEqual({ hasSafeAreaSyntax: true, minimumBottomPadding: true, scrollableOverflow: true });

  const focusableControls = visibleDrawerControls(drawer);
  const focusableCount = await focusableControls.count();
  expect(focusableCount).toBeGreaterThan(1);
  await focusableControls.first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(focusableControls.last()).toBeFocused();
  await focusableControls.last().focus();
  await page.keyboard.press('Tab');
  await expect(focusableControls.first()).toBeFocused();
  await page
    .locator('[data-app-navigation="mobile"] a')
    .first()
    .evaluate((element) => (element as HTMLElement).focus());
  await expect
    .poll(async () => await drawer.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  expect(lifecycleWarnings(), 'after the mobile focus trap checks').toEqual([]);

  const detailHintTrigger = drawer.getByRole('button', { name: 'About Total tokens' });
  await detailHintTrigger.click();
  const detailHint = page.locator('[data-scope="popover"][data-part="content"][data-state="open"]');
  await expect(detailHint).toBeVisible();
  expect(Number(await detailHint.evaluate((element) => getComputedStyle(element).zIndex))).toBeGreaterThan(
    layers.content,
  );
  await page.keyboard.press('Escape');
  await expect(detailHint).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(detailHintTrigger).toBeFocused();
  expect(lifecycleWarnings(), 'after the nested detail Popover closes').toEqual([]);

  await drawer.focus();
  const initialNavigationLabel = await drawerNavigation.getAttribute('aria-label');
  expect(initialNavigationLabel).not.toBeNull();
  await expect(drawer.getByRole('button', { name: 'Next session (j)' })).toBeEnabled();
  await page.keyboard.press('j');
  await expect(drawer.getByText('Recover Claude history', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('k');
  await expect(drawer.getByText('Build report UI', { exact: true }).first()).toBeVisible();
  await expect(drawerNavigation).toHaveAttribute('aria-label', initialNavigationLabel ?? '');
  expect(lifecycleWarnings(), 'after mobile j/k navigation').toEqual([]);
  await capturePlan073Smoke(page, testInfo, 'step7-drawer-390x844-light');

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(sessionTrigger).toBeFocused();
  expect(lifecycleWarnings(), 'after the light mobile Drawer closes').toEqual([]);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await sessionTrigger.click();
  await expect(drawer).toBeVisible();
  await expect(closeButton).toBeFocused();
  expect(lifecycleWarnings(), 'after the dark mobile Drawer opens').toEqual([]);
  await capturePlan073Smoke(page, testInfo, 'step7-drawer-390x844-dark');

  await page.setViewportSize({ height: 900, width: 1024 });
  await expect(drawer).toHaveAttribute('aria-modal', 'false');
  await expect(backdrop).toHaveCount(0);
  await expect(page.locator('[data-scope="drawer"][data-part="content"][data-state="open"]')).toHaveCount(1);
  const overviewLink = page.getByRole('link', { exact: true, name: 'Overview' }).first();
  await overviewLink.focus();
  await expect(overviewLink).toBeFocused();
  await expect(drawer).toBeVisible();
  expect(lifecycleWarnings(), 'after the open Drawer becomes desktop non-modal').toEqual([]);

  await page.setViewportSize(MOBILE_DRAWER_VIEWPORT);
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(backdrop).toBeVisible();
  await expect(page.locator('[data-scope="drawer"][data-part="content"][data-state="open"]')).toHaveCount(1);
  const mobileOverviewLink = page.locator('[data-app-navigation="mobile"] a').first();
  await mobileOverviewLink.evaluate((element) => (element as HTMLElement).focus());
  await expect
    .poll(async () => await drawer.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  expect(lifecycleWarnings(), 'after the open Drawer becomes mobile modal again').toEqual([]);

  await startSelectionCloseCounter(page);
  await closeButton.click();
  await expect(drawer).toBeHidden();
  await expect(sessionTrigger).toBeFocused();
  await expect.poll(async () => await selectionCloseCount(page)).toBe(1);
  expect(lifecycleWarnings()).toEqual([]);
});

test('keeps the desktop Session drawer nonmodal and outside-focus friendly', async ({ page }, testInfo) => {
  const lifecycleWarnings = captureLifecycleWarnings(page);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize(DESKTOP_DRAWER_VIEWPORT);
  await openHydratedReport(page, '/?tab=sessions');

  const sessionTrigger = await openBuildReportRootSession(page, 'desktop');

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('[data-scope="drawer"][data-part="backdrop"]')).toHaveCount(0);
  await expect(sessionTrigger).toBeFocused();
  expect(
    await drawer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
      };
    }),
  ).toEqual({
    bottom: DESKTOP_DRAWER_VIEWPORT.height,
    right: DESKTOP_DRAWER_VIEWPORT.width,
    top: 0,
    width: 440,
  });
  const actionGeometry = await drawer.locator('[data-session-drawer-header] button:visible').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { height: Math.round(rect.height), width: Math.round(rect.width) };
    }),
  );
  expect(actionGeometry.length).toBeGreaterThanOrEqual(3);
  expect(actionGeometry.every(({ height, width }) => height >= 44 && width >= 44)).toBe(true);
  await capturePlan073Smoke(page, testInfo, 'step7-drawer-1280x900-light');

  const overviewLink = page.getByRole('link', { exact: true, name: 'Overview' }).first();
  await overviewLink.focus();
  await expect(overviewLink).toBeFocused();
  await expect(drawer).toBeVisible();
  await startSelectionCloseCounter(page);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(sessionTrigger).toBeFocused();
  await expect.poll(async () => await selectionCloseCount(page)).toBe(1);
  expect(lifecycleWarnings()).toEqual([]);
});
