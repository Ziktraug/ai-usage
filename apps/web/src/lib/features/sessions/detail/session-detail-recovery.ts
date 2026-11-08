import type { LazyModuleLoader, LazyModuleLoadResult } from '../../report/composition/lazy-module-loader';

/** Query owns read failures; only the failed render region needs a rejecting retry.
 * Manual refetch ignores Query's enabled flag, so read eligibility must be checked at retry time. */
export const createSessionDetailRecovery = (
  detail: { readonly refetch: (options: { throwOnError: boolean }) => Promise<unknown> },
  drawer: LazyModuleLoader,
  enabled: () => boolean,
) => ({
  recoverRegion: async (): Promise<void> => {
    if (enabled()) {
      await detail.refetch({ throwOnError: true });
    }
  },
  retryAnalysis: async (): Promise<void> => {
    if (enabled()) {
      await detail.refetch({ throwOnError: false });
    }
  },
  retryChunk: (): Promise<LazyModuleLoadResult> => drawer.retry(),
});
