import { getContext, setContext } from 'svelte';
import type { WebQueryHydrationState } from './client';

interface WebQueryHydrationContext {
  /**
   * True once every query carried by `state` has been hydrated into the shared client
   * (same query hash, same-or-newer dataUpdatedAt). An empty or absent `state` is always
   * covered: a SvelteKit data request hands a route an empty hydration delta while the
   * root provider may have applied more (for example the quota rail) than the route knows.
   */
  readonly covers: (state: WebQueryHydrationState | undefined) => boolean;
}

const webQueryHydrationContextKey = Symbol('web-query-hydration');

const hydrationEntries = (state: WebQueryHydrationState | undefined): ReadonlyMap<string, number> => {
  const entries = new Map<string, number>();
  for (const query of state?.dehydratedState.queries ?? []) {
    const current = entries.get(query.queryHash);
    if (current === undefined || query.state.dataUpdatedAt > current) {
      entries.set(query.queryHash, query.state.dataUpdatedAt);
    }
  }
  return entries;
};

export const webQueryHydrationCovers = (
  applied: WebQueryHydrationState | undefined,
  expected: WebQueryHydrationState | undefined,
): boolean => {
  const appliedEntries = hydrationEntries(applied);
  for (const [queryHash, dataUpdatedAt] of hydrationEntries(expected)) {
    const appliedAt = appliedEntries.get(queryHash);
    if (appliedAt === undefined || appliedAt < dataUpdatedAt) {
      return false;
    }
  }
  return true;
};

export const installWebQueryHydrationContext = (readAppliedState: () => WebQueryHydrationState | undefined): void => {
  setContext<WebQueryHydrationContext>(webQueryHydrationContextKey, {
    covers: (state) => webQueryHydrationCovers(readAppliedState(), state),
  });
};

export const useWebQueryHydrationContext = (): WebQueryHydrationContext => {
  const context = getContext<WebQueryHydrationContext | undefined>(webQueryHydrationContextKey);
  if (context === undefined) {
    throw new Error('Web Query hydration context is unavailable.');
  }
  return context;
};
