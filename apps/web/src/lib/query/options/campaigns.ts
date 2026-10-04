import {
  type CreateInfiniteQueryOptions,
  hashKey,
  type InfiniteData,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
  queryOptions,
  skipToken,
} from '@tanstack/svelte-query';
import { webQueryPolicies } from '../policies';

export class CampaignPageProgressError extends Error {
  constructor(reason: string) {
    super(`Campaign page did not make progress: ${reason}`);
    this.name = 'CampaignPageProgressError';
  }
}

/** Validate before Query publishes a page, retaining the readable prefix on failure. */
export const withCampaignPageProgress = <
  Page extends { readonly items: readonly unknown[]; readonly nextCursor: string | null },
>(
  options: CreateInfiniteQueryOptions<Page, Error, InfiniteData<Page, string | null>, QueryKey, string | null>,
  identity: (item: Page['items'][number]) => string,
) => ({
  ...options,
  queryFn: async (context: QueryFunctionContext<QueryKey, string | null>): Promise<Page> => {
    if (typeof options.queryFn !== 'function') {
      throw new Error('Campaign acquisition requires a query function');
    }
    const page = await options.queryFn(context);
    const previous = context.client.getQueryData<InfiniteData<Page, string | null>>(context.queryKey);
    const existingIndex = previous?.pageParams.indexOf(context.pageParam) ?? -1;
    const prefix =
      context.pageParam === null ? [] : (previous?.pages.slice(0, existingIndex < 0 ? undefined : existingIndex) ?? []);
    const usedCursors =
      context.pageParam === null
        ? []
        : (previous?.pageParams.slice(0, existingIndex < 0 ? undefined : existingIndex) ?? []);
    if (page.nextCursor !== null && (page.nextCursor === context.pageParam || usedCursors.includes(page.nextCursor))) {
      throw new CampaignPageProgressError('the response repeats an already acquired cursor');
    }
    if (page.items.length === 0 && page.nextCursor !== null) {
      throw new CampaignPageProgressError('an empty page still advertises another page');
    }
    const seen = new Set(prefix.flatMap((entry) => entry.items.map(identity)));
    for (const item of page.items) {
      const key = identity(item);
      if (seen.has(key)) {
        throw new CampaignPageProgressError('the response repeats an already acquired identity');
      }
      seen.add(key);
    }
    return page;
  },
});

/** Read retained exact data by identity; server state remains exclusively in TanStack Query. */
export const retainedCampaignQuery = <Data>(client: QueryClient, key: QueryKey | undefined): Data | undefined =>
  key === undefined ? undefined : client.getQueryData<Data>(key);

/** Keep the last readable composite observed during a failed replacement, without acquiring data. */
export const retainedCampaignOptions = <Data>(key: QueryKey | undefined) =>
  queryOptions<Data>({
    ...webQueryPolicies.immutableRevision,
    enabled: false,
    queryFn: skipToken,
    queryKey: key ?? ['web', 'retained-campaign', 'none'],
  });

/** Query exposes acquisition errors to the local retry UI; event handlers need no rejected promise. */
export const loadNextCampaignPage = async (query: {
  readonly fetchNextPage: (options: { cancelRefetch: false; throwOnError: false }) => Promise<unknown>;
}): Promise<void> => {
  await query.fetchNextPage({ cancelRefetch: false, throwOnError: false });
};

/** Discard superseded composite page-reference arrays; exact infinite caches retain explored data. */
export const pruneCampaignExplorations = (client: QueryClient, keepKey: QueryKey): void => {
  const keepHash = hashKey(keepKey);
  client.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === 'web' &&
      query.queryKey[1] === 'immutable-revision' &&
      query.queryKey[2] === 'campaign-exploration' &&
      query.queryHash !== keepHash &&
      !query.isActive(),
  });
};
