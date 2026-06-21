import type { LocalHistoryError, LocalHistoryWarning } from '@ai-usage/local-collectors/errors';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { listSyncRemotes, readSyncedSnapshotRecords, resolveSyncToken } from '@ai-usage/local-collectors/sync-storage';
import type { SyncRemoteConfig } from '@ai-usage/report-core/project-alias';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { Effect } from 'effect';

export type SyncTokenStatus = 'missing' | 'none' | 'present';

export interface SyncRemoteState {
  enabled: boolean;
  fetchedAt?: string;
  machineId?: string;
  machineLabel?: string;
  name: string;
  rows: number;
  tokenEnv?: string;
  tokenStatus: SyncTokenStatus;
  url: string;
}

export interface SyncStoredSnapshotState {
  fetchedAt: string;
  machineId: string;
  machineLabel: string;
  remoteName: string;
  remoteUrl: string;
  rows: number;
}

export interface SyncState {
  localMachine: UsageMachine;
  remotes: SyncRemoteState[];
  storedSnapshots: SyncStoredSnapshotState[];
  warnings: LocalHistoryWarning[];
}

const tokenStatusForRemote = (remote: SyncRemoteConfig) =>
  Effect.gen(function* () {
    if (!remote.tokenEnv) {
      return 'none' as const;
    }
    const token = yield* resolveSyncToken(remote.tokenEnv);
    return token ? ('present' as const) : ('missing' as const);
  });

export const getSyncState: Effect.Effect<
  SyncState,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> = Effect.gen(function* () {
  const localMachine = yield* ensureMachineConfig;
  const remotes = yield* listSyncRemotes;
  const synced = yield* readSyncedSnapshotRecords;
  const byName = new Map(synced.records.map((record) => [record.remoteName, record]));
  const remoteStates: SyncRemoteState[] = [];

  for (const remote of remotes) {
    const record = byName.get(remote.name);
    const tokenStatus = yield* tokenStatusForRemote(remote);
    remoteStates.push({
      name: remote.name,
      url: remote.url,
      enabled: remote.enabled !== false,
      tokenStatus,
      ...(remote.tokenEnv ? { tokenEnv: remote.tokenEnv } : {}),
      ...(record ? { machineId: record.snapshot.machine.id } : {}),
      ...(record ? { machineLabel: record.snapshot.machine.label } : {}),
      rows: record?.snapshot.rows.length ?? 0,
      ...(record ? { fetchedAt: record.fetchedAt } : {}),
    });
  }

  return {
    localMachine,
    remotes: remoteStates,
    storedSnapshots: synced.records.map((record) => ({
      remoteName: record.remoteName,
      remoteUrl: record.remoteUrl,
      fetchedAt: record.fetchedAt,
      machineId: record.snapshot.machine.id,
      machineLabel: record.snapshot.machine.label,
      rows: record.snapshot.rows.length,
    })),
    warnings: synced.warnings,
  };
});
