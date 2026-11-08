import {
  collectionSourceDefinitions,
  type SourceControlEntryView,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const snapshot = (generation: number, jira: Partial<SourceControlEntryView> = {}): SourceControlView => ({
  generatedAt: '2026-10-28T12:00:00.000Z',
  generation,
  instanceId: 'jira-sync-e2e',
  queueDepth: 0,
  runningCount: jira.lifecycle === 'running' ? 1 : 0,
  publication: {
    acknowledgedRequestGeneration: 0,
    dirty: false,
    dirtyGeneration: 0,
    lastOutcome: 'not-run',
    pendingDemand: false,
    publishedGeneration: 0,
    queued: false,
    requestedGeneration: 0,
    rtkCompletedGeneration: 0,
    rtkRequiredGeneration: 0,
    running: false,
  },
  sources: collectionSourceDefinitions.map((source) => ({
    id: source.id,
    label: source.label,
    cadenceMs: source.cadenceMs,
    availability: 'detected',
    policy: 'enabled',
    lifecycle: 'scheduled',
    lastOutcome: 'success',
    reason: { code: 'none' },
    warnings: [],
    ...(source.id === 'jira.issues' ? { lastFinishedAt: '2026-10-28T11:58:00.000Z', ...jira } : {}),
  })),
});

test('Work shows Jira catch-up and refreshes tasks when a completed batch arrives', async ({ page }) => {
  let current = snapshot(1, {
    lastOutcome: 'warning',
    warnings: [{ code: 'jira-sync-pending', message: '28 Jira tickets awaiting details.' }],
  });
  await page.addInitScript((initial) => {
    class SourceEvents extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readonly update = (event: Event) => {
        if (event instanceof CustomEvent) {
          this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(event.detail) }));
        }
      };
      constructor() {
        super();
        window.addEventListener('jira-sync-snapshot', this.update);
        setTimeout(() => {
          this.onopen?.();
          this.dispatchEvent(new MessageEvent('control-state', { data: '{"state":"live"}' }));
          this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(initial) }));
        }, 0);
      }
      close() {
        window.removeEventListener('jira-sync-snapshot', this.update);
      }
    }
    Object.defineProperty(window, 'EventSource', { value: SourceEvents });
  }, current);
  let listReads = 0;
  page.on('request', (request) => {
    if (request.url().includes('/rpc/workThreads/list')) {
      listReads++;
    }
  });
  await page.goto('/work');
  const status = page.locator('[data-jira-sync]');
  await expect(status).toContainText('Catching up Jira');
  await expect(status).toContainText('28 Jira tickets awaiting details.');
  await expect(page.locator('[data-work-hydrated="true"]')).toBeVisible();
  const before = listReads;
  current = snapshot(2, { lastFinishedAt: '2026-10-28T12:00:00.000Z' });
  await page.evaluate(
    (value) => window.dispatchEvent(new CustomEvent('jira-sync-snapshot', { detail: value })),
    current,
  );
  await expect(status).toContainText('Jira checked');
  await expect.poll(() => listReads).toBeGreaterThan(before);
  await expect(status.locator('time')).toHaveAttribute('datetime', '2026-10-28T12:00:00.000Z');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  current = snapshot(3, {
    lastOutcome: 'warning',
    warnings: [
      { code: 'jira-sync-pending', message: '1 Jira ticket awaiting details.' },
      { code: 'jira-details-incomplete', message: 'Could not read Jira details.' },
    ],
  });
  await page.evaluate(
    (value) => window.dispatchEvent(new CustomEvent('jira-sync-snapshot', { detail: value })),
    current,
  );
  await expect(status).toContainText('Jira sync incomplete');
  await expect(status).not.toContainText('Jira checked');
});
