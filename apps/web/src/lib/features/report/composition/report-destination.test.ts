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
import { demoReportPayload } from '../../../../report-data';
import { createWebQueryClient } from '../../../query/client';
import type { ReportQueryClient } from '../../../query/options/report';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import { syntheticCampaignRow } from '../../sessions/table/session-table.fixtures';
import { createSessionTableQueryOwner } from '../../sessions/table/session-table-query-owner';
import {
  createFocusedReportDescriptorSource,
  createFocusedReportSession,
  initialFocusedReportDescriptor,
} from './report-destination';

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
const unusedSessionOwner = {
  canCommit: () => false,
  commit: () => false,
  commitWithVisible: () => 'superseded' as const,
  prepare: () => Promise.reject(new Error('Unexpected Sessions query')),
};

const sessionItem: SessionPageItem = {
  campaignKey: 'campaign-1',
  kind: 'campaign',
  row: syntheticCampaignRow(1),
};
const pagingCursor = 'sq1.0000000000000000.1';
const expiredCursor = 'sq1.0000000000000001.2';

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

describe('focused Svelte report destination', () => {
  test('reuses the current bootstrap until publication invalidation or a forced expiry recovery', async () => {
    const queryClient = createWebQueryClient();
    let bootstrapCalls = 0;
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: () => Promise.reject(new Error('Unexpected Overview query')),
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => {
        bootstrapCalls += 1;
        return Promise.resolve(bootstrap(bootstrapCalls === 1 ? 'revision-two' : 'revision-three'));
      },
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const descriptorSource = createFocusedReportDescriptorSource({
      client,
      initial: initialFocusedReportDescriptor(bootstrap('revision-one')),
      queryClient,
    });
    const signal = new AbortController().signal;

    expect((await descriptorSource.acquire(signal, false)).revision).toBe('revision-one');
    expect((await descriptorSource.acquire(signal, false)).revision).toBe('revision-two');
    expect((await descriptorSource.acquire(signal, false)).revision).toBe('revision-two');
    expect(bootstrapCalls).toBe(1);

    expect((await descriptorSource.acquire(signal, true)).revision).toBe('revision-three');
    expect(bootstrapCalls).toBe(2);
  });

  test('preserves timeline-only versus advanced Overview request ownership', async () => {
    const queryClient = createWebQueryClient();
    const includeAdvancedRequests: boolean[] = [];
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        includeAdvancedRequests.push(request.includeAdvanced);
        const data = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.resolve(bootstrap('revision-one')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const descriptorSource = createFocusedReportDescriptorSource({
      client,
      initial: initialFocusedReportDescriptor(bootstrap('revision-one')),
      queryClient,
    });
    const session = createFocusedReportSession({
      acquire: descriptorSource.acquire,
      client,
      onCommit: () => undefined,
      queryClient,
      sessionOwner: unusedSessionOwner,
    });
    const destination = {
      kind: 'overview' as const,
      query: {
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        range: { from: null, to: null },
      },
      timeline: { dimension: 'harness' as const, granularity: 'day' as const },
    };

    expect(await session.refresh({ ...destination, includeAdvanced: false })).toMatchObject({ status: 'committed' });
    expect(await session.refresh({ ...destination, includeAdvanced: true })).toMatchObject({ status: 'committed' });
    expect(includeAdvancedRequests).toEqual([false, true]);
  });

  test('reacquires once after expiry and atomically commits matching Overview and Breakdown results', async () => {
    const queryClient = createWebQueryClient();
    let bootstrapCalls = 0;
    let overviewCalls = 0;
    let breakdownCalls = 0;
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: (request) => {
        breakdownCalls += 1;
        const data = projectFocusedBreakdown(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedBreakdownFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportOverview: (request) => {
        overviewCalls += 1;
        if (request.query.revision === 'revision-one') {
          return Promise.resolve({
            error: {
              message: 'expired',
              revision: request.query.revision,
              tag: 'RevisionExpired',
            },
            ok: false,
            requestFingerprint: focusedOverviewFingerprint(request),
            revision: request.query.revision,
          });
        }
        const data = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => {
        bootstrapCalls += 1;
        return Promise.resolve(bootstrap('revision-two'));
      },
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const descriptorSource = createFocusedReportDescriptorSource({
      client,
      initial: initialFocusedReportDescriptor(bootstrap('revision-one')),
      queryClient,
    });
    const commits: string[] = [];
    const session = createFocusedReportSession({
      acquire: descriptorSource.acquire,
      client,
      onCommit: ({ breakdown, overview }) => {
        expect(breakdown?.revision).toBe(overview.revision);
        commits.push(overview.revision);
      },
      queryClient,
      sessionOwner: unusedSessionOwner,
    });

    const outcome = await session.refresh({
      kind: 'breakdown',
      query: {
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        range: { from: null, to: null },
      },
      timeline: { dimension: 'harness', granularity: 'day' },
    });

    expect(outcome.status).toBe('committed');
    expect(commits).toEqual(['revision-two']);
    expect(bootstrapCalls).toBe(1);
    expect(overviewCalls).toBe(2);
    expect(breakdownCalls).toBe(2);
    expect(descriptorSource.current().revision).toBe('revision-two');
  });
  test('commits the timeline-only Overview and first Sessions page only after both exact legs resolve', async () => {
    const queryClient = createWebQueryClient();
    const overviewGate = Promise.withResolvers<Awaited<ReturnType<ReportQueryClient['getFocusedReportOverview']>>>();
    const pageGate = Promise.withResolvers<Awaited<ReturnType<SessionClientAdapter['page']>>>();
    const overviewRequests: string[] = [];
    const pageRequests: string[] = [];
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        expect(request.includeAdvanced).toBe(false);
        overviewRequests.push(request.query.revision);
        return overviewGate.promise;
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.reject(new Error('Unexpected bootstrap query')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const sessionOwner = createSessionTableQueryOwner({
      client: sessionClientWithPage((request) => {
        pageRequests.push(request.revision);
        return pageGate.promise;
      }),
      queryClient,
    });
    const commits: string[] = [];
    const session = createFocusedReportSession({
      acquire: () => Promise.resolve(initialFocusedReportDescriptor(bootstrap('revision-pair'))),
      client,
      onCommit: ({ overview }) => commits.push(overview.revision),
      queryClient,
      sessionOwner,
    });

    const pending = session.refresh(sessionsDestination());
    await Promise.resolve();
    const request = sessionsDestination();
    const overviewRequest = {
      includeAdvanced: false,
      query: { ...request.query, revision: 'revision-pair' },
      timeline: request.timeline,
    };
    const overviewData = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, overviewRequest);
    overviewGate.resolve({
      data: overviewData,
      ok: true,
      requestFingerprint: focusedOverviewFingerprint(overviewRequest),
      revision: 'revision-pair',
    });
    await Promise.resolve();
    expect(commits).toEqual([]);
    expect(sessionOwner.snapshot).toBeUndefined();

    pageGate.resolve(successfulSessionPage({ ...request.sessions, cursor: null, revision: 'revision-pair' }));
    expect((await pending).status).toBe('committed');
    expect(commits).toEqual(['revision-pair']);
    expect(sessionOwner.snapshot?.query.revision).toBe('revision-pair');
    expect(overviewRequests).toEqual(pageRequests);
    sessionOwner.close();
  });

  test('preserves the previously committed Overview and Sessions pair when either new leg fails', async () => {
    const queryClient = createWebQueryClient();
    let revision = 'revision-one';
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        const data = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.reject(new Error('Unexpected bootstrap query')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const sessionOwner = createSessionTableQueryOwner({
      client: sessionClientWithPage((request) =>
        request.revision === 'revision-two'
          ? Promise.reject(new Error('second leg failed'))
          : Promise.resolve(successfulSessionPage(request)),
      ),
      queryClient,
    });
    const commits: string[] = [];
    const session = createFocusedReportSession({
      acquire: () => Promise.resolve(initialFocusedReportDescriptor(bootstrap(revision))),
      client,
      onCommit: ({ overview }) => commits.push(overview.revision),
      queryClient,
      sessionOwner,
    });

    expect((await session.refresh(sessionsDestination('first'))).status).toBe('committed');
    revision = 'revision-two';
    const outcome = await session.refresh(sessionsDestination('second'));

    expect(outcome.status).toBe('failed-preserving-previous');
    expect(commits).toEqual(['revision-one']);
    expect(sessionOwner.snapshot?.query.revision).toBe('revision-one');
    expect(sessionOwner.snapshot?.query.filters.query).toBe('first');
    sessionOwner.close();
  });

  test('retries an expired Sessions leg with one new descriptor and never publishes the expired pair', async () => {
    const queryClient = createWebQueryClient();
    let acquisition = 0;
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        const data = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.reject(new Error('Unexpected bootstrap query')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const observedSessionRevisions: string[] = [];
    const sessionOwner = createSessionTableQueryOwner({
      client: sessionClientWithPage((request) => {
        if (request.revision === 'expired-revision') {
          return Promise.resolve({
            error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' as const },
            ok: false as const,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          });
        }
        return Promise.resolve(successfulSessionPage(request));
      }),
      onStateChange: (state) => observedSessionRevisions.push(state?.query.revision ?? 'missing'),
      queryClient,
    });
    const commits: string[] = [];
    const session = createFocusedReportSession({
      acquire: () => {
        acquisition += 1;
        const next = acquisition === 1 ? 'expired-revision' : 'accepted-revision';
        return Promise.resolve(initialFocusedReportDescriptor(bootstrap(next)));
      },
      client,
      onCommit: ({ overview }) => commits.push(overview.revision),
      queryClient,
      sessionOwner,
    });

    expect((await session.refresh(sessionsDestination())).status).toBe('committed');
    expect(acquisition).toBe(2);
    expect(commits).toEqual(['accepted-revision']);
    expect(observedSessionRevisions).toEqual(['accepted-revision']);
    sessionOwner.close();
  });

  test('supersedes a pending Sessions pair without a late partial commit', async () => {
    const queryClient = createWebQueryClient();
    const oldPage = Promise.withResolvers<Awaited<ReturnType<SessionClientAdapter['page']>>>();
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        const data = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.reject(new Error('Unexpected bootstrap query')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const sessionOwner = createSessionTableQueryOwner({
      client: sessionClientWithPage((request) =>
        request.filters.query === 'old' ? oldPage.promise : Promise.resolve(successfulSessionPage(request)),
      ),
      queryClient,
    });
    const commits: string[] = [];
    const session = createFocusedReportSession({
      acquire: () => Promise.resolve(initialFocusedReportDescriptor(bootstrap('shared-revision'))),
      client,
      onCommit: ({ destination }) =>
        commits.push(destination.kind === 'sessions' ? destination.sessions.filters.query : destination.kind),
      queryClient,
      sessionOwner,
    });

    const oldRefresh = session.refresh(sessionsDestination('old'));
    await Promise.resolve();
    expect((await session.refresh(sessionsDestination('new'))).status).toBe('committed');
    oldPage.resolve(successfulSessionPage({ ...sessionScope('old'), cursor: null, revision: 'shared-revision' }));

    expect((await oldRefresh).status).toBe('superseded');
    expect(commits).toEqual(['new']);
    expect(sessionOwner.snapshot?.query.filters.query).toBe('new');
    sessionOwner.close();
  });

  test('lets an external Sessions refresh supersede a blocked exact-revision replay without a late rollback', async () => {
    const queryClient = createWebQueryClient();
    const replayGate = Promise.withResolvers<void>();
    const replayStarted = Promise.withResolvers<void>();
    let replayStartedOnce = false;
    let revision = 'revision-a';
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: () => Promise.reject(new Error('Unexpected Breakdown query')),
      getFocusedReportOverview: (request) => {
        const data = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => Promise.reject(new Error('Unexpected bootstrap query')),
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const observedSessionStates: string[] = [];
    const sessionOwner = createSessionTableQueryOwner({
      client: sessionClientWithPage(async (request) => {
        if (request.revision === 'revision-a' && request.cursor === expiredCursor) {
          return {
            error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' as const },
            ok: false as const,
            requestFingerprint: sessionQueryFingerprint(request),
            revision: request.revision,
          };
        }
        if (request.revision === 'revision-b' && request.cursor === pagingCursor) {
          if (!replayStartedOnce) {
            replayStartedOnce = true;
            replayStarted.resolve();
          }
          await replayGate.promise;
        }
        let nextCursor: string | null = null;
        if (request.cursor === null && request.revision !== 'revision-c') {
          nextCursor = pagingCursor;
        } else if (request.revision === 'revision-a' && request.cursor === pagingCursor) {
          nextCursor = expiredCursor;
        }
        return successfulSessionPage(request, nextCursor);
      }),
      onStateChange: (state) =>
        observedSessionStates.push(`${state?.query.revision ?? 'missing'}:${state?.loadingMore ?? false}`),
      queryClient,
    });
    const commits: string[] = [];
    const session = createFocusedReportSession({
      acquire: () => Promise.resolve(initialFocusedReportDescriptor(bootstrap(revision))),
      client,
      onCommit: ({ overview }) => commits.push(overview.revision),
      queryClient,
      sessionOwner,
    });
    sessionOwner.setRevisionRefresh(async (nextScope) => {
      const destination = sessionsDestination(nextScope.filters.query);
      return await session.refresh({
        ...destination,
        query: { filters: nextScope.filters, range: nextScope.range },
        sessions: nextScope,
      });
    });

    expect((await session.refresh(sessionsDestination('preserved'))).status).toBe('committed');
    await sessionOwner.loadMore();
    revision = 'revision-b';
    const lateRecovery = sessionOwner.loadMore();
    await replayStarted.promise;
    expect(commits).toEqual(['revision-a']);
    expect(observedSessionStates).not.toContain('revision-b:false');

    revision = 'revision-c';
    expect((await session.refresh(sessionsDestination('external'))).status).toBe('committed');
    expect(commits).toEqual(['revision-a', 'revision-c']);
    expect(sessionOwner.snapshot?.query.revision).toBe('revision-c');

    replayGate.resolve();
    await lateRecovery;
    expect(commits).toEqual(['revision-a', 'revision-c']);
    expect(sessionOwner.snapshot?.query.revision).toBe('revision-c');
    expect(observedSessionStates).not.toContain('revision-b:false');
    sessionOwner.close();
  });
});
