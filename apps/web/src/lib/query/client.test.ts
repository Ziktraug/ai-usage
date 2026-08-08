import { describe, expect, test } from 'bun:test';
import { parseSessionQueryRequest, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import { QueryObserver } from '@tanstack/svelte-query';
import {
  countDehydratedSessionPagePayloads,
  createHydratedWebQueryClient,
  createWebQueryClient,
  dehydrateWebQueryClient,
  mergeWebQueryHydrationStates,
} from './client';
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
      ...webQueryPolicies.currentAliasSwr,
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
      ...webQueryPolicies.currentAliasSwr,
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

  test('canonicalizes Session payloads onto session-pages and seeds destination aliases without refetch', () => {
    const serverClient = createWebQueryClient();
    const query = parseSessionQueryRequest({
      cursor: null,
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      pageSize: 200,
      range: { from: null, to: null },
      revision: 'revision-hydrate',
      sort: [{ desc: true, id: 'date' }],
    });
    const fingerprint = sessionQueryFingerprint(query);
    const sessionItem = {
      campaignKey: 'campaign:hydrate',
      kind: 'campaign' as const,
      row: {
        calls: 1,
        campaignKey: 'campaign:hydrate',
        costActual: 0,
        costApprox: 0,
        costKnown: true,
        costQuota: 0,
        durationMs: 1,
        endTime: 2,
        freshTokens: 1,
        harness: 'codex',
        machineId: 'machine-a',
        model: 'model',
        origin: 'interactive' as const,
        project: 'project',
        provider: 'openai',
        rowId: 'row-hydrate',
        sessionLabel: 'Hydrate',
        startTime: 1,
        title: 'Hydrate',
        tokIn: 1,
        tokOut: 1,
        tokenTotal: 2,
        tools: 0,
        turns: 1,
      },
    };
    const topLevel = {
      pageParams: [null],
      pages: [
        {
          itemCount: 1,
          items: [sessionItem],
          nextCursor: null,
          requestFingerprint: fingerprint,
          revision: query.revision,
          sessionCount: 1,
        },
      ],
    };
    const sessions = {
      campaignChildren: [],
      campaignSessions: [],
      query,
      topLevel,
    };
    const destinationData = {
      descriptor: { captureFingerprint: 'c'.repeat(64), revision: query.revision },
      destination: { kind: 'sessions' as const, sessions: query },
      overview: { revision: query.revision },
      sessions,
    };
    const sessionPagesKey = immutableRevisionKey('session-pages', query.revision, fingerprint, 'infinite');
    const exactDestinationKey = [
      'web',
      'immutable-revision',
      'report-destination',
      query.revision,
      'c'.repeat(64),
      'sessions-destination',
      'no-session-window',
    ] as const;
    serverClient.setQueryData(sessionPagesKey, topLevel);
    serverClient.setQueryData(exactDestinationKey, destinationData);
    serverClient.setQueryData(currentAliasKey('report-destination'), destinationData);

    const hydrationState = dehydrateWebQueryClient(serverClient);
    expect(countDehydratedSessionPagePayloads(hydrationState)).toBe(1);

    let browserRequests = 0;
    const browserClient = createHydratedWebQueryClient(hydrationState);
    const observer = new QueryObserver(browserClient, {
      ...webQueryPolicies.currentAliasSwr,
      queryFn: () => {
        browserRequests += 1;
        return destinationData;
      },
      queryKey: currentAliasKey('report-destination'),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const hydratedDestination = browserClient.getQueryData<typeof destinationData>(
      currentAliasKey('report-destination'),
    );

    expect(browserRequests).toBe(0);
    expect(hydratedDestination?.sessions?.topLevel.pages[0]?.items[0]).toEqual(sessionItem);
    expect(browserClient.getQueryData<typeof destinationData>(exactDestinationKey)?.sessions?.topLevel).toEqual(
      topLevel,
    );
    expect(browserClient.getQueryData<typeof topLevel>(sessionPagesKey)).toEqual(topLevel);
    unsubscribe();
    serverClient.clear();
    browserClient.clear();
  });

  test('merges document and page hydration by query hash while retaining the newest exact value', () => {
    const documentClient = createWebQueryClient();
    const pageClient = createWebQueryClient();
    const sharedKey = currentAliasKey('shared');
    const documentOnlyKey = currentAliasKey('document-only');
    const pageOnlyKey = currentAliasKey('page-only');
    documentClient.setQueryData(sharedKey, 'older', { updatedAt: 100 });
    documentClient.setQueryData(documentOnlyKey, 'document', { updatedAt: 200 });
    pageClient.setQueryData(sharedKey, 'newer', { updatedAt: 300 });
    pageClient.setQueryData(pageOnlyKey, 'page', { updatedAt: 200 });
    const merged = mergeWebQueryHydrationStates(
      dehydrateWebQueryClient(documentClient),
      dehydrateWebQueryClient(pageClient),
    );
    const hydrated = createHydratedWebQueryClient(merged);

    expect(merged.dehydratedState.queries).toHaveLength(3);
    expect(hydrated.getQueryData<string>(sharedKey)).toBe('newer');
    expect(hydrated.getQueryData<string>(documentOnlyKey)).toBe('document');
    expect(hydrated.getQueryData<string>(pageOnlyKey)).toBe('page');
  });
});
