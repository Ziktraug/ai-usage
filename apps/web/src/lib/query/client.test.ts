import { describe, expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/svelte-query';
import { createHydratedWebQueryClient, createWebQueryClient, dehydrateWebQueryClient } from './client';
import { currentAliasKey, immutableRevisionKey } from './keys';
import { DEFAULT_BOUNDED_GC_TIME_MS, webQueryPolicies } from './policies';
import { createQueryTestHarness } from './test-harness';

describe('request-scoped Web QueryClient', () => {
  test('QUERY-CORE-REQUEST-ISOLATION: isolates overlapping same-key request work and caches', async () => {
    const alpha = createQueryTestHarness();
    const beta = createQueryTestHarness();
    const key = immutableRevisionKey('report', 'revision-1', 'fingerprint-1', 'overview');
    const alphaResult = Promise.withResolvers<{ owner: 'alpha' }>();
    const betaResult = Promise.withResolvers<{ owner: 'beta' }>();
    const alphaStarted = Promise.withResolvers<AbortSignal>();
    const betaStarted = Promise.withResolvers<AbortSignal>();
    const alphaPending = alpha.fetch({
      key,
      policy: webQueryPolicies.immutableRevision,
      resolve: ({ signal }) => {
        alphaStarted.resolve(signal);
        return alphaResult.promise;
      },
    });
    const betaPending = beta.fetch({
      key,
      policy: webQueryPolicies.immutableRevision,
      resolve: ({ signal }) => {
        betaStarted.resolve(signal);
        return betaResult.promise;
      },
    });
    let betaSettlement: 'pending' | 'rejected' | 'resolved' = 'pending';
    const betaOutcome = betaPending.then(
      (value) => {
        betaSettlement = 'resolved';
        return { status: 'resolved', value } as const;
      },
      (error: unknown) => {
        betaSettlement = 'rejected';
        return { error, status: 'rejected' } as const;
      },
    );
    const [alphaSignal, betaSignal] = await Promise.all([alphaStarted.promise, betaStarted.promise]);

    expect(alpha.client).not.toBe(beta.client);
    expect(alphaSignal).not.toBe(betaSignal);
    expect(alpha.activeCalls()).toHaveLength(1);
    expect(beta.activeCalls()).toHaveLength(1);

    alphaResult.resolve({ owner: 'alpha' });
    await expect(alphaPending).resolves.toEqual({ owner: 'alpha' });
    expect(betaSettlement).toBe('pending');
    expect(betaSignal.aborted).toBe(false);
    expect(beta.cacheEntries()).toMatchObject([{ fetchStatus: 'fetching', key, status: 'pending' }]);

    await alpha.client.invalidateQueries({ exact: true, queryKey: key });
    const alphaRefetchStarted = Promise.withResolvers<AbortSignal>();
    const alphaRefetch = alpha.fetch({
      key,
      policy: webQueryPolicies.immutableRevision,
      resolve: ({ signal }) => {
        alphaRefetchStarted.resolve(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const alphaRefetchOutcome = alphaRefetch.catch((error: unknown) => error);
    const alphaRefetchSignal = await alphaRefetchStarted.promise;
    expect(alphaRefetchSignal).not.toBe(betaSignal);
    expect(alpha.activeCalls()).toHaveLength(1);

    await alpha.cancel(key);
    await alphaRefetchOutcome;
    expect(alphaRefetchSignal.aborted).toBe(true);
    expect(alpha.activeCalls()).toEqual([]);
    alpha.client.clear();
    await Promise.resolve();

    expect(alpha.cacheEntries()).toEqual([]);
    expect(betaSettlement).toBe('pending');
    expect(betaSignal.aborted).toBe(false);
    expect(beta.activeCalls()).toHaveLength(1);
    expect(beta.cacheEntries()).toMatchObject([{ fetchStatus: 'fetching', key, status: 'pending' }]);

    betaResult.resolve({ owner: 'beta' });
    expect(await betaOutcome).toEqual({ status: 'resolved', value: { owner: 'beta' } });
    expect(beta.activeCalls()).toEqual([]);
    expect(beta.cacheEntries()).toMatchObject([{ data: { owner: 'beta' }, key, status: 'success' }]);
  });

  test('QUERY-CORE-NO-GLOBAL-STALE: keeps safety defaults explicit without a global stale policy', () => {
    const defaults = createWebQueryClient().getDefaultOptions();

    expect(defaults.queries).toMatchObject({
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: false,
    });
    expect(defaults.mutations).toMatchObject({ retry: false });
    expect(Object.hasOwn(defaults.queries ?? {}, 'staleTime')).toBe(false);
    expect(Number.isFinite(defaults.queries?.gcTime)).toBe(true);
  });

  test('QUERY-CORE-HYDRATION-TIMESTAMP: preserves authoritative time and avoids a duplicate query', async () => {
    const serverClient = createWebQueryClient();
    const key = currentAliasKey('report');
    let serverRequests = 0;
    await serverClient.fetchQuery({
      ...webQueryPolicies.currentAlias,
      queryFn: () => {
        serverRequests += 1;
        return { revision: 'revision-2' };
      },
      queryKey: key,
    });
    const serverUpdatedAt = serverClient.getQueryState(key)?.dataUpdatedAt;
    const hydrationState = dehydrateWebQueryClient(serverClient);
    const browserClient = createHydratedWebQueryClient(hydrationState);
    let browserRequests = 0;
    const observer = new QueryObserver(browserClient, {
      ...webQueryPolicies.currentAlias,
      queryFn: () => {
        browserRequests += 1;
        return { revision: 'unexpected-duplicate' };
      },
      queryKey: key,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve();

    expect(serverRequests).toBe(1);
    expect(serverUpdatedAt).toBeGreaterThan(0);
    expect(browserClient.getQueryState(key)?.dataUpdatedAt).toBe(serverUpdatedAt);
    expect(browserRequests).toBe(0);
    expect(observer.getCurrentResult().data).toEqual({ revision: 'revision-2' });
    unsubscribe();
  });
});
