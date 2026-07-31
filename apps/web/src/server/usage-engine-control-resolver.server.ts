import type { UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import type { RuntimeMode } from '../runtime-mode';
import { getServerRuntimeMode } from './runtime-mode.server';

export const resolveUsageEngineControlClientForServer = async (
  mode: RuntimeMode = getServerRuntimeMode(),
): Promise<UsageEngineControlClient> => {
  if (mode === 'demo') {
    const { assertOutsideDemo } = await import('./demo-boundary.server');
    assertOutsideDemo(mode);
    throw new Error('Demo mode does not expose usage engine control.');
  }
  if (mode === 'e2e') {
    const { getSourceControlE2EClient } = await import('./e2e/source-control-fixture.server');
    return getSourceControlE2EClient();
  }
  const { createLiveUsageEngineControlClient } = await import('./usage-engine-control.server');
  return createLiveUsageEngineControlClient();
};
