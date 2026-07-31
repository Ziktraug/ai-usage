import type { RuntimeMode } from '../runtime-mode';
import { getServerRuntimeMode } from './runtime-mode.server';
import type { UsageReadModel } from './usage-read-model.server';

type LoadLiveUsageReadModel = () => Promise<{
  readonly createLiveUsageReadModel: () => UsageReadModel;
}>;

const loadLiveUsageReadModel: LoadLiveUsageReadModel = async () => await import('./usage-read-model.server');

export const resolveUsageReadModelForServer = async (
  mode: RuntimeMode = getServerRuntimeMode(),
  loadLive: LoadLiveUsageReadModel = loadLiveUsageReadModel,
): Promise<UsageReadModel> => {
  if (mode === 'demo') {
    const { assertOutsideDemo } = await import('./demo-boundary.server');
    assertOutsideDemo(mode);
    throw new Error('Demo mode does not expose the durable usage read model.');
  }
  if (mode === 'e2e') {
    const { getSyncE2EUsageReadModel } = await import('./e2e/sync-fixture.server');
    return getSyncE2EUsageReadModel();
  }
  const { createLiveUsageReadModel } = await loadLive();
  return createLiveUsageReadModel();
};
