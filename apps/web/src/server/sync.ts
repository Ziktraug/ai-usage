import { createServerFn } from '@tanstack/solid-start';

export const exportManualMergeBundle = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(() =>
    import('./manual-merge.server').then(({ exportManualMergeBundleForServer }) => exportManualMergeBundleForServer()),
  );
