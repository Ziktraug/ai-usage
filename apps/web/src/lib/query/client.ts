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

export const hydrateWebQueryClient = (client: QueryClient, state: WebQueryHydrationState): QueryClient => {
  hydrate(client, state.dehydratedState);
  return client;
};

export const createHydratedWebQueryClient = (state: WebQueryHydrationState): QueryClient =>
  hydrateWebQueryClient(createWebQueryClient(), state);
