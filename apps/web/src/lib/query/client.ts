import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
  QueryClient as TanStackQueryClient,
} from '@tanstack/svelte-query';
import { webQueryClientDefaultOptions } from './policies';

export interface WebQueryHydrationState {
  readonly dehydratedState: DehydratedState;
}

export const createWebQueryClient = (): QueryClient =>
  new TanStackQueryClient({
    defaultOptions: webQueryClientDefaultOptions,
  });

export const dehydrateWebQueryClient = (client: QueryClient): WebQueryHydrationState => ({
  dehydratedState: dehydrate(client, {
    shouldDehydrateMutation: () => false,
    shouldDehydrateQuery: (query) => query.state.status === 'success',
  }),
});

export const mergeWebQueryHydrationStates = (
  ...states: readonly (WebQueryHydrationState | undefined)[]
): WebQueryHydrationState => {
  const queries = new Map<string, DehydratedState['queries'][number]>();
  const mutations: DehydratedState['mutations'] = [];
  for (const state of states) {
    if (!state) {
      continue;
    }
    for (const query of state.dehydratedState.queries) {
      const current = queries.get(query.queryHash);
      if (!current || query.state.dataUpdatedAt >= current.state.dataUpdatedAt) {
        queries.set(query.queryHash, query);
      }
    }
  }
  return { dehydratedState: { mutations, queries: [...queries.values()] } };
};

export const hydrateWebQueryClient = (client: QueryClient, state: WebQueryHydrationState): QueryClient => {
  hydrate(client, state.dehydratedState);
  return client;
};

export const createHydratedWebQueryClient = (state: WebQueryHydrationState): QueryClient =>
  hydrateWebQueryClient(createWebQueryClient(), state);
