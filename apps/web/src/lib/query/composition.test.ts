import { describe, expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient, dehydrateWebQueryClient } from './client';
import { createPublicationQueryInvalidator, createWebQueryRuntime, webQueryOwnership } from './composition';
import { controlPlaneKey, finiteSwrKey, immutableRevisionKey } from './keys';
import { reportBootstrapKey, reportManifestKey } from './options/report';
import { queryPolicy } from './policies';

const invalidRpcResponse = (): Response => Response.json({ invalid: true });
const BULK_GC_TIME_MS = 20;
const BULK_GC_SETTLE_MS = 50;

describe('Web Query composition', () => {
  test('QUERY-CONVERGENCE-REQUEST-RUNTIME: isolates request clients and injects each request fetch', async () => {
    const alphaRequests: Request[] = [];
    const betaRequests: Request[] = [];
    const alpha = createWebQueryRuntime({
      fetch: (request) => {
        alphaRequests.push(request);
        return Promise.resolve(invalidRpcResponse());
      },
      requestOwner: 'alpha',
      url: new URL('http://127.0.0.1:41001/alpha'),
    });
    const beta = createWebQueryRuntime({
      fetch: (request) => {
        betaRequests.push(request);
        return Promise.resolve(invalidRpcResponse());
      },
      requestOwner: 'beta',
      url: new URL('http://127.0.0.1:41002/beta'),
    });
    const isolationKey = finiteSwrKey('runtime', 'owner');
    alpha.queryClient.setQueryData(isolationKey, 'alpha');

    await Promise.allSettled([alpha.rpc.report.revisionManifest({}), beta.rpc.report.revisionManifest({})]);

    expect(alpha.queryClient).not.toBe(beta.queryClient);
    expect(alpha.queryClient.getQueryData<string>(isolationKey)).toBe('alpha');
    expect(beta.queryClient.getQueryData(isolationKey)).toBeUndefined();
    expect(alphaRequests).toHaveLength(1);
    expect(betaRequests).toHaveLength(1);
    expect(alphaRequests[0]?.url).toStartWith('http://127.0.0.1:41001/rpc/report/revisionManifest');
    expect(betaRequests[0]?.url).toStartWith('http://127.0.0.1:41002/rpc/report/revisionManifest');
    expect(alphaRequests[0]?.headers.get('x-ai-usage-request-owner')).toBe('alpha');
    expect(betaRequests[0]?.headers.get('x-ai-usage-request-owner')).toBe('beta');
    alpha.queryClient.clear();
    beta.queryClient.clear();
  });

  test('QUERY-CONVERGENCE-HYDRATION: preserves authoritative state without a bootstrap duplicate', async () => {
    const key = reportBootstrapKey();
    const serverClient = createWebQueryClient();
    let serverRequests = 0;
    await serverClient.fetchQuery({
      ...queryPolicy('current-alias'),
      queryFn: () => {
        serverRequests += 1;
        return { revision: 'revision-hydrated' };
      },
      queryKey: key,
    });
    const serverUpdatedAt = serverClient.getQueryState(key)?.dataUpdatedAt;
    const runtime = createWebQueryRuntime({
      fetch: () => Promise.resolve(invalidRpcResponse()),
      hydrationState: dehydrateWebQueryClient(serverClient),
      url: new URL('http://127.0.0.1:41003/'),
    });
    let browserRequests = 0;
    const observer = new QueryObserver(runtime.queryClient, {
      ...queryPolicy('current-alias'),
      queryFn: () => {
        browserRequests += 1;
        return { revision: 'unexpected-duplicate' };
      },
      queryKey: key,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve();

    expect(serverRequests).toBe(1);
    expect(browserRequests).toBe(0);
    expect(runtime.queryClient.getQueryState(key)?.dataUpdatedAt).toBe(serverUpdatedAt);
    expect(observer.getCurrentResult().data).toEqual({ revision: 'revision-hydrated' });
    unsubscribe();
    serverClient.clear();
    runtime.queryClient.clear();
  });

  test('QUERY-CONVERGENCE-PUBLICATION: refetches two current aliases once and nothing else', async () => {
    const queryClient = createWebQueryClient();
    const calls = {
      bootstrap: 0,
      exact: 0,
      manifest: 0,
    };
    const bootstrapOptions = {
      ...queryPolicy('current-alias'),
      queryFn: () => {
        calls.bootstrap += 1;
        return 'bootstrap';
      },
      queryKey: reportBootstrapKey(),
    };
    const manifestOptions = {
      ...queryPolicy('current-alias'),
      queryFn: () => {
        calls.manifest += 1;
        return 'manifest';
      },
      queryKey: reportManifestKey(),
    };
    const exactOptions = {
      ...queryPolicy('immutable-revision'),
      queryFn: () => {
        calls.exact += 1;
        return 'exact';
      },
      queryKey: immutableRevisionKey('report', 'revision-1', 'fingerprint-1', 'overview'),
    };
    await Promise.all([
      queryClient.fetchQuery(bootstrapOptions),
      queryClient.fetchQuery(manifestOptions),
      queryClient.fetchQuery(exactOptions),
    ]);
    const unrelatedKeys = [
      finiteSwrKey('quota', '24h'),
      finiteSwrKey('skills', 'snapshot'),
      controlPlaneKey('sync', 'fleet', 'generation-1'),
    ] as const;
    for (const key of unrelatedKeys) {
      queryClient.setQueryData(key, 'unrelated');
    }
    const observers = [
      new QueryObserver(queryClient, bootstrapOptions),
      new QueryObserver(queryClient, manifestOptions),
      new QueryObserver(queryClient, exactOptions),
    ];
    const unsubscribers = observers.map((observer) => observer.subscribe(() => undefined));
    const invalidatePublication = createPublicationQueryInvalidator(queryClient);

    expect(await invalidatePublication('revision-2')).toBe(true);
    expect(await invalidatePublication('revision-2')).toBe(false);

    expect(calls).toEqual({ bootstrap: 2, exact: 1, manifest: 2 });
    expect(queryClient.getQueryState(exactOptions.queryKey)?.isInvalidated).toBe(false);
    for (const key of unrelatedKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    queryClient.clear();
  });

  test('QUERY-CONVERGENCE-OWNERSHIP: assigns every family a named finite-GC policy', async () => {
    expect(webQueryOwnership.map(({ family }) => family)).toEqual([
      'report-current',
      'report-exact',
      'session',
      'quota',
      'skills',
      'sync',
    ]);
    expect(webQueryOwnership.filter(({ publication }) => publication !== 'none')).toEqual([
      {
        family: 'report-current',
        policy: 'current-alias',
        publication: 'invalidate-current-alias',
        rendering: 'ssr-awaited',
      },
    ]);
    for (const { policy } of webQueryOwnership) {
      expect(Number.isFinite(queryPolicy(policy).gcTime)).toBe(true);
    }

    const queryClient = createWebQueryClient();
    const boundedFixtureKey = finiteSwrKey('bounded-fixture');
    queryClient.setQueryDefaults(boundedFixtureKey, {
      ...queryPolicy('finite-swr'),
      gcTime: BULK_GC_TIME_MS,
    });
    for (let index = 0; index < 1000; index += 1) {
      queryClient.setQueryData(finiteSwrKey('bounded-fixture', index), index);
    }
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1000);
    await Bun.sleep(BULK_GC_SETTLE_MS);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });
});
