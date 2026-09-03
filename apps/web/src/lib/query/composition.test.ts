import { describe, expect, test } from 'bun:test';
import type { Client } from '@orpc/client';
import { createORPCSvelteQueryUtils } from '@orpc/svelte-query';
import { QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient, dehydrateWebQueryClient } from './client';
import { createPublicationQueryInvalidator, createWebQueryRuntime, webQueryOwnership } from './composition';
import { skillObservationsKey } from './identities/skills';
import { controlPlaneKey, currentAliasKey, finiteSwrKey, immutableRevisionKey } from './keys';
import { reportBootstrapKey, reportManifestKey } from './options/report';
import { queryPolicy } from './policies';
import { currentReportAliasKeys, publicationInvalidatedKeys } from './publication';

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
      ...queryPolicy('current-alias-swr'),
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
      ...queryPolicy('current-alias-swr'),
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
      ...queryPolicy('current-alias-swr'),
      queryFn: () => {
        calls.bootstrap += 1;
        return 'bootstrap';
      },
      queryKey: reportBootstrapKey(),
    };
    const manifestOptions = {
      ...queryPolicy('current-alias-swr'),
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
      controlPlaneKey('sources', 'snapshot'),
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
      'skill-observations',
      'memory',
      'projects',
      'sync',
      'replication',
      'sources',
    ]);
    // Exactly two families react to a completed publication cycle, and they react differently. The
    // report aliases are swept because the cycle republished or renewed the revision they name;
    // skill observations are swept because that same cycle wrote them and nothing else can.
    expect(webQueryOwnership.filter(({ publication }) => publication !== 'none')).toEqual([
      {
        family: 'report-current',
        policy: 'current-alias-swr',
        publication: 'invalidate-current-alias',
        rendering: 'ssr-awaited',
      },
      {
        family: 'skill-observations',
        policy: 'collection-swr',
        publication: 'invalidate-collection-identity',
        rendering: 'ssr-awaited',
      },
    ]);
    // The declared behaviour is the behaviour: what a cycle actually invalidates is what this
    // metadata says it does, so the two cannot drift apart unnoticed.
    expect(publicationInvalidatedKeys()).toEqual([...currentReportAliasKeys(), skillObservationsKey()]);
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

  test('QUERY-ORPC-IDENTITY: derives stable keys, deduplicates calls, and forwards cancellation', async () => {
    interface FixtureInput {
      readonly filters: {
        readonly alpha: number;
        readonly beta: number;
      };
      readonly id: string;
    }

    const calls: FixtureInput[] = [];
    const signals: AbortSignal[] = [];
    const gates = new Map<string, PromiseWithResolvers<{ id: string }>>();
    const procedure: Client<Record<never, never>, FixtureInput, { id: string }, Error> = (input, options) => {
      calls.push(input);
      const signal = options?.signal;
      if (signal === undefined) {
        throw new Error('TanStack Query did not forward its AbortSignal to oRPC.');
      }
      signals.push(signal);
      const gate = Promise.withResolvers<{ id: string }>();
      gates.set(input.id, gate);
      return gate.promise;
    };
    const orpc = createORPCSvelteQueryUtils({ fixture: { byId: procedure } });
    const queryClient = createWebQueryClient();
    const firstInput = { filters: { alpha: 1, beta: 2 }, id: 'shared' };
    const firstOptions = orpc.fixture.byId.queryOptions({
      ...queryPolicy('finite-swr'),
      input: firstInput,
    });
    const secondOptions = orpc.fixture.byId.queryOptions({
      ...queryPolicy('finite-swr'),
      input: { filters: { beta: 2, alpha: 1 }, id: 'shared' },
    });

    expect(firstOptions.queryKey).toEqual([['fixture', 'byId'], { input: firstInput, type: 'query' }]);
    expect(orpc.fixture.byId.key({ input: firstInput })).toEqual([['fixture', 'byId'], { input: firstInput }]);

    const first = queryClient.fetchQuery(firstOptions);
    const second = queryClient.fetchQuery(secondOptions);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(signals).toHaveLength(1);
    gates.get('shared')?.resolve({ id: 'shared' });
    await expect(Promise.all([first, second])).resolves.toEqual([{ id: 'shared' }, { id: 'shared' }]);

    const cancelledInput = { filters: { alpha: 3, beta: 4 }, id: 'cancelled' };
    const aborted = queryClient.fetchQuery(
      orpc.fixture.byId.queryOptions({
        ...queryPolicy('finite-swr'),
        input: cancelledInput,
      }),
    );
    await Promise.resolve();
    await queryClient.cancelQueries({ queryKey: orpc.fixture.byId.key({ input: cancelledInput }) });
    expect(signals[1]?.aborted).toBe(true);
    await expect(aborted).rejects.toBeDefined();
    queryClient.clear();
  });

  test('QUERY-CURRENT-ALIAS-SWR: renders cached data while an invalidated alias revalidates', async () => {
    const queryClient = createWebQueryClient();
    const refresh = Promise.withResolvers<{ revision: string }>();
    let calls = 0;
    const options = {
      ...queryPolicy('current-alias-swr'),
      queryFn: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve({ revision: 'cached' }) : refresh.promise;
      },
      queryKey: currentAliasKey('swr-fixture'),
    };
    await queryClient.fetchQuery(options);
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);

    const invalidation = queryClient.invalidateQueries({ exact: true, queryKey: options.queryKey });
    await Promise.resolve();
    expect(observer.getCurrentResult()).toMatchObject({
      data: { revision: 'cached' },
      fetchStatus: 'fetching',
      isStale: true,
      status: 'success',
    });
    refresh.resolve({ revision: 'refreshed' });
    await invalidation;
    expect(observer.getCurrentResult()).toMatchObject({
      data: { revision: 'refreshed' },
      fetchStatus: 'idle',
      status: 'success',
    });
    unsubscribe();
    queryClient.clear();
  });
});
