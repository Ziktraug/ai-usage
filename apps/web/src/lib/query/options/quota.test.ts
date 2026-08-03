import { describe, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/web-contract/report';
import { isCancelledError, QueryObserver } from '@tanstack/svelte-query';
import type { ReportClient } from '../../rpc/report-client';
import { createWebQueryClient } from '../client';
import { controlPlaneKey, finiteSwrKey } from '../keys';
import { DEFAULT_BOUNDED_GC_TIME_MS, FINITE_SWR_STALE_TIME_MS } from '../policies';
import { invalidateQuotaHistory, quotaHistoryKey, quotaHistoryQueryOptions, updateQuotaHistory } from './quota';

const request: ProviderQuotaHistoryRequest = {
  from: '2026-08-01T00:00:00.000Z',
  maximumPoints: 1200,
  providerKey: 'codex',
  to: '2026-08-02T00:00:00.000Z',
};
const quotaResult: ProviderQuotaHistoryResult = {
  coverage: [],
  generatedAt: '2026-08-02T00:00:00.000Z',
  latest: [],
  points: [],
  skipped: 0,
  truncated: false,
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

describe('Quota Query options', () => {
  test('QUERY-QUOTA-FINITE-SWR: keys provider, range, and optional generation without collisions', () => {
    const base = { provider: 'codex', range: '24h' as const };

    expect(quotaHistoryKey(base)).toEqual(['web', 'finite-swr', 'quota', 'codex', '24h']);
    expect(quotaHistoryKey({ ...base, generation: 1 })).not.toEqual(quotaHistoryKey(base));
    expect(quotaHistoryKey({ ...base, generation: 2 })).not.toEqual(quotaHistoryKey({ ...base, generation: 1 }));
    expect(quotaHistoryKey({ ...base, provider: 'claude' })).not.toEqual(quotaHistoryKey(base));
    expect(quotaHistoryKey({ ...base, range: '7d' })).not.toEqual(quotaHistoryKey(base));

    const disabled = quotaHistoryQueryOptions(createReportClientStub(), request, base, {
      browser: true,
      enabled: false,
    });
    const server = quotaHistoryQueryOptions(createReportClientStub(), request, base, {
      browser: false,
      enabled: true,
    });
    expect(disabled.enabled).toBe(false);
    expect(server).toMatchObject({
      enabled: false,
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      refetchOnMount: true,
      retry: false,
      staleTime: FINITE_SWR_STALE_TIME_MS,
    });
  });

  test('awaits the same SSR options and forwards the exact Query signal', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const queryClient = createWebQueryClient();
    const options = quotaHistoryQueryOptions(
      createReportClientStub({
        getProviderQuotaHistory: (_request, callOptions) => {
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
      request,
      { provider: 'codex', range: '24h' },
      { browser: false, enabled: true },
    );
    const pending = queryClient.fetchQuery(options).catch((error: unknown) => error);
    const signal = await started.promise;

    await queryClient.cancelQueries({ exact: true, queryKey: options.queryKey });
    const cancellation = await pending;

    expect(signal.aborted).toBe(true);
    expect(isCancelledError(cancellation)).toBe(true);
    queryClient.clear();
  });

  test('QUERY-RETAINED-DATA: keeps prior quota data during a finite-SWR range refresh and after a refresh error', async () => {
    let failRefresh = false;
    const nextStarted = Promise.withResolvers<AbortSignal>();
    const queryClient = createWebQueryClient();
    const client = createReportClientStub({
      getProviderQuotaHistory: (nextRequest, callOptions) => {
        if (failRefresh) {
          return Promise.reject(new Error('typed quota refresh failure'));
        }
        if (nextRequest.from === request.from) {
          return Promise.resolve(quotaResult);
        }
        const signal = callOptions?.signal;
        if (!signal) {
          return Promise.reject(new Error('Missing Query signal'));
        }
        nextStarted.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const firstIdentity = { provider: 'codex', range: '24h' as const };
    const nextIdentity = { provider: 'codex', range: '7d' as const };
    const firstOptions = quotaHistoryQueryOptions(client, request, firstIdentity, { browser: true, enabled: true });
    const nextOptions = quotaHistoryQueryOptions(
      client,
      { ...request, from: '2026-07-26T00:00:00.000Z' },
      nextIdentity,
      { browser: true, enabled: true },
    );
    await queryClient.fetchQuery(firstOptions);
    const observer = new QueryObserver(queryClient, firstOptions);
    const unsubscribe = observer.subscribe(() => undefined);

    observer.setOptions(nextOptions);
    const nextSignal = await nextStarted.promise;

    expect(observer.getCurrentResult()).toMatchObject({
      data: quotaResult,
      isPlaceholderData: true,
      status: 'success',
    });
    await queryClient.cancelQueries({ exact: true, queryKey: nextOptions.queryKey });
    expect(nextSignal.aborted).toBe(true);

    failRefresh = true;
    await queryClient.invalidateQueries({ exact: true, queryKey: firstOptions.queryKey, refetchType: 'none' });
    await expect(queryClient.fetchQuery(firstOptions)).rejects.toThrow('typed quota refresh failure');
    expect(queryClient.getQueryData<ProviderQuotaHistoryResult>(firstOptions.queryKey)).toEqual(quotaResult);

    unsubscribe();
    queryClient.clear();
  });

  test('never retains quota data across a different provider or durable generation', async () => {
    const firstIdentity = { generation: 'generation-1', provider: 'codex', range: '24h' as const };
    const cases = [
      {
        identity: { ...firstIdentity, provider: 'claude', range: '7d' as const },
        nextRequest: { ...request, from: '2026-07-25T00:00:00.000Z', providerKey: 'claude' },
      },
      {
        identity: { ...firstIdentity, generation: 'generation-2', range: '7d' as const },
        nextRequest: { ...request, from: '2026-07-26T00:00:00.000Z' },
      },
    ];

    for (const testCase of cases) {
      const nextStarted = Promise.withResolvers<AbortSignal>();
      const queryClient = createWebQueryClient();
      const client = createReportClientStub({
        getProviderQuotaHistory: (nextRequest, callOptions) => {
          if (nextRequest.from === request.from) {
            return Promise.resolve(quotaResult);
          }
          const signal = callOptions?.signal;
          if (!signal) {
            return Promise.reject(new Error('Missing Query signal'));
          }
          nextStarted.resolve(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });
      const firstOptions = quotaHistoryQueryOptions(client, request, firstIdentity, {
        browser: true,
        enabled: true,
      });
      const nextOptions = quotaHistoryQueryOptions(client, testCase.nextRequest, testCase.identity, {
        browser: true,
        enabled: true,
      });
      await queryClient.fetchQuery(firstOptions);
      const observer = new QueryObserver(queryClient, firstOptions);
      const unsubscribe = observer.subscribe(() => undefined);

      observer.setOptions(nextOptions);
      await nextStarted.promise;

      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
      expect(observer.getCurrentResult().status).toBe('pending');

      await queryClient.cancelQueries({ exact: true, queryKey: nextOptions.queryKey });
      unsubscribe();
      queryClient.clear();
    }
  });

  test('invalidates and updates only the exact quota identity, never other quota, Skills, or Sync keys', async () => {
    const queryClient = createWebQueryClient();
    const target = { generation: 'generation-1', provider: 'codex', range: '24h' as const };
    const otherGeneration = { ...target, generation: 'generation-2' };
    const otherProvider = { ...target, provider: 'claude' };
    const otherRange = { ...target, range: '7d' as const };
    const skillsKey = finiteSwrKey('skills', 'snapshot');
    const syncKey = controlPlaneKey('sync', 'fleet');
    for (const key of [
      quotaHistoryKey(target),
      quotaHistoryKey(otherGeneration),
      quotaHistoryKey(otherProvider),
      quotaHistoryKey(otherRange),
      skillsKey,
      syncKey,
    ]) {
      queryClient.setQueryData(key, { seeded: true });
    }

    await invalidateQuotaHistory(queryClient, target);
    expect(queryClient.getQueryState(quotaHistoryKey(target))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(quotaHistoryKey(otherGeneration))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(quotaHistoryKey(otherProvider))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(quotaHistoryKey(otherRange))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(skillsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(syncKey)?.isInvalidated).toBe(false);

    const updated = { ...quotaResult, generatedAt: '2026-08-02T00:01:00.000Z' };
    updateQuotaHistory(queryClient, target, updated);

    expect(queryClient.getQueryData<ProviderQuotaHistoryResult>(quotaHistoryKey(target))).toEqual(updated);
    expect(queryClient.getQueryState(quotaHistoryKey(target))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(quotaHistoryKey(otherGeneration))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(quotaHistoryKey(otherProvider))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(quotaHistoryKey(otherRange))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(skillsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(syncKey)?.isInvalidated).toBe(false);
    queryClient.clear();
  });
});
