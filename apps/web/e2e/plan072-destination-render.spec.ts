/**
 * Plan 072 — per-route destination render measurement.
 *
 * For each of `/`, `/?tab=sessions`, and `/?tab=breakdown` (plus a
 * filtered/sorted Sessions deep link and a dimensioned/sorted Breakdown
 * deep link), the spec records:
 *
 *   - TTFB (from request timing) and HTML size on the document request,
 *   - first useful render (the destination-specific element is mounted),
 *   - hydration bytes per family and the total,
 *   - the number of business RPCs observed after hydration (detected via
 *     MutationObserver marker in the browser),
 *   - the bytes loaded before vs after the first Drawer open (measured
 *     from Performance API resource entries).
 *
 * Output is written to the file named by AI_USAGE_PLAN072_OUTPUT (falling
 * back to stdout) so a wrapper script can persist it into
 * `docs/performance/artifacts/plan072-destination-render.json`.
 *
 * The spec runs against the production harness with `AI_USAGE_PERF=1` so
 * the `__ai-usage/perf/session-query` endpoint is enabled.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { APIRequestContext, Page, Request, Response } from '@playwright/test';
import { expect, test } from './browser-test';

declare global {
  interface Window {
    __plan072FirstUsefulContentMs?: number | null;
    __plan072HydrationTimestamp?: number | null;
    __plan072LayoutShift?: number;
    __plan072LoadingShellObserved?: boolean;
  }
}

const PERF_PATH = '/__ai-usage/perf/session-query';
const JS_FILE_PATTERN = /\.js$/u;
const CSS_FILE_PATTERN = /\.css$/u;
const SVELTEKIT_APP_PATH_PATTERN = /_app\//u;
const CONTROL_MODE = process.env.AI_USAGE_PLAN072_CONTROL === '1';

interface RouteSample {
  readonly brotliClosureBytes: number;
  readonly businessRpcCountAfterHydration: number;
  readonly businessRpcCountBeforeHydration: number;
  readonly chunkCount: number;
  readonly cssRequestCount: number;
  readonly firstUsableRenderMs: number;
  readonly firstUsefulContentMs: number;
  readonly gzipClosureBytes: number;
  readonly htmlBytes: number;
  readonly hydrationTotalBytes: number;
  readonly jsRequestCount: number;
  readonly layoutShift: number;
  readonly loadingShellObserved: boolean;
  readonly rawClosureBytes: number;
  readonly sqlitePhases: Record<string, { count: number; p50Ms: number; p95Ms: number; totalMs: number }>;
  readonly ttfbMs: number;
  readonly url: string;
}

interface DrawerOpenSample {
  readonly bytesLoadedAfterDrawerOpen: number;
  readonly drawerOpenMs: number;
  readonly newChunkFileNames: readonly string[];
}

interface PerfHydration {
  readonly families: Record<string, { bytes: number; queryCount: number }>;
  readonly totalBytes: number;
}

interface PerfSnapshot {
  readonly hydration: PerfHydration;
  readonly sqlite: { phases: Record<string, { count: number; p50Ms: number; p95Ms: number; totalMs: number }> };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface RouteScenario {
  readonly kind: 'breakdown' | 'overview' | 'sessions';
  readonly label: string;
  readonly readySelector: string;
  readonly url: string;
  readonly usefulSelector: string;
}

const ROUTE_SCENARIOS: readonly RouteScenario[] = [
  {
    kind: 'overview',
    label: 'overview',
    readySelector: 'main[data-hydrated="true"][data-route-shell="report"] [data-report-workspace]',
    url: '/',
    usefulSelector: '[data-report-complete-output]',
  },
  {
    kind: 'sessions',
    label: 'sessions',
    readySelector: '[data-session-surface="desktop"]',
    url: '/?tab=sessions',
    usefulSelector: '[data-session-row-id]',
  },
  {
    kind: 'breakdown',
    label: 'breakdown-models',
    readySelector: '[data-breakdown-panel="models"]',
    url: '/?tab=models',
    usefulSelector: '[data-breakdown-panel="models"] h2',
  },
  {
    kind: 'sessions',
    label: 'sessions-filtered',
    readySelector: '[data-session-surface="desktop"]',
    url: '/?q=codex&sort=%7B%22id%22%3A%22project%22%2C%22desc%22%3Afalse%7D&tab=sessions',
    usefulSelector: '[data-session-row-id]',
  },
  {
    kind: 'breakdown',
    label: 'breakdown-projects-sorted',
    readySelector: '[data-projects-panel]',
    url: '/?breakdownSort=sessions&tab=projects',
    usefulSelector: '[data-projects-panel]',
  },
];

const readPerfSnapshot = async (request: APIRequestContext): Promise<PerfSnapshot> => {
  const response = await request.get(PERF_PATH);
  expect(response.ok()).toBe(true);
  const value: unknown = await response.json();
  if (!(isRecord(value) && isRecord(value.hydration) && isRecord(value.sqlite))) {
    throw new Error('Expected the perf snapshot to expose hydration and sqlite blocks');
  }
  const hydration = value.hydration;
  if (!(isRecord(hydration.families) && typeof hydration.totalBytes === 'number')) {
    throw new Error('Expected the perf snapshot hydration block to expose families and totalBytes');
  }
  const families: Record<string, { bytes: number; queryCount: number }> = {};
  for (const [family, candidate] of Object.entries(hydration.families)) {
    if (!isRecord(candidate)) {
      throw new Error(`Expected perf family ${family} to be a record`);
    }
    if (typeof candidate.bytes !== 'number' || typeof candidate.queryCount !== 'number') {
      throw new Error(`Expected perf family ${family} to expose bytes and queryCount`);
    }
    families[family] = { bytes: candidate.bytes, queryCount: candidate.queryCount };
  }
  if (!isRecord(value.sqlite.phases)) {
    throw new Error('Expected the perf snapshot sqlite block to expose phases');
  }
  const sqlitePhases: Record<string, { count: number; p50Ms: number; p95Ms: number; totalMs: number }> = {};
  for (const [phase, candidate] of Object.entries(value.sqlite.phases)) {
    if (!isRecord(candidate)) {
      throw new Error(`Expected sqlite phase ${phase} to be a record`);
    }
    if (
      typeof candidate.count !== 'number' ||
      typeof candidate.p50Ms !== 'number' ||
      typeof candidate.p95Ms !== 'number' ||
      typeof candidate.totalMs !== 'number'
    ) {
      throw new Error(`Expected sqlite phase ${phase} to expose count, p50Ms, p95Ms, and totalMs`);
    }
    sqlitePhases[phase] = {
      count: candidate.count,
      p50Ms: candidate.p50Ms,
      p95Ms: candidate.p95Ms,
      totalMs: candidate.totalMs,
    };
  }
  return {
    hydration: { families, totalBytes: hydration.totalBytes },
    sqlite: { phases: sqlitePhases },
  };
};

const resetPerfSnapshot = async (request: APIRequestContext): Promise<void> => {
  const response = await request.delete(PERF_PATH);
  expect(response.status()).toBe(204);
};

const installRenderObservers = (usefulSelector: string): void => {
  window.__plan072HydrationTimestamp = null;
  window.__plan072FirstUsefulContentMs = null;
  window.__plan072LayoutShift = 0;
  window.__plan072LoadingShellObserved = false;
  const recordRenderState = (): void => {
    if (document.querySelector('[data-report-pending]')) {
      window.__plan072LoadingShellObserved = true;
    }
    if (window.__plan072FirstUsefulContentMs === null && document.querySelector(usefulSelector)) {
      window.__plan072FirstUsefulContentMs = performance.now();
    }
    if (
      window.__plan072HydrationTimestamp === null &&
      document.querySelector('main[data-route-shell="report"][data-hydrated="true"]')
    ) {
      window.__plan072HydrationTimestamp = performance.timeOrigin + performance.now();
    }
  };
  const renderObserver = new MutationObserver(recordRenderState);
  renderObserver.observe(document, { attributes: true, childList: true, subtree: true });
  const layoutObserver = new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      if ('value' in entry && typeof entry.value === 'number' && !('hadRecentInput' in entry && entry.hadRecentInput)) {
        window.__plan072LayoutShift = (window.__plan072LayoutShift ?? 0) + entry.value;
      }
    }
  });
  layoutObserver.observe({ type: 'layout-shift', buffered: true });
  window.addEventListener('DOMContentLoaded', recordRenderState, { once: true });
};

const readResponseBody = async (
  response: Response,
): Promise<{ body: Buffer; pathname: string; type: 'css' | 'js' } | null> => {
  const url = new URL(response.url());
  let type: 'css' | 'js' | null = null;
  if (JS_FILE_PATTERN.test(url.pathname)) {
    type = 'js';
  } else if (CSS_FILE_PATTERN.test(url.pathname)) {
    type = 'css';
  }
  if (!(type && SVELTEKIT_APP_PATH_PATTERN.test(url.pathname))) {
    return null;
  }
  try {
    return { body: await response.body(), pathname: url.pathname, type };
  } catch {
    return null;
  }
};

const readDrawerJavaScript = async (response: Response): Promise<{ bytes: number; pathname: string } | null> => {
  const resource = await readResponseBody(response);
  return resource?.type === 'js' ? { bytes: resource.body.byteLength, pathname: resource.pathname } : null;
};

const measureRoute = async (page: Page, request: APIRequestContext, scenario: RouteScenario): Promise<RouteSample> => {
  await resetPerfSnapshot(request);
  await page.goto('about:blank');
  await page.addInitScript(installRenderObservers, scenario.usefulSelector);

  const timedRPCs: Array<{ pathname: string; startedAt: number }> = [];
  const resourceBodies: Promise<{ body: Buffer; pathname: string; type: 'css' | 'js' } | null>[] = [];
  const requestHandler = (candidate: Request): void => {
    if (candidate.resourceType() !== 'fetch' && candidate.resourceType() !== 'xhr') {
      return;
    }
    const requestUrl = new URL(candidate.url());
    if (requestUrl.pathname.startsWith('/rpc/')) {
      timedRPCs.push({ pathname: requestUrl.pathname, startedAt: candidate.timing().startTime });
    }
  };
  const responseHandler = (response: Response): void => {
    resourceBodies.push(readResponseBody(response));
  };

  page.on('request', requestHandler);
  page.on('response', responseHandler);
  try {
    const navigation = await page.goto(scenario.url);
    if (!navigation) {
      throw new Error('Expected the plan072 navigation to return a document response');
    }
    await expect(page.locator(scenario.readySelector).first()).toBeVisible();
    await expect(page.locator(scenario.usefulSelector).first()).toBeVisible();
    await expect(page.locator('[data-report-pending]')).toHaveCount(0);
    if (scenario.kind === 'sessions') {
      await expect(page.getByLabel('Filter sessions by title, project, model, provider, or harness')).toBeEnabled();
      await expect(page.locator('[data-session-row-id]').first()).toBeVisible();
    }
    if (scenario.kind === 'breakdown') {
      await expect(page.getByRole('tablist', { name: 'Breakdown dimension' })).toBeVisible();
    }
    const firstUsableRenderMs = await page.evaluate(() => performance.now());
    await page.waitForTimeout(50);

    await expect(page.locator('main[data-hydrated="true"][data-route-shell="report"]')).toBeVisible();
    const htmlBytes = (await navigation.body()).byteLength;
    const ttfbMs = navigation.request().timing().responseStart;

    const browserMetrics = await page.evaluate(() => {
      const hydrationTimestamp = window.__plan072HydrationTimestamp;
      const firstUsefulContentMs = window.__plan072FirstUsefulContentMs;
      return {
        firstUsefulContentMs: typeof firstUsefulContentMs === 'number' ? firstUsefulContentMs : null,
        hydrationTimestamp: typeof hydrationTimestamp === 'number' ? hydrationTimestamp : null,
        layoutShift: window.__plan072LayoutShift ?? 0,
        loadingShellObserved: window.__plan072LoadingShellObserved ?? false,
      };
    });
    if (browserMetrics.hydrationTimestamp === null || browserMetrics.firstUsefulContentMs === null) {
      throw new Error('Expected the browser to record hydration and first useful content');
    }
    const hydrationTimestamp = browserMetrics.hydrationTimestamp;
    const postHydrationRPCs = timedRPCs.filter((rpc) => rpc.startedAt > hydrationTimestamp);
    const preHydrationRPCs = timedRPCs.filter((rpc) => rpc.startedAt <= hydrationTimestamp);
    const loadedResources = (await Promise.all(resourceBodies)).filter(
      (entry): entry is { body: Buffer; pathname: string; type: 'css' | 'js' } => entry !== null,
    );
    const uniqueResources = [...new Map(loadedResources.map((entry) => [entry.pathname, entry])).values()];
    const rawClosureBytes = uniqueResources.reduce((total, entry) => total + entry.body.byteLength, 0);
    const gzipClosureBytes = uniqueResources.reduce(
      (total, entry) => total + gzipSync(entry.body, { level: 9 }).byteLength,
      0,
    );
    const brotliClosureBytes = uniqueResources.reduce(
      (total, entry) => total + brotliCompressSync(entry.body).byteLength,
      0,
    );

    const perfSnapshot = await readPerfSnapshot(request);
    if (scenario.kind === 'sessions') {
      const slicePhase = perfSnapshot.sqlite.phases.slice;
      expect(slicePhase?.count).toBeGreaterThan(0);
    }
    if (!CONTROL_MODE) {
      expect(postHydrationRPCs).toHaveLength(0);
    }

    return {
      businessRpcCountBeforeHydration: preHydrationRPCs.length,
      businessRpcCountAfterHydration: postHydrationRPCs.length,
      brotliClosureBytes,
      chunkCount: uniqueResources.length,
      cssRequestCount: uniqueResources.filter((entry) => entry.type === 'css').length,
      firstUsefulContentMs: Number(browserMetrics.firstUsefulContentMs.toFixed(3)),
      firstUsableRenderMs: Number(firstUsableRenderMs.toFixed(3)),
      gzipClosureBytes,
      htmlBytes,
      hydrationTotalBytes: perfSnapshot.hydration.totalBytes,
      jsRequestCount: uniqueResources.filter((entry) => entry.type === 'js').length,
      layoutShift: Number(browserMetrics.layoutShift.toFixed(6)),
      loadingShellObserved: browserMetrics.loadingShellObserved,
      rawClosureBytes,
      sqlitePhases: perfSnapshot.sqlite.phases,
      ttfbMs: Number(ttfbMs.toFixed(3)),
      url: scenario.url,
    };
  } finally {
    page.off('request', requestHandler);
    page.off('response', responseHandler);
  }
};

const measureDrawerOpen = async (page: Page, request: APIRequestContext): Promise<DrawerOpenSample> => {
  await resetPerfSnapshot(request);
  await page.goto('/?origin=%5B%5D&tab=sessions');
  await expect(page.locator('[data-session-surface="desktop"]')).toBeVisible();

  const preClickJsUrls = new Set(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => new URL(entry.name).pathname)
        .filter((pathname) => pathname.includes('_app/') && pathname.endsWith('.js')),
    ),
  );
  const deferredJsBodies: Promise<{ bytes: number; pathname: string } | null>[] = [];
  const responseCollector = (response: Response): void => {
    const url = new URL(response.url());
    if (JS_FILE_PATTERN.test(url.pathname) && SVELTEKIT_APP_PATH_PATTERN.test(url.pathname)) {
      deferredJsBodies.push(readDrawerJavaScript(response));
    }
  };

  page.on('response', responseCollector);
  try {
    const firstRow = page.locator('[data-index="0"]').first();
    await expect(firstRow).toBeVisible();
    const deferredChunkResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return JS_FILE_PATTERN.test(url.pathname) && SVELTEKIT_APP_PATH_PATTERN.test(url.pathname);
    });
    const drawerOpenStart = performance.now();
    await firstRow.click();
    await deferredChunkResponse;
    await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible();
    const drawerOpenMs = performance.now() - drawerOpenStart;
    const capturedEntries = (await Promise.all(deferredJsBodies)).filter(
      (entry): entry is { bytes: number; pathname: string } => entry !== null && !preClickJsUrls.has(entry.pathname),
    );
    const newEntries = [...new Map(capturedEntries.map((entry) => [entry.pathname, entry])).values()];
    const bytesLoadedAfterDrawerOpen = newEntries.reduce((sum, entry) => sum + entry.bytes, 0);
    const newChunkFileNames = newEntries.map((entry) => entry.pathname).sort();
    expect(newEntries.length).toBeGreaterThan(0);
    expect(bytesLoadedAfterDrawerOpen).toBeGreaterThan(0);

    return {
      bytesLoadedAfterDrawerOpen,
      drawerOpenMs: Number(drawerOpenMs.toFixed(3)),
      newChunkFileNames,
    };
  } finally {
    page.off('response', responseCollector);
  }
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
};

const routeSamples: RouteSample[] = [];
const drawerSamples: DrawerOpenSample[] = [];
const SAMPLE_NUMBERS = [1, 2, 3, 4, 5, 6, 7] as const;

// biome-ignore lint/suspicious/noSkippedTests: this benchmark requires the dedicated production perf server.
test.skip(
  process.env.AI_USAGE_PLAN072_OUTPUT === undefined,
  'Plan 072 destination measurements run only through the dedicated benchmark command',
);
test.describe.configure({ mode: 'serial' });

test('warm-up: navigates the production fixture without recording samples', async ({ page, request }) => {
  for (const scenario of ROUTE_SCENARIOS) {
    await page.goto(scenario.url);
    await expect(page.locator(scenario.readySelector).first()).toBeVisible();
  }
  await page.goto('/?origin=%5B%5D&tab=sessions');
  const firstRow = page.locator('[data-index="0"]').first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();
  await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible();
  await resetPerfSnapshot(request);
});

for (const sampleIndex of SAMPLE_NUMBERS) {
  for (const scenario of ROUTE_SCENARIOS) {
    test(`records route ${scenario.label} sample ${sampleIndex}`, async ({ page, request }) => {
      routeSamples.push(await measureRoute(page, request, scenario));
    });
  }
}

for (const sampleIndex of SAMPLE_NUMBERS) {
  test(`records the first drawer open sample ${sampleIndex}`, async ({ page, request }) => {
    drawerSamples.push(await measureDrawerOpen(page, request));
  });
}

test.afterAll(async ({ request }) => {
  const mediansByRoute = ROUTE_SCENARIOS.map((scenario) => {
    const matching = routeSamples.filter((sample) => sample.url === scenario.url);
    return {
      brotliClosureBytes: median(matching.map((sample) => sample.brotliClosureBytes)),
      chunkCount: median(matching.map((sample) => sample.chunkCount)),
      cssRequestCount: median(matching.map((sample) => sample.cssRequestCount)),
      firstUsefulContentMs: median(matching.map((sample) => sample.firstUsefulContentMs)),
      firstUsableRenderMs: median(matching.map((sample) => sample.firstUsableRenderMs)),
      gzipClosureBytes: median(matching.map((sample) => sample.gzipClosureBytes)),
      htmlBytes: median(matching.map((sample) => sample.htmlBytes)),
      hydrationTotalBytes: median(matching.map((sample) => sample.hydrationTotalBytes)),
      jsRequestCount: median(matching.map((sample) => sample.jsRequestCount)),
      layoutShift: median(matching.map((sample) => sample.layoutShift)),
      rawClosureBytes: median(matching.map((sample) => sample.rawClosureBytes)),
      ttfbMs: median(matching.map((sample) => sample.ttfbMs)),
      url: scenario.url,
    };
  });
  const output = {
    drawer: drawerSamples,
    medians: mediansByRoute,
    samples: routeSamples,
  };
  expect(routeSamples).toHaveLength(ROUTE_SCENARIOS.length * SAMPLE_NUMBERS.length);
  expect(drawerSamples).toHaveLength(SAMPLE_NUMBERS.length);
  const outputFile = process.env.AI_USAGE_PLAN072_OUTPUT;
  if (outputFile) {
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify({ plan072DestinationRender: output })}\n`, 'utf8');
    await resetPerfSnapshot(request);
    return;
  }
  process.stdout.write(`${JSON.stringify({ plan072DestinationRender: output })}\n`);
  await resetPerfSnapshot(request);
});
