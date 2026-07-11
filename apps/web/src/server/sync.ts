import { createServerFn } from '@tanstack/solid-start';

export const exportManualMergeBundle = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(async () => {
    const { exportManualMergeBundleForServer } = await import('./manual-merge.server');
    const result = await exportManualMergeBundleForServer();
    return result;
  });
