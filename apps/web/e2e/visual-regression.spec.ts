import { collectionSourceDefinitions, type SourceControlView } from '@ai-usage/report-core/source-control';
import type { Page } from '@playwright/test';
import { test as browserTest, expect, openHydratedReport, openHydratedSkills, reportViewsFor } from './browser-test';

const DESKTOP_VIEWPORT = { height: 900, width: 1280 } as const;
const NARROW_VIEWPORT = { height: 844, width: 390 } as const;
const DESKTOP_MAX_DIFF_PIXELS = 28;
const DRAWER_MAX_DIFF_PIXELS = 24;
const NARROW_MAX_DIFF_PIXELS = 22;
const SKILLS_MAX_DIFF_PIXELS = 12;
const DISABLE_LCD_TEXT_ARGUMENT = '--disable-lcd-text';
const TOP_SESSION_PATTERN = /Top session/;
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

const scrollOverviewValueIntoView = (page: Page): Promise<void> =>
  page.getByRole('region', { name: 'Estimated API-equivalent value' }).evaluate((element) => {
    element.scrollIntoView({ block: 'start' });
  });

const screenshotOptions = {
  animations: 'disabled',
  caret: 'hide',
} as const;

test('matches the desktop Overview', async ({ page }) => {
  await openStableOverview(page);
  await scrollOverviewValueIntoView(page);

  await expect(page).toHaveScreenshot('overview-desktop.png', {
    ...screenshotOptions,
    maxDiffPixels: DESKTOP_MAX_DIFF_PIXELS,
  });
});

test('matches Overview with an open session drawer', async ({ page }) => {
  await openStableOverview(page);
  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible();
  await scrollOverviewValueIntoView(page);

  await expect(page).toHaveScreenshot('overview-session-drawer.png', {
    ...screenshotOptions,
    maxDiffPixels: DRAWER_MAX_DIFF_PIXELS,
  });
});

test('matches the narrow Overview value proposition', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await openStableOverview(page);
  await scrollOverviewValueIntoView(page);

  await expect(page).toHaveScreenshot('overview-narrow.png', {
    ...screenshotOptions,
    maxDiffPixels: NARROW_MAX_DIFF_PIXELS,
  });
});

test('matches the hydrated Skills workspace', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');
  await expect(page.getByRole('textbox', { name: 'alpha-skill SKILL.md' })).toBeVisible();
  await waitForFonts(page);

  await expect(page).toHaveScreenshot('skills-desktop.png', {
    ...screenshotOptions,
    maxDiffPixels: SKILLS_MAX_DIFF_PIXELS,
  });
});
