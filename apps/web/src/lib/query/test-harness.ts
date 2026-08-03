import type { QueryClient } from '@tanstack/svelte-query';
import { createWebQueryClient } from './client';
import type { WebQueryKey } from './keys';
import type { WebQueryPolicy } from './policies';

export interface QueryHarnessCall {
  readonly id: number;
  readonly key: WebQueryKey;
  readonly signal: AbortSignal;
}

export interface QueryHarnessCacheEntry {
  readonly data: unknown;
  readonly dataUpdatedAt: number;
  readonly fetchStatus: 'fetching' | 'idle' | 'paused';
  readonly key: readonly unknown[];
  readonly queryHash: string;
  readonly status: 'error' | 'pending' | 'success';
}

export interface QueryHarnessResolverContext {
  readonly key: WebQueryKey;
  readonly signal: AbortSignal;
}

export interface QueryHarnessRequest<Value> {
  readonly key: WebQueryKey;
  readonly policy: WebQueryPolicy;
  readonly resolve: (context: QueryHarnessResolverContext) => Promise<Value> | Value;
}

export interface QueryTestHarness {
  readonly activeCalls: () => readonly QueryHarnessCall[];
  readonly cacheEntries: () => readonly QueryHarnessCacheEntry[];
  readonly calls: () => readonly QueryHarnessCall[];
  readonly cancel: (key: WebQueryKey) => Promise<void>;
  readonly client: QueryClient;
  readonly fetch: <Value>(request: QueryHarnessRequest<Value>) => Promise<Value>;
}

export const createQueryTestHarness = (client: QueryClient = createWebQueryClient()): QueryTestHarness => {
  const calls: QueryHarnessCall[] = [];
  const activeCalls = new Map<number, QueryHarnessCall>();
  let nextCallId = 1;

  return {
    activeCalls: () => [...activeCalls.values()],
    cacheEntries: () =>
      client
        .getQueryCache()
        .getAll()
        .map((query) => ({
          data: query.state.data,
          dataUpdatedAt: query.state.dataUpdatedAt,
          fetchStatus: query.state.fetchStatus,
          key: query.queryKey,
          queryHash: query.queryHash,
          status: query.state.status,
        })),
    calls: () => [...calls],
    cancel: async (key) => {
      await client.cancelQueries({ exact: true, queryKey: key });
    },
    client,
    fetch: async ({ key, policy, resolve }) =>
      await client.fetchQuery({
        ...policy,
        queryFn: async ({ signal }) => {
          const call = { id: nextCallId, key, signal } satisfies QueryHarnessCall;
          nextCallId += 1;
          calls.push(call);
          activeCalls.set(call.id, call);
          try {
            return await resolve({ key, signal });
          } finally {
            activeCalls.delete(call.id);
          }
        },
        queryKey: key,
      }),
  };
};
