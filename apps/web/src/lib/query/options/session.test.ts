import { describe, expect, test } from 'bun:test';
import {
  parseSessionQueryRequest,
  type SessionPageResult,
  type SessionQueryRequest,
  type SessionQueryServerResult,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { isCancelledError, QueryObserver } from '@tanstack/svelte-query';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { createWebQueryClient } from '../client';
import { DEFAULT_BOUNDED_GC_TIME_MS } from '../policies';
import {
  sessionCampaignChildrenKey,
  sessionCampaignChildrenQueryOptions,
  sessionDetailKey,
  sessionNeighborsKey,
  sessionPageKey,
  sessionPageQueryOptions,
  sessionVcsKey,
} from './session';

const query = parseSessionQueryRequest({
  cursor: null,
  filters: { fields: {}, harness: ['codex'], machine: [], origin: [], query: '' },
  pageSize: 25,
  range: { from: null, to: null },
  revision: 'revision-1',
  sort: [{ desc: true, id: 'date' }],
});
const campaignRequest = { campaignKey: 'campaign-1', query };
const neighborRequest = { query, rowId: 'row-1' };

const pageResult = (request = query): SessionQueryServerResult<SessionPageResult> => {
  const requestFingerprint = sessionQueryFingerprint(request);
  return {
    data: {
      itemCount: 0,
      items: [],
      nextCursor: null,
      requestFingerprint,
      revision: request.revision,
      sessionCount: 0,
    },
    ok: true,
    requestFingerprint,
    revision: request.revision,
  };
};

const unusedRpc = (): Promise<never> => Promise.reject(new Error('Unexpected SessionClientAdapter call'));

const createSessionClientStub = (overrides: Partial<SessionClientAdapter> = {}): SessionClientAdapter => ({
  campaignChildren: unusedRpc,
  detail: unusedRpc,
  neighbors: unusedRpc,
  page: unusedRpc,
  vcs: unusedRpc,
  ...overrides,
});

describe('Session Query options', () => {
  test('QUERY-SESSION-EXACT-IMMUTABLE: separates revision, fingerprint, destination, cursor, and row identity', () => {
    const pageMutations: SessionQueryRequest[] = [
      { ...query, cursor: 'cursor-1' },
      { ...query, filters: { ...query.filters, query: 'changed' } },
      { ...query, pageSize: 50 },
      { ...query, range: { from: '2026-08-01T00:00:00.000Z', to: null } },
      { ...query, revision: 'revision-2' },
      { ...query, sort: [{ desc: false, id: 'date' }] },
    ];
    for (const mutation of pageMutations) {
      expect(sessionPageKey(mutation)).not.toEqual(sessionPageKey(query));
    }
    expect(sessionPageKey({ ...query, cursor: 'cursor-1' })).not.toEqual(
      sessionPageKey({ ...query, cursor: 'cursor-2' }),
    );
    expect(sessionCampaignChildrenKey(campaignRequest)).not.toEqual(sessionNeighborsKey(neighborRequest));
    expect(sessionCampaignChildrenKey({ ...campaignRequest, campaignKey: 'campaign-2' })).not.toEqual(
      sessionCampaignChildrenKey(campaignRequest),
    );
    expect(sessionCampaignChildrenKey({ ...campaignRequest, query: { ...query, cursor: 'cursor-1' } })).not.toEqual(
      sessionCampaignChildrenKey({ ...campaignRequest, query: { ...query, cursor: 'cursor-2' } }),
    );
    expect(
      sessionCampaignChildrenKey({
        ...campaignRequest,
        query: { ...query, filters: { ...query.filters, query: 'changed' } },
      }),
    ).not.toEqual(sessionCampaignChildrenKey(campaignRequest));
    expect(sessionNeighborsKey({ ...neighborRequest, rowId: 'row-2' })).not.toEqual(
      sessionNeighborsKey(neighborRequest),
    );
    expect(sessionNeighborsKey({ ...neighborRequest, query: { ...query, revision: 'revision-2' } })).not.toEqual(
      sessionNeighborsKey(neighborRequest),
    );
    const rowRequest = { revision: query.revision, rowId: 'row-1' };
    expect(sessionDetailKey(rowRequest)).not.toEqual(sessionVcsKey(rowRequest));
    expect(sessionDetailKey({ ...rowRequest, rowId: 'row-2' })).not.toEqual(sessionDetailKey(rowRequest));
    expect(sessionDetailKey({ ...rowRequest, revision: 'revision-2' })).not.toEqual(sessionDetailKey(rowRequest));
    expect(sessionVcsKey({ ...rowRequest, rowId: 'row-2' })).not.toEqual(sessionVcsKey(rowRequest));
    expect(sessionVcsKey({ ...rowRequest, revision: 'revision-2' })).not.toEqual(sessionVcsKey(rowRequest));

    const options = sessionCampaignChildrenQueryOptions(createSessionClientStub(), campaignRequest, {
      browser: false,
    });
    expect(options).toMatchObject({
      enabled: false,
      gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
      refetchOnMount: false,
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    });
  });

  test('awaits critical SSR options and forwards the exact cancellation signal', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const queryClient = createWebQueryClient();
    const options = sessionPageQueryOptions(
      createSessionClientStub({
        page: (_request, signal) => {
          if (!signal) {
            return Promise.reject(new Error('Missing Query signal'));
          }
          started.resolve(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      }),
      query,
      { browser: false },
    );
    const pending = queryClient.fetchQuery(options).catch((error: unknown) => error);
    const signal = await started.promise;

    await queryClient.cancelQueries({ exact: true, queryKey: options.queryKey });
    const cancellation = await pending;

    expect(options.enabled).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(isCancelledError(cancellation)).toBe(true);
    expect(queryClient.isFetching()).toBe(0);
    queryClient.clear();
  });

  test('QUERY-RETAINED-DATA: keeps the prior page while a new exact cursor is pending', async () => {
    const secondRequest = { ...query, cursor: 'cursor-2' };
    const secondStarted = Promise.withResolvers<AbortSignal>();
    const queryClient = createWebQueryClient();
    const client = createSessionClientStub({
      page: (request, signal) => {
        if (request.cursor === null) {
          return Promise.resolve(pageResult(request));
        }
        if (!signal) {
          return Promise.reject(new Error('Missing Query signal'));
        }
        secondStarted.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const firstOptions = sessionPageQueryOptions(client, query, { browser: true });
    const secondOptions = sessionPageQueryOptions(client, secondRequest, { browser: true });
    await queryClient.fetchQuery(firstOptions);
    const observer = new QueryObserver(queryClient, firstOptions);
    const unsubscribe = observer.subscribe(() => undefined);

    observer.setOptions(secondOptions);
    const secondSignal = await secondStarted.promise;

    expect(observer.getCurrentResult()).toMatchObject({
      data: pageResult(query),
      isPlaceholderData: true,
      status: 'success',
    });
    await queryClient.cancelQueries({ exact: true, queryKey: secondOptions.queryKey });
    expect(secondSignal.aborted).toBe(true);

    unsubscribe();
    queryClient.clear();
  });

  test('never retains a page across a different immutable fingerprint or revision', async () => {
    const cases = [
      {
        request: { ...query, cursor: 'cursor-fingerprint', pageSize: 50 },
      },
      {
        request: { ...query, cursor: 'cursor-revision', revision: 'revision-2' },
      },
    ];

    for (const testCase of cases) {
      const nextStarted = Promise.withResolvers<AbortSignal>();
      const queryClient = createWebQueryClient();
      const client = createSessionClientStub({
        page: (request, signal) => {
          if (request.cursor === null) {
            return Promise.resolve(pageResult(request));
          }
          if (!signal) {
            return Promise.reject(new Error('Missing Query signal'));
          }
          nextStarted.resolve(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });
      const firstOptions = sessionPageQueryOptions(client, query, { browser: true });
      const nextOptions = sessionPageQueryOptions(client, testCase.request, { browser: true });
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

  test('retains successful exact page data when an explicit refresh fails', async () => {
    let shouldFail = false;
    const queryClient = createWebQueryClient();
    const options = sessionPageQueryOptions(
      createSessionClientStub({
        page: () =>
          shouldFail ? Promise.reject(new Error('typed refresh failure')) : Promise.resolve(pageResult(query)),
      }),
      query,
      { browser: false },
    );
    await queryClient.fetchQuery(options);
    shouldFail = true;
    await queryClient.invalidateQueries({ exact: true, queryKey: options.queryKey, refetchType: 'none' });

    await expect(queryClient.fetchQuery(options)).rejects.toThrow('typed refresh failure');

    expect(queryClient.getQueryData<SessionQueryServerResult<SessionPageResult>>(options.queryKey)).toEqual(
      pageResult(query),
    );
    queryClient.clear();
  });
});
