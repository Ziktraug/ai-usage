import { collectionSourceDefinitions, type SourceControlView } from '@ai-usage/report-core/source-control';
import type { Page } from '@playwright/test';
import { E2E_SKILLS_FIXTURE_HEADER } from '../src/lib/server/rpc/e2e-fixture-profile';
import { test as browserTest, expect, openHydratedReport, openHydratedSkills, reportViewsFor } from './browser-test';

const DESKTOP_VIEWPORT = { height: 900, width: 1280 } as const;
const OVERVIEW_DESKTOP_VIEWPORT = { height: 1000, width: 1440 } as const;
const NARROW_VIEWPORT = { height: 844, width: 390 } as const;
const DESKTOP_MAX_DIFF_PIXELS = 28;
const DRAWER_MAX_DIFF_PIXELS = 24;
const EXECUTIVE_METRIC_COUNT = 4;
const MIN_PRIMARY_VALUE_FONT_SIZE_PX = 44;
const MIN_TOUCH_TARGET_PX = 44;
const NARROW_MAX_DIFF_PIXELS = 22;
const SKILLS_MAX_DIFF_PIXELS = 12;
const DISABLE_LCD_TEXT_ARGUMENT = '--disable-lcd-text';
const STABLE_SOURCE_CONTROL_SNAPSHOT = {
  generatedAt: '2026-06-11T12:00:00.000Z',
  generation: 1,
  instanceId: 'visual-regression',
  publication: {
    acknowledgedRequestGeneration: 1,
    dirty: false,
    dirtyGeneration: 1,
    lastOutcome: 'success',
    pendingDemand: false,
    publishedGeneration: 1,
    queued: false,
    requestedGeneration: 1,
    revision: 'visual-regression-revision',
    rtkCompletedGeneration: 1,
    rtkRequiredGeneration: 1,
    running: false,
  },
  queueDepth: 0,
  runningCount: 0,
  sources: collectionSourceDefinitions.map((definition) => ({
    availability: 'detected',
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'success',
    lifecycle: 'scheduled',
    policy: 'enabled',
    reason: { code: 'none' },
    warnings: [],
  })),
} satisfies SourceControlView;

const test = browserTest.extend({
  launchOptions: async ({ launchOptions }, use): Promise<void> => {
    await use({
      ...launchOptions,
      args: [...(launchOptions.args ?? []), DISABLE_LCD_TEXT_ARGUMENT],
    });
  },
});

test.use({
  colorScheme: 'light',
  contextOptions: {
    reducedMotion: 'reduce',
  },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'Europe/Paris',
  viewport: DESKTOP_VIEWPORT,
});

const waitForFonts = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    await document.fonts.ready;
  });

const installStableSourceControl = async (page: Page): Promise<void> => {
  await page.addInitScript((serializedSnapshot) => {
    class StableEventSource extends EventTarget {
      static readonly CLOSED = 2;
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readonly url: string;
      readonly withCredentials = false;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      readyState = StableEventSource.CONNECTING;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        queueMicrotask(() => {
          this.readyState = StableEventSource.OPEN;
          this.onopen?.(new Event('open'));
          this.dispatchEvent(new MessageEvent('snapshot', { data: serializedSnapshot }));
        });
      }

      close(): void {
        this.readyState = StableEventSource.CLOSED;
      }
    }

    Reflect.set(window, 'EventSource', StableEventSource);
  }, JSON.stringify(STABLE_SOURCE_CONTROL_SNAPSHOT));
};

const openStableOverview = async (page: Page): Promise<void> => {
  await installStableSourceControl(page);
  await openHydratedReport(page);
  await expect(page.getByText('5 / 6 sessions', { exact: true })).toBeVisible();
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await waitForFonts(page);
};

const expectViewportProfile = async (
  page: Page,
  viewport: { readonly height: number; readonly width: number },
  colorScheme: 'dark' | 'light',
): Promise<void> => {
  expect(page.viewportSize()).toEqual(viewport);
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(colorScheme === 'dark');
};

const expectDecisionFirstOverviewAtTop = async (page: Page) => {
  const period = page.getByRole('region', { name: 'Report period' });
  const kpi = page.locator('[data-executive-kpi]');
  const chart = page.locator('[data-executive-chart]');
  const chartPlot = chart.locator('[data-report-range-part="chart"]');
  const metrics = page.locator('[data-executive-metrics]');
  const metricItems = metrics.locator(':scope > div');
  const investigation = page.getByRole('heading', { level: 2, name: 'Investigate' });

  await expect(period).toBeVisible();
  await expect(kpi).toBeVisible();
  await expect(kpi).toContainText('Standard API-price estimate');
  await expect(chart).toBeVisible();
  await expect(chartPlot).toBeVisible();
  await expect(metrics).toBeVisible();
  await expect(metricItems).toHaveCount(EXECUTIVE_METRIC_COUNT);
  await expect(investigation).toBeVisible();

  const documentGeometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollY: window.scrollY,
  }));
  expect(documentGeometry.scrollY).toBe(0);
  expect(documentGeometry.scrollWidth).toBeLessThanOrEqual(documentGeometry.clientWidth);

  const readingOrderIsDecisionFirst = await page.locator('[data-report-overview]').evaluate((element) => {
    const investigationHeading = [...element.querySelectorAll('h2')].find(
      (heading) => heading.textContent?.trim() === 'Investigate',
    );
    const markers = [
      element.querySelector('[data-executive-kpi]'),
      element.querySelector('[data-executive-chart]'),
      element.querySelector('[data-executive-metrics]'),
      investigationHeading ?? null,
    ];
    const documentOrder = [...element.querySelectorAll('*')];
    const positions = markers.map((marker) => (marker === null ? -1 : documentOrder.indexOf(marker)));
    return (
      positions.every((position) => position >= 0) &&
      positions.every((position, index) => index === 0 || position > (positions[index - 1] ?? Number.POSITIVE_INFINITY))
    );
  });
  expect(readingOrderIsDecisionFirst).toBe(true);

  const primaryValueFontSize = Number.parseFloat(
    await kpi
      .locator('strong')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
  );
  const secondaryValueFontSize = Number.parseFloat(
    await metricItems
      .first()
      .locator('dd')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
  );
  expect(primaryValueFontSize).toBeGreaterThan(secondaryValueFontSize);

  return { chart, kpi, metricItems, period, primaryValueFontSize };
};

const screenshotOptions = {
  animations: 'disabled',
  caret: 'hide',
} as const;

test('matches the initial desktop light Overview at 1440x1000', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize(OVERVIEW_DESKTOP_VIEWPORT);
  await openStableOverview(page);
  await expectViewportProfile(page, OVERVIEW_DESKTOP_VIEWPORT, 'light');
  const { chart, kpi, metricItems, primaryValueFontSize } = await expectDecisionFirstOverviewAtTop(page);
  expect(primaryValueFontSize).toBeGreaterThanOrEqual(MIN_PRIMARY_VALUE_FONT_SIZE_PX);

  const foldBottoms = [
    await kpi.evaluate((element) => Math.ceil(element.getBoundingClientRect().bottom)),
    await chart.evaluate((element) => Math.ceil(element.getBoundingClientRect().bottom)),
    ...(await metricItems.evaluateAll((elements) =>
      elements.map((element) => Math.ceil(element.getBoundingClientRect().bottom)),
    )),
  ];
  expect(foldBottoms.every((bottom) => bottom <= OVERVIEW_DESKTOP_VIEWPORT.height)).toBe(true);

  await expect(page).toHaveScreenshot('overview-desktop.png', {
    ...screenshotOptions,
    maxDiffPixels: DESKTOP_MAX_DIFF_PIXELS,
  });
});

test('matches the initial narrow dark Overview at 390x844', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize(NARROW_VIEWPORT);
  await openStableOverview(page);
  await expectViewportProfile(page, NARROW_VIEWPORT, 'dark');
  const { chart, kpi, period } = await expectDecisionFirstOverviewAtTop(page);

  const mobileNavigation = page.locator('[data-app-navigation="mobile"]');
  const chartHeading = chart.getByRole('heading', { level: 2, name: 'Activity' });
  await expect(mobileNavigation).toBeVisible();
  await expect(chartHeading).toBeVisible();
  const navigationTop = await mobileNavigation.evaluate((element) => Math.floor(element.getBoundingClientRect().top));
  const [periodBottom, kpiBottom, chartTop, chartHeadingBottom] = await Promise.all([
    period.evaluate((element) => Math.ceil(element.getBoundingClientRect().bottom)),
    kpi.evaluate((element) => Math.ceil(element.getBoundingClientRect().bottom)),
    chart.evaluate((element) => Math.floor(element.getBoundingClientRect().top)),
    chartHeading.evaluate((element) => Math.ceil(element.getBoundingClientRect().bottom)),
  ]);
  expect(periodBottom).toBeLessThanOrEqual(navigationTop);
  expect(kpiBottom).toBeLessThanOrEqual(navigationTop);
  expect(chartTop).toBeLessThan(navigationTop);
  expect(chartHeadingBottom).toBeLessThanOrEqual(navigationTop);

  const presetGeometry = await period.locator('button:visible').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        bottom: Math.ceil(box.bottom),
        clipped: element.scrollWidth > element.clientWidth + 1,
        height: Math.floor(box.height),
      };
    }),
  );
  expect(presetGeometry).toHaveLength(6);
  expect(
    presetGeometry.every(
      ({ bottom, clipped, height }) => bottom <= navigationTop && !clipped && height >= MIN_TOUCH_TARGET_PX,
    ),
  ).toBe(true);

  await expect(page).toHaveScreenshot('overview-narrow.png', {
    ...screenshotOptions,
    maxDiffPixels: NARROW_MAX_DIFF_PIXELS,
  });
});

test('matches the mobile light session drawer at 390x844', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize(NARROW_VIEWPORT);
  await openStableOverview(page);
  await expectViewportProfile(page, NARROW_VIEWPORT, 'light');
  await page
    .getByRole('heading', { level: 2, name: 'Top sessions' })
    .locator('xpath=ancestor::section[1]')
    .getByRole('button')
    .first()
    .click();

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  const closeButton = drawer.getByRole('button', { name: 'Close session details' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(drawer).toHaveCSS('animation-name', 'none');
  await expect(closeButton).toBeFocused();

  const drawerGeometry = await drawer.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      bottom: Math.round(box.bottom),
      left: Math.round(box.left),
      pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      right: Math.round(box.right),
      width: Math.round(box.width),
    };
  });
  expect(drawerGeometry).toEqual({
    bottom: NARROW_VIEWPORT.height,
    left: 0,
    pageHasHorizontalOverflow: false,
    right: NARROW_VIEWPORT.width,
    width: NARROW_VIEWPORT.width,
  });

  const layerOrder = await page.evaluate(() => {
    const zIndex = (selector: string): number => {
      const element = document.querySelector(selector);
      return element ? Number(getComputedStyle(element).zIndex) : Number.NaN;
    };
    return {
      backdrop: zIndex('[data-scope="drawer"][data-part="backdrop"][data-state="open"]'),
      content: zIndex('[data-scope="drawer"][data-part="content"][data-state="open"]'),
      navigation: zIndex('[data-app-navigation="mobile"]'),
    };
  });
  expect(layerOrder.backdrop).toBeGreaterThan(layerOrder.navigation);
  expect(layerOrder.content).toBeGreaterThan(layerOrder.navigation);

  const headerActions = drawer.locator('[data-session-drawer-header] button:visible');
  const headerActionGeometry = await headerActions.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { height: Math.floor(box.height), width: Math.floor(box.width) };
    }),
  );
  expect(headerActionGeometry.length).toBeGreaterThanOrEqual(3);
  expect(
    headerActionGeometry.every(({ height, width }) => height >= MIN_TOUCH_TARGET_PX && width >= MIN_TOUCH_TARGET_PX),
  ).toBe(true);

  await expect(page).toHaveScreenshot('overview-session-drawer.png', {
    ...screenshotOptions,
    maxDiffPixels: DRAWER_MAX_DIFF_PIXELS,
  });
});

test('matches the hydrated Skills workspace', async ({ page }) => {
  await page.setExtraHTTPHeaders({ [E2E_SKILLS_FIXTURE_HEADER]: 'visual' });
  await openHydratedSkills(page, '/skills/global/alpha-skill');
  await expect(page.getByRole('textbox', { name: 'alpha-skill SKILL.md' })).toBeVisible();
  await waitForFonts(page);

  await expect(page).toHaveScreenshot('skills-desktop.png', {
    ...screenshotOptions,
    maxDiffPixels: SKILLS_MAX_DIFF_PIXELS,
  });
});
