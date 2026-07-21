import { createServerFn } from '@tanstack/solid-start';

export const exportManualMergeBundle = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(async () => {
    const { assertOutsideDemo } = await import('./demo-boundary.server');
    assertOutsideDemo();
    const { exportManualMergeBundleForServer } = await import('./manual-merge.server');
    const result = await exportManualMergeBundleForServer();
    return result;
  });
