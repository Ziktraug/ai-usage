import { readFile, writeFile } from 'node:fs/promises';
import { parseSourceControlCommandResponse } from '@ai-usage/report-core/source-control';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page, Request, Response, TestInfo } from '@playwright/test';
import { expect, test, waitForHydratedNavigation } from './browser-test';
import {
  addCampaignContinuityRevision,
  CONTINUITY_CAMPAIGN_COUNT,
  CONTINUITY_CHILD_COUNT,
  CONTINUITY_HOME_RECORD_ENV,
  CONTINUITY_ROOT_TITLE,
} from './campaign-continuity-fixture';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';
import { freezeSessionScrollCollectionSources } from './session-scroll-source-control';

const LIST_ROUTE = '/campaigns?range=all&q=Continuity';
const PAGE_PATH = '/rpc/session/page';
const CHILDREN_PATH = '/rpc/session/campaignChildren';
const BOOTSTRAP_PATH = '/rpc/report/revisionBootstrap';
const BOOTSTRAP_GLOB = '**/rpc/report/revisionBootstrap**';
const BOOTSTRAP_UNAVAILABLE = 'The current fixture revision is temporarily unavailable.';
const OPEN_SESSION_PATTERN = /^Open session/;
const RETRY_PATTERN = /Retry/;
const REFRESH_PATTERN = /^Apply new data$/;
const MAX_MOUNTED_CAMPAIGNS = 60;
const MAX_MOUNTED_SESSIONS = 80;

const saveMeasurements = async (testInfo: TestInfo, name: string, measurements: unknown): Promise<void> => {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(measurements, null, 2));
  await testInfo.attach(name, { contentType: 'application/json', path });
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

interface PageObservation {
  readonly bytes: number;
  readonly identities: string[];
  readonly milliseconds: number;
  readonly networkMilliseconds: number;
  readonly pathname: string;
  readonly requestStartedAt: number;
  readonly responseReceivedAt: number;
  readonly revision: string;
  readonly startedAt: number;
}

const captureAcquisition = async (page: Page) => {
  await page.addInitScript(() => {
    const appearances: Record<string, number> = {};
    Object.assign(window, { campaignTestAppearances: appearances });
    const observer = new MutationObserver(() => {
      if (Object.keys(appearances).length >= 1024) {
        observer.disconnect();
        return;
      }
      for (const row of document.querySelectorAll(
        '[data-campaign-card], [data-campaign-node], [data-timeline-campaign]',
      )) {
        const key = row.getAttribute('data-row-id') ?? row.getAttribute('data-campaign-key');
        if (key && appearances[key] === undefined) {
          appearances[key] = Date.now();
        }
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  const started = new Map<Request, number>();
  const active = new Set<string>();
  const repeatedConcurrent: string[] = [];
  const responses: Promise<PageObservation>[] = [];
  const requestIdentity = (request: Request): string => `${request.url()} ${request.postData() ?? ''}`;
  const onRequest = (request: Request): void => {
    if (![PAGE_PATH, CHILDREN_PATH].includes(new URL(request.url()).pathname)) {
      return;
    }
    started.set(request, performance.now());
    const key = requestIdentity(request);
    if (active.has(key)) {
      repeatedConcurrent.push(key);
    }
    active.add(key);
  };
  const onResponse = (response: Response): void => {
    const request = response.request();
    const start = started.get(request);
    if (start === undefined) {
      return;
    }
    responses.push(
      (async () => {
        const body = await response.body();
        await response.finished();
        const timing = request.timing();
        active.delete(requestIdentity(request));
        const decoded = decodeRpcResponseBody(body.toString());
        const result = isRecord(decoded) && isRecord(decoded.data) ? decoded.data : null;
        if (!(isRecord(decoded) && result && Array.isArray(result.items) && typeof decoded.revision === 'string')) {
          throw new Error('Campaign acquisition must return a revision and bounded items');
        }
        const identities = result.items.map((item: unknown) => {
          if (!isRecord(item)) {
            throw new Error('Campaign acquisition item must be identified');
          }
          const key = new URL(request.url()).pathname === PAGE_PATH ? item.campaignKey : item.rowId;
          if (typeof key !== 'string') {
            throw new Error('Campaign acquisition item has no stable identity');
          }
          return key;
        });
        return {
          bytes: body.byteLength,
          identities,
          milliseconds: Math.round(performance.now() - start),
          networkMilliseconds: Math.round(timing.responseEnd),
          pathname: new URL(request.url()).pathname,
          revision: decoded.revision,
          startedAt: start,
          requestStartedAt: timing.startTime,
          responseReceivedAt: timing.startTime + timing.responseEnd,
        };
      })(),
    );
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    count: () => started.size,
    finish: async () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      const observations = await Promise.all(responses);
      expect(repeatedConcurrent, 'one request per revision, scope and cursor at a time').toEqual([]);
      for (const observation of observations) {
        expect(observation.bytes).toBeLessThan(2 * 1024 * 1024);
        expect(observation.identities.length).toBeLessThanOrEqual(observation.pathname === PAGE_PATH ? 40 : 100);
        expect(new Set(observation.identities).size).toBe(observation.identities.length);
      }
      const appearances = await page.evaluate(() => {
        const candidate: unknown = 'campaignTestAppearances' in window ? window.campaignTestAppearances : null;
        return typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, number>) : {};
      });
      return observations.map((observation) => {
        const mounted = observation.identities
          .map((key) => appearances[key])
          .filter((at): at is number => at !== undefined && at >= observation.requestStartedAt);
        const firstMountedAt = mounted.length > 0 ? Math.min(...mounted) : null;
        return {
          ...observation,
          firstMountedAfterRequestMs:
            firstMountedAt === null ? null : Math.round(firstMountedAt - observation.requestStartedAt),
          firstMountedAfterResponseMs:
            firstMountedAt === null ? null : Math.round(firstMountedAt - observation.responseReceivedAt),
        };
      });
    },
  };
};

const frame = async (page: Page): Promise<void> => {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
};

const wheel = async (page: Page, surface: Locator, delta?: number): Promise<void> => {
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) {
    throw new Error('Campaign scroll surface must be visible');
  }
  const visibleTop = Math.max(0, box.y);
  const visibleBottom = Math.min(page.viewportSize()?.height ?? 720, box.y + box.height);
  await page.mouse.move(box.x + box.width / 2, visibleTop + Math.min((visibleBottom - visibleTop) / 2, 200));
  await page.mouse.wheel(0, delta ?? box.height * 0.7);
  await frame(page);
};

const openCampaigns = async (page: Page, url = LIST_ROUTE): Promise<void> => {
  await page.goto(url);
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await expect(page.locator('[data-app-navigation="mobile"][data-hydrated="true"]')).toBeVisible();
  } else {
    await waitForHydratedNavigation(page);
  }
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
};

const traverse = async (
  page: Page,
  surface: Locator,
  rowSelector: string,
  identityAttribute: string,
  expected: number,
  maximumMounted: number,
  observe?: () => Promise<void>,
) => {
  await expect(surface).toBeVisible();
  const seen = new Set<string>();
  const heap = async (): Promise<number | null> =>
    await page.evaluate(() => {
      const memory: unknown = 'memory' in performance ? performance.memory : null;
      return typeof memory === 'object' &&
        memory !== null &&
        'usedJSHeapSize' in memory &&
        typeof memory.usedJSHeapSize === 'number'
        ? memory.usedJSHeapSize
        : null;
    });
  const heapBefore = await heap();
  let mountedMaximum = 0;
  let lastProgressAt = performance.now();
  let previousCount = 0;
  const startedAt = performance.now();
  while (seen.size < expected) {
    await observe?.();
    const identities = await surface
      .locator(rowSelector)
      .evaluateAll(
        (elements, attribute) => elements.map((element) => element.getAttribute(attribute)),
        identityAttribute,
      );
    expect(identities.every(Boolean), 'every mounted row has its stable identity').toBe(true);
    expect(new Set(identities).size, 'mounted rows are unique').toBe(identities.length);
    expect(identities.length).toBeLessThanOrEqual(maximumMounted);
    mountedMaximum = Math.max(mountedMaximum, identities.length);
    for (const identity of identities) {
      seen.add(identity!);
    }
    if (seen.size > previousCount) {
      lastProgressAt = performance.now();
      previousCount = seen.size;
    }
    if (performance.now() - lastProgressAt > 10_000) {
      throw new Error(`Scrolling stopped progressing after ${seen.size}/${expected} distinct rows`);
    }
    if (seen.size < expected) {
      await wheel(page, surface);
    }
  }
  return {
    heapAfter: await heap(),
    heapBefore,
    identities: [...seen],
    milliseconds: Math.round(performance.now() - startedAt),
    mountedMaximum,
  };
};

const visibleAnchor = async (surface: Locator, selector: string, attribute: string) => {
  const read = async () =>
    await surface.evaluate(
      (element, input) => {
        const bounds = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>(input.selector)].find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.bottom > bounds.top + 1 && box.top < bounds.bottom - 1;
        });
        if (!row) {
          return null;
        }
        return { key: row.getAttribute(input.attribute), offset: row.getBoundingClientRect().top - bounds.top };
      },
      { attribute, selector },
    );
  let previous: Awaited<ReturnType<typeof read>> = null;
  await expect
    .poll(
      async () => {
        const current = await read();
        const settled =
          current !== null && previous?.key === current.key && Math.abs(previous.offset - current.offset) <= 0.5;
        previous = current;
        return settled;
      },
      { message: 'The first intersecting campaign row must settle before the anchor check' },
    )
    .toBe(true);
  const anchor = await read();
  if (!anchor) {
    throw new Error('The visible campaign anchor disappeared');
  }
  return anchor;
};

const publishContinuityRevision = async (request: APIRequestContext, baseURL: string, batch = 'new'): Promise<void> => {
  const recordPath = process.env[CONTINUITY_HOME_RECORD_ENV];
  if (!recordPath) {
    throw new Error('The continuity configuration must identify its isolated home');
  }
  const record: unknown = JSON.parse(await readFile(recordPath, 'utf8'));
  if (!(isRecord(record) && typeof record.home === 'string')) {
    throw new Error('Invalid isolated continuity home record');
  }
  await addCampaignContinuityRevision(record.home, batch);
  for (const command of [
    { command: 'set-enabled', enabled: true, sourceId: 'codex.sessions' },
    { command: 'run-now', sourceId: 'codex.sessions' },
  ]) {
    const response = await request.post('/api/source-control/command', {
      data: command,
      headers: { origin: baseURL },
    });
    expect(parseSourceControlCommandResponse(await response.json()).ok).toBe(true);
  }
};

test.beforeEach(async ({ request, baseURL }) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
});

test('scrolls every campaign once with bounded DOM and acquisition, then finds an unloaded child', async ({
  page,
}, testInfo) => {
  const traffic = await captureAcquisition(page);
  await openCampaigns(page);
  const list = page.locator('[data-campaign-scroll="list"]');
  const result = await traverse(
    page,
    list,
    '[data-campaign-card]',
    'data-campaign-key',
    CONTINUITY_CAMPAIGN_COUNT,
    MAX_MOUNTED_CAMPAIGNS,
  );
  expect(result.identities).toContain('production-e2e-machine:codex:continuity-campaign-0159');
  const observations = await traffic.finish();
  const acquired = observations.filter((entry) => entry.pathname === PAGE_PATH).flatMap((entry) => entry.identities);
  expect(new Set(acquired).size).toBe(acquired.length);
  expect(acquired.length).toBeGreaterThanOrEqual(120);
  await saveMeasurements(testInfo, 'campaign-continuous-scroll.json', { ...result, observations });

  await page.getByRole('searchbox', { name: 'Find a campaign', exact: true }).fill('Continuity child 0359');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('[data-campaign-card]')).toHaveCount(1);
  await expect(page.locator('[data-campaign-card]')).toContainText(CONTINUITY_ROOT_TITLE);
  await expect(page.getByText('Map scope: full campaign.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open matching session Continuity child 0359', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-session-round-prompt]')).toBeVisible();
  await expect(drawer.locator('[data-session-round-prompt]')).toHaveText('Continuity child 0359');
});

test('scrolls a large hierarchy and restores the same session anchor and keyboard focus after details', async ({
  page,
}, testInfo) => {
  const traffic = await captureAcquisition(page);
  await openCampaigns(page, `${LIST_ROUTE}%20root`);
  const map = page.locator('[data-campaign-scroll="map"]');
  const lateParentStates: Array<{ rowId: string | null; depth: string | null }> = [];
  const result = await traverse(
    page,
    map,
    '[data-campaign-node]',
    'data-row-id',
    CONTINUITY_CHILD_COUNT + 1,
    MAX_MOUNTED_SESSIONS,
    async () => {
      const lateChild = map.locator('[data-campaign-node]').filter({ hasText: 'Continuity child 0013' });
      lateParentStates.push(
        ...(await lateChild.evaluateAll((rows) =>
          rows.map((row) => ({
            rowId: row.getAttribute('data-row-id'),
            depth: row.getAttribute('data-depth'),
          })),
        )),
      );
    },
  );
  expect(new Set(lateParentStates.map(({ rowId }) => rowId)).size).toBe(1);
  expect(new Set(lateParentStates.map(({ depth }) => depth))).toEqual(new Set(['0', '2']));
  const anchor = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
  const row = map.locator(`[data-row-id="${anchor.key}"]`);
  const trigger = row.getByRole('button', { name: OPEN_SESSION_PATTERN });
  await trigger.focus();
  const beforeOpen = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  const restored = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
  await saveMeasurements(testInfo, 'campaign-drawer-anchors.json', { anchor, beforeOpen, restored });
  expect(restored.key).toBe(beforeOpen.key);
  expect(Math.abs(restored.offset - beforeOpen.offset)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Project timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Agent Map', exact: true }).click();
  await expect(map.locator(`[data-row-id="${anchor.key}"]`)).toBeVisible();
  const afterSwitch = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
  expect(afterSwitch.key).toBe(restored.key);
  expect(Math.abs(afterSwitch.offset - restored.offset)).toBeLessThanOrEqual(2);
  const observations = await traffic.finish();
  const children = observations
    .filter((entry) => entry.pathname === CHILDREN_PATH)
    .flatMap((entry) => entry.identities);
  expect(new Set(children).size).toBe(children.length);
  await saveMeasurements(testInfo, 'campaign-large-hierarchy.json', { ...result, observations });
  await page.screenshot({ path: testInfo.outputPath('campaign-desktop-continuity.png') });
});

for (const outcome of ['mismatched response', 'expired revision'] as const) {
  test(`suspends a ${outcome} frontier, retains its rows and resumes with a local Retry`, async ({
    page,
  }, testInfo) => {
    await openCampaigns(page);
    const list = page.locator('[data-campaign-scroll="list"]');
    const report = page.locator('main[data-route-shell="campaigns"]');
    await expect(report).toHaveAttribute('aria-busy', 'false');
    const release = Promise.withResolvers<void>();
    const recoveryRelease = Promise.withResolvers<void>();
    const geometry = async () =>
      await list.evaluate((host) => ({
        scrollTop: host.scrollTop,
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        top: host.getBoundingClientRect().top,
        footerHeight: host.lastElementChild?.getBoundingClientRect().height,
        loadedRows: host.getAttribute('data-loaded-rows'),
        focusedControl: document.activeElement?.tagName,
      }));
    let failureReady = false;
    let failureDelivered = false;
    let recoveryReady = false;
    let failedRequests = 0;
    let failedBootstraps = 0;
    if (outcome === 'expired revision') {
      await page.route(BOOTSTRAP_GLOB, async (route) => {
        // An initial source-publication event can still revalidate the hydrated bootstrap.
        // This failure belongs only to the refresh triggered by the rejected frontier.
        if (!failureDelivered) {
          await route.continue();
          return;
        }
        failedBootstraps++;
        const unavailable: ReportRevisionBootstrapResult = {
          error: { tag: 'RevisionUnavailable', message: BOOTSTRAP_UNAVAILABLE },
          ok: false,
          requestFingerprint: 'report-bootstrap:v1:{}',
        };
        await route.fulfill({ body: encodeRpcResponseBody(unavailable), contentType: 'application/json', status: 200 });
      });
    }
    await page.route('**/rpc/session/page**', async (route) => {
      failedRequests++;
      const response = await route.fetch();
      const decoded = decodeRpcResponseBody(await response.text());
      if (!isRecord(decoded)) {
        throw new Error('Expected a campaign page');
      }
      const failure =
        outcome === 'expired revision'
          ? {
              ok: false,
              revision: decoded.revision,
              requestFingerprint: decoded.requestFingerprint,
              error: {
                tag: 'RevisionExpired',
                revision: decoded.revision,
                message: 'The displayed fixture revision expired.',
              },
            }
          : { ...decoded, revision: 'wrong-frontier-revision' };
      failureReady = true;
      await release.promise;
      failureDelivered = true;
      await route.fulfill({ response, body: encodeRpcResponseBody(failure) });
    });
    try {
      for (let index = 0; index < 20 && failedRequests === 0; index++) {
        await wheel(page, list, 5000);
      }
      await expect.poll(() => failureReady, { message: 'Scrolling must acquire the intercepted frontier' }).toBe(true);
      const beforeFailure = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
      release.resolve();
      const retry = list.getByRole('button', { name: 'Retry campaigns', exact: true });
      await expect(retry).toBeVisible();
      await expect(list.locator('[data-campaign-card]').first()).toBeVisible();
      if (outcome === 'expired revision') {
        await expect(page.getByText(BOOTSTRAP_UNAVAILABLE, { exact: false })).toBeVisible();
        expect(failedBootstraps).toBe(1);
      }
      const afterFailure = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
      expect(afterFailure.key).toBe(beforeFailure.key);
      expect(Math.abs(afterFailure.offset - beforeFailure.offset)).toBeLessThanOrEqual(2);
      for (let index = 0; index < 5; index++) {
        await wheel(page, list, 5000);
      }
      // An intentional quiescence interval detects automatic retry loops after the rejected frontier.
      await page.waitForTimeout(1200);
      expect(failedRequests).toBe(1);
      await page.unroute('**/rpc/session/page**');
      await page.unroute(BOOTSTRAP_GLOB);
      await page.route('**/rpc/session/page**', async (route) => {
        const response = await route.fetch();
        recoveryReady = true;
        if (outcome === 'expired revision') {
          await recoveryRelease.promise;
        }
        await route.fulfill({ response });
      });
      const beforeRetry = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
      const beforeRetryGeometry = await geometry();
      await expect(retry).toBeEnabled();
      const recoveredBootstrap =
        outcome === 'expired revision'
          ? page.waitForResponse((response) => new URL(response.url()).pathname === BOOTSTRAP_PATH)
          : null;
      const acquired = page.waitForResponse((response) => new URL(response.url()).pathname === PAGE_PATH);
      await retry.click();
      if (recoveredBootstrap) {
        expect((await recoveredBootstrap).ok()).toBe(true);
      }
      await expect.poll(() => recoveryReady).toBe(true);
      const duringRetry = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
      const duringRetryGeometry = await geometry();
      recoveryRelease.resolve();
      expect((await acquired).ok()).toBe(true);
      await expect(page.getByRole('button', { name: RETRY_PATTERN })).toHaveCount(0);
      await expect(report).toHaveAttribute('aria-busy', 'false');
      const afterRetry = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
      await saveMeasurements(testInfo, 'campaign-retry-anchors.json', {
        beforeFailure,
        afterFailure,
        beforeRetry,
        beforeRetryGeometry,
        duringRetry,
        duringRetryGeometry,
        afterRetry,
        afterRetryGeometry: await geometry(),
      });
      expect(afterRetry.key).toBe(beforeRetry.key);
      expect(Math.abs(afterRetry.offset - beforeRetry.offset)).toBeLessThanOrEqual(2);
    } finally {
      release.resolve();
      recoveryRelease.resolve();
    }
  });
}

test('keeps a late page out of new search results', async ({ page }) => {
  await openCampaigns(page);
  const list = page.locator('[data-campaign-scroll="list"]');
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let intercepted = false;
  await page.route('**/rpc/session/page**', async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    const response = await route.fetch();
    blocked.resolve();
    await release.promise;
    await route.fulfill({ response });
    completed.resolve();
  });
  try {
    for (let index = 0; index < 20 && !intercepted; index++) {
      await wheel(page, list, 5000);
    }
    await blocked.promise;
    await page.getByRole('searchbox', { name: 'Find a campaign', exact: true }).fill('Continuity campaign 0159');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.locator('[data-campaign-card]')).toHaveCount(1);
    await expect(page.locator('[data-campaign-card]')).toContainText('Continuity campaign 0159');
    release.resolve();
    await completed.promise;
    await frame(page);
    await frame(page);
    await expect(page.locator('[data-campaign-card]')).toHaveCount(1);
    await expect(page.locator('[data-campaign-card]')).toContainText('Continuity campaign 0159');
  } finally {
    release.resolve();
  }
});

test('keeps the timeline axis fixed while campaigns append and avoids loading hidden descendants', async ({
  page,
}, testInfo) => {
  const traffic = await captureAcquisition(page);
  await openCampaigns(page, `${LIST_ROUTE}&campaignView=timeline`);
  const timeline = page.locator('[data-project-timeline]');
  const axis = {
    end: await timeline.getAttribute('data-axis-end'),
    start: await timeline.getAttribute('data-axis-start'),
  };
  await page.getByRole('button', { name: `Collapse sessions for ${CONTINUITY_ROOT_TITLE}`, exact: true }).click();
  const hiddenAt = performance.now();
  const surface = page.locator('[data-campaign-scroll="timeline"]');
  const result = await traverse(
    page,
    surface,
    '[data-timeline-campaign]',
    'data-campaign-key',
    CONTINUITY_CAMPAIGN_COUNT,
    MAX_MOUNTED_CAMPAIGNS,
  );
  await expect(timeline).toHaveAttribute('data-axis-start', axis.start!);
  await expect(timeline).toHaveAttribute('data-axis-end', axis.end!);
  const observations = await traffic.finish();
  expect(observations.filter((entry) => entry.pathname === CHILDREN_PATH && entry.startedAt >= hiddenAt)).toHaveLength(
    0,
  );
  expect(observations.filter((entry) => entry.pathname === CHILDREN_PATH).length).toBeLessThanOrEqual(1);
  await saveMeasurements(testInfo, 'campaign-timeline-continuity.json', { ...result, observations });
  await page.screenshot({ path: testInfo.outputPath('campaign-timeline-continuity.png') });
});

test('uses one mobile exploration viewport and preserves a measured session through resize', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCampaigns(page, `${LIST_ROUTE}%20root`);
  await page.getByRole('button', { name: 'View selected campaign', exact: true }).click();
  const map = page.locator('[data-campaign-scroll="map"]');
  await expect(map).toBeVisible();
  await expect(page.locator('[data-campaign-scroll="list"]')).toBeHidden();
  for (let index = 0; index < 25; index++) {
    await wheel(page, map);
  }
  const anchor = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
  const anchorRow = map.locator(`[data-row-id="${anchor.key}"]`);
  const resizeAnchors = [{ width: 390, ...anchor }];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const resized = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
    resizeAnchors.push({ width, ...resized });
    expect(resized.key).toBe(anchor.key);
    if (width === 390) {
      expect(
        Math.abs(resized.offset - anchor.offset),
        'Returning to the same width preserves the measured offset',
      ).toBeLessThanOrEqual(2);
    }
    const overflow = await page.evaluate(
      () =>
        Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(await map.locator('[data-campaign-node]').count()).toBeLessThanOrEqual(MAX_MOUNTED_SESSIONS);
  }
  await anchorRow.getByRole('button', { name: OPEN_SESSION_PATTERN }).focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(anchorRow.getByRole('button', { name: OPEN_SESSION_PATTERN })).toBeFocused();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.flatMap(({ target }) => target) })),
  ).toEqual([]);
  await saveMeasurements(testInfo, 'campaign-mobile-resize-anchors.json', resizeAnchors);
  await page.screenshot({ path: testInfo.outputPath('campaign-mobile-continuity.png') });
});

test('pins deep exploration through a real publication and explicitly restores it in the new revision', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  await openCampaigns(page);
  const list = page.locator('[data-campaign-scroll="list"]');
  const geometry = async () =>
    await list.evaluate((element) => ({
      scrollTop: element.scrollTop,
      viewportTop: element.getBoundingClientRect().top,
      outerTop: element.closest('[data-campaign-list]')?.getBoundingClientRect().top,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
  for (let index = 0; index < 45; index++) {
    await wheel(page, list);
  }
  const anchor = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
  const beforeMapGeometry = await geometry();
  const map = page.locator('[data-campaign-scroll="map"]');
  await traverse(page, map, '[data-campaign-node]', 'data-row-id', CONTINUITY_CHILD_COUNT + 1, MAX_MOUNTED_SESSIONS);
  expect(Number(await map.getAttribute('data-loaded-rows'))).toBeGreaterThanOrEqual(301);
  const afterMap = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
  const afterMapGeometry = await geometry();
  const sessionAnchor = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
  const report = page.locator('main[data-route-shell="campaigns"]');
  const revision = await report.getAttribute('data-report-revision');
  await publishContinuityRevision(request, baseURL!);
  const refresh = page.getByRole('button', { name: REFRESH_PATTERN });
  await expect(refresh).toBeVisible();
  await expect(report).toHaveAttribute('data-report-revision', revision!);
  const beforeApply = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
  await saveMeasurements(testInfo, 'campaign-revision-pinned-anchors.json', {
    anchor,
    afterMap,
    beforeApply,
    sessionAnchor,
    beforeMapGeometry,
    afterMapGeometry,
    beforeApplyGeometry: await geometry(),
  });
  expect(beforeApply.key).toBe(anchor.key);
  expect(Math.abs(beforeApply.offset - anchor.offset)).toBeLessThanOrEqual(2);
  await refresh.click();
  await expect(report).not.toHaveAttribute('data-report-revision', revision!);
  const restored = await visibleAnchor(list, '[data-campaign-card]', 'data-campaign-key');
  await saveMeasurements(testInfo, 'campaign-revision-list-anchors.json', {
    anchor,
    restored,
    restoredGeometry: await geometry(),
  });
  expect(restored.key).toBe(anchor.key);
  expect(Math.abs(restored.offset - anchor.offset)).toBeLessThanOrEqual(2);
  await expect(
    page
      .getByRole('region', { name: 'Agent Map', exact: true })
      .getByRole('heading', { name: CONTINUITY_ROOT_TITLE, exact: true }),
  ).toBeVisible();
  expect(Number(await map.getAttribute('data-loaded-rows'))).toBeGreaterThanOrEqual(301);
  const restoredSession = await visibleAnchor(map, '[data-campaign-node]', 'data-row-id');
  await saveMeasurements(testInfo, 'campaign-revision-session-anchors.json', { sessionAnchor, restoredSession });
  expect(restoredSession.key).toBe(sessionAnchor.key);
  expect(Math.abs(restoredSession.offset - sessionAnchor.offset)).toBeLessThanOrEqual(2);
  await freezeSessionScrollCollectionSources(request, baseURL!);
});

test('restores a far matching session through publication without replaying the full hierarchy', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  // This non-modal desktop path keeps the publication action beside the wide reader.
  await page.setViewportSize({ width: 1920, height: 1080 });
  const traffic = await captureAcquisition(page);
  await openCampaigns(page, `${LIST_ROUTE}%20child%200359`);
  const map = page.locator('[data-campaign-scroll="map"]');
  await expect(map).toHaveAttribute('data-loaded-rows', '101');
  await page.getByRole('button', { name: 'Open matching session Continuity child 0359', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer.locator('[data-session-round-prompt]')).toBeVisible();
  await expect(drawer.locator('[data-session-round-prompt]')).toHaveText('Continuity child 0359');
  const selectedSession = new URL(page.url()).searchParams.get('selectedSession');
  expect(selectedSession).toBeTruthy();
  const report = page.locator('main[data-route-shell="campaigns"]');
  const originalRevision = await report.getAttribute('data-report-revision');
  await publishContinuityRevision(request, baseURL!, 'matching-refresh');
  const refresh = page.getByRole('button', { name: REFRESH_PATTERN });
  await expect(refresh).toBeVisible();
  await expect(report).toHaveAttribute('data-report-revision', originalRevision!);
  await expect(refresh).toBeInViewport();
  const refreshHitTarget = await refresh.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return { bounds: bounds.toJSON(), hitsButton: target?.closest('button') === element, target: target?.outerHTML };
  });
  await testInfo.attach('publication-action-hit-target', {
    body: JSON.stringify(refreshHitTarget),
    contentType: 'application/json',
  });
  expect(refreshHitTarget.hitsButton).toBe(true);
  await refresh.click();
  await expect(report).not.toHaveAttribute('data-report-revision', originalRevision!);
  const revision = await report.getAttribute('data-report-revision');
  await expect(drawer.locator('[data-session-round-prompt]')).toBeVisible();
  await expect(drawer.locator('[data-session-round-prompt]')).toHaveText('Continuity child 0359');
  expect(new URL(page.url()).searchParams.get('selectedSession')).toBe(selectedSession);
  const observations = await traffic.finish();
  await saveMeasurements(testInfo, 'campaign-search-revision-continuity.json', {
    selectedSession,
    originalRevision,
    revision,
    observations,
  });
  await expect(map).toHaveAttribute('data-loaded-rows', '101');
  const restoredPages = observations.filter((entry) => entry.pathname === CHILDREN_PATH && entry.revision === revision);
  expect(restoredPages).toHaveLength(2);
  expect(restoredPages.map((entry) => entry.identities.length).sort((left, right) => left - right)).toEqual([1, 100]);
  expect(restoredPages.some((entry) => entry.identities.length === 1 && entry.identities[0] === selectedSession)).toBe(
    true,
  );
  await freezeSessionScrollCollectionSources(request, baseURL!);
});
