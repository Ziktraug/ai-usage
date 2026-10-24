import type { SourceControlView } from '@ai-usage/report-core/source-control';
import type { UsageEngineStatus } from '@ai-usage/usage-engine-control';

interface WriterLease {
  readonly release: () => Promise<void>;
}

export interface RuntimeLifecycleDependencies {
  readonly acquireWriterLease: () => Promise<WriterLease>;
  readonly closeEvents: () => void;
  readonly disposeSourceControl: () => Promise<void>;
  readonly initializeStore: () => Promise<number>;
  readonly onBeginShutdown: () => void;
  readonly onInitialPublication: (publication: NonNullable<UsageEngineStatus['currentPublication']>) => void;
  readonly onReady: () => void;
  readonly onSourceStarted: (snapshot: SourceControlView) => void;
  readonly onStoreInitialized: (schemaVersion: number) => void;
  readonly publishInitialRevision: () => Promise<NonNullable<UsageEngineStatus['currentPublication']>>;
  readonly quiesceStore: () => Promise<void>;
  readonly recover: () => Promise<void>;
  readonly settleCommands: () => Promise<void>;
  readonly startSourceControl: () => Promise<SourceControlView>;
  readonly stopAutonomousCollection: () => Promise<void>;
  readonly validateConfig: () => Promise<void>;
  readonly watchSourceChanges: (signal: AbortSignal) => Promise<void>;
}

export interface RuntimeLifecycle {
  readonly closeAutonomousSourceAdmission: () => void;
  readonly dispose: () => Promise<void>;
  readonly disposeRetainingWriterLease: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly start: () => Promise<void>;
}

export const createRuntimeLifecycle = (dependencies: RuntimeLifecycleDependencies): RuntimeLifecycle => {
  let writerLease: WriterLease | undefined;
  let startPromise: Promise<void> | undefined;
  let disposalPromise: Promise<void> | undefined;
  let sourceChangesTask: Promise<void> | undefined;
  let sourceAdmissionClosePromise: Promise<void> | undefined;
  let sourceAdmissionCloseFailure: unknown;
  let ownedCleanupPromise: Promise<void> | undefined;
  let releaseWriterLeaseDuringCleanup = true;
  let shutdownBegun = false;
  let sourceStartAttempted = false;
  let storeInitializationAttempted = false;
  const abortController = new AbortController();

  const closeAutonomousSourceAdmission = (): void => {
    if (!(sourceStartAttempted && sourceAdmissionClosePromise === undefined)) {
      return;
    }
    sourceAdmissionClosePromise = dependencies.stopAutonomousCollection().catch((error: unknown) => {
      sourceAdmissionCloseFailure = error;
    });
  };

  const assertStartupActive = (): void => {
    if (shutdownBegun || abortController.signal.aborted) {
      throw new Error('Usage engine startup was aborted.');
    }
  };

  const beginShutdown = (): void => {
    if (shutdownBegun) {
      return;
    }
    shutdownBegun = true;
    dependencies.onBeginShutdown();
    closeAutonomousSourceAdmission();
  };

  const cleanupOwnedResources = (releaseWriterLease: boolean): Promise<void> => {
    if (!releaseWriterLease) {
      releaseWriterLeaseDuringCleanup = false;
    }
    ownedCleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      try {
        await sourceAdmissionClosePromise;
      } catch (error) {
        failures.push(error);
      }
      if (sourceAdmissionCloseFailure !== undefined) {
        failures.push(sourceAdmissionCloseFailure);
      }
      try {
        await dependencies.settleCommands();
      } catch (error) {
        failures.push(error);
      }
      abortController.abort();
      if (sourceStartAttempted) {
        try {
          await dependencies.disposeSourceControl();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await sourceChangesTask;
      } catch (error) {
        failures.push(error);
      }
      if (storeInitializationAttempted) {
        try {
          await dependencies.quiesceStore();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 0 && releaseWriterLeaseDuringCleanup) {
        const lease = writerLease;
        if (lease) {
          try {
            await lease.release();
            writerLease = undefined;
          } catch (error) {
            failures.push(error);
          }
        }
      }
      dependencies.closeEvents();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'The usage engine could not safely release its writer lease during shutdown.',
        );
      }
    })();
    return ownedCleanupPromise;
  };

  const start = (): Promise<void> => {
    if (startPromise) {
      return startPromise;
    }
    if (abortController.signal.aborted) {
      return Promise.reject(new Error('Usage engine startup was aborted.'));
    }
    startPromise = (async () => {
      try {
        writerLease = await dependencies.acquireWriterLease();
        assertStartupActive();
        storeInitializationAttempted = true;
        dependencies.onStoreInitialized(await dependencies.initializeStore());
        assertStartupActive();
        await dependencies.validateConfig();
        assertStartupActive();
        await dependencies.recover();
        assertStartupActive();
        dependencies.onInitialPublication(await dependencies.publishInitialRevision());
        assertStartupActive();
        sourceStartAttempted = true;
        const startedSourceControl = await dependencies.startSourceControl();
        assertStartupActive();
        dependencies.onSourceStarted(startedSourceControl);
        dependencies.onReady();
        sourceChangesTask = dependencies.watchSourceChanges(abortController.signal);
      } catch (error) {
        beginShutdown();
        try {
          await cleanupOwnedResources(true);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'The usage engine failed to start and could not safely clean up.',
          );
        }
        throw error;
      }
    })();
    return startPromise;
  };

  const disposeRuntime = (releaseWriterLease: boolean): Promise<void> => {
    if (!releaseWriterLease) {
      releaseWriterLeaseDuringCleanup = false;
    }
    if (disposalPromise) {
      return disposalPromise;
    }
    disposalPromise = (async () => {
      beginShutdown();
      try {
        await startPromise;
      } catch {
        // The startup caller owns its failure; disposal must still finish cleanup.
      }
      await cleanupOwnedResources(releaseWriterLease);
    })();
    return disposalPromise;
  };

  return {
    closeAutonomousSourceAdmission,
    dispose: () => disposeRuntime(true),
    disposeRetainingWriterLease: () => disposeRuntime(false),
    signal: abortController.signal,
    start,
  };
};
