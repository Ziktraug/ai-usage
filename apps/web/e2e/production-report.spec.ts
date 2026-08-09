import {
  HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL,
  HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL,
  HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
} from '@ai-usage/local-machine/testing/harness-home';
import type { Request } from '@playwright/test';
import { expect, reportViewsFor, test } from './browser-test';
import { capturePlan073Smoke } from './plan073-smoke';
import { encodeRpcResponseBody, isRpcPathname, RPC_ROUTE_GLOB, rpcStringFieldValues } from './rpc-test-transport';
import { createServerStateNetworkTrace } from './server-state-network';

const NON_EMPTY_ATTRIBUTE_PATTERN = /.+/;
const SESSION_QUERY_FINGERPRINT_PATTERN = /^session-query-v1:[0-9a-f]{16}$/;
const SESSION_NEIGHBOR_FINGERPRINT_PATTERN = /^session-neighbor-v1:[0-9a-f]{16}$/;
const FOCUSED_OVERVIEW_FINGERPRINT_PREFIX = 'focused-overview-v1:';
const PROJECT_COLUMN_PATTERN = /Project/;
const SOURCES_URL_PATTERN = /\/sources$/;
const SESSION_PAGE_PATH = '/rpc/session/page';
const EXPECTED_ENABLED_SOURCE_COUNT = 7;
const INITIAL_HTML_SECRET_SENTINELS = [
  HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
  HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL,
  HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL,
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
] as const;

interface CapturedRpcResponse {
  body: Promise<string>;
  status: number;
}

interface ProtocolIdentity {
  fingerprints: string[];
  revisions: string[];
}

interface ObservedRequest {
  readonly pathname: string;
  readonly resourceType: string;
  readonly startedAtEpochMs: number;
  readonly url: string;
}

const REPORT_BOOTSTRAP_PATH = '/rpc/report/revisionBootstrap';

const writeCharacterization = (scenario: string, value: unknown): void => {
  process.stdout.write(`${JSON.stringify({ scenario, type: 'plan-069-gate-0', value })}\n`);
};

const countOccurrences = (value: string, needle: string): number => value.split(needle).length - 1;

const sortedCountRecord = (values: readonly string[]): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
};

const protocolIdentityFrom = (body: string): ProtocolIdentity => ({
  fingerprints: rpcStringFieldValues(body, 'requestFingerprint'),
  revisions: rpcStringFieldValues(body, 'revision'),
});

const expectExactProtocolIdentity = (
  body: string,
  revision: string,
  fingerprintPattern: RegExp,
  expectedFingerprint?: string,
): void => {
  const identity = protocolIdentityFrom(body);
  expect(identity.fingerprints.length).toBeGreaterThan(0);
  expect(identity.revisions.length).toBeGreaterThan(0);
  expect(new Set(identity.revisions)).toEqual(new Set([revision]));
  for (const fingerprint of identity.fingerprints) {
    expect(fingerprint).toMatch(fingerprintPattern);
    if (expectedFingerprint !== undefined) {
      expect(fingerprint).toBe(expectedFingerprint);
    }
  }
};

test('renders the report timeline on the initial production Overview', async ({ page }) => {
  const serverStateTrace = createServerStateNetworkTrace(page);
  const observedRequests: ObservedRequest[] = [];
  const pendingServerQueries = new Set<Request>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    observedRequests.push({
      pathname: url.pathname,
      resourceType: request.resourceType(),
      startedAtEpochMs: request.timing().startTime,
      url: `${url.pathname}${url.search}`,
    });
    if (isRpcPathname(url.pathname) && request.resourceType() !== 'eventsource') {
      pendingServerQueries.add(request);
    }
  });
  const settleServerQuery = (request: Request): void => {
    if (isRpcPathname(new URL(request.url()).pathname) && request.resourceType() !== 'eventsource') {
      pendingServerQueries.delete(request);
    }
  };
  page.on('requestfinished', settleServerQuery);
  page.on('requestfailed', settleServerQuery);

  const initialResponse = await page.request.get('/');
  const initialHtml = await initialResponse.text();
  expect(initialResponse.ok()).toBe(true);
  expect(initialHtml).toContain('Usage report');
  expect(initialHtml).not.toContain('Loading report data');
  expect(initialHtml).toContain('focused-overview-v1:');
  // Useful bounded report/query data belongs in SSR. Only explicit secret-bearing
  // fixture values are forbidden from the serialized initial HTML.
  for (const secretSentinel of INITIAL_HTML_SECRET_SENTINELS) {
    expect(initialHtml).not.toContain(secretSentinel);
  }

  await page.addInitScript(() => {
    Reflect.set(globalThis, '__aiUsageFalseEmptyRange', false);
    let hydrationObserver: MutationObserver | undefined;
    const recordHydration = () => {
      if (
        Reflect.get(globalThis, '__aiUsageHydratedAtEpochMs') === undefined &&
        document.querySelector('main[data-hydrated="true"]')
      ) {
        Reflect.set(globalThis, '__aiUsageHydratedAtEpochMs', performance.timeOrigin + performance.now());
        hydrationObserver?.disconnect();
      }
    };
    const recordFalseEmptyRange = () => {
      if (document.body?.textContent?.includes('No dated sessions match the current filters')) {
        Reflect.set(globalThis, '__aiUsageFalseEmptyRange', true);
      }
    };
    new MutationObserver(recordFalseEmptyRange).observe(document, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    hydrationObserver = new MutationObserver(recordHydration);
    hydrationObserver.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        recordFalseEmptyRange();
        recordHydration();
      },
      { once: true },
    );
  });
  const overviewGate = Promise.withResolvers<void>();
  let rpcRequestCount = 0;
  await page.route(RPC_ROUTE_GLOB, async (route) => {
    rpcRequestCount++;
    // A cold source-control bootstrap may return one pending manifest before
    // report-published prompts the exact-revision owner to retry.
    if (rpcRequestCount <= 3) {
      await route.continue();
      return;
    }
    await overviewGate.promise;
    await route.continue();
  });
  const navigationStartedAt = performance.now();
  const navigationResponse = await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const navigationToHydratedMs = performance.now() - navigationStartedAt;
  const dateRange = page.getByRole('region', { name: 'Report period' });
  const activity = page.getByRole('region', { name: 'Activity' });
  try {
    await expect(dateRange).toContainText('Jun 3 → Jul 03, 2026');
    await expect(dateRange).toContainText('Jul 03, 2026');
    await expect(dateRange.getByText('Loading report range…', { exact: true })).toHaveCount(0);
  } finally {
    overviewGate.resolve();
  }
  await expect(
    activity.getByRole('button', { name: 'Inspect activity timeline. Use arrow keys to inspect days.' }),
  ).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('No dated sessions match the current filters')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, '__aiUsageFalseEmptyRange'))).toBe(false);
  await expect.poll(() => pendingServerQueries.size).toBe(0);

  if (!navigationResponse) {
    throw new Error('Initial production navigation did not return a document response.');
  }
  const documentTiming = navigationResponse.request().timing();
  const hydratedAtEpochMs = await page.evaluate(() => Reflect.get(globalThis, '__aiUsageHydratedAtEpochMs'));
  if (typeof hydratedAtEpochMs !== 'number') {
    throw new Error('Initial production navigation did not expose its hydration timestamp.');
  }
  const requestUrls = observedRequests.map(({ url }) => url);
  const duplicateUrls = Object.entries(sortedCountRecord(requestUrls))
    .filter(([, count]) => count > 1)
    .map(([url, count]) => ({ count, url }));
  const bootstrapRequestsAfterHydration = observedRequests
    .filter(
      ({ pathname, startedAtEpochMs }) => pathname === REPORT_BOOTSTRAP_PATH && startedAtEpochMs >= hydratedAtEpochMs,
    )
    .map(({ url }) => url)
    .sort();
  // One dehydrated Query entry serializes the identity once in queryKey and once in queryHash.
  const dehydratedBootstrapKeyOccurrenceCount = countOccurrences(initialHtml, 'report-bootstrap');
  const pendingNonSseServerQueries = [...pendingServerQueries].map((request) => request.url()).sort();

  expect(documentTiming.responseStart).toBeGreaterThanOrEqual(0);
  expect(documentTiming.responseEnd).toBeGreaterThanOrEqual(documentTiming.responseStart);
  expect(bootstrapRequestsAfterHydration).toEqual([]);
  expect(dehydratedBootstrapKeyOccurrenceCount).toBe(2);
  expect(pendingNonSseServerQueries).toEqual([]);
  process.stdout.write(
    `${JSON.stringify({
      bootstrapRequestsAfterHydration,
      dehydratedBootstrapKeyOccurrenceCount,
      documentCompletionMs: documentTiming.responseEnd,
      documentTtfbMs: documentTiming.responseStart,
      duplicateUrls,
      navigationToHydratedMs,
      pendingNonSseServerQueries,
      requestClasses: sortedCountRecord(observedRequests.map(({ resourceType }) => resourceType)),
      ssrHtmlBytes: new TextEncoder().encode(initialHtml).byteLength,
      totalRequestCount: observedRequests.length,
      type: 'production-overview-ssr-hydration',
      serverStateCounts: serverStateTrace.counts(),
    })}\n`,
  );
  serverStateTrace.dispose();
});

test('reuses the current revision bootstrap across Sessions filter and sort without route-load duplicates', async ({
  page,
}) => {
  const trace = createServerStateNetworkTrace(page);
  const browserBootstrapRequests: string[] = [];
  const routeDataRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === REPORT_BOOTSTRAP_PATH) {
      browserBootstrapRequests.push(`${url.pathname}${url.search}`);
    } else if (url.pathname.endsWith('/__data.json')) {
      routeDataRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto('/?tab=sessions');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.locator('[data-session-surface="desktop"]')).toBeVisible();
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  trace.checkpoint('session-actions');
  browserBootstrapRequests.length = 0;
  routeDataRequests.length = 0;

  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  const filteredSessionsResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === SESSION_PAGE_PATH,
  );
  await search.fill('codex');
  await filteredSessionsResponse;
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('codex');
  await expect.poll(() => browserBootstrapRequests.length).toBe(0);
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  await expect.poll(() => trace.counts('session-actions').operations['session.page'] ?? 0).toBe(1);
  expect(browserBootstrapRequests).toHaveLength(0);

  const sortedSessionsResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === SESSION_PAGE_PATH,
  );
  await page.getByRole('columnheader', { name: PROJECT_COLUMN_PATTERN }).getByRole('button').click();
  await sortedSessionsResponse;
  await expect.poll(() => new URL(page.url()).searchParams.get('sort') ?? '').toContain('project');
  await expect.poll(() => browserBootstrapRequests.length).toBe(0);
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  await expect.poll(() => trace.counts('session-actions').operations['session.page'] ?? 0).toBe(2);
  expect(browserBootstrapRequests).toHaveLength(0);
  expect(routeDataRequests).toEqual([]);
  const counts = trace.counts('session-actions');
  expect(counts.operations).toEqual({ 'report.focusedOverview': 1, 'session.page': 2 });
  expect(counts.routeData).toBe(0);
  writeCharacterization('sessions-filter-sort', counts);
  trace.dispose();
});

test('records destination request counts and report DOM identity', async ({ page }) => {
  const trace = createServerStateNetworkTrace(page);
  await page.goto('/');
  const workspace = page.locator('[data-report-workspace]');
  const graph = page.locator('[data-report-range-part="chart"]');
  await expect(workspace).toBeVisible();
  await expect(graph).toBeVisible();
  await workspace.evaluate((element) => element.setAttribute('data-plan-069-workspace', 'baseline'));
  await graph.evaluate((element) => element.setAttribute('data-plan-069-graph', 'baseline'));
  trace.checkpoint('destination-navigation');

  const views = reportViewsFor(page);
  await views.getByRole('link', { exact: true, name: 'Analysis' }).click();
  await expect(page.getByRole('heading', { exact: true, name: 'Models' })).toBeVisible();
  await views.getByRole('link', { exact: true, name: 'Sessions' }).click();
  await expect(page.locator('[data-session-surface="desktop"]')).toBeVisible();
  await views.getByRole('link', { exact: true, name: 'Overview' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Advanced analysis' })).toBeVisible();

  await expect(workspace).toHaveAttribute('data-plan-069-workspace', 'baseline');
  const graphIdentity = await page.locator('[data-report-range-part="chart"]').getAttribute('data-plan-069-graph');
  const counts = trace.counts('destination-navigation');
  expect(counts.operations).toEqual({
    'report.focusedBreakdown': 1,
    'report.focusedOverview': 1,
    'session.page': 1,
  });
  expect(counts.routeData).toBe(0);
  writeCharacterization('overview-breakdown-sessions-overview', {
    counts,
    graphRetainedAcrossDestinations: graphIdentity === 'baseline',
    workspaceRetainedAcrossDestinations: true,
  });
  trace.dispose();
});

test('records filter range sort and history request counts without route data', async ({ page }) => {
  const trace = createServerStateNetworkTrace(page);
  await page.goto('/?tab=sessions');
  const workspace = page.locator('[data-report-workspace]');
  await expect(page.locator('[data-session-surface="desktop"]')).toBeVisible();
  await workspace.evaluate((element) => element.setAttribute('data-plan-069-workspace', 'history'));
  trace.checkpoint('filter-range-sort-history');

  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  const filteredSessionsResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === SESSION_PAGE_PATH,
  );
  await search.fill('codex');
  await filteredSessionsResponse;
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('codex');
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  const sortedSessionsResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === SESSION_PAGE_PATH,
  );
  await page.getByRole('columnheader', { name: PROJECT_COLUMN_PATTERN }).getByRole('button').click();
  await sortedSessionsResponse;
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).not.toBeNull();
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  const rangedSessionsResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === SESSION_PAGE_PATH,
  );
  await page.getByRole('region', { name: 'Report period' }).getByRole('button', { exact: true, name: '7d' }).click();
  await rangedSessionsResponse;
  await expect.poll(() => new URL(page.url()).searchParams.get('range')).not.toBeNull();
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  const rangedUrl = page.url();

  await page.goBack();
  await expect(page).not.toHaveURL(rangedUrl);
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(rangedUrl);
  await expect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);

  await expect(workspace).toHaveAttribute('data-plan-069-workspace', 'history');
  const counts = trace.counts('filter-range-sort-history');
  // Filter, sort, and range have distinct semantic query identities. History reuses those
  // completed entries without adding route data or another Sessions request.
  expect(counts.operations).toEqual({ 'report.focusedOverview': 2, 'session.page': 3 });
  expect(counts.routeData).toBe(0);
  writeCharacterization('filter-range-sort-back-forward', {
    counts,
    workspaceRetainedAcrossHistory: true,
  });
  trace.dispose();
});

test('records one exact expiry and one failed background refresh while retaining the complete report', async ({
  page,
}) => {
  const trace = createServerStateNetworkTrace(page);
  await page.goto('/');
  const workspace = page.locator('[data-report-workspace]');
  const completeOutput = page.locator('[data-report-complete-output]');
  await expect(completeOutput).toBeVisible();
  await workspace.evaluate((element) => element.setAttribute('data-plan-069-workspace', 'last-good'));

  let interceptedOutcome: 'QueryFailed' | 'RevisionExpired' = 'RevisionExpired';
  let interceptedCount = 0;
  await page.route('**/rpc/report/focusedOverview', async (route) => {
    interceptedCount += 1;
    if (interceptedCount > 2) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const identity = protocolIdentityFrom(await response.text());
    const revision = identity.revisions[0];
    const requestFingerprint = identity.fingerprints[0];
    if (!(revision && requestFingerprint)) {
      throw new Error('The intercepted focused Overview response did not expose exact identity.');
    }
    await route.fulfill({
      body: encodeRpcResponseBody({
        error: { message: `Characterized ${interceptedOutcome}`, revision, tag: interceptedOutcome },
        ok: false,
        requestFingerprint,
        revision,
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  trace.checkpoint('expiry');
  await page.getByRole('region', { name: 'Report period' }).getByRole('button', { exact: true, name: '7d' }).click();
  await expect(page.locator('[data-report-refresh-error]')).toBeVisible();
  await expect(completeOutput).toBeVisible();
  await expect(workspace).toHaveAttribute('data-plan-069-workspace', 'last-good');
  const expiryCounts = trace.counts('expiry');
  expect(expiryCounts.operations).toEqual({ 'report.focusedOverview': 1, 'report.revisionBootstrap': 1 });
  writeCharacterization('exact-revision-expiry', expiryCounts);

  interceptedOutcome = 'QueryFailed';
  trace.checkpoint('background-failure');
  const chartOptions = page.getByRole('region', { name: 'Activity' }).locator('details[aria-label="Explore activity"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Model' }).click();
  await expect(page.locator('[data-report-refresh-error]')).toBeVisible();
  await expect(completeOutput).toBeVisible();
  await expect(workspace).toHaveAttribute('data-plan-069-workspace', 'last-good');
  const failureCounts = trace.counts('background-failure');
  expect(failureCounts.operations).toEqual({ 'report.focusedOverview': 1 });
  writeCharacterization('failed-background-refresh', failureCounts);
  trace.dispose();
});

test('provides one accessible responsive source-control surface', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();

  const sourceSummary = page.getByRole('region', { name: 'Collection source status' }).locator('a[href="/sources"]');
  await expect(sourceSummary).toBeVisible();
  await sourceSummary.focus();
  await expect(page.getByText('Collection sources', { exact: true })).toBeVisible();
  await sourceSummary.press('Enter');

  await expect(page).toHaveURL(SOURCES_URL_PATTERN);
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Sessions' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Provider usage' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Enrichments' })).toBeVisible();
  const healthySources = page.locator('[data-healthy-source-summary]');
  await expect(healthySources).toHaveJSProperty('open', false);
  await healthySources.locator('summary').click();
  await expect(healthySources).toHaveJSProperty('open', true);
  await expect(page.getByRole('checkbox', { name: 'Enabled' })).toHaveCount(EXPECTED_ENABLED_SOURCE_COUNT);
  await expect(page.getByText('codex.sessions', { exact: true })).toBeVisible();

  const detectAll = page.getByRole('button', { name: 'Detect all' });
  await expect(detectAll).toBeEnabled();
  await detectAll.focus();
  await expect(detectAll).toBeFocused();
});

test('keeps the Report range mounted while focused chart options refresh', async ({ page }) => {
  await page.goto('/');
  const dateRange = page.getByRole('region', { name: 'Report period' });
  const activity = page.getByRole('region', { name: 'Activity' });
  const timeline = activity.getByRole('button', {
    name: 'Inspect activity timeline. Use arrow keys to inspect days.',
  });
  await expect(timeline).toBeVisible({ timeout: 5000 });
  const advancedAnalysis = page.getByRole('region', { name: 'Advanced analysis' });
  await expect(advancedAnalysis.getByRole('heading', { level: 3, name: 'Punchcard' })).toBeVisible();
  await dateRange.evaluate((element) => element.setAttribute('data-stability-marker', 'original-range'));
  await timeline.evaluate((element) => element.setAttribute('data-stability-marker', 'original-chart'));
  await page.route(RPC_ROUTE_GLOB, async (route) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    await route.continue();
  });
  const chartOptions = activity.locator('details[aria-label="Explore activity"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Model' }).click();
  await expect(dateRange).toHaveAttribute('data-stability-marker', 'original-range', { timeout: 1000 });
  await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
  await expect(dateRange).toHaveAttribute('data-stability-marker', 'original-range');
  await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
  await expect(advancedAnalysis.getByRole('heading', { level: 3, name: 'Punchcard' })).toBeVisible();
});

test('keeps the last complete report visible while the report range changes', async ({ page }) => {
  await page.goto('/');
  const dateRange = page.getByRole('region', { name: 'Report period' });
  const timeline = page.getByRole('region', { name: 'Activity' }).getByRole('button', {
    name: 'Inspect activity timeline. Use arrow keys to inspect days.',
  });
  await expect(timeline).toBeVisible({ timeout: 5000 });
  await dateRange.evaluate((element) => element.setAttribute('data-stability-marker', 'original-range'));
  await timeline.evaluate((element) => element.setAttribute('data-stability-marker', 'original-chart'));

  const overviewGate = Promise.withResolvers<void>();
  await page.route(RPC_ROUTE_GLOB, async (route) => {
    await overviewGate.promise;
    await route.continue();
  });

  try {
    await dateRange.getByRole('button', { exact: true, name: '7d' }).click();
    await expect(dateRange).toHaveAttribute('data-stability-marker', 'original-range');
    await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
    await expect(dateRange.getByText('Loading report range…', { exact: true })).toHaveCount(0);
    await expect(dateRange.getByText('No dated sessions match the current filters', { exact: true })).toHaveCount(0);
  } finally {
    overviewGate.resolve();
  }

  await expect(dateRange.getByRole('button', { exact: true, name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dateRange).toContainText('Jun 26 → Jul 03, 2026 · 7 days');
  await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
});

test('hydrates and automatically pages Sessions through the production revision protocol', async ({ page }) => {
  const rpcResponses: CapturedRpcResponse[] = [];
  page.on('response', (response) => {
    if (isRpcPathname(new URL(response.url()).pathname)) {
      rpcResponses.push({
        body: response.text().catch(() => ''),
        status: response.status(),
      });
    }
  });
  const overviewResponseCount = async (): Promise<number> =>
    (await Promise.all(rpcResponses.map(({ body }) => body))).filter((body) =>
      body.includes(FOCUSED_OVERVIEW_FINGERPRINT_PREFIX),
    ).length;

  const initialDocumentResponse = await page.request.get('/?tab=sessions');
  const initialDocumentHtml = await initialDocumentResponse.text();
  expect(initialDocumentResponse.ok()).toBe(true);
  expect(initialDocumentHtml).not.toContain(HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL);
  expect(initialDocumentHtml).not.toContain(HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL);
  expect(initialDocumentHtml).not.toContain(HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL);
  expect(initialDocumentHtml).not.toContain(HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL);

  await page.goto('/?tab=sessions');
  const report = page.locator('main[data-hydrated="true"]');
  await expect(report).toBeVisible();
  const completedSessionCount = page.getByText('207 / 207 sessions', { exact: true });
  const queryFailure = page.getByText('The report query could not be completed.', { exact: true });
  await expect(completedSessionCount.or(queryFailure)).toBeVisible();
  expect(await queryFailure.count()).toBe(0);
  await expect(report).toHaveAttribute('data-report-revision', NON_EMPTY_ATTRIBUTE_PATTERN);
  await expect(report).toHaveAttribute('data-request-fingerprint', SESSION_QUERY_FINGERPRINT_PATTERN);
  const revision = await report.getAttribute('data-report-revision');
  const requestFingerprint = await report.getAttribute('data-request-fingerprint');
  if (!(revision && requestFingerprint)) {
    throw new Error('Production Sessions diagnostics must expose a revision and request fingerprint');
  }

  const sessionViewport = page.locator('[data-session-surface="desktop"]');
  await expect
    .poll(async () => {
      await sessionViewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return await page
        .locator('tr[data-index]')
        .evaluateAll((rows) => Math.max(...rows.map((row) => Number(row.getAttribute('data-index')))));
    })
    .toBe(204);
  await expect(page.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0);

  const rootSessionRow = page.locator('tr[data-index]').filter({ hasText: 'Implement fixture root' });
  await expect(rootSessionRow).toHaveCount(1);
  await rootSessionRow.click({ force: true });
  const rootDrawer = page.getByRole('dialog');
  await expect(rootDrawer).toBeVisible();
  const codexSourceControl = rootDrawer.getByRole('region', { name: 'Session source control' });
  await expect(
    codexSourceControl.getByRole('link', { name: 'Open repository fixture/ai-usage in a new tab' }),
  ).toBeVisible();
  await expect(codexSourceControl).toContainText('fixture/main');
  await expect(codexSourceControl).toContainText('01234567');
  await codexSourceControl.getByRole('button', { name: 'Resolve GitHub repository and pull request links' }).click();
  await expect(codexSourceControl.getByRole('link', { name: 'Open #42 in a new tab' })).toBeVisible();
  await rootDrawer.getByRole('button', { name: 'Analyze root session chronology' }).click();
  const sessionAnalysis = rootDrawer.getByRole('region', { name: 'Session analysis' });
  await expect(sessionAnalysis.getByRole('heading', { level: 2, name: 'Session analysis' })).toBeVisible();
  await expect(rootDrawer.locator('[aria-label="Token anatomy"]')).toBeVisible();
  const timelineSection = sessionAnalysis.locator('section[aria-labelledby="session-timeline"]');
  await expect(timelineSection).toContainText(HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL);
  await expect(sessionAnalysis.getByText(HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL, { exact: true })).toHaveCount(1);
  const consistencyMetadata = sessionAnalysis.locator('[data-session-analysis-item="consistency-meta"]');
  await expect(consistencyMetadata).toHaveText('Local detail · comparable metrics match this report revision.');
  await expect(consistencyMetadata).toHaveAttribute('data-tone', 'neutral');
  await expect(consistencyMetadata).not.toHaveAttribute('role', 'status');
  await expect(sessionAnalysis.locator('[data-tone="neutral"][role="status"]')).toHaveCount(0);
  await expect(sessionAnalysis.locator('[data-tone="warning"]')).toHaveCount(0);
  await expect(sessionAnalysis).not.toContainText('may be newer');
  const timingCoverage = sessionAnalysis.locator('[data-session-analysis-item="partial-duration"]');
  await expect(timingCoverage).toBeVisible();
  await expect(timingCoverage).toHaveAttribute('data-tone', 'neutral');
  await expect(timingCoverage).not.toHaveAttribute('role', 'status');
  await expect(sessionAnalysis.locator('[data-session-analysis-item="partial-turns"]')).toHaveCount(0);
  await expect(sessionAnalysis.locator('[data-session-analysis-metric="active"]')).toContainText('≥');
  await expect(sessionAnalysis.locator('[data-session-analysis-metric="gap"]')).toContainText('≤');
  await expect(sessionAnalysis.getByRole('button', { name: 'Show real gaps' })).toHaveCount(0);
  const privacyMetadata = timelineSection.locator('[data-session-analysis-item="privacy"]');
  await expect(privacyMetadata).toBeVisible();
  await expect(privacyMetadata).toHaveAttribute('data-tone', 'neutral');
  await expect(privacyMetadata).not.toHaveAttribute('role', 'status');
  const hideAnalysisButton = rootDrawer.getByRole('button', { name: 'Hide session chronology' });
  await expect(hideAnalysisButton).toBeVisible();
  await expect(hideAnalysisButton).toHaveText('Hide analysis');
  await hideAnalysisButton.click();
  await expect(sessionAnalysis).toHaveCount(0);
  await expect(rootDrawer).toBeVisible();
  await expect(rootDrawer.locator('[aria-label="Token anatomy"]')).toBeVisible();
  await rootDrawer.getByRole('button', { name: 'Close session details' }).click();
  await expect(rootDrawer).toHaveCount(0);

  await sessionViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator('tr[data-index="0"]').locator('td').last().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const nextSession = page.getByRole('button', { name: 'Next session' });
  await expect(nextSession).toBeEnabled();
  await nextSession.click();
  await expect(page.getByRole('button', { name: 'Previous session' })).toBeEnabled();
  await expect(report).toHaveAttribute('data-report-revision', revision);
  await expect(report).toHaveAttribute('data-request-fingerprint', requestFingerprint);
  await expect.poll(overviewResponseCount).toBe(0);

  await page.keyboard.press('Escape');
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Advanced analysis' })).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: 'Advanced analysis' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 3, name: 'Punchcard' })).toBeVisible();
  await expect.poll(overviewResponseCount).toBe(1);

  const responseBodies = await Promise.all(rpcResponses.map(({ body }) => body));
  const sessionResponseBodies = responseBodies.filter((body) => body.includes('session-query-v1:'));
  // First page is SSR-hydrated; with 200-row pages only one follow-up RPC is required to reach index 204.
  expect(sessionResponseBodies.length).toBeGreaterThanOrEqual(1);
  for (const responseBody of sessionResponseBodies) {
    expectExactProtocolIdentity(responseBody, revision, SESSION_QUERY_FINGERPRINT_PATTERN, requestFingerprint);
  }
  const neighborResponseBodies = responseBodies.filter((body) => body.includes('session-neighbor-v1:'));
  expect(neighborResponseBodies.length).toBeGreaterThanOrEqual(2);
  for (const responseBody of neighborResponseBodies) {
    expectExactProtocolIdentity(responseBody, revision, SESSION_NEIGHBOR_FINGERPRINT_PATTERN);
  }
  const detailResponseBodies = responseBodies.filter((body) => body.includes('matches-report'));
  expect(detailResponseBodies).toHaveLength(1);
  for (const responseBody of detailResponseBodies) {
    expect(new Set(protocolIdentityFrom(responseBody).revisions)).toEqual(new Set([revision]));
  }
  expect(rpcResponses.length).toBeGreaterThanOrEqual(4);
  expect(rpcResponses.every(({ status }) => status === 200)).toBe(true);
  const allResponseBodies = responseBodies.join('\n');
  expect(allResponseBodies).not.toContain(HARNESS_FIXTURE_CREDENTIAL_REMOTE_SENTINEL);
  expect(allResponseBodies).not.toContain(HARNESS_FIXTURE_DANGEROUS_URL_SENTINEL);
  expect(allResponseBodies).not.toContain(HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL);
});

test('opens Claude chronology and recorded source control from the production revision', async ({ page }) => {
  await page.goto('/?tab=sessions');
  const sessionViewport = page.locator('[data-session-surface="desktop"]');
  await expect(sessionViewport).toBeVisible();
  await expect
    .poll(
      async () =>
        await sessionViewport.evaluate((element) => {
          element.scrollTop = element.scrollHeight;

          const claudeRow = Array.from(element.querySelectorAll('tr[data-index]')).find((row) =>
            row.textContent?.includes('claude claude-f'),
          );
          if (!(claudeRow instanceof HTMLElement)) {
            return false;
          }

          claudeRow.click();
          return true;
        }),
    )
    .toBe(true);

  const claudeDrawer = page.getByRole('dialog');
  const claudeSourceControl = claudeDrawer.getByRole('region', { name: 'Session source control' });
  await expect(claudeSourceControl).toContainText('fixture/main → fixture/topic');
  await expect(claudeSourceControl.getByRole('link', { name: 'Open #27 in a new tab' })).toBeVisible();
  await claudeDrawer.getByRole('button', { name: 'Analyze root session chronology' }).click();
  const claudeAnalysis = claudeDrawer.getByRole('region', { name: 'Session analysis' });
  await expect(claudeAnalysis.getByText(HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL, { exact: true })).toHaveCount(1);
  await expect(claudeAnalysis).toContainText('Root interval time');
  await expect(claudeAnalysis).toContainText('Recorded duration unavailable');
});

test('automatically pages mobile Sessions and keeps modal analysis usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/?tab=sessions');

  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const summaries = page.getByRole('list', { name: 'Session summaries' });
  await expect(summaries).toBeVisible();
  const pagingSentinel = page.locator('[data-session-paging-sentinel="mobile"]');
  await expect(pagingSentinel).toHaveCount(1);
  expect(await pagingSentinel.evaluate((element) => element.parentElement?.dataset.sessionSurface === 'mobile')).toBe(
    true,
  );
  await expect
    .poll(
      async () =>
        await summaries.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          const indices = Array.from(element.querySelectorAll<HTMLElement>('[data-session-row-id][data-index]')).map(
            (row) => Number(row.dataset.index),
          );
          return Math.max(...indices, -1);
        }),
    )
    .toBe(204);
  expect(await summaries.locator('[data-session-row-id][data-index]').count()).toBeLessThanOrEqual(600);
  await expect(page.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0);

  const rootTrigger = summaries.getByRole('button', { exact: true, name: 'Inspect session: Implement fixture root' });
  await expect(rootTrigger).toBeVisible();
  await rootTrigger.focus();
  await rootTrigger.click();

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  const drawerBody = drawer.locator('[data-session-drawer-body]');
  const drawerHeader = drawer.locator('[data-session-drawer-header]');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  const analyzeButton = drawer.getByRole('button', { name: 'Analyze root session chronology' });
  await expect(analyzeButton).toBeVisible();
  const headerActionGeometry = await drawerHeader.locator('button:visible').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { height: Math.round(rect.height), width: Math.round(rect.width) };
    }),
  );
  expect(headerActionGeometry).toHaveLength(4);
  expect(headerActionGeometry.every(({ height, width }) => height >= 44 && width >= 44)).toBe(true);

  await analyzeButton.click();
  const analysis = drawer.getByRole('region', { name: 'Session analysis' });
  await expect(analysis).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Hide session chronology' })).toBeVisible();
  await expect(drawer.locator('[aria-label="Token anatomy"]')).toBeVisible();
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
  const analysisGeometry = await drawerBody.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(analysisGeometry.scrollHeight).toBeGreaterThan(analysisGeometry.clientHeight);
  await expect
    .poll(
      async () =>
        await drawerBody.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        }),
    )
    .toBeGreaterThan(0);
  await expect(drawer.getByRole('button', { name: 'Close session details' })).toBeVisible();
  await capturePlan073Smoke(page, testInfo, 'step7-drawer-analysis-390x844-light');

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(rootTrigger).toBeFocused();
});
