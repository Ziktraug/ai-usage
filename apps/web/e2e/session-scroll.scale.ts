import { createHash } from 'node:crypto';
import type { Locator, Page, Response, TestInfo } from '@playwright/test';
import { expect, test } from './browser-test';
import { SESSION_SCROLL_EXPECTED_COUNT } from './session-scroll-fixture';

const SESSION_ROUTE = '/?campaigns=off&tab=sessions';
const SERVER_FUNCTION_PATH_PREFIX = '/_serverFn/';
const SESSION_QUERY_FINGERPRINT_PATTERN = /^session-query-v1:[0-9a-f]{16}$/;
const LOAD_MORE_SESSION_BUTTON_PATTERN = /load more sessions/i;
const LOAD_MORE_SESSION_TEXT_PATTERN = /^Load more sessions/;
const SCROLLABLE_OVERFLOW_PATTERN = /^(auto|scroll)$/;
const MAXIMUM_SESSION_PAGE_ITEMS = 200;
const MAXIMUM_SESSION_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_SCROLL_ITERATIONS = 10_000;
const MAXIMUM_STALLED_SCROLL_MS = 20_000;
const SCROLL_STEP_RATIO = 0.75;

interface CapturedSessionPage {
  bytes: number;
  fingerprints: string[];
  rowIds: string[];
  url: string;
}

interface RenderedSessionRow {
  index: number;
  rowId: string;
}

interface SessionSurfaceSnapshot {
  clientHeight: number;
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
  mode: 'desktop' | 'mobile';
  width: number;
}

const viewportCases: ViewportCase[] = [
  { height: 900, maximumRenderedItems: 300, mode: 'desktop', width: 1024 },
  { height: 844, maximumRenderedItems: 600, mode: 'mobile', width: 390 },
];

let desktopResult: ScrollResult | undefined;

test.describe.configure({ mode: 'serial' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wireString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value) && typeof value.s === 'string') {
    return value.s;
  }
  return;
};

const collectWireFieldValues = (value: unknown, fieldName: string, values: string[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWireFieldValues(item, fieldName, values);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const properties = value.p;
  if (isRecord(properties) && Array.isArray(properties.k) && Array.isArray(properties.v)) {
    for (const [index, key] of properties.k.entries()) {
      const propertyValue = properties.v[index];
      if (key === fieldName) {
        const stringValue = wireString(propertyValue);
        if (stringValue !== undefined) {
          values.push(stringValue);
        }
      }
      collectWireFieldValues(propertyValue, fieldName, values);
    }
  }
  if (Array.isArray(value.a)) {
    for (const item of value.a) {
      collectWireFieldValues(item, fieldName, values);
    }
  }
};

const readCapturedSessionPage = async (response: Response): Promise<CapturedSessionPage | undefined> => {
  const body = await response.body();
  if (!body.includes('session-query-v1:')) {
    return;
  }
  const serialized: unknown = JSON.parse(body.toString('utf8'));
  const fingerprints: string[] = [];
  const rowIds: string[] = [];
  collectWireFieldValues(serialized, 'requestFingerprint', fingerprints);
  collectWireFieldValues(serialized, 'rowId', rowIds);
  return {
    bytes: body.byteLength,
    fingerprints,
    rowIds,
    url: response.url(),
  };
};

const captureSessionPages = (page: Page): { finish: () => Promise<CapturedSessionPage[]> } => {
  const pendingPages: Promise<CapturedSessionPage | undefined>[] = [];
  const onResponse = (response: Response): void => {
    if (!new URL(response.url()).pathname.startsWith(SERVER_FUNCTION_PATH_PREFIX)) {
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

const readSurfaceSnapshot = (surface: Locator): Promise<SessionSurfaceSnapshot> =>
  surface.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('The Session surface must be an HTML scroll container');
    }
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-session-row-id][data-index]')).map((row) => ({
      index: Number(row.dataset.index),
      rowId: row.dataset.sessionRowId ?? '',
    }));
    return {
      clientHeight: element.clientHeight,
      rows,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });

const afterAnimationFrame = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );

const moveSurface = async (surface: Locator, target: 'end' | 'start' | number): Promise<void> => {
  await surface.evaluate((element, destination) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('The Session surface must be an HTML scroll container');
    }
    if (destination === 'start') {
      element.scrollTop = 0;
      return;
    }
    if (destination === 'end') {
      element.scrollTop = element.scrollHeight;
      return;
    }
    element.scrollTop = destination;
  }, target);
};

const assertPageBudgets = (
  capturedPages: CapturedSessionPage[],
  orderedRowIds: string[],
  requestFingerprint: string,
): { maximumBytes: number; pageCount: number } => {
  expect(capturedPages.length, 'At least one focused Session page must cross the production wire').toBeGreaterThan(0);
  const wireRowIds = new Set<string>();
  let maximumBytes = 0;
  for (const capturedPage of capturedPages) {
    maximumBytes = Math.max(maximumBytes, capturedPage.bytes);
    expect(capturedPage.bytes, `Session response exceeded its 2 MiB wire cap: ${capturedPage.url}`).toBeLessThanOrEqual(
      MAXIMUM_SESSION_RESPONSE_BYTES,
    );
    const uniquePageRowIds = new Set(capturedPage.rowIds);
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
    for (const fingerprint of capturedPage.fingerprints) {
      expect(fingerprint).toMatch(SESSION_QUERY_FINGERPRINT_PATTERN);
      expect(fingerprint).toBe(requestFingerprint);
    }
    for (const rowId of uniquePageRowIds) {
      wireRowIds.add(rowId);
    }
  }
  expect(wireRowIds).toEqual(new Set(orderedRowIds));
  return { maximumBytes, pageCount: capturedPages.length };
};

const inspectAllSessions = async (
  page: Page,
  viewportCase: ViewportCase,
  testInfo: TestInfo,
): Promise<ScrollResult> => {
  const capture = captureSessionPages(page);
  await page.setViewportSize({ height: viewportCase.height, width: viewportCase.width });
  await page.goto(SESSION_ROUTE);
  const report = page.locator('main[data-hydrated="true"]');
  await expect(report).toBeVisible();
  await expect(page.getByText('5,000 / 5,000 sessions', { exact: true })).toBeVisible();
  await expect(report).toHaveAttribute('data-request-fingerprint', SESSION_QUERY_FINGERPRINT_PATTERN);
  const requestFingerprint = await report.getAttribute('data-request-fingerprint');
  if (!requestFingerprint) {
    throw new Error('The production Session report must expose its request fingerprint');
  }

  const surface = page.locator(`[data-session-surface="${viewportCase.mode}"]`);
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
    expect(snapshot.rows.length).toBeLessThanOrEqual(viewportCase.maximumRenderedItems);
    const liveIndices = new Set(snapshot.rows.map(({ index }) => index));
    const liveRowIds = new Set(snapshot.rows.map(({ rowId }) => rowId));
    expect(liveIndices.size, 'A Session index must appear at most once in the live DOM').toBe(snapshot.rows.length);
    expect(liveRowIds.size, 'A Session row ID must appear at most once in the live DOM').toBe(snapshot.rows.length);
    for (const { index, rowId } of snapshot.rows) {
      if (!(Number.isSafeInteger(index) && index >= 0 && index < SESSION_SCROLL_EXPECTED_COUNT)) {
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

  let iteration = 0;
  while (indexToRowId.size < SESSION_SCROLL_EXPECTED_COUNT) {
    iteration += 1;
    if (iteration > MAXIMUM_SCROLL_ITERATIONS) {
      throw new Error(`Session traversal exceeded ${MAXIMUM_SCROLL_ITERATIONS} bounded scroll steps`);
    }
    const snapshot = await readSurfaceSnapshot(surface);
    recordSnapshot(snapshot);
    if (indexToRowId.size === SESSION_SCROLL_EXPECTED_COUNT) {
      break;
    }
    const maximumScrollTop = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
    const scrollStep = Math.max(1, Math.floor(snapshot.clientHeight * SCROLL_STEP_RATIO));
    const nextScrollTop = Math.min(maximumScrollTop, snapshot.scrollTop + scrollStep);
    if (nextScrollTop > snapshot.scrollTop) {
      await moveSurface(surface, nextScrollTop);
      await afterAnimationFrame(page);
      continue;
    }

    const previousHeight = snapshot.scrollHeight;
    const previousRowCount = indexToRowId.size;
    await expect
      .poll(
        async () => {
          const nextSnapshot = await readSurfaceSnapshot(surface);
          recordSnapshot(nextSnapshot);
          return nextSnapshot.scrollHeight > previousHeight || indexToRowId.size > previousRowCount;
        },
        {
          message: `Session scrolling stalled after reaching ${previousRowCount} of ${SESSION_SCROLL_EXPECTED_COUNT} rows`,
          timeout: MAXIMUM_STALLED_SCROLL_MS,
        },
      )
      .toBe(true);
  }

  const expectedIndices = Array.from({ length: SESSION_SCROLL_EXPECTED_COUNT }, (_, index) => index);
  expect([...indexToRowId.keys()].sort((left, right) => left - right)).toEqual(expectedIndices);
  expect(rowIdToIndex.size).toBe(SESSION_SCROLL_EXPECTED_COUNT);
  const orderedRowIds = expectedIndices.map((index) => {
    const rowId = indexToRowId.get(index);
    if (!rowId) {
      throw new Error(`Session index ${index} was not reachable`);
    }
    return rowId;
  });

  await moveSurface(surface, 'start');
  await expect(surface.locator('[data-index="0"]')).toHaveAttribute('data-session-row-id', orderedRowIds[0]);
  await moveSurface(surface, 'end');
  await expect(surface.locator(`[data-index="${SESSION_SCROLL_EXPECTED_COUNT - 1}"]`)).toHaveAttribute(
    'data-session-row-id',
    orderedRowIds[SESSION_SCROLL_EXPECTED_COUNT - 1],
  );
  await expect(report).toHaveAttribute('data-request-fingerprint', requestFingerprint);
  await expect(page.getByText('Loading more sessions…', { exact: true })).toHaveCount(0);

  const pageBudgets = assertPageBudgets(await capture.finish(), orderedRowIds, requestFingerprint);
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
        sessionsReached: orderedRowIds.length,
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
  test(`reaches every production Session exactly once on ${viewportCase.mode}`, async ({ page }, testInfo) => {
    const result = await inspectAllSessions(page, viewportCase, testInfo);
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
