import { browserQueryRuntime } from '../../query/browser-runtime';
import type { WebQueryHydrationState } from '../../query/client';
import { reportUnexpectedPrefetchFailure } from './prefetch-errors';
import type { RoutePrefetch } from './query-load';

export const NAVIGATION_PREFETCH_BUDGET_MS = 250;

/** Bounds routing, not the Query request: late answers still populate the document cache. */
export const prefetchNavigationIntent = async (
  state: WebQueryHydrationState | undefined,
  prefetch: RoutePrefetch,
): Promise<void> => {
  const runtime = browserQueryRuntime();
  if (!(runtime && state) || state.dehydratedState.queries.length > 0) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // Query owns the failure. The destination observer exposes it (and its normal retry UI).
      Promise.resolve()
        .then(() => prefetch(runtime))
        .catch(reportUnexpectedPrefetchFailure),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, NAVIGATION_PREFETCH_BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
