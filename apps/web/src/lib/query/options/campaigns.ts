import type { QueryClient, QueryKey } from '@tanstack/svelte-query';

/** Read retained exact data by identity; server state remains exclusively in TanStack Query. */
export const retainedCampaignQuery = <Data>(client: QueryClient, key: QueryKey | undefined): Data | undefined =>
  key === undefined ? undefined : client.getQueryData<Data>(key);

export const loadNextCampaignPage = async (query: {
  readonly fetchNextPage: () => Promise<unknown>;
}): Promise<void> => {
  await query.fetchNextPage();
};
