import { readFile } from 'node:fs/promises';
import { parseSourceControlCommandResponse } from '@ai-usage/report-core/source-control';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page, Request, Response } from '@playwright/test';
import {
  expect,
  openHydratedReport,
  test,
  waitForFocusedReportSettled,
  waitForHydratedNavigation,
} from './browser-test';
import {
  addCampaignContinuityRevision,
  CONTINUITY_CHILD_COUNT,
  CONTINUITY_HOME_RECORD_ENV,
  CONTINUITY_ROOT_TITLE,
  DETAIL_EXPLORATION_COUNT,
  DETAIL_EXPLORATION_TITLE,
} from './campaign-continuity-fixture';
import { decodeRpcResponseBody, rpcStringFieldValues } from './rpc-test-transport';
import { afterAnimationFrame, sessionSurface } from './session-scroll-driver';
import { freezeSessionScrollCollectionSources } from './session-scroll-source-control';

const SESSIONS = '/?tab=sessions&range=all&origin=%5B%5D';
const DEEP_SESSIONS = `${SESSIONS}&q=${encodeURIComponent(DETAIL_EXPLORATION_TITLE)}`;
const CAMPAIGN = '/campaigns?range=all&q=Continuity%20root';
const FAR_CHILD = 'Continuity child 0359';
const LINK_PARENT = 'Continuity child 0250';
const LINK_CHILD = 'Continuity child 0013';
const ROUNDS = /^Rounds/;
const OPEN_SESSION = /^Open session/;
const MEMBERS = /^Members/;
const EXPLORATION_TITLE = /Detail exploration \d{4}/;
const FILTER_PROJECT = /^Filter project:/;
const FILTER_MODEL = /^Filter model:/;
const DETAIL_PATH = '/rpc/session/detail';
const LOOKUP_PATH = '/rpc/session/lookup';
const PAGE_PATH = '/rpc/session/page';
const CHILDREN_PATH = '/rpc/session/campaignChildren';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const drawerFor = (page: Page): Locator => page.getByRole('dialog', { name: 'Session details', exact: true });

const expectRounds = async (page: Page, title: string): Promise<void> => {
  const drawer = drawerFor(page);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('tab', { name: ROUNDS })).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.getByRole('list', { name: 'Rounds', exact: true })).toBeVisible();
  await expect(drawer.locator('[data-session-round-prompt]')).toContainText(title);
};

const reportRevision = async (page: Page): Promise<string> => {
  const revision = await page.locator('main[data-report-revision]').getAttribute('data-report-revision');
  if (!revision) {
    throw new Error('The visible report must expose its served revision');
  }
  return revision;
};

const detailResponse = (page: Page): Promise<Response> =>
  page.waitForResponse((response) => new URL(response.url()).pathname === DETAIL_PATH);

const expectResponseRevision = async (response: Response, revision: string): Promise<void> => {
  expect(response.ok()).toBe(true);
  expect(new Set(rpcStringFieldValues(await response.text(), 'revision'))).toEqual(new Set([revision]));
};

const wheel = async (page: Page, surface: Locator, delta = 4000): Promise<void> => {
  await surface.hover();
  await page.mouse.wheel(0, delta);
  await afterAnimationFrame(page);
};

const anchorFor = async (surface: Locator, selector: string, attribute: string) => {
  const read = async () =>
    await surface.evaluate(
      (element, input) => {
        const bounds = element.getBoundingClientRect();
        const top = Math.max(
          bounds.top,
          ...[...element.querySelectorAll('thead th')].map((cell) => cell.getBoundingClientRect().bottom),
        );
        const row = [...element.querySelectorAll<HTMLElement>(input.selector)].find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.bottom > top && box.top < bounds.bottom;
        });
        const key = row?.getAttribute(input.attribute);
        return row && key ? { key, offset: row.getBoundingClientRect().top - bounds.top } : null;
      },
      { attribute, selector },
    );
  let previous: Awaited<ReturnType<typeof read>> = null;
  await expect
    .poll(async () => {
      const current = await read();
      const settled =
        current !== null && previous?.key === current.key && Math.abs(previous.offset - current.offset) < 1;
      previous = current;
      return settled;
    })
    .toBe(true);
  const anchor = await read();
  if (!anchor) {
    throw new Error('The visible exploration anchor disappeared');
  }
  return anchor;
};

const captureSessionTraffic = (page: Page) => {
  const requests: Request[] = [];
  const responses: Promise<{ pathname: string; body: string }>[] = [];
  const observeRequest = (request: Request): void => {
    if (new URL(request.url()).pathname.startsWith('/rpc/session/')) {
      requests.push(request);
    }
  };
  const observeResponse = (response: Response): void => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/rpc/session/')) {
      responses.push(response.text().then((body) => ({ pathname, body })));
    }
  };
  page.on('request', observeRequest);
  page.on('response', observeResponse);
  return {
    count: (pathname: string) => requests.filter((request) => new URL(request.url()).pathname === pathname).length,
    finish: async () => {
      page.off('request', observeRequest);
      page.off('response', observeResponse);
      const captured = await Promise.all(responses);
      for (const { pathname, body } of captured) {
        if (![PAGE_PATH, CHILDREN_PATH, LOOKUP_PATH].includes(pathname)) {
          continue;
        }
        expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
        const result = decodeRpcResponseBody(body);
        if (!(isRecord(result) && isRecord(result.data))) {
          throw new Error('A successful Session acquisition must expose its bounded result');
        }
        if (Array.isArray(result.data.items)) {
          expect(result.data.items.length).toBeLessThanOrEqual(pathname === CHILDREN_PATH ? 100 : 200);
        }
      }
      return captured;
    },
  };
};

/** Discover an opaque identity through the real campaign search, then reload its direct Session URL. */
const discoverFarSession = async (page: Page): Promise<string> => {
  await page.goto('/campaigns?range=all&q=Continuity%20child%200359');
  await waitForHydratedNavigation(page);
  await page.getByRole('button', { name: `Open matching session ${FAR_CHILD}`, exact: true }).click();
  await expectRounds(page, FAR_CHILD);
  const url = new URL(page.url());
  const rowId =
    url.searchParams.get('selectedSession') ??
    (url.pathname.startsWith('/sessions/') ? decodeURIComponent(url.pathname.slice('/sessions/'.length)) : null);
  if (!rowId) {
    throw new Error('The selected campaign child must have a URL-addressable Session identity');
  }
  return rowId;
};

const directSessionUrl = (rowId: string): string =>
  `/sessions/${encodeURIComponent(rowId)}?tab=sessions&range=all&origin=%5B%5D`;

const publishRevision = async (request: APIRequestContext, origin: string, batch: string): Promise<void> => {
  const recordPath = process.env[CONTINUITY_HOME_RECORD_ENV];
  if (!recordPath) {
    throw new Error('The continuity runner must provide its isolated fixture HOME');
  }
  const record: unknown = JSON.parse(await readFile(recordPath, 'utf8'));
  if (!(isRecord(record) && typeof record.home === 'string')) {
    throw new Error('Invalid continuity fixture HOME record');
  }
  await addCampaignContinuityRevision(record.home, batch);
  for (const command of [
    { command: 'set-enabled', enabled: true, sourceId: 'codex.sessions' },
    { command: 'run-now', sourceId: 'codex.sessions' },
  ]) {
    const response = await request.post('/api/source-control/command', { data: command, headers: { origin } });
    expect(parseSourceControlCommandResponse(await response.json()).ok).toBe(true);
  }
};

test.beforeEach(async ({ request, baseURL }) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
});

test('keeps a deeply acquired Sessions surface and anchor through Rounds, Back and Forward', async ({ page }) => {
  const traffic = captureSessionTraffic(page);
  await openHydratedReport(page, DEEP_SESSIONS);
  const surface = sessionSurface(page, 'desktop');
  const mountedSurface = await surface.elementHandle();
  const maximumIndex = () =>
    surface
      .locator('[data-session-index]')
      .evaluateAll((rows) => Math.max(-1, ...rows.map((row) => Number(row.getAttribute('data-session-index')))));
  await expect
    .poll(
      async () => {
        await wheel(page, surface);
        return await maximumIndex();
      },
      { message: 'Continuous scrolling must acquire the third Sessions page' },
    )
    .toBeGreaterThanOrEqual(400);
  expect(traffic.count(PAGE_PATH)).toBeGreaterThanOrEqual(2);
  expect(await surface.locator('[data-session-row-id]').count()).toBeLessThan(60);
  const anchor = await anchorFor(surface, '[data-session-row-id]', 'data-session-row-id');
  const row = surface.locator(`[data-session-row-id="${anchor.key}"]`);
  const visibleRowPoint = await row
    .locator('td')
    .first()
    .evaluate((cell) => {
      const bounds = cell.getBoundingClientRect();
      const viewport = cell.closest('[data-session-surface]');
      if (!viewport) {
        throw new Error('The selected Session must belong to the exploration viewport');
      }
      const viewportBounds = viewport.getBoundingClientRect();
      const top = Math.max(
        bounds.top,
        viewportBounds.top,
        ...[...viewport.querySelectorAll('thead th')].map((header) => header.getBoundingClientRect().bottom),
      );
      const bottom = Math.min(bounds.bottom, viewportBounds.bottom);
      const point = { x: bounds.left + bounds.width / 2, y: (top + bottom) / 2 };
      if (bottom <= top || document.elementFromPoint(point.x, point.y)?.closest('tr') !== cell.closest('tr')) {
        throw new Error('The visible Session click must hit its row below the sticky header');
      }
      return point;
    });
  await page.mouse.click(visibleRowPoint.x, visibleRowPoint.y);
  await expectRounds(page, DETAIL_EXPLORATION_TITLE);
  const detailUrl = page.url();
  await page.goBack();
  await expect(drawerFor(page)).toBeHidden();
  expect(await mountedSurface?.evaluate((element) => element.isConnected)).toBe(true);
  const restored = await anchorFor(surface, '[data-session-row-id]', 'data-session-row-id');
  expect(restored.key).toBe(anchor.key);
  expect(Math.abs(restored.offset - anchor.offset)).toBeLessThanOrEqual(2);
  await expect(row).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(detailUrl);
  await expectRounds(page, DETAIL_EXPLORATION_TITLE);
  await page.keyboard.press('Escape');
  await expect(drawerFor(page)).toBeHidden();
  expect(traffic.count(PAGE_PATH)).toBe(2);
  await traffic.finish();
  await expect(
    page.getByText(
      `Represents ${DETAIL_EXPLORATION_COUNT} of ${DETAIL_EXPLORATION_COUNT} filtered sessions · ${DETAIL_EXPLORATION_COUNT} of ${DETAIL_EXPLORATION_COUNT} campaign rows loaded`,
      { exact: true },
    ),
  ).toBeVisible();
});

test('follows a linked child from Rounds and returns to the virtualized Agent Map at the same revision', async ({
  page,
}) => {
  await page.goto(CAMPAIGN);
  await waitForHydratedNavigation(page);
  const revision = await reportRevision(page);
  const map = page.locator('[data-campaign-scroll="map"]');
  const parent = map.getByRole('button', { name: `Open session ${LINK_PARENT}`, exact: true });
  for (let step = 0; step < 70 && !(await parent.isVisible()); step++) {
    await wheel(page, map, 600);
  }
  await expect(parent).toBeVisible();
  expect(Number(await map.getAttribute('data-loaded-rows'))).toBeGreaterThan(100);
  expect(await map.locator('[data-campaign-node]').count()).toBeLessThanOrEqual(80);
  await parent.focus();
  const anchor = await anchorFor(map, '[data-campaign-node]', 'data-row-id');
  const mapUrl = page.url();
  const loaded = detailResponse(page);
  await page.keyboard.press('Enter');
  await expectRounds(page, LINK_PARENT);
  await expectResponseRevision(await loaded, revision);
  const unassigned = drawerFor(page).locator('[data-session-rounds-unrounded]');
  await expect(unassigned).toBeVisible();
  await unassigned.locator('summary').click();
  const childLoaded = detailResponse(page);
  await unassigned.getByRole('button', { name: 'Open session', exact: true }).click();
  await expectRounds(page, LINK_CHILD);
  await expectResponseRevision(await childLoaded, revision);
  const childUrl = page.url();
  await page.goBack();
  await expect(page).toHaveURL(mapUrl);
  await expect(drawerFor(page)).toBeHidden();
  await expect(parent).toBeFocused();
  const restored = await anchorFor(map, '[data-campaign-node]', 'data-row-id');
  expect(restored.key).toBe(anchor.key);
  expect(Math.abs(restored.offset - anchor.offset)).toBeLessThanOrEqual(2);
  expect(await reportRevision(page)).toBe(revision);
  await page.goForward();
  await expect(page).toHaveURL(childUrl);
  await expectRounds(page, LINK_CHILD);
});

test('returns from Timeline Rounds with the same campaign, axis and exact revision', async ({ page }) => {
  await page.goto(`${CAMPAIGN}&campaignView=timeline`);
  await waitForHydratedNavigation(page);
  const revision = await reportRevision(page);
  const timeline = page.locator('[data-project-timeline]');
  const axis = {
    start: await timeline.getAttribute('data-axis-start'),
    end: await timeline.getAttribute('data-axis-end'),
  };
  const before = page.url();
  const trigger = page.locator('[data-timeline-session]').getByRole('button', { name: OPEN_SESSION }).first();
  const loaded = detailResponse(page);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(drawerFor(page).getByRole('list', { name: 'Rounds', exact: true })).toBeVisible();
  await expectResponseRevision(await loaded, revision);
  await page.goBack();
  await expect(page).toHaveURL(before);
  await expect(drawerFor(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(timeline).toHaveAttribute('data-axis-start', axis.start!);
  await expect(timeline).toHaveAttribute('data-axis-end', axis.end!);
  expect(await reportRevision(page)).toBe(revision);
});

test('loads and reloads a far Session URL from SSR without duplicate lookup or unrelated keyboard navigation', async ({
  page,
}) => {
  const rowId = await discoverFarSession(page);
  await openHydratedReport(page, DEEP_SESSIONS);
  const precedingUrl = page.url();
  for (const load of ['direct', 'reload'] as const) {
    const traffic = captureSessionTraffic(page);
    const response = load === 'direct' ? await page.goto(directSessionUrl(rowId)) : await page.reload();
    expect(response?.ok()).toBe(true);
    const html = await response!.text();
    expect(html).toContain('data-route-shell="report"');
    expect(html).toContain('session-lookup');
    expect(html).toContain(rowId);
    expect(html).not.toContain('Synthetic demonstration');
    await expectRounds(page, FAR_CHILD);
    const revision = await reportRevision(page);
    await expect(sessionSurface(page, 'desktop')).toBeVisible();
    await expect(sessionSurface(page, 'desktop').locator(`[data-session-row-id="${rowId}"]`)).toHaveCount(0);
    const selectedUrl = page.url();
    await expect(drawerFor(page).getByRole('button', { name: 'Next session (j)', exact: true })).toBeDisabled();
    await expect(drawerFor(page).getByRole('button', { name: 'Previous session (k)', exact: true })).toBeDisabled();
    await drawerFor(page).getByRole('button', { name: 'Close session details', exact: true }).focus();
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    await expect(page).toHaveURL(selectedUrl);
    await expectRounds(page, FAR_CHILD);
    // The first Sessions page comes from SSR; an address outside it must not page through history.
    expect(traffic.count(PAGE_PATH)).toBe(0);
    expect(traffic.count(LOOKUP_PATH)).toBe(0);
    expect(traffic.count(DETAIL_PATH)).toBe(1);
    const responses = await traffic.finish();
    for (const captured of responses.filter(({ pathname }) => [LOOKUP_PATH, DETAIL_PATH].includes(pathname))) {
      expect(new Set(rpcStringFieldValues(captured.body, 'revision'))).toEqual(new Set([revision]));
    }
  }
  await page.keyboard.press('Escape');
  await expect(drawerFor(page)).toBeHidden();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(sessionSurface(page, 'desktop')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(precedingUrl);
  await expect(drawerFor(page)).toBeHidden();
});

test('hydrates a directly addressed campaign outside the acquired report filters without a browser lookup', async ({
  page,
}) => {
  await discoverFarSession(page);
  const campaignKey = new URL(page.url()).searchParams.get('selectedCampaign');
  expect(campaignKey).toBeTruthy();
  const directUrl = `/campaigns/${encodeURIComponent(campaignKey!)}?tab=sessions&range=all&q=unmatched-direct-campaign-filter`;
  for (const load of ['direct', 'reload'] as const) {
    const traffic = captureSessionTraffic(page);
    const response = load === 'direct' ? await page.goto(directUrl) : await page.reload();
    expect(response?.ok()).toBe(true);
    const html = await response!.text();
    expect(html).toContain('session-page');
    expect(html).toContain(campaignKey!);
    expect(html).not.toContain('"prompt-1"');
    await expectRounds(page, CONTINUITY_ROOT_TITLE);
    const revision = await reportRevision(page);
    expect(traffic.count(PAGE_PATH)).toBe(0);
    expect(traffic.count(LOOKUP_PATH)).toBe(0);
    expect(traffic.count(DETAIL_PATH)).toBe(1);
    for (const captured of await traffic.finish()) {
      if (captured.pathname === DETAIL_PATH) {
        expect(new Set(rpcStringFieldValues(captured.body, 'revision'))).toEqual(new Set([revision]));
      }
    }
  }
});

test('recovers one failed Session details chunk only after an explicit reload at the same identity', async ({
  page,
  browserFailureGate,
  baseURL,
}) => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../.svelte-kit/build/output/client/.vite/manifest.json', import.meta.url), 'utf8'),
  );
  const drawerChunk = isRecord(manifest)
    ? manifest['src/lib/features/sessions/detail/session-detail-members-query-slot.svelte']
    : undefined;
  if (!(isRecord(drawerChunk) && typeof drawerChunk.file === 'string')) {
    throw new Error('The built manifest must identify the lazy Session details chunk');
  }
  const pathname = `/${drawerChunk.file}`;
  const verifyExpectedFailure = browserFailureGate.allowScriptResponseOnce({
    url: new URL(pathname, baseURL).href,
    status: 503,
  });
  let chunkRequests = 0;
  let documentRequests = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'document') {
      documentRequests++;
    }
  });
  await page.route(`**${pathname}`, async (route) => {
    chunkRequests++;
    if (chunkRequests === 1) {
      await route.fulfill({ status: 503, contentType: 'text/javascript', body: '' });
      return;
    }
    await route.continue();
  });
  try {
    await openHydratedReport(page, DEEP_SESSIONS);
    const main = await page.locator('main[data-route-shell="report"]').elementHandle();
    const documentsBeforeOpen = documentRequests;
    const revision = await reportRevision(page);
    await sessionSurface(page, 'desktop').locator('[data-session-row-id]').first().locator('td').first().click();
    const reload = page.getByRole('button', { name: 'Reload session details', exact: true });
    await expect(reload).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe('/');
    const selectedUrl = page.url();
    expect(chunkRequests).toBe(1);
    expect(documentRequests).toBe(documentsBeforeOpen);
    expect(await main?.evaluate((element) => element.isConnected)).toBe(true);
    await reload.click();
    await expectRounds(page, DETAIL_EXPLORATION_TITLE);
    await expect(page).toHaveURL(selectedUrl);
    expect(await reportRevision(page)).toBe(revision);
    expect(chunkRequests).toBe(2);
    expect(documentRequests).toBe(documentsBeforeOpen + 1);
  } finally {
    verifyExpectedFailure();
  }
});

test('keeps Session B selected when the detail for previously selected A arrives late', async ({ page }) => {
  await openHydratedReport(page, DEEP_SESSIONS);
  const surface = sessionSurface(page, 'desktop');
  const first = surface.locator('[data-session-row-id]').nth(0);
  const second = surface.locator('[data-session-row-id]').nth(1);
  const rowId = await first.getAttribute('data-session-row-id');
  const titleA = (await first.innerText()).match(EXPLORATION_TITLE)?.[0];
  const titleB = (await second.innerText()).match(EXPLORATION_TITLE)?.[0];
  if (!(rowId && titleA && titleB && titleA !== titleB)) {
    throw new Error('The real Sessions table must expose two distinct sessions');
  }
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let held = false;
  await page.route('**/rpc/session/detail**', async (route) => {
    const input = route.request().postData() ?? new URL(route.request().url()).searchParams.get('data');
    if (input === null) {
      throw new Error('Session detail must identify its requested row');
    }
    if (!rpcStringFieldValues(input, 'rowId').includes(rowId)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    held = true;
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  try {
    await first.locator('td').first().click();
    await expect.poll(() => held).toBe(true);
    await expect(drawerFor(page)).toBeVisible();
    await second.locator('td').first().click();
    await expectRounds(page, titleB);
    const selectedUrl = page.url();
    release.resolve();
    await delivered.promise;
    await afterAnimationFrame(page);
    await afterAnimationFrame(page);
    await expect(page).toHaveURL(selectedUrl);
    await expectRounds(page, titleB);
    await expect(drawerFor(page).locator('[data-session-round-prompt]')).not.toContainText(titleA);
  } finally {
    release.resolve();
  }
});

test('pins Sessions Rounds through a real publication until Close and Apply new data', async ({
  page,
  request,
  baseURL,
}) => {
  await openHydratedReport(page, DEEP_SESSIONS);
  const explorationUrl = page.url();
  const surface = sessionSurface(page, 'desktop');
  const selectedRow = surface.locator('[data-session-row-id]').first();
  const rowId = await selectedRow.getAttribute('data-session-row-id');
  const title = (await selectedRow.innerText()).match(EXPLORATION_TITLE)?.[0];
  if (!(rowId && title)) {
    throw new Error('The selected Session must have an identity and prompt title');
  }
  await selectedRow.locator('td').first().click();
  await expectRounds(page, title);
  await expect.poll(() => new URL(page.url()).pathname).not.toBe('/');
  const selectedPath = new URL(page.url()).pathname;
  const originalRevision = await reportRevision(page);
  const prompt = await drawerFor(page).locator('[data-session-round-prompt]').elementHandle();
  try {
    await publishRevision(request, baseURL!, 'detail-integration');
    const apply = page.getByRole('button', { name: 'Apply new session data', exact: true });
    await expect(apply).toBeVisible();
    await expect(apply).toBeDisabled();
    expect(await reportRevision(page)).toBe(originalRevision);
    expect(await prompt?.evaluate((element) => element.isConnected)).toBe(true);
    await expectRounds(page, title);
    await drawerFor(page).getByRole('tab', { name: 'Summary', exact: true }).click();
    for (const field of [FILTER_PROJECT, FILTER_MODEL]) {
      const previousUrl = page.url();
      await drawerFor(page).getByRole('button', { name: field }).click();
      await expect.poll(() => page.url()).not.toBe(previousUrl);
      await waitForFocusedReportSettled(page);
      expect(await reportRevision(page)).toBe(originalRevision);
      await expect(apply).toBeDisabled();
    }
    await drawerFor(page).getByRole('tab', { name: ROUNDS }).click();
    await expectRounds(page, title);
    const filteredDetailUrl = page.url();
    await drawerFor(page).getByRole('button', { name: 'Close session details', exact: true }).click();
    await expect(drawerFor(page)).toBeHidden();
    await expect(page).toHaveURL(explorationUrl);
    expect(await reportRevision(page)).toBe(originalRevision);
    await page.goForward();
    await expect(page).toHaveURL(filteredDetailUrl);
    await expectRounds(page, title);
    expect(await reportRevision(page)).toBe(originalRevision);
    await drawerFor(page).getByRole('button', { name: 'Close session details', exact: true }).click();
    await expect(drawerFor(page)).toBeHidden();
    await expect(page).toHaveURL(explorationUrl);
    expect(await reportRevision(page)).toBe(originalRevision);
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect.poll(() => reportRevision(page)).not.toBe(originalRevision);
    const revision = await reportRevision(page);
    const refreshed = detailResponse(page);
    await surface.locator(`[data-session-row-id="${rowId}"]`).locator('td').first().click();
    await expectRounds(page, title);
    await expectResponseRevision(await refreshed, revision);
    await expect.poll(() => new URL(page.url()).pathname).toBe(selectedPath);
  } finally {
    await freezeSessionScrollCollectionSources(request, baseURL!);
  }
});

test('keeps campaign Members acquisition bounded and supports opening a member from the panel', async ({ page }) => {
  await page.goto(CAMPAIGN);
  await waitForHydratedNavigation(page);
  const campaignKey = await page.locator('[data-campaign-card]').first().getAttribute('data-campaign-key');
  expect(campaignKey).toBeTruthy();
  const traffic = captureSessionTraffic(page);
  await openHydratedReport(page, `/campaigns/${encodeURIComponent(campaignKey!)}?tab=sessions&range=all&origin=%5B%5D`);
  await expectRounds(page, CONTINUITY_ROOT_TITLE);
  const revision = await reportRevision(page);
  await drawerFor(page).getByRole('tab', { name: MEMBERS }).click();
  const members = drawerFor(page).locator('[data-session-drawer-members]');
  const rows = members.locator('[data-campaign-session-row-id]');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeLessThan(40);
  await expect(members.locator('[data-campaign-scroll="list"]')).toHaveAttribute('data-loaded-rows', '101');
  await expect(members.locator('[data-campaign-session-counts]')).toContainText(
    `101 / ${CONTINUITY_CHILD_COUNT + 1} sessions loaded`,
  );
  const initialRequests = traffic.count(PAGE_PATH) + traffic.count(CHILDREN_PATH);
  expect(initialRequests).toBeLessThanOrEqual(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawerFor(page)).toHaveAttribute('aria-modal', 'true');
  await expect(members.locator('[data-campaign-scroll="list"]')).toBeVisible();
  expect(await rows.count()).toBeLessThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const member = rows.filter({ hasText: 'Continuity child' }).first();
  const loaded = detailResponse(page);
  await member.click();
  await expect(drawerFor(page).getByRole('tab', { name: ROUNDS })).toHaveAttribute('aria-selected', 'true');
  await expect(drawerFor(page).locator('[data-session-round-prompt]')).toContainText('Continuity child');
  await expectResponseRevision(await loaded, revision);
  await traffic.finish();
});

test('keeps mobile Rounds modal and restores focus after the original virtual row leaves the DOM', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHydratedReport(page, DEEP_SESSIONS);
  const mobile = sessionSurface(page, 'mobile');
  await expect(mobile).toBeVisible();
  await expect(sessionSurface(page, 'desktop')).toBeHidden();
  const row = mobile.locator('[data-session-row-id]').first();
  const rowId = await row.getAttribute('data-session-row-id');
  await row.locator('[data-session-index]').focus();
  await page.keyboard.press('Enter');
  await expectRounds(page, DETAIL_EXPLORATION_TITLE);
  const drawer = drawerFor(page);
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  const motion = await drawer.evaluate(async (element) => {
    const animations = element.getAnimations();
    const before = {
      opacity: getComputedStyle(element).opacity,
      animations: animations.map((animation) => ({
        currentTime: animation.currentTime,
        playState: animation.playState,
      })),
    };
    await Promise.all(animations.map((animation) => animation.finished));
    return { before, settledOpacity: getComputedStyle(element).opacity };
  });
  await test.info().attach('drawer-motion-before-axe', {
    body: JSON.stringify(motion),
    contentType: 'application/json',
  });
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.flatMap(({ target }) => target) })),
  ).toEqual([]);
  // Programmatic scroll while modal is open deliberately unmounts its former trigger.
  // The user must still be able to close and recover a meaningful exploration focus.
  await mobile.evaluate((element) => {
    element.scrollTop = 12_000;
  });
  await expect(mobile.locator(`[data-session-row-id="${rowId}"]`)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(mobile).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return (
          active instanceof HTMLElement &&
          active.isConnected &&
          active !== document.body &&
          (active.matches('[data-session-surface]') || active.closest('[data-session-surface]') !== null)
        );
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('restores visible focus after closing a directly addressed Campaign Session on mobile', async ({ page }) => {
  const rowId = await discoverFarSession(page);
  const campaignKey = new URL(page.url()).searchParams.get('selectedCampaign');
  if (!campaignKey) {
    throw new Error('Campaign search must expose the selected campaign identity');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const traffic = captureSessionTraffic(page);
  const response = await page.goto(
    `/campaigns?range=all&selectedCampaign=${encodeURIComponent(campaignKey)}&selectedSession=${encodeURIComponent(rowId)}`,
  );
  expect(response?.ok()).toBe(true);
  const html = await response!.text();
  expect(html).toContain('session-lookup');
  expect(html).toContain(rowId);
  await expectRounds(page, FAR_CHILD);
  expect(traffic.count(LOOKUP_PATH)).toBe(0);
  expect(traffic.count(DETAIL_PATH)).toBe(1);
  await expect(drawerFor(page)).toHaveAttribute('aria-modal', 'true');
  const mapVisible = await page.locator('[data-campaign-scroll="map"]').isVisible();
  await drawerFor(page).getByRole('button', { name: 'Close session details', exact: true }).click();
  await expect(drawerFor(page)).toBeHidden();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return (
            active instanceof HTMLElement &&
            active !== document.body &&
            active.isConnected &&
            active.getClientRects().length > 0 &&
            getComputedStyle(active).visibility !== 'hidden' &&
            active.closest('[hidden], [inert]') === null
          );
        }),
      )
      .toBe(true);
  } finally {
    const focus = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML.slice(0, 1000),
      scrollTop: document.scrollingElement?.scrollTop,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }));
    await test.info().attach('mobile-campaign-close-focus', {
      body: JSON.stringify({ ...focus, mapVisible, url: page.url() }),
      contentType: 'application/json',
    });
    await traffic.finish();
  }
});
