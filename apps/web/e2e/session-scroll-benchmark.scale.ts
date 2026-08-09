import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, CDPSession, Page, Request, Response } from '@playwright/test';
import { expect, test } from './browser-test';
import { rpcStringFieldValues } from './rpc-test-transport';
import { measureInitialStaticClosureBytes } from './session-scroll-benchmark-closure';
import {
  afterAnimationFrame,
  moveSessionSurface,
  readExpandedCampaignChildIdentity,
  type SessionSurfaceMode,
  sessionSurface,
} from './session-scroll-driver';
import {
  SESSION_SCROLL_CHILD_LABEL,
  SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT,
  SESSION_SCROLL_EXPECTED_COUNT,
  SESSION_SCROLL_FILTER_QUERY,
} from './session-scroll-fixture';
import { freezeSessionScrollCollectionSources } from './session-scroll-source-control';

interface SessionQueryPerfPhaseStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  totalMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireNonNegativeNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Expected ${label} to be a non-negative finite number`);
  }
  return value;
};

const requireNonNegativeInteger = (value: unknown, label: string): number => {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw new Error(`Expected ${label} to be a non-negative safe integer`);
  }
  return value;
};

const parsePhaseStats = (value: unknown, label: string): SessionQueryPerfPhaseStats => {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return {
    count: requireNonNegativeInteger(value.count, `${label}.count`),
    p50Ms: requireNonNegativeNumber(value.p50Ms, `${label}.p50Ms`),
    p95Ms: requireNonNegativeNumber(value.p95Ms, `${label}.p95Ms`),
    totalMs: requireNonNegativeNumber(value.totalMs, `${label}.totalMs`),
  };
};

const parsePerfSnapshot = (
  value: unknown,
): {
  hydration: {
    families: Record<string, { bytes: number; queryCount: number }>;
    totalBytes: number;
  };
  sqlite: { phases: Record<string, SessionQueryPerfPhaseStats> };
} => {
  if (!(isRecord(value) && isRecord(value.hydration) && isRecord(value.sqlite))) {
    throw new Error('Expected the Session performance snapshot to contain hydration and SQLite data');
  }
  if (!(isRecord(value.hydration.families) && isRecord(value.sqlite.phases))) {
    throw new Error('Expected the Session performance snapshot to contain family and phase records');
  }
  const families: Record<string, { bytes: number; queryCount: number }> = {};
  for (const [family, candidate] of Object.entries(value.hydration.families)) {
    if (!isRecord(candidate)) {
      throw new Error(`Expected hydration family ${family} to be an object`);
    }
    families[family] = {
      bytes: requireNonNegativeNumber(candidate.bytes, `hydration.${family}.bytes`),
      queryCount: requireNonNegativeInteger(candidate.queryCount, `hydration.${family}.queryCount`),
    };
  }
  const phases: Record<string, SessionQueryPerfPhaseStats> = {};
  for (const [phase, candidate] of Object.entries(value.sqlite.phases)) {
    phases[phase] = parsePhaseStats(candidate, `sqlite.${phase}`);
  }
  return {
    hydration: {
      families,
      totalBytes: requireNonNegativeNumber(value.hydration.totalBytes, 'hydration.totalBytes'),
    },
    sqlite: { phases },
  };
};

interface SessionScrollSample {
  browserSessionRpcCount: number;
  cumulativeSessionResponseBytes: number;
  desktopFullTraversalMs: number;
  desktopMaximumRenderedItems: number;
  desktopMaximumSessionDomNodes: number;
  desktopSessionPageCount: number;
  desktopSessionRpcCount: number;
  desktopSettledRenderedItems: number;
  desktopSettledSessionDomNodes: number;
  duplicateIdentityCount: number;
  filterMs: number;
  firstSessionIdentity: string | null;
  heapDeltaBytes: number | null;
  hydrationFamilyBytes: Record<string, { bytes: number; queryCount: number }>;
  hydrationTotalBytes: number;
  initialHtmlBytes: number;
  initialMs: number;
  lastSessionIdentity: string | null;
  maximumPageBytes: number;
  missingIdentityCount: number;
  mobileFullTraversalMs: number;
  mobileMaximumRenderedItems: number;
  mobileMaximumSessionDomNodes: number;
  mobileSettledRenderedItems: number;
  mobileSettledSessionDomNodes: number;
  sessionPageCount: number;
  sortMs: number;
  sqlitePhases: Record<string, SessionQueryPerfPhaseStats>;
  uniqueIdentityCount: number;
}

const LAST_CAMPAIGN_INDEX = SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT - 1;
const SESSION_QUERY_FINGERPRINT_PATTERN = /^session-query-v1:/;
const SESSION_PAGE_RPC_PATH = '/rpc/session/page';
const SESSION_PERF_PATH = '/__ai-usage/perf/session-query';
const MAXIMUM_SESSION_SCROLL_STEPS = SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT;
const MAXIMUM_SESSION_PAGE_ITEMS = 200;
const MAXIMUM_SESSION_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_DESKTOP_RENDERED_ITEMS = 300;
const MAXIMUM_MOBILE_RENDERED_ITEMS = 600;
const EXPECTED_TOTAL_SESSION_PAGES = Math.ceil(SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT / MAXIMUM_SESSION_PAGE_ITEMS);
const EXPECTED_DESKTOP_SESSION_RPCS = EXPECTED_TOTAL_SESSION_PAGES - 1;
const DESKTOP_VIEWPORT = { height: 900, width: 1024 } as const;
const MOBILE_VIEWPORT = { height: 844, width: 390 } as const;
const BASE_URL = 'http://127.0.0.1:4177';
const samples: SessionScrollSample[] = [];

const maximumValidCampaignIndex = (indices: readonly number[]): number => {
  for (const index of indices) {
    if (!(Number.isSafeInteger(index) && index >= 0 && index <= LAST_CAMPAIGN_INDEX)) {
      throw new Error('Benchmark observed an invalid campaign index');
    }
  }
  return Math.max(...indices, -1);
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await freezeSessionScrollCollectionSources(request, BASE_URL);
});

const readHeapBytes = async (client: CDPSession): Promise<number | null> => {
  try {
    await client.send('HeapProfiler.collectGarbage');
    const { metrics } = await client.send('Performance.getMetrics');
    return metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? null;
  } catch {
    return null;
  }
};

const resetPerfSnapshot = async (request: APIRequestContext): Promise<void> => {
  const response = await request.delete(`${BASE_URL}${SESSION_PERF_PATH}`);
  expect(response.status()).toBe(204);
};

const readPerfSnapshot = async (
  request: APIRequestContext,
): Promise<{
  hydration: {
    families: Record<string, { bytes: number; queryCount: number }>;
    totalBytes: number;
  };
  sqlite: { phases: Record<string, SessionQueryPerfPhaseStats> };
}> => {
  const response = await request.get(`${BASE_URL}${SESSION_PERF_PATH}`);
  expect(response.ok()).toBe(true);
  return parsePerfSnapshot(await response.json());
};

const waitForAllRows = async (
  page: Page,
  surfaceMode: SessionSurfaceMode,
): Promise<{
  elapsedMs: number;
  firstIdentity: string | null;
  lastIdentity: string | null;
  maximumItems: number;
  maximumNodes: number;
  settledItems: number;
  settledNodes: number;
}> => {
  const surface = sessionSurface(page, surfaceMode);
  const startedAt = performance.now();
  let maximumIndex = -1;
  let maximumItems = 0;
  let maximumNodes = 0;
  let firstIdentity: string | null = null;
  let lastIdentity: string | null = null;

  const recordSnapshot = async (): Promise<{ maximumIndex: number; scrollHeight: number }> => {
    const snapshot = await surface.evaluate((element) => {
      const renderedItems = Array.from(element.querySelectorAll<HTMLElement>('[data-index]'));
      return {
        identities: renderedItems.map((item) => ({
          index: Number(item.dataset.index),
          rowId: item.dataset.sessionRowId ?? '',
        })),
        renderedItems: renderedItems.length,
        scrollHeight: element.scrollHeight,
        sessionDomNodes: element.querySelectorAll('*').length,
      };
    });
    maximumIndex = Math.max(
      maximumIndex,
      maximumValidCampaignIndex(snapshot.identities.map((identity) => identity.index)),
    );
    maximumItems = Math.max(maximumItems, snapshot.renderedItems);
    maximumNodes = Math.max(maximumNodes, snapshot.sessionDomNodes);
    for (const identity of snapshot.identities) {
      if (identity.rowId.length === 0) {
        continue;
      }
      if (identity.index === 0) {
        firstIdentity = identity.rowId;
      }
      if (identity.index === LAST_CAMPAIGN_INDEX) {
        lastIdentity = identity.rowId;
      }
    }
    return { maximumIndex, scrollHeight: snapshot.scrollHeight };
  };

  let scrollStep = 0;
  while (maximumIndex < LAST_CAMPAIGN_INDEX) {
    scrollStep += 1;
    if (scrollStep > MAXIMUM_SESSION_SCROLL_STEPS) {
      throw new Error(`Benchmark traversal exceeded ${MAXIMUM_SESSION_SCROLL_STEPS} bounded scroll steps`);
    }
    const previous = await recordSnapshot();
    if (previous.maximumIndex === LAST_CAMPAIGN_INDEX) {
      break;
    }
    await moveSessionSurface(surface, 'end');
    await afterAnimationFrame(page);
    await expect
      .poll(
        async () => {
          const next = await recordSnapshot();
          return next.maximumIndex > previous.maximumIndex || next.scrollHeight > previous.scrollHeight;
        },
        {
          message: `Benchmark Session traversal stalled after campaign index ${previous.maximumIndex}`,
        },
      )
      .toBe(true);
  }

  await expect(surface.locator(`[data-index="${LAST_CAMPAIGN_INDEX}"]`)).toBeVisible();
  expect(maximumIndex).toBe(LAST_CAMPAIGN_INDEX);
  const settled = await surface.evaluate((element) => ({
    renderedItems: element.querySelectorAll('[data-index]').length,
    sessionDomNodes: element.querySelectorAll('*').length,
  }));
  return {
    elapsedMs: performance.now() - startedAt,
    firstIdentity,
    lastIdentity,
    maximumItems,
    maximumNodes,
    settledItems: settled.renderedItems,
    settledNodes: settled.sessionDomNodes,
  };
};

const verifyEveryVirtualizedCampaign = async (
  page: Page,
  surfaceMode: SessionSurfaceMode,
): Promise<{ firstIdentity: string; identities: string[]; lastIdentity: string }> => {
  const surface = sessionSurface(page, surfaceMode);
  const identitiesByIndex = new Map<number, string>();
  const geometry = await surface.evaluate((element) => ({
    clientHeight: element.clientHeight,
    maximumScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
  }));
  const scrollIncrement = Math.max(1, Math.floor(geometry.clientHeight / 2));

  for (let scrollTop = 0; scrollTop < geometry.maximumScrollTop; scrollTop += scrollIncrement) {
    await moveSessionSurface(surface, scrollTop);
    await afterAnimationFrame(page);
    const rendered = await surface.evaluate((element) =>
      Array.from(element.querySelectorAll<HTMLElement>('[data-index]')).map((item) => ({
        index: Number(item.dataset.index),
        rowId: item.dataset.sessionRowId ?? '',
      })),
    );
    for (const { index, rowId } of rendered) {
      maximumValidCampaignIndex([index]);
      expect(rowId).not.toBe('');
      const previous = identitiesByIndex.get(index);
      if (previous !== undefined) {
        expect(rowId).toBe(previous);
      }
      identitiesByIndex.set(index, rowId);
    }
  }

  await moveSessionSurface(surface, geometry.maximumScrollTop);
  await afterAnimationFrame(page);
  const finalRendered = await surface.evaluate((element) =>
    Array.from(element.querySelectorAll<HTMLElement>('[data-index]')).map((item) => ({
      index: Number(item.dataset.index),
      rowId: item.dataset.sessionRowId ?? '',
    })),
  );
  for (const { index, rowId } of finalRendered) {
    maximumValidCampaignIndex([index]);
    expect(rowId).not.toBe('');
    const previous = identitiesByIndex.get(index);
    if (previous !== undefined) {
      expect(rowId).toBe(previous);
    }
    identitiesByIndex.set(index, rowId);
  }

  expect(identitiesByIndex.size).toBe(SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT);
  const uniqueIdentities = new Set(identitiesByIndex.values());
  expect(uniqueIdentities.size).toBe(SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT);
  const firstIdentity = identitiesByIndex.get(0);
  const lastIdentity = identitiesByIndex.get(LAST_CAMPAIGN_INDEX);
  if (!(firstIdentity && lastIdentity)) {
    throw new Error('Benchmark virtualized identity sweep omitted an endpoint');
  }
  const identities = Array.from({ length: SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT }, (_, index) => {
    const identity = identitiesByIndex.get(index);
    if (!identity) {
      throw new Error(`Benchmark virtualized identity sweep omitted campaign index ${index}`);
    }
    return identity;
  });
  return { firstIdentity, identities, lastIdentity };
};

const readCapturedSessionPage = async (
  response: Response,
): Promise<{ bytes: number; rowIds: string[] } | undefined> => {
  try {
    const body = await response.body();
    if (!body.includes('session-query-v1:')) {
      return;
    }
    const responseBody = body.toString('utf8');
    return {
      bytes: body.byteLength,
      rowIds: rpcStringFieldValues(responseBody, 'rowId'),
    };
  } catch {
    return;
  }
};

const runSample = async (page: Page, request: APIRequestContext): Promise<SessionScrollSample> => {
  await resetPerfSnapshot(request);

  const pendingPages: Promise<{ bytes: number; rowIds: string[] } | undefined>[] = [];
  let browserSessionRpcCount = 0;

  const onRequest = (pending: Request): void => {
    if (new URL(pending.url()).pathname === SESSION_PAGE_RPC_PATH) {
      browserSessionRpcCount += 1;
    }
  };
  const onResponse = (response: Response): void => {
    if (new URL(response.url()).pathname === SESSION_PAGE_RPC_PATH) {
      pendingPages.push(readCapturedSessionPage(response));
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    const initialStartedAt = performance.now();
    const navigation = await page.goto('/?origin=%5B%5D&tab=sessions');
    if (!navigation) {
      throw new Error('Benchmark navigation did not return a document response');
    }
    const initialHtml = await navigation.body();
    const initialHtmlBytes = initialHtml.byteLength;
    const report = page.locator('main[data-hydrated="true"]');
    await expect(report).toBeVisible();
    const surface = page.locator('[data-session-surface="desktop"]');
    await expect(surface.locator('[data-index="0"]')).toBeVisible();
    await expect(page.getByText('5,000 / 5,000 sessions', { exact: true })).toBeVisible();
    await expect(report).toHaveAttribute('data-request-fingerprint', SESSION_QUERY_FINGERPRINT_PATTERN);
    await afterAnimationFrame(page);
    const initialMs = performance.now() - initialStartedAt;
    // Hydration must not issue a session-page business refetch before ordinary scrolling begins.
    expect(browserSessionRpcCount).toBe(0);

    const hydrationSnapshot = await readPerfSnapshot(request);

    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    const heapBefore = await readHeapBytes(client);
    const desktopTraversal = await waitForAllRows(page, 'desktop');
    const heapAfter = await readHeapBytes(client);
    expect(desktopTraversal.maximumItems).toBeLessThanOrEqual(MAXIMUM_DESKTOP_RENDERED_ITEMS);

    const desktopCapturedPages = (await Promise.all(pendingPages.slice())).flatMap((pageCapture) =>
      pageCapture === undefined ? [] : [pageCapture],
    );
    expect(browserSessionRpcCount).toBe(EXPECTED_DESKTOP_SESSION_RPCS);
    expect(desktopCapturedPages).toHaveLength(EXPECTED_DESKTOP_SESSION_RPCS);
    expect(desktopCapturedPages.length + 1).toBe(EXPECTED_TOTAL_SESSION_PAGES);
    const desktopIdentitySweep = await verifyEveryVirtualizedCampaign(page, 'desktop');
    expect(desktopTraversal.firstIdentity).toBe(desktopIdentitySweep.firstIdentity);
    expect(desktopTraversal.lastIdentity).toBe(desktopIdentitySweep.lastIdentity);
    const expandedChildIdentity = await readExpandedCampaignChildIdentity(
      page,
      'desktop',
      SESSION_SCROLL_FILTER_QUERY,
      SESSION_SCROLL_CHILD_LABEL,
      SESSION_SCROLL_EXPECTED_COUNT - 1,
    );
    const observedSessionIdentities = [...desktopIdentitySweep.identities, expandedChildIdentity];
    const uniqueSessionIdentities = new Set(observedSessionIdentities);
    const duplicateIdentityCount = observedSessionIdentities.length - uniqueSessionIdentities.size;
    const missingIdentityCount = Math.max(0, SESSION_SCROLL_EXPECTED_COUNT - uniqueSessionIdentities.size);
    expect(observedSessionIdentities).toHaveLength(SESSION_SCROLL_EXPECTED_COUNT);
    expect(duplicateIdentityCount).toBe(0);
    expect(missingIdentityCount).toBe(0);

    await page.setViewportSize(MOBILE_VIEWPORT);
    const mobileSurface = sessionSurface(page, 'mobile');
    await expect(mobileSurface).toBeVisible();
    const mobileMiddle = await mobileSurface.evaluate((element) =>
      Math.floor(Math.max(0, element.scrollHeight - element.clientHeight) / 2),
    );
    await moveSessionSurface(mobileSurface, mobileMiddle);
    await afterAnimationFrame(page);
    const mobileTraversal = await waitForAllRows(page, 'mobile');
    expect(mobileTraversal.maximumItems).toBeLessThanOrEqual(MAXIMUM_MOBILE_RENDERED_ITEMS);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(surface).toBeVisible();
    await expect(page.getByText('5,000 / 5,000 sessions', { exact: true })).toBeVisible();

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

    const capturedPages = (await Promise.all(pendingPages)).flatMap((pageCapture) =>
      pageCapture === undefined ? [] : [pageCapture],
    );
    const measuredPageBytes = capturedPages.map((pageCapture) => pageCapture.bytes);
    for (const pageCapture of capturedPages) {
      expect(pageCapture.rowIds.length).toBeLessThanOrEqual(MAXIMUM_SESSION_PAGE_ITEMS);
      expect(pageCapture.bytes).toBeLessThanOrEqual(MAXIMUM_SESSION_RESPONSE_BYTES);
    }

    expect(desktopTraversal.firstIdentity).not.toBeNull();
    expect(desktopTraversal.lastIdentity).not.toBeNull();
    expect(desktopTraversal.firstIdentity).not.toBe(desktopTraversal.lastIdentity);

    const sqliteSnapshot = await readPerfSnapshot(request);
    expect(sqliteSnapshot.sqlite.phases.identity?.count).toBe(EXPECTED_TOTAL_SESSION_PAGES + 2);

    await client.detach();
    return {
      browserSessionRpcCount,
      cumulativeSessionResponseBytes: measuredPageBytes.reduce((sum, value) => sum + value, 0),
      desktopFullTraversalMs: Number(desktopTraversal.elapsedMs.toFixed(3)),
      desktopMaximumRenderedItems: desktopTraversal.maximumItems,
      desktopMaximumSessionDomNodes: desktopTraversal.maximumNodes,
      desktopSettledRenderedItems: desktopTraversal.settledItems,
      desktopSettledSessionDomNodes: desktopTraversal.settledNodes,
      desktopSessionPageCount: desktopCapturedPages.length + 1,
      desktopSessionRpcCount: desktopCapturedPages.length,
      duplicateIdentityCount,
      filterMs: Number(filterMs.toFixed(3)),
      firstSessionIdentity: observedSessionIdentities[0] ?? null,
      heapDeltaBytes: heapBefore === null || heapAfter === null ? null : Math.max(0, heapAfter - heapBefore),
      hydrationFamilyBytes: hydrationSnapshot.hydration.families,
      hydrationTotalBytes: hydrationSnapshot.hydration.totalBytes,
      initialHtmlBytes,
      initialMs: Number(initialMs.toFixed(3)),
      lastSessionIdentity: observedSessionIdentities.at(-1) ?? null,
      maximumPageBytes: Math.max(...measuredPageBytes, 0),
      missingIdentityCount,
      mobileFullTraversalMs: Number(mobileTraversal.elapsedMs.toFixed(3)),
      mobileMaximumRenderedItems: mobileTraversal.maximumItems,
      mobileMaximumSessionDomNodes: mobileTraversal.maximumNodes,
      mobileSettledRenderedItems: mobileTraversal.settledItems,
      mobileSettledSessionDomNodes: mobileTraversal.settledNodes,
      sessionPageCount: capturedPages.length,
      sortMs: Number(sortMs.toFixed(3)),
      sqlitePhases: sqliteSnapshot.sqlite.phases,
      uniqueIdentityCount: uniqueSessionIdentities.size,
    };
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    await resetPerfSnapshot(request).catch(() => undefined);
  }
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

test('warms the production fixture without recording a sample', async ({ page, request }) => {
  await runSample(page, request);
});

for (let sampleIndex = 1; sampleIndex <= 3; sampleIndex += 1) {
  test(`records production sample ${sampleIndex}`, async ({ page, request }) => {
    samples.push(await runSample(page, request));
  });
}

test.afterAll(() => {
  const supportedHeapDeltas = samples.flatMap((sample) =>
    sample.heapDeltaBytes === null ? [] : [sample.heapDeltaBytes],
  );
  const initialStaticClosure = measureInitialStaticClosureBytes();
  const output = {
    fixture: { campaigns: SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT, sessions: SESSION_SCROLL_EXPECTED_COUNT },
    initialStaticClosure,
    medians: {
      browserSessionRpcCount: median(samples.map((sample) => sample.browserSessionRpcCount)),
      cumulativeSessionResponseBytes: median(samples.map((sample) => sample.cumulativeSessionResponseBytes)),
      desktopFullTraversalMs: median(samples.map((sample) => sample.desktopFullTraversalMs)),
      desktopMaximumRenderedItems: median(samples.map((sample) => sample.desktopMaximumRenderedItems)),
      desktopMaximumSessionDomNodes: median(samples.map((sample) => sample.desktopMaximumSessionDomNodes)),
      desktopSessionPageCount: median(samples.map((sample) => sample.desktopSessionPageCount)),
      desktopSessionRpcCount: median(samples.map((sample) => sample.desktopSessionRpcCount)),
      filterMs: median(samples.map((sample) => sample.filterMs)),
      heapDeltaBytes: supportedHeapDeltas.length > 0 ? median(supportedHeapDeltas) : null,
      hydrationTotalBytes: median(samples.map((sample) => sample.hydrationTotalBytes)),
      initialHtmlBytes: median(samples.map((sample) => sample.initialHtmlBytes)),
      initialMs: median(samples.map((sample) => sample.initialMs)),
      maximumPageBytes: median(samples.map((sample) => sample.maximumPageBytes)),
      mobileFullTraversalMs: median(samples.map((sample) => sample.mobileFullTraversalMs)),
      mobileMaximumRenderedItems: median(samples.map((sample) => sample.mobileMaximumRenderedItems)),
      mobileMaximumSessionDomNodes: median(samples.map((sample) => sample.mobileMaximumSessionDomNodes)),
      sessionPageCount: median(samples.map((sample) => sample.sessionPageCount)),
      sortMs: median(samples.map((sample) => sample.sortMs)),
      uniqueIdentityCount: median(samples.map((sample) => sample.uniqueIdentityCount)),
    },
    samples,
  };
  const serializedOutput = `${JSON.stringify({ sessionScrollBenchmark: output })}\n`;
  const outputPath = process.env.AI_USAGE_SESSION_BENCHMARK_OUTPUT;
  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serializedOutput, 'utf8');
    return;
  }
  process.stdout.write(serializedOutput);
});
