import { createServerFn } from '@tanstack/solid-start';
import { assertOutsideDemo } from './demo-boundary.server';

export const exportManualMergeBundle = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(async () => {
    assertOutsideDemo();
    const { exportManualMergeBundleForServer } = await import('./manual-merge.server');
    const result = await exportManualMergeBundleForServer();
    return result;
  });
