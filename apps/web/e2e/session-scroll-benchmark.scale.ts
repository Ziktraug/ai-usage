import type { CDPSession, Page, Response } from '@playwright/test';
import { expect, test } from './browser-test';
import { afterAnimationFrame, type SessionSurfaceMode, sessionSurface } from './session-scroll-driver';
import { SESSION_SCROLL_EXPECTED_COUNT, SESSION_SCROLL_FILTER_QUERY } from './session-scroll-fixture';

interface SessionScrollSample {
  desktopMaximumRenderedItems: number;
  desktopMaximumSessionDomNodes: number;
  filterMs: number;
  heapDeltaBytes: number | null;
  initialMs: number;
  maximumPageBytes: number;
  mobileMaximumRenderedItems: number;
  mobileMaximumSessionDomNodes: number;
  sortMs: number;
}

const LAST_SESSION_INDEX = SESSION_SCROLL_EXPECTED_COUNT - 1;
const SESSION_QUERY_FINGERPRINT_PATTERN = /^session-query-v1:/;
const SERVER_FUNCTION_PATH = '/_serverFn/';
const samples: SessionScrollSample[] = [];

test.describe.configure({ mode: 'serial' });

const readHeapBytes = async (client: CDPSession): Promise<number | null> => {
  try {
    await client.send('HeapProfiler.collectGarbage');
    const { metrics } = await client.send('Performance.getMetrics');
    return metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? null;
  } catch {
    return null;
  }
};

const waitForAllRows = async (
  page: Page,
  surfaceMode: SessionSurfaceMode,
): Promise<{ maximumItems: number; maximumNodes: number }> => {
  const surface = sessionSurface(page, surfaceMode);
  const mobileSentinel = page.locator('[data-session-paging-sentinel="mobile"]');
  let maximumItems = 0;
  let maximumNodes = 0;

  await expect
    .poll(
      async () => {
        if (surfaceMode === 'mobile') {
          await mobileSentinel.evaluate((element) => element.scrollIntoView({ block: 'end' }));
        }
        const snapshot = await surface.evaluate((element) => {
          const renderedItems = Array.from(element.querySelectorAll<HTMLElement>('[data-index]'));
          element.scrollTop = element.scrollHeight;
          return {
            maximumIndex: Math.max(...renderedItems.map((item) => Number(item.dataset.index)), -1),
            renderedItems: renderedItems.length,
            sessionDomNodes: element.querySelectorAll('*').length,
          };
        });
        maximumItems = Math.max(maximumItems, snapshot.renderedItems);
        maximumNodes = Math.max(maximumNodes, snapshot.sessionDomNodes);
        return snapshot.maximumIndex;
      },
      { intervals: [25, 50, 100], timeout: 120_000 },
    )
    .toBe(LAST_SESSION_INDEX);

  return { maximumItems, maximumNodes };
};

const responseBytes = async (response: Response): Promise<number> => {
  try {
    const body = await response.body();
    return body.includes('session-query-v1:') ? body.byteLength : 0;
  } catch {
    return 0;
  }
};

const runSample = async (page: Page): Promise<SessionScrollSample> => {
  const sessionResponseBytes: Promise<number>[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith(SERVER_FUNCTION_PATH)) {
      sessionResponseBytes.push(responseBytes(response));
    }
  });

  await page.setViewportSize({ height: 900, width: 1024 });
  const initialStartedAt = performance.now();
  await page.goto('/?campaigns=off&tab=sessions');
  const report = page.locator('main[data-hydrated="true"]');
  await expect(report).toBeVisible();
  await expect(page.getByText('5,000 / 5,000 sessions', { exact: true })).toBeVisible();
  await expect(report).toHaveAttribute('data-request-fingerprint', SESSION_QUERY_FINGERPRINT_PATTERN);
  const surface = page.locator('[data-session-surface="desktop"]');
  await expect(surface.locator('[data-index="0"]')).toBeVisible();
  await afterAnimationFrame(page);
  const initialMs = performance.now() - initialStartedAt;

  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const heapBefore = await readHeapBytes(client);
  const desktopMaximum = await waitForAllRows(page, 'desktop');
  const heapAfter = await readHeapBytes(client);

  await surface.evaluate((element) => {
    element.scrollTop = 0;
  });
  const firstRow = surface.locator('[data-index="0"]');
  await expect(firstRow).toBeVisible();
  const firstRowId = await firstRow.getAttribute('data-session-row-id');
  const initialFingerprint = await report.getAttribute('data-request-fingerprint');

  const sortStartedAt = performance.now();
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await expect(report).not.toHaveAttribute('data-request-fingerprint', initialFingerprint ?? '');
  await expect(surface.locator('[data-index="0"]')).not.toHaveAttribute('data-session-row-id', firstRowId ?? '');
  await afterAnimationFrame(page);
  const sortMs = performance.now() - sortStartedAt;

  const sortedFingerprint = await report.getAttribute('data-request-fingerprint');
  const filterStartedAt = performance.now();
  await page
    .getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' })
    .fill(SESSION_SCROLL_FILTER_QUERY);
  await expect(page.getByText('1 / 5,000 sessions', { exact: true })).toBeVisible();
  await expect(report).not.toHaveAttribute('data-request-fingerprint', sortedFingerprint ?? '');
  await afterAnimationFrame(page);
  const filterMs = performance.now() - filterStartedAt;

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/?campaigns=off&tab=sessions');
  await expect(page.getByText('5,000 / 5,000 sessions', { exact: true })).toBeVisible();
  const mobileMaximum = await waitForAllRows(page, 'mobile');

  const measuredPageBytes = await Promise.all(sessionResponseBytes);
  await client.detach();
  return {
    desktopMaximumRenderedItems: desktopMaximum.maximumItems,
    desktopMaximumSessionDomNodes: desktopMaximum.maximumNodes,
    filterMs: Number(filterMs.toFixed(3)),
    heapDeltaBytes: heapBefore === null || heapAfter === null ? null : Math.max(0, heapAfter - heapBefore),
    initialMs: Number(initialMs.toFixed(3)),
    maximumPageBytes: Math.max(...measuredPageBytes, 0),
    mobileMaximumRenderedItems: mobileMaximum.maximumItems,
    mobileMaximumSessionDomNodes: mobileMaximum.maximumNodes,
    sortMs: Number(sortMs.toFixed(3)),
  };
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

test('warms the production fixture without recording a sample', async ({ page }) => {
  await runSample(page);
});

for (let sampleIndex = 1; sampleIndex <= 3; sampleIndex += 1) {
  test(`records production sample ${sampleIndex}`, async ({ page }) => {
    samples.push(await runSample(page));
  });
}

test.afterAll(() => {
  const supportedHeapDeltas = samples.flatMap((sample) =>
    sample.heapDeltaBytes === null ? [] : [sample.heapDeltaBytes],
  );
  const output = {
    fixture: { campaigns: false, sessions: SESSION_SCROLL_EXPECTED_COUNT },
    medians: {
      desktopMaximumRenderedItems: median(samples.map((sample) => sample.desktopMaximumRenderedItems)),
      desktopMaximumSessionDomNodes: median(samples.map((sample) => sample.desktopMaximumSessionDomNodes)),
      filterMs: median(samples.map((sample) => sample.filterMs)),
      heapDeltaBytes: supportedHeapDeltas.length > 0 ? median(supportedHeapDeltas) : null,
      initialMs: median(samples.map((sample) => sample.initialMs)),
      maximumPageBytes: median(samples.map((sample) => sample.maximumPageBytes)),
      mobileMaximumRenderedItems: median(samples.map((sample) => sample.mobileMaximumRenderedItems)),
      mobileMaximumSessionDomNodes: median(samples.map((sample) => sample.mobileMaximumSessionDomNodes)),
      sortMs: median(samples.map((sample) => sample.sortMs)),
    },
    samples,
  };
  process.stdout.write(`${JSON.stringify({ sessionScrollBenchmark: output })}\n`);
});
