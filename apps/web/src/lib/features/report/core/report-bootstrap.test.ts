import { describe, expect, it } from 'bun:test';
import {
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  projectFocusedBreakdown,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import { sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { demoReportPayload } from '../../../../report-data';
import { type ReportQueryClient, reportBootstrapKey } from '../../../query/options/report';
import { reportDestinationKey } from '../../../query/options/report-destination';
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

const successfulResult = (): Extract<ReportRevisionBootstrapResult, { readonly ok: true }> => {
  const { rows: _rows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;
  return {
    bootstrap: projectFocusedSupport(
      reportSupport,
      { harness: ['claude-code'], machine: [{ label: 'Laptop', value: 'machine-a' }], truncated: false },
      { revision: 'compatible-last-revision' },
      { dateDomain: { first: '2026-07-01', last: '2026-08-01' } },
    ),
    manifest: {
      captureFingerprint: 'c'.repeat(64),
      expiresAt: 2,
      generatedAt: '2026-08-01T10:00:00.000Z',
      publishedAt: 1,
      revision: 'compatible-last-revision',
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
            neighbors: unavailable,
            page: (request) => {
              sessionPageCount += 1;
              const requestFingerprint = sessionQueryFingerprint(request);
              return Promise.resolve({
                data: {
                  itemCount: 0,
                  items: [],
                  nextCursor: null,
                  requestFingerprint,
                  revision: request.revision,
                  sessionCount: 0,
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
  });
});
