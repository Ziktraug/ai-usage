import { focusedRevisionFingerprint } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionQueryRequest,
  projectSessionCampaignChildren,
  projectSessionPage,
  type SessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import type { Locator, Page, Request } from '@playwright/test';
import { campaignMapFixtureRows } from '../src/campaign-map-fixture';
import { expect, test, waitForHydratedNavigation } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';
import { freezeSessionScrollCollectionSources } from './session-scroll-source-control';

const DAY_MS = 86_400_000;
const FIRST_DAY = '2026-10-04T12:00:00.000Z';
const NEXT_DAY = '2026-10-05T12:00:00.000Z';
const FIRST_REVISION = 'period-continuity-r1';
const NEXT_REVISION = 'period-continuity-r2';
const BOOTSTRAP_GLOB = '**/rpc/report/revisionBootstrap**';
const CAMPAIGNS = 'main[data-route-shell="campaigns"]';
const TIMELINE = '[data-project-timeline]';
const OLDER_CAMPAIGN = '[data-timeline-campaign][data-campaign-key*="period-older-"]';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const requestInput = (request: Request): unknown => {
  const serialized = request.postData() ?? new URL(request.url()).searchParams.get('data');
  if (serialized === null) {
    throw new Error('A Campaign RPC request must contain its exact query');
  }
  return decodeRpcResponseBody(serialized);
};

const periodRows = (generatedAt: string, older = true): SerializedRow[] => {
  const template = campaignMapFixtureRows[0];
  if (!template?.source) {
    throw new Error('The Campaign fixture must supply a root identity');
  }
  const source = template.source;
  const day = Date.parse(`${generatedAt.slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: older ? 80 : 1 }, (_, index) => {
    const previous = index >= 40;
    const id = `period-${previous ? 'older' : 'recent'}-${String(index).padStart(3, '0')}`;
    const start = day - (previous ? 5 * DAY_MS : 0) + 10 * 3_600_000 + index * 1000;
    const date = new Date(start).toISOString();
    const endDate = new Date(start + 3_600_000).toISOString();
    return {
      ...template,
      activeDate: endDate,
      date,
      durationMs: 3_600_000,
      endDate,
      name: id,
      project: 'Period continuity',
      sessionLabel: id,
      source: { ...source, rootSourceSessionId: id, sourceSessionId: id },
    };
  });
};

interface FixtureRevision {
  readonly generatedAt: string;
  readonly revision: string;
  readonly rows: SerializedRow[];
}

/** Keep the production UI, transport parsing and Query composition, with bounded clock-controlled report fixtures. */
const installPeriodFixture = async (page: Page, initial: FixtureRevision) => {
  let current = initial;
  let bootstrapCalls = 0;
  let pausedRevision = '';
  let release = (): void => undefined;
  let pause = Promise.resolve();
  const revisions = new Map([[initial.revision, initial]]);
  const acquisitions: SessionQueryRequest[] = [];
  const documents: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') {
      documents.push(request.url());
    }
  });
  await page.route(BOOTSTRAP_GLOB, async (route) => {
    bootstrapCalls += 1;
    const fixture = current;
    const response = await route.fetch();
    const original = decodeRpcResponseBody(await response.text());
    if (
      !(
        isRecord(original) &&
        original.ok === true &&
        isRecord(original.manifest) &&
        isRecord(original.bootstrap) &&
        isRecord(original.bootstrap.support)
      )
    ) {
      throw new Error('The isolated production report must have a valid bootstrap');
    }
    const body = {
      ...original,
      manifest: { ...original.manifest, generatedAt: fixture.generatedAt, revision: fixture.revision },
      bootstrap: {
        ...original.bootstrap,
        requestFingerprint: focusedRevisionFingerprint('support', { revision: fixture.revision }),
        revision: fixture.revision,
        support: { ...original.bootstrap.support, generatedAt: fixture.generatedAt },
      },
    };
    await route.fulfill({ response, body: encodeRpcResponseBody(body) });
  });
  const rowsFor = (revision: string): SerializedRow[] => {
    const fixture = revisions.get(revision);
    if (!fixture) {
      throw new Error(`Unexpected Campaign revision: ${revision}`);
    }
    return fixture.rows;
  };
  await page.route('**/rpc/session/page**', async (route) => {
    const query = parseSessionQueryRequest(requestInput(route.request()));
    acquisitions.push(query);
    if (query.revision === pausedRevision) {
      await pause;
    }
    const data = projectSessionPage(rowsFor(query.revision), query);
    await route.fulfill({
      body: encodeRpcResponseBody({
        data,
        ok: true,
        requestFingerprint: data.requestFingerprint,
        revision: data.revision,
      }),
      contentType: 'application/json',
    });
  });
  await page.route('**/rpc/session/campaignChildren**', async (route) => {
    const query = parseSessionCampaignChildrenRequest(requestInput(route.request()));
    const data = projectSessionCampaignChildren(rowsFor(query.query.revision), query);
    await route.fulfill({
      body: encodeRpcResponseBody({
        data,
        ok: true,
        requestFingerprint: data.requestFingerprint,
        revision: data.revision,
      }),
      contentType: 'application/json',
    });
  });
  return {
    acquisitions,
    bootstrapCalls: () => bootstrapCalls,
    documents,
    publish: (fixture: FixtureRevision) => {
      revisions.set(fixture.revision, fixture);
      current = fixture;
    },
    hold: (revision: string) => {
      pausedRevision = revision;
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
};

const enterTimeline = async (page: Page, range: string): Promise<void> => {
  await page.goto(`/projects?range=${encodeURIComponent(range)}`);
  await waitForHydratedNavigation(page);
  await page.locator('[data-app-navigation="desktop"]').getByRole('link', { name: 'Campaigns', exact: true }).click();
  await expect(page.locator(CAMPAIGNS)).toBeVisible();
  await expect(page.locator(CAMPAIGNS)).toHaveAttribute('data-report-revision', FIRST_REVISION);
  await page.getByRole('button', { name: 'Project timeline', exact: true }).click();
  await expect(page.locator(TIMELINE)).toBeVisible();
};

const readAxis = async (page: Page) => ({
  start: await page.locator(TIMELINE).getAttribute('data-axis-start'),
  end: await page.locator(TIMELINE).getAttribute('data-axis-end'),
});

const scrollTimeline = async (page: Page, delta: number): Promise<void> => {
  const surface = page.locator('[data-campaign-scroll="timeline"]');
  await surface.scrollIntoViewIfNeeded({ timeout: 10_000 });
  const box = await surface.boundingBox();
  if (!box) {
    throw new Error('Timeline scroll surface must be visible');
  }
  await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 100, (page.viewportSize()?.height ?? 720) - 40));
  await page.mouse.wheel(0, delta);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
};

const reachOlderCampaign = async (page: Page): Promise<Locator> => {
  for (let step = 0; step < 25 && (await page.locator(OLDER_CAMPAIGN).count()) === 0; step += 1) {
    await scrollTimeline(page, 700);
  }
  const key = await page.locator(OLDER_CAMPAIGN).first().getAttribute('data-campaign-key');
  const row = page.locator(`[data-timeline-campaign][data-campaign-key="${key}"]`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await expect(row).toBeInViewport();
  return row;
};

const refreshBootstrap = async (page: Page, generatedAt: string): Promise<void> => {
  await page.clock.setFixedTime(new Date(generatedAt));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
};

test.beforeEach(async ({ request, baseURL }) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
});

test('keeps a complete rolling-period axis while scrolling from recent to older campaigns', async ({ page }) => {
  const fixture = await installPeriodFixture(page, {
    generatedAt: FIRST_DAY,
    revision: FIRST_REVISION,
    rows: periodRows(FIRST_DAY),
  });
  await enterTimeline(page, '7d');
  const expected = { start: '2026-09-27T00:00:00.000Z', end: '2026-10-04T23:59:59.999Z' };
  await expect.poll(() => readAxis(page)).toEqual(expected);
  expect(fixture.acquisitions).toHaveLength(1);
  const firstRow = page.locator('[data-timeline-campaign]').first();
  const firstKey = await firstRow.getAttribute('data-campaign-key');
  const firstGeometry = await firstRow.locator('[data-timeline-campaign-bar]').getAttribute('style');
  const older = await reachOlderCampaign(page);
  await expect(older.locator('[data-timeline-campaign-bar]')).toBeVisible();
  expect(await readAxis(page)).toEqual(expected);
  expect(fixture.acquisitions).toHaveLength(2);
  expect(fixture.acquisitions.map((query) => query.range.to)).toEqual([null, null]);
  await scrollTimeline(page, -20_000);
  const restored = page.locator(`[data-timeline-campaign][data-campaign-key="${firstKey}"]`);
  await expect(restored.locator('[data-timeline-campaign-bar]')).toHaveAttribute('style', firstGeometry!);
  expect(fixture.documents).toHaveLength(1);
});

for (const initiallyEmpty of [false, true]) {
  test(`applies tomorrow's Today data and axis together${initiallyEmpty ? ' after an empty response' : ''}`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(FIRST_DAY));
    const fixture = await installPeriodFixture(page, {
      generatedAt: FIRST_DAY,
      revision: FIRST_REVISION,
      rows: initiallyEmpty ? [] : periodRows(FIRST_DAY, false),
    });
    const oldAxis = { start: '2026-10-04T00:00:00.000Z', end: '2026-10-04T23:59:59.999Z' };
    const newAxis = { start: '2026-10-05T00:00:00.000Z', end: '2026-10-05T23:59:59.999Z' };
    try {
      await enterTimeline(page, 'today');
      await expect.poll(() => readAxis(page)).toEqual(oldAxis);
      await page.locator(CAMPAIGNS).evaluate((main) => {
        const transitions: {
          revision: string | null;
          start: string | null;
          end: string | null;
          rowStart: string | null;
          rowEnd: string | null;
        }[] = [];
        Object.assign(window, { periodTimelineTransitions: transitions });
        new MutationObserver(() => {
          if (transitions.length < 32) {
            const timeline = main.querySelector('[data-project-timeline]');
            const row = main.querySelector('[data-timeline-campaign]');
            transitions.push({
              revision: main.getAttribute('data-report-revision'),
              start: timeline?.getAttribute('data-axis-start') ?? null,
              end: timeline?.getAttribute('data-axis-end') ?? null,
              rowStart: row?.getAttribute('data-start') ?? null,
              rowEnd: row?.getAttribute('data-end') ?? null,
            });
          }
        }).observe(main, {
          attributes: true,
          attributeFilter: ['data-report-revision', 'data-axis-start', 'data-axis-end', 'data-start', 'data-end'],
          childList: true,
          subtree: true,
        });
      });
      fixture.publish({ generatedAt: NEXT_DAY, revision: NEXT_REVISION, rows: periodRows(NEXT_DAY, false) });
      fixture.hold(NEXT_REVISION);
      await refreshBootstrap(page, NEXT_DAY);
      const apply = page.getByRole('button', { name: 'Apply new data', exact: true });
      await expect(apply).toBeVisible();
      expect(await readAxis(page)).toEqual(oldAxis);
      await expect(page.locator(CAMPAIGNS)).toHaveAttribute('data-report-revision', FIRST_REVISION);
      await apply.click();
      await expect.poll(() => fixture.acquisitions.some((query) => query.revision === NEXT_REVISION)).toBe(true);
      expect(await readAxis(page)).toEqual(oldAxis);
      await expect(page.locator(CAMPAIGNS)).toHaveAttribute('data-report-revision', FIRST_REVISION);
      fixture.release();
      await expect(page.locator(CAMPAIGNS)).toHaveAttribute('data-report-revision', NEXT_REVISION);
      await expect.poll(() => readAxis(page)).toEqual(newAxis);
      await expect(page.locator('[data-timeline-campaign-bar]')).toBeVisible();
      await expect(page.locator('[data-timeline-campaign]')).toHaveAttribute('data-start', '2026-10-05T10:00:00.000Z');
      await expect(page.locator('[data-timeline-campaign]')).toHaveAttribute('data-end', '2026-10-05T11:00:00.000Z');
      const transitions = await page.evaluate(() => Reflect.get(window, 'periodTimelineTransitions') as unknown);
      expect(Array.isArray(transitions)).toBe(true);
      if (Array.isArray(transitions)) {
        expect(transitions.length).toBeGreaterThan(0);
        for (const transition of transitions) {
          expect([
            {
              revision: FIRST_REVISION,
              ...oldAxis,
              rowStart: initiallyEmpty ? null : '2026-10-04T10:00:00.000Z',
              rowEnd: initiallyEmpty ? null : '2026-10-04T11:00:00.000Z',
            },
            {
              revision: NEXT_REVISION,
              ...newAxis,
              rowStart: '2026-10-05T10:00:00.000Z',
              rowEnd: '2026-10-05T11:00:00.000Z',
            },
          ]).toContainEqual(transition);
        }
      }
      expect(fixture.acquisitions.map((query) => query.range)).toEqual(
        [oldAxis, newAxis].map(({ start, end }) => ({ from: start, to: end })),
      );
      expect(fixture.documents).toHaveLength(1);
    } finally {
      fixture.release();
    }
  });
}

for (const range of ['all', '..2026-10-04']) {
  test(`retains the ${range} axis during acquisition and explicitly fits all loaded campaigns`, async ({ page }) => {
    await installPeriodFixture(page, {
      generatedAt: FIRST_DAY,
      revision: FIRST_REVISION,
      rows: periodRows(FIRST_DAY),
    });
    await enterTimeline(page, range);
    const firstAxis = await readAxis(page);
    expect(firstAxis.start).toBe('2026-10-04T10:00:00.000Z');
    const older = await reachOlderCampaign(page);
    expect(await readAxis(page)).toEqual(firstAxis);
    await expect(older.locator('[data-timeline-campaign-bar]')).toHaveCount(0);
    const key = await older.getAttribute('data-campaign-key');
    const fit = page.getByRole('button', { name: 'Fit loaded campaigns', exact: true });
    await expect(fit).toBeVisible();
    await fit.click();
    await expect(page.locator(TIMELINE)).toHaveAttribute('data-axis-start', '2026-09-29T10:00:40.000Z');
    await expect(
      page.locator(`[data-timeline-campaign][data-campaign-key="${key}"] [data-timeline-campaign-bar]`),
    ).toBeVisible();
    expect((await readAxis(page)).end).toBe(firstAxis.end);
  });
}
