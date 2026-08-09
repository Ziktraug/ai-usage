import { describe, expect, test } from 'bun:test';
import {
  type FocusedReportSupport,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  projectFocusedBreakdown,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import {
  parseSessionQueryRequest,
  type SessionPageItem,
  type SessionQueryRequest,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { QueryObserver } from '@tanstack/svelte-query';
import { demoReportPayload } from '../../../../report-data';
import { createWebQueryClient } from '../../../query/client';
import type { ReportQueryClient } from '../../../query/options/report';
import { reportDestinationExactKey, reportDestinationQueryOptions } from '../../../query/options/report-destination';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import { syntheticCampaignRow } from '../../sessions/table/session-table.fixtures';

const { rows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;

const bootstrap = (revision: string): Extract<ReportRevisionBootstrapResult, { readonly ok: true }> => ({
  bootstrap: projectFocusedSupport(reportSupport, { harness: ['codex'], machine: [], truncated: false }, { revision }),
  manifest: {
    captureFingerprint: `${revision}-capture`,
    expiresAt: 2,
    generatedAt: reportSupport.generatedAt,
    publishedAt: 1,
    revision,
    rowsBytes: 1,
    supportBytes: 1,
  },
  ok: true,
  requestFingerprint: 'report-manifest:v1:{}',
});
const sessionItem: SessionPageItem = {
  campaignKey: 'campaign-1',
  kind: 'campaign',
  row: syntheticCampaignRow(1),
};
const sessionScope = (query = '') => {
  const request = parseSessionQueryRequest({
    cursor: null,
    filters: { fields: {}, harness: [], machine: [], origin: [], query },
    pageSize: 100,
    range: { from: null, to: null },
    revision: 'scope-placeholder',
    sort: [{ desc: true, id: 'date' }],
  });
  const { cursor: _cursor, revision: _revision, ...scope } = request;
  return scope;
};

const sessionsDestination = (query = '') => ({
  kind: 'sessions' as const,
  query: { filters: sessionScope(query).filters, range: sessionScope(query).range },
  sessions: sessionScope(query),
  timeline: { dimension: 'harness' as const, granularity: 'day' as const },
});

const overviewDestination = (query = '') => ({
  includeAdvanced: true,
  kind: 'overview' as const,
  query: { filters: sessionScope(query).filters, range: sessionScope(query).range },
  timeline: { dimension: 'harness' as const, granularity: 'day' as const },
});

const breakdownDestination = (query = '') => ({
  kind: 'breakdown' as const,
  query: { filters: sessionScope(query).filters, range: sessionScope(query).range },
  timeline: { dimension: 'harness' as const, granularity: 'day' as const },
});

const successfulOverview = (request: Parameters<ReportQueryClient['getFocusedReportOverview']>[0]) => ({
  data: projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request),
  ok: true as const,
  requestFingerprint: focusedOverviewFingerprint(request),
  revision: request.query.revision,
});

const successfulBreakdown = (request: Parameters<ReportQueryClient['getFocusedReportBreakdown']>[0]) => ({
  data: projectFocusedBreakdown(rows, reportSupport as FocusedReportSupport, request),
  ok: true as const,
  requestFingerprint: focusedBreakdownFingerprint(request),
  revision: request.query.revision,
});

const successfulSessionPage = (request: SessionQueryRequest, nextCursor: string | null = null) => {
  const requestFingerprint = sessionQueryFingerprint(request);
  return {
    data: {
      itemCount: 1,
      items: [sessionItem],
      nextCursor,
      requestFingerprint,
      revision: request.revision,
      sessionCount: 1,
    },
    ok: true as const,
    requestFingerprint,
    revision: request.revision,
  };
};

const sessionClientWithPage = (page: SessionClientAdapter['page']): SessionClientAdapter => {
  const unexpected = () => Promise.reject(new Error('Unexpected Session operation'));
  return { campaignChildren: unexpected, detail: unexpected, neighbors: unexpected, page, vcs: unexpected };
};

describe('report destination Query', () => {
  test('QUERY-REPORT-DESTINATION: caches one complete Breakdown value and reuses it while fresh', async () => {
    const queryClient = createWebQueryClient();
    const calls = { bootstrap: 0, breakdown: 0, overview: 0 };
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: (request) => {
        calls.breakdown += 1;
        return Promise.resolve(successfulBreakdown(request));
      },
      getFocusedReportOverview: (request) => {
        calls.overview += 1;
        return Promise.resolve(successfulOverview(request));
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => {
        calls.bootstrap += 1;
        return Promise.resolve(bootstrap('revision-query'));
      },
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const destination = breakdownDestination();
    const dependencies = {
      queryClient,
      reportClient: client,
      sessionClient: sessionClientWithPage(() => Promise.reject(new Error('Unexpected Session query'))),
    };
    const options = reportDestinationQueryOptions(dependencies, destination, { browser: true });

    const first = await queryClient.fetchQuery(options);
    const second = await queryClient.fetchQuery(options);

    expect(second).toBe(first);
    expect(calls).toEqual({ bootstrap: 1, breakdown: 1, overview: 1 });
    expect(first.breakdown?.revision).toBe(first.overview.revision);
    expect(queryClient.getQueryData<typeof first>(reportDestinationExactKey(destination, first.descriptor))).toBe(
      first,
    );
    queryClient.clear();
  });

  test('QUERY-REPORT-DESTINATION-ATOMIC: exposes neither Breakdown nor Sessions before both exact legs resolve', async () => {
    const queryClient = createWebQueryClient();
    const overviewGate = Promise.withResolvers<Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>>();
    const breakdownGate = Promise.withResolvers<Awaited<ReturnType<ReportQueryClient['getFocusedReportBreakdown']>>>();
    const pageGate = Promise.withResolvers<Awaited<ReturnType<SessionClientAdapter['page']>>>();
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => breakdownGate.promise,
      getFocusedReportOverview: () => overviewGate.promise,
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.resolve(bootstrap('revision-atomic')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const dependencies = {
      queryClient,
      reportClient: client,
      sessionClient: sessionClientWithPage(() => pageGate.promise),
    };
    const breakdown = breakdownDestination();
    const pendingBreakdown = queryClient.fetchQuery(
      reportDestinationQueryOptions(dependencies, breakdown, { browser: true }),
    );
    let breakdownSettled = false;
    pendingBreakdown.finally(() => {
      breakdownSettled = true;
    });
    await Promise.resolve();
    const breakdownOverviewRequest = {
      includeAdvanced: false,
      query: { ...breakdown.query, revision: 'revision-atomic' },
      timeline: breakdown.timeline,
    };
    overviewGate.resolve(successfulOverview(breakdownOverviewRequest));
    await Promise.resolve();
    expect(breakdownSettled).toBe(false);
    const breakdownRequest = { query: { ...breakdown.query, revision: 'revision-atomic' } };
    breakdownGate.resolve(successfulBreakdown(breakdownRequest));
    const breakdownResult = await pendingBreakdown;
    expect(breakdownResult.breakdown?.revision).toBe(breakdownResult.overview.revision);

    await queryClient.invalidateQueries({
      exact: true,
      queryKey: reportDestinationQueryOptions(dependencies, sessionsDestination(), { browser: true }).queryKey,
      refetchType: 'none',
    });
    const sessions = sessionsDestination();
    const pendingSessions = queryClient.fetchQuery(
      reportDestinationQueryOptions(dependencies, sessions, { browser: true }),
    );
    let sessionsSettled = false;
    pendingSessions.finally(() => {
      sessionsSettled = true;
    });
    await Promise.resolve();
    expect(sessionsSettled).toBe(false);
    const sessionsOverviewRequest = {
      includeAdvanced: false,
      query: { ...sessions.query, revision: 'revision-atomic' },
      timeline: sessions.timeline,
    };
    overviewGate.resolve(successfulOverview(sessionsOverviewRequest));
    pageGate.resolve(successfulSessionPage({ ...sessions.sessions, cursor: null, revision: 'revision-atomic' }));
    const sessionsResult = await pendingSessions;
    expect(sessionsResult.sessions?.query.revision).toBe(sessionsResult.overview.revision);
    queryClient.clear();
  });

  test('QUERY-REPORT-DESTINATION-EXPIRY: reacquires once and stores only the accepted exact revision', async () => {
    const queryClient = createWebQueryClient();
    let bootstrapCalls = 0;
    let overviewCalls = 0;
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        overviewCalls += 1;
        if (request.query.revision === 'revision-expired') {
          return Promise.resolve({
            error: { message: 'expired', revision: request.query.revision, tag: 'RevisionExpired' as const },
            ok: false as const,
            requestFingerprint: focusedOverviewFingerprint(request),
            revision: request.query.revision,
          });
        }
        return Promise.resolve(successfulOverview(request));
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => {
        bootstrapCalls += 1;
        return Promise.resolve(bootstrap(bootstrapCalls === 1 ? 'revision-expired' : 'revision-accepted'));
      },
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const destination = overviewDestination();
    const dependencies = {
      queryClient,
      reportClient: client,
      sessionClient: sessionClientWithPage(() => Promise.reject(new Error('Unexpected Session query'))),
    };

    const result = await queryClient.fetchQuery(
      reportDestinationQueryOptions(dependencies, destination, { browser: true }),
    );

    expect(result.descriptor.revision).toBe('revision-accepted');
    expect(result.overview.revision).toBe('revision-accepted');
    expect(bootstrapCalls).toBe(2);
    expect(overviewCalls).toBe(2);
    queryClient.clear();
  });

  test('QUERY-REPORT-DESTINATION-LAST-GOOD: keeps the prior value through failure and supersedes late work', async () => {
    const queryClient = createWebQueryClient();
    const oldGate = Promise.withResolvers<Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>>();
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        const query = request.query.filters.query;
        if (query === 'old-pending') {
          return oldGate.promise;
        }
        if (query === 'failing') {
          return Promise.reject(new Error('background refresh failed'));
        }
        return Promise.resolve(successfulOverview(request));
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.resolve(bootstrap('revision-stable')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const dependencies = {
      queryClient,
      reportClient: client,
      sessionClient: sessionClientWithPage(() => Promise.reject(new Error('Unexpected Session query'))),
    };
    const initial = overviewDestination('initial');
    const observer = new QueryObserver(
      queryClient,
      reportDestinationQueryOptions(dependencies, initial, { browser: true }),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    expect(observer.getCurrentResult().data?.destination.query.filters.query).toBe('initial');

    const failing = overviewDestination('failing');
    observer.setOptions(reportDestinationQueryOptions(dependencies, failing, { browser: true }));
    const failed = await observer.refetch();
    expect(failed.error?.message).toBe('background refresh failed');
    expect(failed.data?.destination.query.filters.query).toBe('initial');

    const oldPending = overviewDestination('old-pending');
    observer.setOptions(reportDestinationQueryOptions(dependencies, oldPending, { browser: true }));
    const oldRefresh = observer.refetch();
    await Promise.resolve();
    const accepted = overviewDestination('accepted');
    observer.setOptions(reportDestinationQueryOptions(dependencies, accepted, { browser: true }));
    await observer.refetch();
    expect(observer.getCurrentResult().data?.destination.query.filters.query).toBe('accepted');

    const oldRequest = {
      includeAdvanced: true,
      query: { ...oldPending.query, revision: 'revision-stable' },
      timeline: oldPending.timeline,
    };
    oldGate.resolve(successfulOverview(oldRequest));
    await oldRefresh;
    expect(observer.getCurrentResult().data?.destination.query.filters.query).toBe('accepted');
    unsubscribe();
    queryClient.clear();
  });
});
