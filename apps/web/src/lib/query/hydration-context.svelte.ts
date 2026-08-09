import { getContext, setContext } from 'svelte';
import type { WebQueryHydrationState } from './client';

interface WebQueryHydrationContext {
  readonly appliedSignature: string;
}

const webQueryHydrationContextKey = Symbol('web-query-hydration');

export const installWebQueryHydrationContext = (readAppliedSignature: () => string): void => {
  setContext<WebQueryHydrationContext>(webQueryHydrationContextKey, {
    get appliedSignature() {
      return readAppliedSignature();
    },
  });
};

export const webQueryHydrationSignature = (state: WebQueryHydrationState | undefined): string =>
  state?.dehydratedState.queries
    .map((query) => `${query.queryHash}:${query.state.dataUpdatedAt}`)
    .sort()
    .join('|') ?? '';

export const useWebQueryHydrationContext = (): WebQueryHydrationContext => {
  const context = getContext<WebQueryHydrationContext | undefined>(webQueryHydrationContextKey);
  if (context === undefined) {
    throw new Error('Web Query hydration context is unavailable.');
  }
  return context;
};
