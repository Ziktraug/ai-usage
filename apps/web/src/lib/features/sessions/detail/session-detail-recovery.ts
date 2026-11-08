import type { LazyModuleLoader } from '../../report/composition/lazy-module-loader';

/** Query owns read failures; only the failed render region needs a rejecting retry. */
export const createSessionDetailRecovery = (
  detail: { readonly refetch: (options: { throwOnError: boolean }) => Promise<unknown> },
  drawer: LazyModuleLoader,
) => ({
  recoverRegion: async (): Promise<void> => {
    await detail.refetch({ throwOnError: true });
  },
  retryAnalysis: async (): Promise<void> => {
    await detail.refetch({ throwOnError: false });
  },
  retryChunk: async (): Promise<void> => {
    await drawer.retry();
  },
});
