import type { RuntimeMode } from '../../../foundation/runtime-mode';
import type { SourceControlConnectionState } from '../../../foundation/source-control-client';

export const reportMutationsEnabled = (runtimeMode: RuntimeMode, connection: SourceControlConnectionState): boolean =>
  runtimeMode === 'live' && connection === 'live';
