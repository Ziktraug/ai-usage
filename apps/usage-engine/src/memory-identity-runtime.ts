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

/** Thrown by `start()` when a disposal began while a Memory stage was still in flight. */
export class LocalMemoryRuntimeStartCancelledError extends Error {
  override readonly name = 'LocalMemoryRuntimeStartCancelledError';
}

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
  // Shutdown may arrive while a Memory stage is still pending. The stages
  // re-check this flag after every await and hand whatever they just acquired
  // to the disposer, which waits for the in-flight start before it releases
  // the Usage writer; nothing Memory-side may outlive that release.
  let startInFlight: Promise<void> | undefined;
  let usageStartPending = false;
  let disposing = false;
  let retainMemoryLease = false;

  const assertStartupActive = (): void => {
    if (disposing) {
      throw new LocalMemoryRuntimeStartCancelledError('The local Memory runtime startup was cancelled by shutdown.');
    }
  };

  const runStart = async (): Promise<void> => {
    usageStartPending = true;
    try {
      await runtime.start();
    } finally {
      usageStartPending = false;
    }
    try {
      assertStartupActive();
      lease = await dependencies.acquireLease?.();
      assertStartupActive();
      kernel = await (dependencies.openKernel ?? openLocalIdentityKernel)({ databasePath });
      assertStartupActive();
      service = await dependencies.startService?.(kernel);
      assertStartupActive();
      replication = await dependencies.startReplication?.(kernel);
      assertStartupActive();
    } catch (error) {
      if (error instanceof LocalMemoryRuntimeStartCancelledError) {
        // The disposer that cancelled this start owns the unwind of what was acquired.
        throw error;
      }
      const cleanupFailures: unknown[] = [];
      await replication?.dispose().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      replication = undefined;
      await service?.dispose().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      service = undefined;
      await kernel?.close().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      kernel = undefined;
      await lease?.release().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      lease = undefined;
      if (!disposing) {
        await runtime.dispose().catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'The local Memory runtime failed during startup.');
      }
      throw error;
    }
  };

  const start = (): Promise<void> => {
    startInFlight ??= runStart();
    return startInFlight;
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
    if (retainMemoryLease) {
      return;
    }
    const held = lease;
    lease = undefined;
    await held?.release();
  };

  const disposeWith = async (retainWriterLease: boolean): Promise<void> => {
    disposing = true;
    if (retainWriterLease) {
      // Mirrors the Usage lease: a retained lease stays on disk so the next
      // engine takes the stale-owner recovery path instead of a silent takeover.
      retainMemoryLease = true;
    }
    const disposeRuntime = (): Promise<void> =>
      retainWriterLease ? runtime.disposeRetainingWriterLease() : runtime.dispose();
    let runtimeDisposal: Promise<void> | undefined;
    if (usageStartPending) {
      // Nothing Memory-side exists yet, so the Usage runtime may abort its own
      // startup right away; the start above then stops at its first check.
      runtimeDisposal = disposeRuntime();
      runtimeDisposal.catch(() => undefined);
    }
    await startInFlight?.catch(() => undefined);
    await combineCleanup([
      closeReplication,
      closeService,
      closeKernel,
      releaseLease,
      () => runtimeDisposal ?? disposeRuntime(),
    ]);
  };

  const wrapped: UsageEngineRuntimeHost = {
    cancelCommand: (commandId) => runtime.cancelCommand(commandId),
    changes: () => runtime.changes(),
    dispose: () => disposeWith(false),
    disposeRetainingWriterLease: () => disposeWith(true),
    execute: (command) => runtime.execute(command),
    executeCommand: (command, commandId) => runtime.executeCommand(command, commandId),
    start,
    status: () => runtime.status(),
    waitForCommand: (commandId) => runtime.waitForCommand(commandId),
    waitForIdle: () => runtime.waitForIdle(),
  };
  return Object.freeze(wrapped);
};
