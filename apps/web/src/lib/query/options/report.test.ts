import { describe, expect, test } from 'bun:test';
import type {
  FocusedReportServerResult,
  FocusedSupportResult,
  ReportRevisionBootstrapResult,
  ReportRevisionManifestResult,
} from '@ai-usage/web-contract/report';
import { isCancelledError, QueryObserver } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import { createHydratedWebQueryClient, createWebQueryClient, dehydrateWebQueryClient } from '../client';
import { controlPlaneKey, finiteSwrKey } from '../keys';
import { DEFAULT_BOUNDED_GC_TIME_MS } from '../policies';
import {
  invalidateCurrentReportAliases,
  reportBootstrapKey,
  reportBootstrapQueryOptions,
  reportBreakdownKey,
  reportManifestKey,
  reportManifestQueryOptions,
  reportOverviewKey,
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

const unusedRpc = (): Promise<never> => Promise.reject(new Error('Unexpected ReportClient call'));

const createReportClientStub = (overrides: Partial<ReportClient> = {}): ReportClient => ({
  getCampaignLabelOverrides: unusedRpc,
  getFocusedReportBreakdown: unusedRpc,
  getFocusedReportOverview: unusedRpc,
  getFocusedReportSupport: unusedRpc,
  getProviderQuotaHistory: unusedRpc,
  getReportPerfEnabled: unusedRpc,
  getReportRevisionBootstrap: unusedRpc,
  getReportRevisionManifest: unusedRpc,
  saveProjectGroups: unusedRpc,
  setCampaignLabelOverride: unusedRpc,
  ...overrides,
});

describe('Report Query options', () => {
  test('QUERY-REPORT-EXACT-IMMUTABLE: keys exact revision, fingerprint, and destination without collisions', () => {
    const identity = { fingerprint: 'fingerprint-1', revision };

    expect(reportManifestKey()).not.toEqual(reportBootstrapKey());
    expect(reportSupportKey(identity)).toEqual([
      'web',
      'immutable-revision',
      'report',
      revision,
      'fingerprint-1',
      'support',
    ]);
    expect(reportOverviewKey(identity)).not.toEqual(reportSupportKey(identity));
    expect(reportBreakdownKey(identity)).not.toEqual(reportOverviewKey(identity));
    expect(reportSupportKey({ ...identity, fingerprint: 'fingerprint-2' })).not.toEqual(reportSupportKey(identity));
    expect(reportSupportKey({ ...identity, revision: 'revision-2' })).not.toEqual(reportSupportKey(identity));

    const options = reportSupportQueryOptions(
      createReportClientStub({ getFocusedReportSupport: () => Promise.resolve(supportUnavailable) }),
      { revision },
      identity,
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
      { fingerprint: 'fingerprint-1', revision },
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
    const exactOptions = reportSupportQueryOptions(
      reportClient,
      { revision },
      { fingerprint: 'fingerprint-1', revision },
      { browser: true },
    );
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
