import { describe, expect, test } from 'bun:test';
import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/web-contract/report';
import { isCancelledError, QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient } from '../client';
import { controlPlaneKey, finiteSwrKey } from '../keys';
import { DEFAULT_BOUNDED_GC_TIME_MS, FINITE_SWR_STALE_TIME_MS } from '../policies';
import {
  invalidateQuotaHistory,
  type QuotaQueryClient,
  quotaHistoryKey,
  quotaHistoryQueryOptions,
  quotaRailHistoryRequest,
  quotaRailKey,
  quotaRailQueryOptions,
  updateQuotaHistory,
} from './quota';

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

const createReportClientStub = (overrides: Partial<QuotaQueryClient> = {}): QuotaQueryClient => ({
  getProviderQuotaHistory: unusedRpc,
  ...overrides,
});

describe('Quota Query options', () => {
  test('QUERY-QUOTA-RAIL: uses one stable finite-SWR key and a two-point all-provider history request', async () => {
    const requests: ProviderQuotaHistoryRequest[] = [];
    const signals: AbortSignal[] = [];
    const queryClient = createWebQueryClient();
    const options = quotaRailQueryOptions(
      createReportClientStub({
        getProviderQuotaHistory: (input, callOptions) => {
          requests.push(input);
          if (callOptions?.signal) {
            signals.push(callOptions.signal);
          }
          return Promise.resolve(quotaResult);
        },
      }),
      { browser: false, enabled: true },
    );

    await expect(queryClient.fetchQuery(options)).resolves.toEqual(quotaResult);

    expect(quotaRailKey()).toEqual(['web', 'finite-swr', 'quota', 'rail']);
    expect(options).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      queryKey: quotaRailKey(),
      staleTime: FINITE_SWR_STALE_TIME_MS,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ maximumPoints: 2 });
    expect(requests[0]?.machineId).toBeUndefined();
    expect(requests[0]?.providerKey).toBeUndefined();
    expect(Date.parse(requests[0]?.to ?? '') - Date.parse(requests[0]?.from ?? '')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(signals).toHaveLength(1);
    expect(quotaRailHistoryRequest(new Date('2026-08-08T00:00:00.000Z'))).toEqual({
      from: '2026-07-09T00:00:00.000Z',
      maximumPoints: 2,
      to: '2026-08-08T00:00:00.000Z',
    });
  });

  test('QUERY-QUOTA-FINITE-SWR: keys every request and policy field without collisions', () => {
    const basePolicy = { range: '24h' as const };
    const baseKey = quotaHistoryKey(request, basePolicy);

    expect(baseKey).toEqual([
      'web',
      'finite-swr',
      'quota',
      'provider-present',
      true,
      'codex',
      'machine-present',
      false,
      '',
      'maximum-points',
      1200,
      'generation-present',
      false,
      '',
      'from',
      request.from,
      'to',
      request.to,
      'range',
      '24h',
    ]);
    const requestMutations: ProviderQuotaHistoryRequest[] = [
      { ...request, providerKey: 'claude' },
      { from: request.from, maximumPoints: 1200, to: request.to },
      { ...request, machineId: 'machine-1' },
      { ...request, from: '2026-07-31T00:00:00.000Z' },
      { ...request, to: '2026-08-03T00:00:00.000Z' },
      { ...request, maximumPoints: 800 },
    ];
    for (const mutation of requestMutations) {
      expect(quotaHistoryKey(mutation, basePolicy)).not.toEqual(baseKey);
    }
    expect(quotaHistoryKey(request, { range: '7d' })).not.toEqual(baseKey);
    expect(quotaHistoryKey(request, { generation: 1, range: '24h' })).not.toEqual(baseKey);
    expect(quotaHistoryKey(request, { generation: 2, range: '24h' })).not.toEqual(
      quotaHistoryKey(request, { generation: 1, range: '24h' }),
    );

    const disabled = quotaHistoryQueryOptions(createReportClientStub(), request, basePolicy, {
      browser: true,
      enabled: false,
    });
    const server = quotaHistoryQueryOptions(createReportClientStub(), request, basePolicy, {
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
      { range: '24h' },
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
    const scopedRequest = { ...request, machineId: 'machine-1' };
    let failRefresh = false;
    const nextStarted = Promise.withResolvers<AbortSignal>();
    const queryClient = createWebQueryClient();
    const client = createReportClientStub({
      getProviderQuotaHistory: (nextRequest, callOptions) => {
        if (failRefresh) {
          return Promise.reject(new Error('typed quota refresh failure'));
        }
        if (nextRequest.from === scopedRequest.from) {
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
    const firstIdentity = { generation: 'generation-1', range: '24h' as const };
    const nextIdentity = { generation: 'generation-1', range: '7d' as const };
    const firstOptions = quotaHistoryQueryOptions(client, scopedRequest, firstIdentity, {
      browser: true,
      enabled: true,
    });
    const nextOptions = quotaHistoryQueryOptions(
      client,
      {
        ...scopedRequest,
        from: '2026-07-26T00:00:00.000Z',
        to: '2026-08-03T00:00:00.000Z',
      },
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

  test('never retains quota data across provider, machine, generation, or resolution boundaries', async () => {
    const scopedRequest = { ...request, machineId: 'machine-1' };
    const firstIdentity = { generation: 'generation-1', range: '24h' as const };
    const cases = [
      {
        identity: { ...firstIdentity, range: '7d' as const },
        nextRequest: { ...scopedRequest, from: '2026-07-25T00:00:00.000Z', providerKey: 'claude' },
      },
      {
        identity: { ...firstIdentity, range: '7d' as const },
        nextRequest: { ...scopedRequest, from: '2026-07-25T00:00:00.000Z', machineId: 'machine-2' },
      },
      {
        identity: { ...firstIdentity, generation: 'generation-2', range: '7d' as const },
        nextRequest: { ...scopedRequest, from: '2026-07-26T00:00:00.000Z' },
      },
      {
        identity: { ...firstIdentity, range: '7d' as const },
        nextRequest: { ...scopedRequest, from: '2026-07-25T00:00:00.000Z', maximumPoints: 800 },
      },
    ];

    for (const testCase of cases) {
      const nextStarted = Promise.withResolvers<AbortSignal>();
      const queryClient = createWebQueryClient();
      const client = createReportClientStub({
        getProviderQuotaHistory: (nextRequest, callOptions) => {
          if (nextRequest.from === scopedRequest.from) {
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
      const firstOptions = quotaHistoryQueryOptions(client, scopedRequest, firstIdentity, {
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
    const targetRequest = { ...request, machineId: 'machine-1' };
    const targetPolicy = { generation: 'generation-1', range: '24h' as const };
    const otherEntries = [
      [{ ...targetRequest, providerKey: 'claude' }, targetPolicy] as const,
      [{ ...targetRequest, machineId: 'machine-2' }, targetPolicy] as const,
      [{ ...targetRequest, from: '2026-07-31T00:00:00.000Z' }, targetPolicy] as const,
      [{ ...targetRequest, to: '2026-08-03T00:00:00.000Z' }, targetPolicy] as const,
      [{ ...targetRequest, maximumPoints: 800 }, targetPolicy] as const,
      [targetRequest, { ...targetPolicy, generation: 'generation-2' }] as const,
      [targetRequest, { ...targetPolicy, range: '7d' as const }] as const,
    ];
    const skillsKey = finiteSwrKey('skills', 'snapshot');
    const syncKey = controlPlaneKey('sync', 'fleet');
    for (const key of [
      quotaHistoryKey(targetRequest, targetPolicy),
      ...otherEntries.map(([otherRequest, otherPolicy]) => quotaHistoryKey(otherRequest, otherPolicy)),
      skillsKey,
      syncKey,
    ]) {
      queryClient.setQueryData(key, { seeded: true });
    }

    await invalidateQuotaHistory(queryClient, targetRequest, targetPolicy);
    expect(queryClient.getQueryState(quotaHistoryKey(targetRequest, targetPolicy))?.isInvalidated).toBe(true);
    for (const [otherRequest, otherPolicy] of otherEntries) {
      expect(queryClient.getQueryState(quotaHistoryKey(otherRequest, otherPolicy))?.isInvalidated).toBe(false);
    }
    expect(queryClient.getQueryState(skillsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(syncKey)?.isInvalidated).toBe(false);

    const updated = { ...quotaResult, generatedAt: '2026-08-02T00:01:00.000Z' };
    updateQuotaHistory(queryClient, targetRequest, targetPolicy, updated);

    expect(queryClient.getQueryData<ProviderQuotaHistoryResult>(quotaHistoryKey(targetRequest, targetPolicy))).toEqual(
      updated,
    );
    expect(queryClient.getQueryState(quotaHistoryKey(targetRequest, targetPolicy))?.isInvalidated).toBe(false);
    for (const [otherRequest, otherPolicy] of otherEntries) {
      expect(queryClient.getQueryState(quotaHistoryKey(otherRequest, otherPolicy))?.isInvalidated).toBe(false);
    }
    expect(queryClient.getQueryState(skillsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(syncKey)?.isInvalidated).toBe(false);
    queryClient.clear();
  });
});
