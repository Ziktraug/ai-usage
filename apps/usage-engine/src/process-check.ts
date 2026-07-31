import { lstat } from 'node:fs/promises';
import { loadUsageEngineRendezvous, usageEngineTargetIdFor } from '@ai-usage/usage-engine-control/node';
import { queryUsageStoreGenerations, UsageStoreError } from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import { inspectUsageEngineLock } from './engine-lock';
import type { UsageEngineCheckReport, UsageEngineProcessPaths } from './process';
import { usageEngineRendezvousPath } from './rendezvous-file';

const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const inspectRendezvous = async (
  paths: UsageEngineProcessPaths,
  lock: Awaited<ReturnType<typeof inspectUsageEngineLock>>,
): Promise<UsageEngineCheckReport['rendezvous']> => {
  const rendezvousPath = usageEngineRendezvousPath(paths.stateDirectory);
  const stats = await lstat(rendezvousPath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!stats) {
    return { state: 'absent' };
  }
  try {
    const rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
    const targetMatches = rendezvous.targetId === usageEngineTargetIdFor(paths);
    const lockInstanceId = 'instanceId' in lock ? lock.instanceId : undefined;
    const state = lockInstanceId === rendezvous.instanceId && targetMatches ? 'valid' : 'mismatched';
    return {
      instanceId: rendezvous.instanceId,
      port: rendezvous.port,
      protocolVersion: rendezvous.protocolVersion,
      state,
    };
  } catch {
    return { state: 'unsafe' };
  }
};

const inspectStore = async (databasePath: string): Promise<UsageEngineCheckReport['store']> => {
  try {
    const generations = await Effect.runPromise(queryUsageStoreGenerations({ dbPath: databasePath }));
    return { ...generations, state: 'compatible' };
  } catch (error) {
    return {
      reason: error instanceof UsageStoreError ? error.reason : 'storage-failure',
      state: 'unavailable',
    };
  }
};

export const checkUsageEngine = async (paths: UsageEngineProcessPaths): Promise<UsageEngineCheckReport> => {
  const lockInspection = await inspectUsageEngineLock(paths.databasePath);
  const lock: UsageEngineCheckReport['lock'] =
    lockInspection.state === 'live' || lockInspection.state === 'stale'
      ? {
          instanceId: lockInspection.instanceId,
          pid: lockInspection.pid,
          state: lockInspection.state,
        }
      : { state: lockInspection.state };
  const [rendezvous, store] = await Promise.all([
    inspectRendezvous(paths, lockInspection),
    inspectStore(paths.databasePath),
  ]);
  const stoppedAndClean = lock.state === 'absent' && rendezvous.state === 'absent';
  const runningAndConsistent = lock.state === 'live' && rendezvous.state === 'valid';
  return {
    lock,
    ok: store.state === 'compatible' && (stoppedAndClean || runningAndConsistent),
    rendezvous,
    store,
  };
};
