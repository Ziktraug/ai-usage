import { describe, expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/svelte-query';
import { createHydratedWebQueryClient, createWebQueryClient, dehydrateWebQueryClient } from './client';
import { currentAliasKey, immutableRevisionKey } from './keys';
import { DEFAULT_BOUNDED_GC_TIME_MS, webQueryPolicies } from './policies';

describe('request-scoped Web QueryClient', () => {
  test('QUERY-CORE-REQUEST-ISOLATION: creates independent caches for concurrent requests', () => {
    const alpha = createWebQueryClient();
    const beta = createWebQueryClient();
    const key = immutableRevisionKey('report', 'revision-1', 'fingerprint-1', 'overview');

    alpha.setQueryData(key, { owner: 'alpha' });
    beta.setQueryData(key, { owner: 'beta' });

    expect(alpha).not.toBe(beta);
    expect(alpha.getQueryData<{ owner: string }>(key)).toEqual({ owner: 'alpha' });
    expect(beta.getQueryData<{ owner: string }>(key)).toEqual({ owner: 'beta' });
    alpha.clear();
    expect(beta.getQueryData<{ owner: string }>(key)).toEqual({ owner: 'beta' });
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
