import type { SyncRemoteState, SyncState, SyncTokenStatus } from '@ai-usage/sync';

export interface SyncSummary {
  configuredRemotes: number;
  enabledRemotes: number;
  missingTokens: number;
  storedSnapshots: number;
  warningCount: number;
}

export const buildSyncSummary = (state: SyncState): SyncSummary => ({
  configuredRemotes: state.remotes.length,
  enabledRemotes: state.remotes.filter((remote) => remote.enabled).length,
  missingTokens: state.remotes.filter((remote) => remote.tokenStatus === 'missing').length,
  storedSnapshots: state.storedSnapshots.length,
  warningCount: state.warnings.length,
});

export const tokenStatusLabel = (status: SyncTokenStatus) => {
  switch (status) {
    case 'missing':
      return 'Missing env';
    case 'present':
      return 'Env present';
    case 'none':
      return 'No token';
  }
};

export const enabledStatusLabel = (remote: Pick<SyncRemoteState, 'enabled'>) =>
  remote.enabled ? 'Enabled' : 'Disabled';

export const remoteMachineLabel = (remote: Pick<SyncRemoteState, 'machineLabel' | 'machineId'>) =>
  remote.machineLabel ?? remote.machineId ?? 'Not pulled yet';

export const formatSyncDateTime = (iso: string | undefined) => {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
};
