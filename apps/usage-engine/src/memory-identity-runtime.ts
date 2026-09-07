import path from 'node:path';
import {
  type LocalIdentityKernel,
  type OpenLocalIdentityKernelOptions,
  openLocalIdentityKernel,
} from '@ai-usage/memory-sqlite/identity';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';
import { usageEngineLockPath } from './engine-lock';

export const localMemoryIdentityDatabasePath = (stateDirectory: string): string =>
  path.join(stateDirectory, 'memory.sqlite');

/**
 * The Memory SQLite writer lease is keyed to the Memory database path, so it
 * lives next to `memory.sqlite` inside the owned engine state directory. Two
 * engines that share a state directory but point at different usage databases
 * hold distinct usage locks; this lock is what still excludes them here.
 */
export const localMemoryIdentityLockPath = (stateDirectory: string): string =>
  usageEngineLockPath(localMemoryIdentityDatabasePath(stateDirectory));

export interface LocalMemoryIdentityWriterLease {
  readonly release: () => Promise<void>;
}

export interface LocalMemoryIdentityRuntimeDependencies {
  /** Acquired after the Usage writer lease is established and before the Memory kernel opens. */
  readonly acquireLease?: () => Promise<LocalMemoryIdentityWriterLease>;
  readonly openKernel?: (options: OpenLocalIdentityKernelOptions) => Promise<LocalIdentityKernel>;
  readonly startReplication?: (kernel: LocalIdentityKernel) => Promise<{ readonly dispose: () => Promise<void> }>;
  readonly startService?: (kernel: LocalIdentityKernel) => Promise<{ readonly dispose: () => Promise<void> }>;
}

const defaultDependencies: LocalMemoryIdentityRuntimeDependencies = {
  openKernel: openLocalIdentityKernel,
};

const combineCleanup = async (operations: readonly (() => Promise<void>)[]): Promise<void> => {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'The local runtime could not close every owned store.');
  }
};

export const withLocalMemoryIdentityKernel = (
  runtime: UsageEngineRuntimeHost,
  databasePath: string,
  dependencies: LocalMemoryIdentityRuntimeDependencies = defaultDependencies,
): UsageEngineRuntimeHost => {
  let lease: LocalMemoryIdentityWriterLease | undefined;
  let kernel: LocalIdentityKernel | undefined;
  let replication: { readonly dispose: () => Promise<void> } | undefined;
  let service: { readonly dispose: () => Promise<void> } | undefined;

  const start = async (): Promise<void> => {
    await runtime.start();
    try {
      lease = await dependencies.acquireLease?.();
      kernel = await (dependencies.openKernel ?? openLocalIdentityKernel)({ databasePath });
      service = await dependencies.startService?.(kernel);
      replication = await dependencies.startReplication?.(kernel);
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      await replication?.dispose().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      replication = undefined;
      await service?.dispose().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      service = undefined;
      await kernel?.close().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      kernel = undefined;
      await lease?.release().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      lease = undefined;
      await runtime.dispose().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'The local Memory runtime failed during startup.');
      }
      throw error;
    }
  };

  const closeReplication = async (): Promise<void> => {
    const started = replication;
    replication = undefined;
    await started?.dispose();
  };

  const closeService = async (): Promise<void> => {
    const started = service;
    service = undefined;
    await started?.dispose();
  };

  const closeKernel = async (): Promise<void> => {
    const opened = kernel;
    kernel = undefined;
    await opened?.close();
  };

  const releaseLease = async (): Promise<void> => {
    const held = lease;
    lease = undefined;
    await held?.release();
  };

  const wrapped: UsageEngineRuntimeHost = {
    cancelCommand: (commandId) => runtime.cancelCommand(commandId),
    changes: () => runtime.changes(),
    dispose: () => combineCleanup([closeReplication, closeService, closeKernel, releaseLease, () => runtime.dispose()]),
    // Mirrors the Usage lease: a retained lease stays on disk so the next
    // engine takes the stale-owner recovery path instead of a silent takeover.
    disposeRetainingWriterLease: () =>
      combineCleanup([closeReplication, closeService, closeKernel, () => runtime.disposeRetainingWriterLease()]),
    execute: (command) => runtime.execute(command),
    executeCommand: (command, commandId) => runtime.executeCommand(command, commandId),
    start,
    status: () => runtime.status(),
    waitForCommand: (commandId) => runtime.waitForCommand(commandId),
    waitForIdle: () => runtime.waitForIdle(),
  };
  return Object.freeze(wrapped);
};
