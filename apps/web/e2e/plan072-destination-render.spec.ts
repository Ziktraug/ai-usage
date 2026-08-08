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
import type { APIRequestContext, Page, Request, Response } from '@playwright/test';
import { expect, test } from './browser-test';

declare global {
  interface Window {
    __plan072HydrationTimestamp?: number | null;
  }
}

const PERF_PATH = '/__ai-usage/perf/session-query';
const SESSION_PAGE_RPC_PATH = '/rpc/session/page';
const REPORT_BOOTSTRAP_PATH = '/rpc/report/revisionBootstrap';
const JS_FILE_PATTERN = /\.js$/u;
const SVELTEKIT_APP_PATH_PATTERN = /_app\//u;

interface RouteSample {
  readonly businessRpcCountAfterHydration: number;
  readonly firstUsableRenderMs: number;
  readonly htmlBytes: number;
  readonly hydrationTotalBytes: number;
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

const ROUTES = [
  '/',
  '/?tab=sessions',
  '/?tab=breakdown',
  '/?filters=%7B%22query%22%3A%22codex%22%7D&sort=%5B%7B%22id%22%3A%22date%22%2C%22desc%22%3Atrue%7D%5D&tab=sessions',
  '/?sort=%5B%7B%22id%22%3A%22cost%22%2C%22desc%22%3Atrue%7D%5D&tab=models',
] as const;

const BASELINE_ROUTES = new Set(['/', '/?tab=sessions', '/?tab=breakdown']);

const DESTINATION_READY_SELECTOR: Readonly<Record<string, string>> = {
  '/': 'main[data-hydrated="true"][data-route-shell="report"] [data-report-workspace]',
  '/?tab=sessions': '[data-session-surface="desktop"]',
  // `breakdown` is not a canonical Dashboard tab today; keep measuring the
  // literal requested URL, which resolves to the report fallback.
  '/?tab=breakdown': '[data-report-complete-output]',
  '/?tab=models': '[data-breakdown-panel="models"]',
};

const getReadySelector = (route: string): string | null => {
  const exact = DESTINATION_READY_SELECTOR[route];
  if (exact) {
    return exact;
  }
  const parsed = new URL(`http://localhost${route}`);
  const tab = parsed.searchParams.get('tab');
  return tab ? (DESTINATION_READY_SELECTOR[`/?tab=${tab}`] ?? null) : null;
};

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

const HYDRATION_INIT_SCRIPT = /* javascript */ `
window.__plan072HydrationTimestamp = null;
var hydrationObserver;
function recordPlan072Hydration() {
  if (
    window.__plan072HydrationTimestamp === null &&
    document.querySelector('main[data-route-shell="report"][data-hydrated="true"]')
  ) {
    window.__plan072HydrationTimestamp = performance.timeOrigin + performance.now();
    if (hydrationObserver) {
      hydrationObserver.disconnect();
    }
  }
}
hydrationObserver = new MutationObserver(recordPlan072Hydration);
hydrationObserver.observe(document, { attributes: true, childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', recordPlan072Hydration, { once: true });
`;

const measureRoute = async (page: Page, request: APIRequestContext, route: string): Promise<RouteSample> => {
  await resetPerfSnapshot(request);
  await page.goto('about:blank');

  await page.addInitScript(HYDRATION_INIT_SCRIPT);

  const timedRPCs: Array<{ pathname: string; startedAt: number }> = [];
  const requestHandler = (candidate: Request): void => {
    if (candidate.resourceType() !== 'fetch' && candidate.resourceType() !== 'xhr') {
      return;
    }
    const requestUrl = new URL(candidate.url());
    if (requestUrl.pathname === SESSION_PAGE_RPC_PATH || requestUrl.pathname === REPORT_BOOTSTRAP_PATH) {
      timedRPCs.push({ pathname: requestUrl.pathname, startedAt: candidate.timing().startTime });
    }
  };

  page.on('request', requestHandler);
  try {
    const usableStart = performance.now();
    const navigation = await page.goto(route);
    if (!navigation) {
      throw new Error('Expected the plan072 navigation to return a document response');
    }
    const readySelector = getReadySelector(route);
    if (!readySelector) {
      throw new Error(`No ready selector is registered for ${route}`);
    }
    await expect(page.locator(readySelector).first()).toBeVisible();
    const firstUsableRenderMs = performance.now() - usableStart;

    await expect(page.locator('main[data-hydrated="true"][data-route-shell="report"]')).toBeVisible();
    const htmlBytes = (await navigation.body()).byteLength;
    const ttfbMs = navigation.request().timing().responseStart;

    const hydrationTimestamp = await page.evaluate(() => {
      const ts = window.__plan072HydrationTimestamp;
      return typeof ts === 'number' ? ts : null;
    });
    if (hydrationTimestamp === null) {
      throw new Error('Expected the browser to record its hydration timestamp');
    }
    const postHydrationRPCs = timedRPCs.filter((rpc) => rpc.startedAt > hydrationTimestamp);

    const perfSnapshot = await readPerfSnapshot(request);
    const isSessionsRoute = route.includes('tab=sessions');
    if (isSessionsRoute) {
      const slicePhase = perfSnapshot.sqlite.phases.slice;
      expect(slicePhase?.count).toBeGreaterThan(0);
    }
    if (BASELINE_ROUTES.has(route)) {
      expect(postHydrationRPCs).toHaveLength(0);
    }

    return {
      businessRpcCountAfterHydration: postHydrationRPCs.length,
      firstUsableRenderMs: Number(firstUsableRenderMs.toFixed(3)),
      htmlBytes,
      hydrationTotalBytes: perfSnapshot.hydration.totalBytes,
      sqlitePhases: perfSnapshot.sqlite.phases,
      ttfbMs: Number(ttfbMs.toFixed(3)),
      url: route,
    };
  } finally {
    page.off('request', requestHandler);
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
      deferredJsBodies.push(
        response
          .body()
          .then((body) => ({ bytes: body.byteLength, pathname: url.pathname }))
          .catch(() => null),
      );
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

test.describe.configure({ mode: 'serial' });

test('warm-up: navigates the production fixture without recording samples', async ({ page, request }) => {
  for (const route of ROUTES) {
    await page.goto(route);
    const readySelector = getReadySelector(route);
    if (!readySelector) {
      throw new Error(`No ready selector is registered for ${route}`);
    }
    await expect(page.locator(readySelector).first()).toBeVisible();
  }
  await page.goto('/?origin=%5B%5D&tab=sessions');
  const firstRow = page.locator('[data-index="0"]').first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();
  await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible();
  await resetPerfSnapshot(request);
});

for (let sampleIndex = 1; sampleIndex <= 3; sampleIndex += 1) {
  for (const route of ROUTES) {
    test(`records route ${route} sample ${sampleIndex}`, async ({ page, request }) => {
      routeSamples.push(await measureRoute(page, request, route));
    });
  }
}

for (let sampleIndex = 1; sampleIndex <= 3; sampleIndex += 1) {
  test(`records the first drawer open sample ${sampleIndex}`, async ({ page, request }) => {
    drawerSamples.push(await measureDrawerOpen(page, request));
  });
}

test.afterAll(async ({ request }) => {
  const routeEntries = routeSamples.map((sample) => ({
    businessRpcCountAfterHydration: sample.businessRpcCountAfterHydration,
    firstUsableRenderMs: sample.firstUsableRenderMs,
    htmlBytes: sample.htmlBytes,
    hydrationTotalBytes: sample.hydrationTotalBytes,
    sqlitePhases: sample.sqlitePhases,
    ttfbMs: sample.ttfbMs,
    url: sample.url,
  }));
  const mediansByRoute = ROUTES.map((route) => {
    const matching = routeSamples.filter((sample) => sample.url === route);
    return {
      firstUsableRenderMs: median(matching.map((sample) => sample.firstUsableRenderMs)),
      htmlBytes: median(matching.map((sample) => sample.htmlBytes)),
      hydrationTotalBytes: median(matching.map((sample) => sample.hydrationTotalBytes)),
      ttfbMs: median(matching.map((sample) => sample.ttfbMs)),
      url: route,
    };
  });
  const output = {
    drawer: drawerSamples,
    medians: mediansByRoute,
    samples: routeEntries,
  };
  expect(routeSamples).toHaveLength(ROUTES.length * 3);
  expect(drawerSamples).toHaveLength(3);
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
