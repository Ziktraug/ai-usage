import { createServerFn } from '@tanstack/solid-start';

export const getSyncFleet = createServerFn({ method: 'GET' }).handler(async () => {
  const { assertOutsideDemo } = await import('./demo-boundary.server');
  assertOutsideDemo();
  const { queryManualSyncFleetForServer } = await import('./manual-merge.server');
  return await queryManualSyncFleetForServer();
});

export const exportManualMergeBundle = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(async () => {
    const { assertOutsideDemo } = await import('./demo-boundary.server');
    assertOutsideDemo();
    const { exportManualMergeBundleForServer } = await import('./manual-merge.server');
    const result = await exportManualMergeBundleForServer();
    return result;
  });
