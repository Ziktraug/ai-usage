import type { RuntimeMode } from '../runtime-mode';
import { getServerRuntimeMode } from './runtime-mode.server';

export const startSourceControlPluginOutsideDemo = async (
  start: () => Promise<void>,
  mode: RuntimeMode = getServerRuntimeMode(),
): Promise<boolean> => {
  if (mode === 'demo') {
    return false;
  }
  await start();
  return true;
};
