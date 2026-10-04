import { describe, expect, it } from 'bun:test';
import {
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  projectFocusedBreakdown,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import {
  buildCampaignChronology,
  enrichSessionPresentationRow,
  parseSessionQueryRequest,
  projectSessionLookup,
  projectSessionPage,
  type SessionLookupRequest,
  type SessionQueryRequest,
  sessionQueryFingerprint,
  sessionRowIdentity,
} from '@ai-usage/report-core/session-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { demoReportPayload } from '../../../../report-data';
import { countDehydratedSessionPagePayloads, createHydratedWebQueryClient } from '../../../query/client';
import { type ReportQueryClient, reportBootstrapKey } from '../../../query/options/report';
import { reportDestinationKey } from '../../../query/options/report-destination';
import {
  sessionLookupKey,
  sessionLookupQueryOptions,
  sessionPageKey,
  sessionPageQueryOptions,
} from '../../../query/options/session';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import {
  acquireLiveReportQueryState,
  deferredLiveReportQueryState,
  ReportBootstrapUnavailableError,
  reportPageDataFor,
  requireAvailableReportBootstrap,
} from './report-bootstrap';

const liveOptions = () => ({
  fetch: () => Promise.reject(new Error('The injected report client owns this test acquisition')),
  pageUrl: new URL('http://report.invalid/'),
  url: new URL('http://report.invalid/'),
});

const unavailableResult: ReportRevisionBootstrapResult = {
  error: { message: 'private engine detail', tag: 'RevisionUnavailable' },
  ok: false,
  requestFingerprint: 'report-manifest:v1:{}',
};

const successfulResult = (
  revision = 'compatible-last-revision',
): Extract<ReportRevisionBootstrapResult, { readonly ok: true }> => {
  const { rows: _rows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;
  return {
    bootstrap: projectFocusedSupport(
      reportSupport,
      { harness: ['claude-code'], machine: [{ label: 'Laptop', value: 'machine-a' }], truncated: false },
      { revision },
      { dateDomain: { first: '2026-07-01', last: '2026-08-01' } },
    ),
    manifest: {
      captureFingerprint: 'c'.repeat(64),
      expiresAt: 2,
      generatedAt: '2026-08-01T10:00:00.000Z',
      publishedAt: 1,
      revision,
      rowsBytes: 1,
      supportBytes: 1,
    },
    ok: true,
    requestFingerprint: 'report-manifest:v1:{}',
  };
};

const reportClientFixture = (
  result: ReportRevisionBootstrapResult,
  overview: ReportQueryClient['getFocusedReportOverview'] = () => Promise.reject(new Error('Unexpected report query')),
  breakdown: ReportQueryClient['getFocusedReportBreakdown'] = () =>
    Promise.reject(new Error('Unexpected report query')),
): ReportQueryClient => {
  const unavailable = () => Promise.reject(new Error('Unexpected report query'));
  return {
    getFocusedReportBreakdown: breakdown,
    getFocusedReportOverview: overview,
    getFocusedReportSupport: unavailable,
    getReportRevisionBootstrap: () => Promise.resolve(result),
    getReportRevisionManifest: unavailable,
  };
};

const sessionClientFixture = (overrides: Partial<SessionClientAdapter>): SessionClientAdapter => {
  const unavailable = () => Promise.reject(new Error('Unexpected Sessions query'));
  return {
    campaignChildren: unavailable,
    detail: unavailable,
    lookup: unavailable,
    neighbors: unavailable,
    page: unavailable,
    vcs: unavailable,
    ...overrides,
  };
};

const successfulOverviewClient = (result = successfulResult()): ReportQueryClient =>
  reportClientFixture(result, (request) => {
    const data = projectFocusedOverview(demoReportPayload.rows, result.bootstrap.support, request);
    return Promise.resolve({
      data,
      ok: true,
      requestFingerprint: focusedOverviewFingerprint(request),
      revision: request.query.revision,
    });
  });

describe('report bootstrap', () => {
  it('turns typed unavailability into a bounded route error', () => {
    expect(() => requireAvailableReportBootstrap(unavailableResult)).toThrow(ReportBootstrapUnavailableError);
    expect(() => requireAvailableReportBootstrap(unavailableResult)).toThrow('Report data is temporarily unavailable.');
  });

  it.each(['demo', 'e2e'] as const)('selects the %s payload without acquiring server state', (mode) => {
    let fetchCount = 0;
    const data = reportPageDataFor(
      mode,
      {
        fetch: () => {
          fetchCount += 1;
          return Promise.reject(new Error('Synthetic report mode must not acquire RPC data'));
        },
        url: new URL('http://synthetic.invalid/'),
      },
      undefined,
    );

    expect(data.mode).toBe(mode);
    expect(fetchCount).toBe(0);
    expect(data.queryState.dehydratedState.queries).toHaveLength(0);
    expect(data.mode === 'live' ? undefined : data.payload.rows.length).toBeGreaterThan(0);
  });

  it('represents SPA entry as an empty hydration delta for the persistent browser cache', () => {
    expect(deferredLiveReportQueryState()).toEqual({
      dehydratedState: { mutations: [], queries: [] },
    });
  });

  it('refuses live page data the server never acquired', () => {
    expect(() =>
      reportPageDataFor(
        'live',
        { fetch: () => Promise.reject(new Error('unused')), url: new URL('http://report.invalid/') },
        undefined,
      ),
    ).toThrow(ReportBootstrapUnavailableError);
  });

  it('awaits a successful compatible publication and dehydrates the exact current alias key', async () => {
    let acquisitionCount = 0;
    const result = successfulResult();
    const queryState = await acquireLiveReportQueryState(liveOptions(), {
      createClient: () => {
        acquisitionCount += 1;
        return reportClientFixture(result);
      },
    });

    expect(acquisitionCount).toBe(1);
    const [query] = queryState.dehydratedState.queries;
    expect(query?.queryKey).toEqual(reportBootstrapKey());
    expect(query?.state.data).toEqual(result);
  });

  it('rejects typed live unavailability without dehydrating it as successful report data', async () => {
    await expect(
      acquireLiveReportQueryState(liveOptions(), { createClient: () => reportClientFixture(unavailableResult) }),
    ).rejects.toBeInstanceOf(ReportBootstrapUnavailableError);
  });

  it('dehydrates the landing Overview beside the bootstrap so the first paint needs no round trip', async () => {
    let overviewCount = 0;
    const queryState = await acquireLiveReportQueryState(liveOptions(), {
      createClient: () =>
        reportClientFixture(successfulResult(), () => {
          overviewCount += 1;
          return Promise.resolve({ error: { message: 'stub', tag: 'RevisionUnavailable' }, ok: false } as never);
        }),
    });

    expect(overviewCount).toBe(1);
    const keys = queryState.dehydratedState.queries.map((query) => query.queryKey);
    expect(keys).toHaveLength(2);
    expect(keys).toContainEqual(reportBootstrapKey());
  });

  it('keeps the route usable when the Overview prefetch fails', async () => {
    const queryState = await acquireLiveReportQueryState(liveOptions(), {
      createClient: () =>
        reportClientFixture(successfulResult(), () => Promise.reject(new Error('Overview acquisition failed'))),
    });

    const keys = queryState.dehydratedState.queries.map((query) => query.queryKey);
    expect(keys).toEqual([reportBootstrapKey()]);
  });

  it('dehydrates both exact legs for a Breakdown deep link', async () => {
    const result = successfulResult();
    let breakdownCount = 0;
    const queryState = await acquireLiveReportQueryState(
      { ...liveOptions(), pageUrl: new URL('http://report.invalid/?tab=projects') },
      {
        createClient: () =>
          reportClientFixture(
            result,
            (request) => {
              const data = projectFocusedOverview(demoReportPayload.rows, result.bootstrap.support, request);
              return Promise.resolve({
                data,
                ok: true,
                requestFingerprint: focusedOverviewFingerprint(request),
                revision: request.query.revision,
              });
            },
            (request) => {
              breakdownCount += 1;
              const data = projectFocusedBreakdown(demoReportPayload.rows, result.bootstrap.support, request);
              return Promise.resolve({
                data,
                ok: true,
                requestFingerprint: focusedBreakdownFingerprint(request),
                revision: request.query.revision,
              });
            },
          ),
      },
    );

    expect(breakdownCount).toBe(1);
    expect(queryState.dehydratedState.queries).toHaveLength(5);
    expect(queryState.dehydratedState.queries.map((query) => query.queryKey)).toContainEqual(reportDestinationKey());
  });

  it('dehydrates the exact first page for a Sessions deep link', async () => {
    const result = successfulResult();
    let sessionPageCount = 0;
    const queryState = await acquireLiveReportQueryState(
      { ...liveOptions(), pageUrl: new URL('http://report.invalid/?tab=sessions') },
      {
        createClient: () =>
          reportClientFixture(result, (request) => {
            const data = projectFocusedOverview(demoReportPayload.rows, result.bootstrap.support, request);
            return Promise.resolve({
              data,
              ok: true,
              requestFingerprint: focusedOverviewFingerprint(request),
              revision: request.query.revision,
            });
          }),
        createSessionClient: () => {
          const unavailable = () => Promise.reject(new Error('Unexpected Sessions query'));
          return {
            campaignChildren: unavailable,
            detail: unavailable,
            lookup: unavailable,
            neighbors: unavailable,
            page: (request) => {
              sessionPageCount += 1;
              const requestFingerprint = sessionQueryFingerprint(request);
              const sourceRow = demoReportPayload.rows[0];
              if (!sourceRow) {
                throw new Error('Demo payload must include a Sessions row for hydration coverage');
              }
              const row = enrichSessionPresentationRow(sourceRow);
              return Promise.resolve({
                data: {
                  itemCount: 1,
                  items: [
                    {
                      campaignKey: row.campaignKey ?? `campaign:${row.rowId}`,
                      chronology: buildCampaignChronology([row]),
                      kind: 'campaign' as const,
                      row,
                    },
                  ],
                  nextCursor: null,
                  requestFingerprint,
                  revision: request.revision,
                  sessionCount: 1,
                },
                ok: true,
                requestFingerprint,
                revision: request.revision,
              });
            },
            vcs: unavailable,
          };
        },
      },
    );

    expect(sessionPageCount).toBe(1);
    expect(queryState.dehydratedState.queries).toHaveLength(5);
    expect(queryState.dehydratedState.queries.map((query) => query.queryKey)).toContainEqual(reportDestinationKey());
    // Production invariant: Session row payloads serialize once (canonical session-pages).
    expect(countDehydratedSessionPagePayloads(queryState)).toBe(1);

    let browserRequests = 0;
    const browserClient = createHydratedWebQueryClient(queryState);
    const destination = browserClient.getQueryData<{ sessions?: { topLevel: { pages: { items: unknown[] }[] } } }>(
      reportDestinationKey(),
    );
    browserClient.getQueryCache().subscribe(() => {
      browserRequests += 1;
    });
    expect(destination?.sessions?.topLevel.pages[0]?.items).toHaveLength(1);
    expect(browserRequests).toBe(0);
    browserClient.clear();
  });

  it.each([
    'campaign-root',
    'campaign-child',
  ])('hydrates one exact metadata lookup for a directly addressed %s outside the Session window', async (sourceSessionId) => {
    const sourceRow = demoReportPayload.rows.find((row) => row.source?.sourceSessionId === sourceSessionId);
    if (!sourceRow) {
      throw new Error('Expected the directly addressed Session fixture');
    }
    const request = { revision: successfulResult().manifest.revision, rowId: sessionRowIdentity(sourceRow) };
    const lookups: SessionLookupRequest[] = [];
    let pages = 0;
    let nativeReads = 0;
    const sessionClient = sessionClientFixture({
      detail: () => {
        nativeReads += 1;
        return Promise.reject(new Error('Native history must not be prefetched for SSR'));
      },
      lookup: (input) => {
        lookups.push(input);
        const data = projectSessionLookup(demoReportPayload.rows, input);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: data.requestFingerprint,
          revision: data.revision,
        });
      },
      page: (input) => {
        pages += 1;
        const data = projectSessionPage(demoReportPayload.rows, input);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: data.requestFingerprint,
          revision: data.revision,
        });
      },
    });
    const queryState = await acquireLiveReportQueryState(
      { ...liveOptions(), pageUrl: new URL(`http://report.invalid/sessions/${request.rowId}?tab=sessions&range=all`) },
      { createClient: () => successfulOverviewClient(), createSessionClient: () => sessionClient },
    );
    expect(lookups).toEqual([request]);
    expect(pages).toBe(1);
    expect(nativeReads).toBe(0);
    const lookup = queryState.dehydratedState.queries.find(
      (query) => JSON.stringify(query.queryKey) === JSON.stringify(sessionLookupKey(request)),
    );
    expect(lookup?.state.data).toMatchObject({
      data: { found: true, row: { rowId: request.rowId } },
      ok: true,
      revision: request.revision,
    });
    expect(countDehydratedSessionPagePayloads(queryState)).toBe(1);
    const browserClient = createHydratedWebQueryClient(queryState);
    try {
      const hydrated = await browserClient.fetchQuery(
        sessionLookupQueryOptions(sessionClient, request, { browser: true }),
      );
      expect(lookup?.state.data).toEqual(hydrated);
      expect(lookups).toEqual([request]);
      expect(nativeReads).toBe(0);
    } finally {
      browserClient.clear();
    }
  });

  it.each(['sessions', 'overview'])('reuses a directly addressed singleton already present in %s', async (tab) => {
    const sourceRow = demoReportPayload.rows.find((row) => row.source?.sourceSessionId === 'claude-history-fallback');
    if (!sourceRow) {
      throw new Error('Expected a standalone Session fixture');
    }
    let lookups = 0;
    const queryState = await acquireLiveReportQueryState(
      {
        ...liveOptions(),
        pageUrl: new URL(`http://report.invalid/sessions/${sessionRowIdentity(sourceRow)}?tab=${tab}&range=all`),
      },
      {
        createClient: () => successfulOverviewClient(),
        createSessionClient: () =>
          sessionClientFixture({
            lookup: () => {
              lookups += 1;
              return Promise.reject(new Error('Already acquired session metadata must not be fetched again'));
            },
            page: (input) => {
              const data = projectSessionPage(demoReportPayload.rows, input);
              return Promise.resolve({
                data,
                ok: true,
                requestFingerprint: data.requestFingerprint,
                revision: data.revision,
              });
            },
          }),
      },
    );
    expect(queryState.dehydratedState.queries.map((query) => query.queryKey)).toContainEqual(reportDestinationKey());
    expect(lookups).toBe(0);
  });

  it.each([
    'sessions',
    'overview',
  ])('hydrates one bounded campaign projection outside the acquired %s scope', async (tab) => {
    const revision = successfulResult().manifest.revision;
    const campaign = projectSessionPage(
      demoReportPayload.rows,
      parseSessionQueryRequest({
        cursor: null,
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        pageSize: 100,
        range: { from: null, to: null },
        revision,
        sort: [{ desc: true, id: 'date' }],
      }),
    ).items.find((item) => (item.row.campaignTotalCount ?? 1) > 1);
    if (!campaign) {
      throw new Error('Expected the multi-session campaign fixture');
    }
    const pages: SessionQueryRequest[] = [];
    let nativeReads = 0;
    const sessionClient = sessionClientFixture({
      detail: () => {
        nativeReads += 1;
        return Promise.reject(new Error('SSR must not read native detail'));
      },
      page: (request) => {
        pages.push(request);
        const data = projectSessionPage(demoReportPayload.rows, request);
        return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision });
      },
    });
    const queryState = await acquireLiveReportQueryState(
      {
        ...liveOptions(),
        pageUrl: new URL(
          `http://report.invalid/campaigns/${encodeURIComponent(campaign.campaignKey)}?tab=${tab}&range=all&q=missing-campaign-background&origin=%5B%5D`,
        ),
      },
      { createClient: () => successfulOverviewClient(), createSessionClient: () => sessionClient },
    );
    const projections = pages.filter((request) => request.filters.fields.campaign === campaign.campaignKey);
    expect(projections).toHaveLength(1);
    const request = projections[0]!;
    expect(request).toMatchObject({ cursor: null, pageSize: 1, revision });
    const hydrated = queryState.dehydratedState.queries.find(
      (query) => JSON.stringify(query.queryKey) === JSON.stringify(sessionPageKey(request)),
    );
    expect(hydrated?.state.data).toMatchObject({
      data: { items: [{ campaignKey: campaign.campaignKey }] },
      ok: true,
      revision,
    });
    expect(pages).toHaveLength(tab === 'sessions' ? 2 : 1);
    expect(nativeReads).toBe(0);
    const browserClient = createHydratedWebQueryClient(queryState);
    try {
      expect(
        await browserClient.fetchQuery(sessionPageQueryOptions(sessionClient, request, { browser: true })),
      ).toEqual(hydrated?.state.data);
      expect(pages).toHaveLength(tab === 'sessions' ? 2 : 1);
    } finally {
      browserClient.clear();
    }
  });

  it('prefetches deep session metadata at the acquired destination revision after bootstrap expiry recovery', async () => {
    const sourceRow = demoReportPayload.rows.find((row) => row.source?.sourceSessionId === 'campaign-child');
    if (!sourceRow) {
      throw new Error('Expected a child Session fixture');
    }
    const oldBootstrap = successfulResult('expired-revision');
    const newBootstrap = successfulResult('replacement-revision');
    const reportClient = successfulOverviewClient(newBootstrap);
    const lookups: SessionLookupRequest[] = [];
    let bootstraps = 0;
    const rowId = sessionRowIdentity(sourceRow);
    const queryState = await acquireLiveReportQueryState(
      { ...liveOptions(), pageUrl: new URL(`http://report.invalid/sessions/${rowId}?range=all`) },
      {
        createClient: () => ({
          ...reportClient,
          getFocusedReportOverview: (request) =>
            request.query.revision === oldBootstrap.manifest.revision
              ? Promise.resolve({
                  error: { message: 'expired', revision: request.query.revision, tag: 'RevisionExpired' },
                  ok: false,
                  requestFingerprint: focusedOverviewFingerprint(request),
                  revision: request.query.revision,
                })
              : reportClient.getFocusedReportOverview(request),
          getReportRevisionBootstrap: () => Promise.resolve(++bootstraps === 1 ? oldBootstrap : newBootstrap),
        }),
        createSessionClient: () =>
          sessionClientFixture({
            lookup: (request) => {
              lookups.push(request);
              const data = projectSessionLookup(demoReportPayload.rows, request);
              return Promise.resolve({
                data,
                ok: true,
                requestFingerprint: data.requestFingerprint,
                revision: data.revision,
              });
            },
          }),
      },
    );
    const request = { revision: newBootstrap.manifest.revision, rowId };
    expect(bootstraps).toBe(2);
    expect(lookups).toEqual([request]);
    expect(queryState.dehydratedState.queries.map((query) => query.queryKey)).toContainEqual(sessionLookupKey(request));
    expect(queryState.dehydratedState.queries.map((query) => query.queryKey)).not.toContainEqual(
      sessionLookupKey({ ...request, revision: oldBootstrap.manifest.revision }),
    );
  });
});
