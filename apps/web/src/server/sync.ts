import { createServerFn } from '@tanstack/solid-start';
import { exportManualMergeBundleForServer, getSyncFleetForServer } from './sync-data.server';

export const getSyncFleet = createServerFn({ method: 'GET' }).handler(async () => {
  const { assertOutsideDemo } = await import('./demo-boundary.server');
  assertOutsideDemo();
  const { resolveUsageReadModelForServer } = await import('./usage-read-model-resolver.server');
  return await getSyncFleetForServer(await resolveUsageReadModelForServer());
});

export const exportManualMergeBundle = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(async () => {
    const { assertOutsideDemo } = await import('./demo-boundary.server');
    assertOutsideDemo();
    const { resolveUsageReadModelForServer } = await import('./usage-read-model-resolver.server');
    return await exportManualMergeBundleForServer(await resolveUsageReadModelForServer());
  });
