import {
  collectionSourceDefinitions,
  type SourceControlEntryView,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import AxeBuilder from '@axe-core/playwright';
import { expect, openHydratedReport, test } from './browser-test';

const SOURCES_URL = /\/sources$/;

test.use({ hasTouch: true });

test('opens collection details on hover and keyboard without shifting focus, and keeps one stream across routes', async ({
  page,
}) => {
  let streams = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'eventsource') {
      streams += 1;
    }
  });
  await openHydratedReport(page);
  const header = page.locator('[data-workspace-topbar]');
  const trigger = header.getByRole('button', { name: 'Collection status' });
  const details = page.getByRole('dialog', { name: 'Collection details' });
  const search = page.getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' });
  await search.focus();
  await trigger.hover();
  await expect(details).toBeVisible();
  await expect(search).toBeFocused();
  await details.hover();
  await expect(details.getByRole('link', { name: 'View sources' })).toBeVisible();
  await expect(details.locator('[data-source-summary-attribution]')).toContainText('Source status checked at');
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(search).toBeFocused();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(details).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(details.getByRole('link', { name: 'View sources' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(details.getByRole('link', { name: 'View sources' })).toBeFocused();
  const { violations } = await new AxeBuilder({ page })
    .include('[data-workspace-topbar]')
    .include('[data-source-card]')
    .analyze();
  expect(violations).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(SOURCES_URL);
  await expect(details).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Collection status' })).toBeVisible();
  expect(streams).toBe(1);
  await expect(page.getByText('Local workspace', { exact: true })).toHaveCount(0);
});

test('keeps the mobile header compact and collection actions usable by touch', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHydratedReport(page);
  const header = page.locator('[data-workspace-topbar]');
  const trigger = header.getByRole('button', { name: 'Collection status' });
  const details = page.getByRole('dialog', { name: 'Collection details' });
  await trigger.tap();
  await expect(details).toBeVisible();
  const runAll = details.getByRole('button', { name: 'Collect now' });
  await expect(runAll).toBeEnabled();
  const release = Promise.withResolvers<void>();
  await page.route('**/api/source-control/command', async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await runAll.tap();
    await expect(runAll).toBeDisabled();
    await expect(runAll).toHaveAttribute('aria-busy', 'true');
    release.resolve();
    await expect(runAll).toBeEnabled();
    expect(await header.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(54);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const { violations } = await new AxeBuilder({ page })
      .include('[data-workspace-topbar]')
      .include('[data-source-card]')
      .analyze();
    expect(violations).toEqual([]);
    // The panel overlays the heading; use the page margin outside its bounded surface.
    await page.touchscreen.tap(8, 200);
    await expect(details).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

test('keeps dated historical uncertainty in the details and promotes current problems', async ({ page }) => {
  const historyMessage =
    '13 historical sessions have uncertain metrics (14 local records; latest occurrence: 2026-09-08). No metric anomalies in the last 7 days.';
  const snapshot: SourceControlView = {
    generatedAt: '2026-10-06T10:00:00.000Z',
    generation: 1,
    instanceId: 'warning-presentation-test',
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map(
      ({ id, label, cadenceMs }): SourceControlEntryView => ({
        id,
        label,
        cadenceMs,
        availability: 'detected',
        lastOutcome: id === 'codex.sessions' ? 'warning' : 'success',
        lifecycle: 'scheduled',
        policy: 'enabled',
        reason: { code: 'none' },
        warnings: id === 'codex.sessions' ? [{ code: 'historicalMetricValidation', message: historyMessage }] : [],
      }),
    ),
  };
  // Controlled source snapshots exercise presentation; the preceding tests use the real SSE transport.
  await page.addInitScript((initial) => {
    Object.defineProperty(window, 'EventSource', {
      value: class extends EventTarget {
        private readonly receive = (event: Event) => {
          if (event instanceof CustomEvent) {
            this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(event.detail) }));
          }
        };
        constructor() {
          super();
          window.addEventListener('e2e-source-snapshot', this.receive);
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(initial) })));
        }
        close() {
          window.removeEventListener('e2e-source-snapshot', this.receive);
        }
      },
    });
  }, snapshot);
  await openHydratedReport(page);
  const trigger = page.getByRole('button', { name: 'Collection status' });
  await expect(trigger).toHaveText('Up to date');
  await trigger.hover();
  const details = page.getByRole('dialog', { name: 'Collection details' });
  await expect(details.locator('[data-source-history-notes]')).toContainText(historyMessage);
  await expect(details.getByRole('link', { name: 'View sources' })).toBeVisible();
  const quotaMessage = 'Codex backfill could not advance; live and previously stored history remain available.';
  const failed = {
    ...snapshot,
    generation: 2,
    sources: snapshot.sources.map((source) =>
      source.id === 'codex.usage-limits'
        ? {
            ...source,
            lastOutcome: 'warning' as const,
            warnings: [{ code: 'provider-warning', message: quotaMessage }],
          }
        : source,
    ),
  };
  await page.evaluate((next) => window.dispatchEvent(new CustomEvent('e2e-source-snapshot', { detail: next })), failed);
  await expect(trigger).toHaveText('Needs attention');
  await expect(details).toContainText(quotaMessage);
  await expect(details.locator('[data-source-history-notes]')).toContainText(historyMessage);
  const { violations } = await new AxeBuilder({ page })
    .include('[data-workspace-topbar]')
    .include('[data-source-card]')
    .analyze();
  expect(violations).toEqual([]);
  await page.evaluate((next) => window.dispatchEvent(new CustomEvent('e2e-source-snapshot', { detail: next })), {
    ...snapshot,
    generation: 3,
  });
  await expect(trigger).toHaveText('Up to date');
});
