import { collectionSourceDefinitions, type SourceControlView } from '@ai-usage/report-core/source-control';
import type { Page } from '@playwright/test';
import { expect, test } from './browser-test';

const DESKTOP_VIEWPORT = { height: 900, width: 1280 } as const;
const NARROW_VIEWPORT = { height: 844, width: 390 } as const;
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

test.use({
  colorScheme: 'light',
  deviceScaleFactor: 1,
  locale: 'en-US',
  reducedMotion: 'reduce',
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
  await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByText('3 / 4 sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await waitForFonts(page);
};

const scrollOverviewValueIntoView = (page: Page): Promise<void> =>
  page.getByRole('region', { name: 'API-equivalent value' }).evaluate((element) => {
    element.scrollIntoView({ block: 'start' });
  });

const screenshotOptions = {
  animations: 'disabled',
  caret: 'hide',
} as const;

test('matches the desktop Overview', async ({ page }) => {
  await openStableOverview(page);
  await scrollOverviewValueIntoView(page);

  await expect(page).toHaveScreenshot('overview-desktop.png', screenshotOptions);
});

test('matches Overview with an open session drawer', async ({ page }) => {
  await openStableOverview(page);
  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible();
  await scrollOverviewValueIntoView(page);

  await expect(page).toHaveScreenshot('overview-session-drawer.png', screenshotOptions);
});

test('matches the narrow Overview value proposition', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await openStableOverview(page);
  await scrollOverviewValueIntoView(page);

  await expect(page).toHaveScreenshot('overview-narrow.png', screenshotOptions);
});

test('matches the hydrated Skills workspace', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'alpha-skill SKILL.md' })).toBeVisible();
  await waitForFonts(page);

  await expect(page).toHaveScreenshot('skills-desktop.png', screenshotOptions);
});
