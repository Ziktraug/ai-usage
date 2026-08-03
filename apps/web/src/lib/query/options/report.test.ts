import { describe, expect, test } from 'bun:test';
import { focusedRevisionFingerprint } from '@ai-usage/report-core/focused-report-query';
import type {
  FocusedBreakdownRequest,
  FocusedOverviewRequest,
  FocusedReportServerResult,
  FocusedRevisionRequest,
  FocusedSupportResult,
  ReportRevisionBootstrapResult,
  ReportRevisionManifestResult,
} from '@ai-usage/web-contract/report';
import { isCancelledError, QueryObserver } from '@tanstack/svelte-query';
import { createHydratedWebQueryClient, createWebQueryClient, dehydrateWebQueryClient } from '../client';
import { controlPlaneKey, finiteSwrKey } from '../keys';
import { DEFAULT_BOUNDED_GC_TIME_MS } from '../policies';
import {
  invalidateCurrentReportAliases,
  type ReportQueryClient,
  reportBootstrapKey,
  reportBootstrapQueryOptions,
  reportBreakdownKey,
  reportBreakdownQueryOptions,
  reportManifestKey,
  reportManifestQueryOptions,
  reportOverviewKey,
  reportOverviewQueryOptions,
  reportSupportKey,
  reportSupportQueryOptions,
} from './report';

const revision = 'revision-1';
const manifestUnavailable: ReportRevisionManifestResult = {
  error: { message: 'No publication.', tag: 'RevisionUnavailable' },
  ok: false,
  requestFingerprint: 'report-manifest:v1:{}',
};
const bootstrapUnavailable: ReportRevisionBootstrapResult = manifestUnavailable;
const supportUnavailable: FocusedReportServerResult<FocusedSupportResult> = {
  error: { message: 'Expired.', revision, tag: 'RevisionExpired' },
  ok: false,
  requestFingerprint: 'focused-support-v1:fingerprint',
  revision,
};
const reportQuery: FocusedOverviewRequest['query'] = {
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  range: { from: null, to: null },
  revision,
};
const overviewRequest: FocusedOverviewRequest = {
  includeAdvanced: false,
  query: reportQuery,
  timeline: { dimension: 'provider', granularity: 'day' },
};
const breakdownRequest: FocusedBreakdownRequest = { query: reportQuery };

const unusedRpc = (): Promise<never> => Promise.reject(new Error('Unexpected ReportClient call'));

const createReportClientStub = (overrides: Partial<ReportQueryClient> = {}): ReportQueryClient => ({
  getFocusedReportBreakdown: unusedRpc,
  getFocusedReportOverview: unusedRpc,
  getFocusedReportSupport: unusedRpc,
  getReportRevisionBootstrap: unusedRpc,
  getReportRevisionManifest: unusedRpc,
  ...overrides,
});

describe('Report Query options', () => {
  test('QUERY-REPORT-EXACT-IMMUTABLE: keys exact revision, fingerprint, and destination without collisions', () => {
    expect(reportManifestKey()).not.toEqual(reportBootstrapKey());
    expect(reportSupportKey({ revision })).toEqual([
      'web',
      'immutable-revision',
      'report',
      revision,
      focusedRevisionFingerprint('support', { revision }),
      'support',
    ]);
    expect(reportOverviewKey(overviewRequest)).not.toEqual(reportSupportKey({ revision }));
    expect(reportBreakdownKey(breakdownRequest)).not.toEqual(reportOverviewKey(overviewRequest));

    const overviewMutations: FocusedOverviewRequest[] = [
      { ...overviewRequest, includeAdvanced: true },
      { ...overviewRequest, query: { ...reportQuery, revision: 'revision-2' } },
      { ...overviewRequest, query: { ...reportQuery, filters: { ...reportQuery.filters, query: 'changed' } } },
      {
        ...overviewRequest,
        query: { ...reportQuery, range: { from: '2026-08-01T00:00:00.000Z', to: null } },
      },
      { ...overviewRequest, timeline: { ...overviewRequest.timeline, dimension: 'model' } },
      { ...overviewRequest, timeline: { ...overviewRequest.timeline, granularity: 'week' } },
    ];
    for (const mutation of overviewMutations) {
      expect(reportOverviewKey(mutation)).not.toEqual(reportOverviewKey(overviewRequest));
    }
    const breakdownMutations: FocusedBreakdownRequest[] = [
      { query: { ...reportQuery, revision: 'revision-2' } },
      { query: { ...reportQuery, filters: { ...reportQuery.filters, query: 'changed' } } },
      { query: { ...reportQuery, range: { from: null, to: '2026-08-02T00:00:00.000Z' } } },
    ];
    for (const mutation of breakdownMutations) {
      expect(reportBreakdownKey(mutation)).not.toEqual(reportBreakdownKey(breakdownRequest));
    }
    expect(reportSupportKey({ revision: 'revision-2' })).not.toEqual(reportSupportKey({ revision }));

    const options = reportSupportQueryOptions(
      createReportClientStub({ getFocusedReportSupport: () => Promise.resolve(supportUnavailable) }),
      { revision },
      { browser: false },
    );
    expect(options).toMatchObject({
      enabled: false,
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      refetchOnMount: false,
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    });
  });

  test('captures one canonical request for both the exact key and deferred RPC after caller mutation', async () => {
    const expectedSupport: FocusedRevisionRequest = { revision };
    const mutableSupport: FocusedRevisionRequest = { ...expectedSupport };
    const expectedOverview: FocusedOverviewRequest = {
      ...overviewRequest,
      query: {
        ...overviewRequest.query,
        filters: { ...overviewRequest.query.filters },
        range: { ...overviewRequest.query.range },
      },
      timeline: { ...overviewRequest.timeline },
    };
    const mutableOverview: FocusedOverviewRequest = {
      ...expectedOverview,
      query: {
        ...expectedOverview.query,
        filters: { ...expectedOverview.query.filters },
        range: { ...expectedOverview.query.range },
      },
      timeline: { ...expectedOverview.timeline },
    };
    const expectedBreakdown: FocusedBreakdownRequest = {
      query: {
        ...breakdownRequest.query,
        filters: { ...breakdownRequest.query.filters },
        range: { ...breakdownRequest.query.range },
      },
    };
    const mutableBreakdown: FocusedBreakdownRequest = {
      query: {
        ...expectedBreakdown.query,
        filters: { ...expectedBreakdown.query.filters },
        range: { ...expectedBreakdown.query.range },
      },
    };
    let receivedSupport: FocusedRevisionRequest | undefined;
    let receivedOverview: FocusedOverviewRequest | undefined;
    let receivedBreakdown: FocusedBreakdownRequest | undefined;
    const client = createReportClientStub({
      getFocusedReportBreakdown: (request) => {
        receivedBreakdown = request;
        return Promise.resolve(supportUnavailable);
      },
      getFocusedReportOverview: (request) => {
        receivedOverview = request;
        return Promise.resolve(supportUnavailable);
      },
      getFocusedReportSupport: (request) => {
        receivedSupport = request;
        return Promise.resolve(supportUnavailable);
      },
    });
    const supportOptions = reportSupportQueryOptions(client, mutableSupport, { browser: false });
    const overviewOptions = reportOverviewQueryOptions(client, mutableOverview, { browser: false });
    const breakdownOptions = reportBreakdownQueryOptions(client, mutableBreakdown, { browser: false });

    mutableSupport.revision = 'revision-mutated';
    mutableOverview.query.revision = 'revision-mutated';
    mutableOverview.query.filters.query = 'mutated-filter';
    mutableOverview.timeline.dimension = 'model';
    mutableBreakdown.query.revision = 'revision-mutated';
    mutableBreakdown.query.filters.query = 'mutated-filter';

    const queryClient = createWebQueryClient();
    await Promise.all([
      queryClient.fetchQuery(supportOptions),
      queryClient.fetchQuery(overviewOptions),
      queryClient.fetchQuery(breakdownOptions),
    ]);

    expect(receivedSupport).toEqual(expectedSupport);
    expect(receivedOverview).toEqual(expectedOverview);
    expect(receivedBreakdown).toEqual(expectedBreakdown);
    expect([...supportOptions.queryKey]).toEqual([...reportSupportKey(expectedSupport)]);
    expect([...overviewOptions.queryKey]).toEqual([...reportOverviewKey(expectedOverview)]);
    expect([...breakdownOptions.queryKey]).toEqual([...reportBreakdownKey(expectedBreakdown)]);
    expect([...supportOptions.queryKey]).not.toEqual([...reportSupportKey(mutableSupport)]);
    expect([...overviewOptions.queryKey]).not.toEqual([...reportOverviewKey(mutableOverview)]);
    expect([...breakdownOptions.queryKey]).not.toEqual([...reportBreakdownKey(mutableBreakdown)]);
    queryClient.clear();
  });

  test('QUERY-REPORT-CURRENT-ALIAS: awaits the same SSR options and reuses hydration without a duplicate bootstrap', async () => {
    let serverCalls = 0;
    const serverClient = createWebQueryClient();
    const serverOptions = reportBootstrapQueryOptions(
      createReportClientStub({
        getReportRevisionBootstrap: (_options) => {
          serverCalls += 1;
          return Promise.resolve(bootstrapUnavailable);
        },
      }),
      { browser: false },
    );

    expect(serverOptions.enabled).toBe(false);
    expect(serverOptions.staleTime).toBe(0);
    expect(serverOptions.gcTime).toBe(DEFAULT_BOUNDED_GC_TIME_MS);
    expect(await serverClient.fetchQuery(serverOptions)).toEqual(bootstrapUnavailable);

    const browserClient = createHydratedWebQueryClient(dehydrateWebQueryClient(serverClient));
    let browserCalls = 0;
    const observer = new QueryObserver(
      browserClient,
      reportBootstrapQueryOptions(
        createReportClientStub({
          getReportRevisionBootstrap: () => {
            browserCalls += 1;
            return Promise.resolve(bootstrapUnavailable);
          },
        }),
        { browser: true },
      ),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve();

    expect(serverCalls).toBe(1);
    expect(browserCalls).toBe(0);
    expect(observer.getCurrentResult().data).toEqual(bootstrapUnavailable);

    unsubscribe();
    serverClient.clear();
    browserClient.clear();
  });

  test('passes the exact Query signal and removes active work on cancellation', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const client = createWebQueryClient();
    const options = reportSupportQueryOptions(
      createReportClientStub({
        getFocusedReportSupport: (_request, callOptions) => {
          const signal = callOptions?.signal;
          if (!signal) {
            return Promise.reject(new Error('Missing Query signal'));
          }
          started.resolve(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }),
      { revision },
      { browser: false },
    );
    const pending = client.fetchQuery(options).catch((error: unknown) => error);
    const signal = await started.promise;

    await client.cancelQueries({ exact: true, queryKey: options.queryKey });
    const cancellation = await pending;

    expect(signal.aborted).toBe(true);
    expect(isCancelledError(cancellation)).toBe(true);
    expect(client.isFetching()).toBe(0);
    client.clear();
  });

  test('QUERY-PUBLICATION-SCOPED-INVALIDATION: refetches only current aliases', async () => {
    let manifestCalls = 0;
    let bootstrapCalls = 0;
    let exactCalls = 0;
    const queryClient = createWebQueryClient();
    const reportClient = createReportClientStub({
      getFocusedReportSupport: () => {
        exactCalls += 1;
        return Promise.resolve(supportUnavailable);
      },
      getReportRevisionBootstrap: () => {
        bootstrapCalls += 1;
        return Promise.resolve(bootstrapUnavailable);
      },
      getReportRevisionManifest: () => {
        manifestCalls += 1;
        return Promise.resolve(manifestUnavailable);
      },
    });
    const manifestOptions = reportManifestQueryOptions(reportClient, { browser: true });
    const bootstrapOptions = reportBootstrapQueryOptions(reportClient, { browser: true });
    const exactOptions = reportSupportQueryOptions(reportClient, { revision }, { browser: true });
    await Promise.all([
      queryClient.fetchQuery(manifestOptions),
      queryClient.fetchQuery(bootstrapOptions),
      queryClient.fetchQuery(exactOptions),
    ]);
    const skillsKey = finiteSwrKey('skills', 'snapshot');
    const syncKey = controlPlaneKey('sync', 'fleet');
    queryClient.setQueryData(skillsKey, { scope: 'skills' });
    queryClient.setQueryData(syncKey, { scope: 'sync' });
    const observers = [
      new QueryObserver(queryClient, manifestOptions),
      new QueryObserver(queryClient, bootstrapOptions),
      new QueryObserver(queryClient, exactOptions),
    ];
    const unsubscribers = observers.map((observer) => observer.subscribe(() => undefined));

    await invalidateCurrentReportAliases(queryClient);

    expect({ bootstrapCalls, exactCalls, manifestCalls }).toEqual({
      bootstrapCalls: 2,
      exactCalls: 1,
      manifestCalls: 2,
    });
    expect(queryClient.getQueryState(exactOptions.queryKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(skillsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(syncKey)?.isInvalidated).toBe(false);

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    queryClient.clear();
  });
});
