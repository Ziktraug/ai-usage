import { createHash } from 'node:crypto';
import {
  collectionSourceDefinitions,
  parseSourceControlCommandResponse,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import type { APIRequestContext, Locator, Page, Response, TestInfo } from '@playwright/test';
import { expect, test } from './browser-test';
import { rpcStringFieldValues } from './rpc-test-transport';
import { afterAnimationFrame, type SessionSurfaceMode, sessionSurface } from './session-scroll-driver';
import { SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT } from './session-scroll-fixture';

const SESSION_ROUTE = '/?origin=%5B%5D&range=%7B%22mode%22%3A%22all%22%7D&tab=sessions';
const SESSION_PAGE_RPC_PATH = '/rpc/session/page';
const SESSION_QUERY_FINGERPRINT_PATTERN = /^session-query-v1:[0-9a-f]{16}$/;
const NON_EMPTY_ATTRIBUTE_PATTERN = /.+/;
const LOAD_MORE_SESSION_BUTTON_PATTERN = /load more sessions/i;
const LOAD_MORE_SESSION_TEXT_PATTERN = /^Load more sessions/;
const SCROLLABLE_OVERFLOW_PATTERN = /^(auto|scroll)$/;
const MAXIMUM_SESSION_PAGE_ITEMS = 200;
const MAXIMUM_SESSION_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_SCROLL_ITERATIONS = 10_000;
const MAXIMUM_STALLED_SCROLL_MS = 20_000;
const DESKTOP_SCROLL_STEP_RATIO = 0.75;
const SOURCE_CONTROL_COMMAND_PATH = '/api/source-control/command';

interface CapturedSessionPage {
  bytes: number;
  fingerprints: string[];
  revisions: string[];
  rowIds: string[];
  url: string;
}

interface RenderedSessionRow {
  index: number;
  rowId: string;
}

interface SessionSurfaceSnapshot {
  clientHeight: number;
  nextScrollTop: number;
  reportRevision: string;
  requestFingerprint: string;
  rows: RenderedSessionRow[];
  scrollHeight: number;
  scrollTop: number;
}

interface ScrollResult {
  maximumRenderedItems: number;
  orderedRowIds: string[];
  requestFingerprint: string;
  sequenceFingerprint: string;
  sessionPageCount: number;
  sessionResponseMaximumBytes: number;
}

interface ViewportCase {
  height: number;
  maximumRenderedItems: number;
  mode: SessionSurfaceMode;
  width: number;
}

const viewportCases: ViewportCase[] = [
  { height: 900, maximumRenderedItems: 300, mode: 'desktop', width: 1024 },
  { height: 844, maximumRenderedItems: 600, mode: 'mobile', width: 390 },
];

let desktopResult: ScrollResult | undefined;

test.describe.configure({ mode: 'serial' });

const readCapturedSessionPage = async (response: Response): Promise<CapturedSessionPage | undefined> => {
  const body = await response.body();
  if (!body.includes('session-query-v1:')) {
    return;
  }
  const responseBody = body.toString('utf8');
  const fingerprints = rpcStringFieldValues(responseBody, 'requestFingerprint');
  const revisions = rpcStringFieldValues(responseBody, 'revision');
  const rowIds = rpcStringFieldValues(responseBody, 'rowId');
  return {
    bytes: body.byteLength,
    fingerprints,
    revisions,
    rowIds,
    url: response.url(),
  };
};

const captureSessionPages = (page: Page): { finish: () => Promise<CapturedSessionPage[]> } => {
  const pendingPages: Promise<CapturedSessionPage | undefined>[] = [];
  const onResponse = (response: Response): void => {
    if (new URL(response.url()).pathname !== SESSION_PAGE_RPC_PATH) {
      return;
    }
    pendingPages.push(readCapturedSessionPage(response));
  };
  page.on('response', onResponse);
  return {
    finish: async () => {
      page.off('response', onResponse);
      return (await Promise.all(pendingPages)).filter(
        (capturedPage): capturedPage is CapturedSessionPage => capturedPage !== undefined,
      );
    },
  };
};

const disableCollectionSource = async (
  request: APIRequestContext,
  sourceId: (typeof collectionSourceDefinitions)[number]['id'],
): Promise<SourceControlView> => {
  const response = await request.post(SOURCE_CONTROL_COMMAND_PATH, {
    data: { command: 'set-enabled', enabled: false, sourceId },
  });
  const result = parseSourceControlCommandResponse(await response.json());
  if (!(response.ok() && result.ok)) {
    throw new Error(`Could not disable the ${sourceId} collection source`);
  }
  return result.snapshot;
};

const freezeCollectionSources = async (request: APIRequestContext): Promise<string> => {
  for (const { id } of collectionSourceDefinitions) {
    await disableCollectionSource(request, id);
  }

  const probeSource = collectionSourceDefinitions[0];
  if (!probeSource) {
    throw new Error('The production fixture must declare at least one collection source');
  }
  await expect
    .poll(
      async () => {
        const snapshot = await disableCollectionSource(request, probeSource.id);
        const { publication } = snapshot;
        return {
          allSourcesDormant:
            snapshot.sources.length === collectionSourceDefinitions.length &&
            snapshot.sources.every(({ lifecycle, policy }) => lifecycle === 'dormant' && policy === 'disabled'),
          publicationSettled:
            !(publication.dirty || publication.pendingDemand || publication.queued || publication.running) &&
            publication.publishedGeneration >= publication.dirtyGeneration &&
            publication.acknowledgedRequestGeneration >= publication.requestedGeneration,
          queueDepth: snapshot.queueDepth,
          runningCount: snapshot.runningCount,
        };
      },
      {
        message: 'The scale fixture collection sources must become fully dormant before traversal',
        timeout: 60_000,
      },
    )
    .toEqual({
      allSourcesDormant: true,
      publicationSettled: true,
      queueDepth: 0,
      runningCount: 0,
    });

  const settledSnapshot = await disableCollectionSource(request, probeSource.id);
  const revision = settledSnapshot.publication.revision;
  if (!revision) {
    throw new Error('The settled scale fixture must expose its publication revision');
  }
  return revision;
};

const readSurfaceSnapshot = (surface: Locator): Promise<SessionSurfaceSnapshot> =>
  surface.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('The Session surface must be an HTML scroll container');
    }
    const rowElements = Array.from(element.querySelectorAll<HTMLElement>('[data-session-row-id][data-index]'));
    const lastRow = rowElements.at(-1);
    const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const lastObservedRowTop = lastRow
      ? element.scrollTop + lastRow.getBoundingClientRect().top - element.getBoundingClientRect().top
      : element.scrollTop + element.clientHeight;
    const report = document.querySelector<HTMLElement>('main[data-hydrated="true"]');
    const reportRevision = report?.dataset.reportRevision;
    const requestFingerprint = report?.dataset.requestFingerprint;
    if (!(reportRevision && requestFingerprint)) {
      throw new Error('The Session surface must belong to one identified report query');
    }
    return {
      clientHeight: element.clientHeight,
      nextScrollTop: Math.min(maximumScrollTop, Math.max(element.scrollTop, lastObservedRowTop)),
      reportRevision,
      requestFingerprint,
      rows: rowElements.map((row) => ({
        index: Number(row.dataset.index),
        rowId: row.dataset.sessionRowId ?? '',
      })),
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });

const moveSurface = (surface: Locator, target: 'end' | 'start' | number): Promise<boolean> =>
  surface.evaluate((element, destination) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('The Session surface must be an HTML scroll container');
    }
    const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    let requestedScrollTop = typeof destination === 'number' ? destination : maximumScrollTop;
    if (destination === 'start') {
      requestedScrollTop = 0;
    }
    const nextScrollTop = Math.min(maximumScrollTop, Math.max(0, requestedScrollTop));
    if (nextScrollTop === element.scrollTop) {
      return false;
    }
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const handleScroll = (): void => {
        settled = true;
        resolve(true);
      };
      element.addEventListener('scroll', handleScroll, { once: true });
      element.scrollTop = nextScrollTop;
      requestAnimationFrame(() => {
        element.removeEventListener('scroll', handleScroll);
        if (!settled) {
          reject(new Error(`The Session surface moved to ${nextScrollTop} without a native scroll event`));
        }
      });
    });
  }, target);

const assertPageBudgets = (
  capturedPages: CapturedSessionPage[],
  orderedRowIds: string[],
  requestFingerprint: string,
  reportRevision: string,
): { maximumBytes: number; pageCount: number } => {
  const revisionPages = capturedPages.filter(
    ({ fingerprints, revisions, rowIds }) =>
      rowIds.length > 0 && fingerprints.includes(requestFingerprint) && revisions.includes(reportRevision),
  );
  expect(
    revisionPages.length,
    'At least one focused Session page for the completed report revision must cross the production wire',
  ).toBeGreaterThan(0);
  const wireRowIds = new Set<string>();
  let maximumBytes = 0;
  for (const capturedPage of revisionPages) {
    maximumBytes = Math.max(maximumBytes, capturedPage.bytes);
    expect(capturedPage.bytes, `Session response exceeded its 2 MiB wire cap: ${capturedPage.url}`).toBeLessThanOrEqual(
      MAXIMUM_SESSION_RESPONSE_BYTES,
    );
    const uniquePageRowIds = new Set(capturedPage.rowIds);
    expect(capturedPage.rowIds.length, `Session response repeated a row ID within one page: ${capturedPage.url}`).toBe(
      uniquePageRowIds.size,
    );
    expect(
      uniquePageRowIds.size,
      `Session response exceeded ${MAXIMUM_SESSION_PAGE_ITEMS} unique rows: ${capturedPage.url}`,
    ).toBeLessThanOrEqual(MAXIMUM_SESSION_PAGE_ITEMS);
    expect(uniquePageRowIds.size, `Session response did not expose any row IDs: ${capturedPage.url}`).toBeGreaterThan(
      0,
    );
    expect(
      capturedPage.fingerprints.length,
      `Session response did not expose a request fingerprint: ${capturedPage.url}`,
    ).toBeGreaterThan(0);
    expect(
      capturedPage.revisions.length,
      `Session response did not expose a revision: ${capturedPage.url}`,
    ).toBeGreaterThan(0);
    for (const revision of capturedPage.revisions) {
      expect(revision).toMatch(NON_EMPTY_ATTRIBUTE_PATTERN);
    }
    for (const fingerprint of capturedPage.fingerprints) {
      expect(fingerprint).toMatch(SESSION_QUERY_FINGERPRINT_PATTERN);
      expect(fingerprint).toBe(requestFingerprint);
    }
    for (const rowId of uniquePageRowIds) {
      if (wireRowIds.has(rowId)) {
        throw new Error(`Session row ID ${rowId} crossed the production wire more than once`);
      }
      wireRowIds.add(rowId);
    }
  }
  expect(wireRowIds).toEqual(new Set(orderedRowIds));
  return { maximumBytes, pageCount: revisionPages.length };
};

const inspectAllSessions = async (
  page: Page,
  request: APIRequestContext,
  viewportCase: ViewportCase,
  testInfo: TestInfo,
): Promise<ScrollResult> => {
  await page.setViewportSize({ height: viewportCase.height, width: viewportCase.width });
  await page.goto(SESSION_ROUTE);
  const report = page.locator('main[data-hydrated="true"]');
  await expect(report).toBeVisible();
  await expect(page.getByText('5,000 / 5,000 sessions', { exact: true })).toBeVisible();
  const frozenReportRevision = await freezeCollectionSources(request);

  // Close the previous document before strict response capture so its
  // navigation-cancelled requests cannot enter the new report's wire proof.
  await page.goto('about:blank');
  const capture = captureSessionPages(page);
  await page.goto(SESSION_ROUTE);
  await expect(report).toBeVisible();
  await expect(page.getByText('5,000 / 5,000 sessions', { exact: true })).toBeVisible();
  await expect(report).toHaveAttribute('data-report-revision', frozenReportRevision);
  await expect(report).toHaveAttribute('data-request-fingerprint', SESSION_QUERY_FINGERPRINT_PATTERN);
  const reportElement = await report.elementHandle();
  if (!reportElement) {
    throw new Error('The production Session report must expose its mounted root element');
  }
  const reportRevision = await report.getAttribute('data-report-revision');
  const requestFingerprint = await report.getAttribute('data-request-fingerprint');
  if (!(reportRevision && requestFingerprint)) {
    throw new Error('The production Session report must expose its revision and request fingerprint');
  }

  const surface = sessionSurface(page, viewportCase.mode);
  await expect(surface).toBeVisible();
  await expect(page.getByRole('button', { name: LOAD_MORE_SESSION_BUTTON_PATTERN })).toHaveCount(0);
  await expect(page.getByText(LOAD_MORE_SESSION_TEXT_PATTERN)).toHaveCount(0);
  const scrollSemantics = await surface.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollSemantics.clientHeight).toBeGreaterThan(0);
  expect(scrollSemantics.scrollHeight).toBeGreaterThan(scrollSemantics.clientHeight);
  expect(scrollSemantics.overflowY).toMatch(SCROLLABLE_OVERFLOW_PATTERN);

  if (viewportCase.mode === 'mobile') {
    const sentinel = page.locator('[data-session-paging-sentinel="mobile"]');
    await expect(sentinel).toHaveCount(1);
    expect(
      await sentinel.evaluate((element) => element.parentElement?.dataset.sessionSurface === 'mobile'),
      'The mobile paging sentinel must be owned by the mobile scroll root',
    ).toBe(true);
  }

  const indexToRowId = new Map<number, string>();
  const rowIdToIndex = new Map<string, number>();
  let maximumRenderedItems = 0;
  const recordSnapshot = (snapshot: SessionSurfaceSnapshot): void => {
    maximumRenderedItems = Math.max(maximumRenderedItems, snapshot.rows.length);
    if (snapshot.rows.length > viewportCase.maximumRenderedItems) {
      throw new Error(
        `Session surface rendered ${snapshot.rows.length} items, above its ${viewportCase.maximumRenderedItems} item budget`,
      );
    }
    const liveIndices = new Set(snapshot.rows.map(({ index }) => index));
    const liveRowIds = new Set(snapshot.rows.map(({ rowId }) => rowId));
    if (liveIndices.size !== snapshot.rows.length) {
      throw new Error('A Session index must appear at most once in the live DOM');
    }
    if (liveRowIds.size !== snapshot.rows.length) {
      throw new Error('A Session row ID must appear at most once in the live DOM');
    }
    for (const { index, rowId } of snapshot.rows) {
      if (!(Number.isSafeInteger(index) && index >= 0 && index < SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT)) {
        throw new Error(`Invalid Session data-index ${index}`);
      }
      if (rowId.length === 0) {
        throw new Error(`Session index ${index} did not expose an opaque row ID`);
      }
      const knownRowId = indexToRowId.get(index);
      if (knownRowId !== undefined && knownRowId !== rowId) {
        throw new Error(`Session index ${index} changed row ID from ${knownRowId} to ${rowId}`);
      }
      const knownIndex = rowIdToIndex.get(rowId);
      if (knownIndex !== undefined && knownIndex !== index) {
        throw new Error(`Session row ID ${rowId} moved from index ${knownIndex} to ${index}`);
      }
      indexToRowId.set(index, rowId);
      rowIdToIndex.set(rowId, index);
    }
  };
  const assertStableReportQuery = (snapshot: SessionSurfaceSnapshot): void => {
    if (snapshot.requestFingerprint !== requestFingerprint) {
      throw new Error(`Session query fingerprint changed from ${requestFingerprint} to ${snapshot.requestFingerprint}`);
    }
    if (snapshot.reportRevision !== reportRevision) {
      throw new Error(`Session report revision changed from ${reportRevision} to ${snapshot.reportRevision}`);
    }
  };

  let iteration = 0;
  while (indexToRowId.size < SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT) {
    iteration += 1;
    if (iteration > MAXIMUM_SCROLL_ITERATIONS) {
      throw new Error(`Session traversal exceeded ${MAXIMUM_SCROLL_ITERATIONS} bounded scroll steps`);
    }
    const snapshot = await readSurfaceSnapshot(surface);
    assertStableReportQuery(snapshot);
    recordSnapshot(snapshot);
    if (indexToRowId.size === SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT) {
      break;
    }
    // Mobile cards have a fixed row geometry. The last rendered card has
    // already been recorded, so its top advances the window without skipping
    // unseen rows. Keep the table's established viewport step on desktop.
    const maximumScrollTop = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
    const nextScrollTop =
      viewportCase.mode === 'mobile'
        ? snapshot.nextScrollTop
        : Math.min(
            maximumScrollTop,
            snapshot.scrollTop + Math.max(1, Math.floor(snapshot.clientHeight * DESKTOP_SCROLL_STEP_RATIO)),
          );
    if (nextScrollTop > snapshot.scrollTop) {
      const previousHeight = snapshot.scrollHeight;
      const previousRowCount = indexToRowId.size;
      expect(
        await moveSurface(surface, nextScrollTop),
        'The Session surface must advance to the next scroll step',
      ).toBe(true);
      await afterAnimationFrame(page);
      await expect
        .poll(
          async () => {
            const nextSnapshot = await readSurfaceSnapshot(surface);
            assertStableReportQuery(nextSnapshot);
            recordSnapshot(nextSnapshot);
            return nextSnapshot.scrollHeight > previousHeight || indexToRowId.size > previousRowCount;
          },
          {
            message: `The Session virtual window did not acknowledge its scroll step after reaching ${previousRowCount} rows`,
            timeout: MAXIMUM_STALLED_SCROLL_MS,
          },
        )
        .toBe(true);
      continue;
    }

    const previousHeight = snapshot.scrollHeight;
    const previousRowCount = indexToRowId.size;
    await expect
      .poll(
        async () => {
          const nextSnapshot = await readSurfaceSnapshot(surface);
          assertStableReportQuery(nextSnapshot);
          recordSnapshot(nextSnapshot);
          return nextSnapshot.scrollHeight > previousHeight || indexToRowId.size > previousRowCount;
        },
        {
          message: `Session scrolling stalled after reaching ${previousRowCount} of ${SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT} rows`,
          timeout: MAXIMUM_STALLED_SCROLL_MS,
        },
      )
      .toBe(true);
  }

  const expectedIndices = Array.from({ length: SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT }, (_, index) => index);
  expect([...indexToRowId.keys()].sort((left, right) => left - right)).toEqual(expectedIndices);
  expect(rowIdToIndex.size).toBe(SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT);
  const orderedRowIds = expectedIndices.map((index) => {
    const rowId = indexToRowId.get(index);
    if (!rowId) {
      throw new Error(`Session index ${index} was not reachable`);
    }
    return rowId;
  });
  const firstRowId = orderedRowIds[0];
  const lastRowId = orderedRowIds[SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT - 1];
  if (!(firstRowId && lastRowId)) {
    throw new Error('Expected the session fixture to contain first and last row identifiers');
  }

  await moveSurface(surface, 'start');
  await expect(surface.locator('[data-index="0"]')).toHaveAttribute('data-session-row-id', firstRowId);
  await moveSurface(surface, 'end');
  await expect(surface.locator(`[data-index="${SESSION_SCROLL_EXPECTED_CAMPAIGN_COUNT - 1}"]`)).toHaveAttribute(
    'data-session-row-id',
    lastRowId,
  );
  expect(
    await reportElement.evaluate(
      (element) => element.isConnected && element === document.querySelector('main[data-hydrated="true"]'),
    ),
    'Loading additional Session pages must preserve the mounted Report root',
  ).toBe(true);
  await expect(report).toHaveAttribute('data-report-revision', reportRevision);
  await expect(report).toHaveAttribute('data-request-fingerprint', requestFingerprint);
  await expect(page.getByText('Loading more sessions…', { exact: true })).toHaveCount(0);

  const pageBudgets = assertPageBudgets(await capture.finish(), orderedRowIds, requestFingerprint, reportRevision);
  const sequenceFingerprint = createHash('sha256').update(JSON.stringify(orderedRowIds)).digest('hex');
  const result = {
    maximumRenderedItems,
    orderedRowIds,
    requestFingerprint,
    sequenceFingerprint,
    sessionPageCount: pageBudgets.pageCount,
    sessionResponseMaximumBytes: pageBudgets.maximumBytes,
  };
  await testInfo.attach(`session-scroll-${viewportCase.mode}.json`, {
    body: JSON.stringify(
      {
        maximumRenderedItems,
        requestFingerprint,
        sequenceFingerprint,
        sessionPageCount: pageBudgets.pageCount,
        sessionResponseMaximumBytes: pageBudgets.maximumBytes,
        topLevelCampaignsReached: orderedRowIds.length,
        viewport: { height: viewportCase.height, width: viewportCase.width },
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  return result;
};

for (const viewportCase of viewportCases) {
  test(`reaches every top-level production campaign exactly once on ${viewportCase.mode}`, async ({
    page,
    request,
  }, testInfo) => {
    const result = await inspectAllSessions(page, request, viewportCase, testInfo);
    if (viewportCase.mode === 'desktop') {
      desktopResult = result;
      return;
    }
    if (!desktopResult) {
      throw new Error('The serial desktop traversal must complete before the mobile comparison');
    }
    expect(result.requestFingerprint).toBe(desktopResult.requestFingerprint);
    expect(result.sequenceFingerprint).toBe(desktopResult.sequenceFingerprint);
    expect(result.orderedRowIds).toEqual(desktopResult.orderedRowIds);
  });
}
