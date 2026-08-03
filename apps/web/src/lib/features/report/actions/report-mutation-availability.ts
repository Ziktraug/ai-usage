import type { RuntimeMode } from '../../../../runtime-mode';
import type { SourceControlConnectionState } from '../../../../source-control-client';

export const reportMutationsEnabled = (runtimeMode: RuntimeMode, connection: SourceControlConnectionState): boolean =>
  runtimeMode === 'live' && connection === 'live';
