import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { scheduler as hostScheduler } from 'node:timers/promises';
import { runBoundaryEffect, WideEventResourceService, WideEventSink } from '@ai-usage/effect-runtime';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import {
  ensureMachineConfig,
  readAiUsageConfig,
  readMergedAiUsageConfigFrom,
  setSourcePolicyOverride,
  updateAiUsageConfig,
  writeMachineConfig,
} from '@ai-usage/local-collectors/machine-config';
import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import {
  type ProjectSourceSelector,
  parseProjectGroupConfigs,
  projectSourceSelectorFor,
  projectSourceSelectorKey,
} from '@ai-usage/report-core/project-group';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  type CollectionSourceId,
  collectionSourceIds,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import {
  createStoredReportCapture,
  readStoredReportSourceFingerprint,
  toStoredReportPublicationCapture,
} from '@ai-usage/report-data';
import {
  parseUsageEnginePublicationRevision,
  type UsageEngineProjectSourceReference,
} from '@ai-usage/usage-engine-control';
import {
  initializeUsageStore,
  publishServedReportRevision,
  queryServedReportRevisionSupport,
  quiesceUsageStoreForShutdown,
  retainServedReportRevisions,
  type UpdateUsageMachineLabelInput,
  type UsageStoreGenerations,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import {
  discardUsageEngineHandoff,
  readUsageEngineInput,
  repairManagedCursorUsageExportModes,
  scavengeUsageEngineInbox,
  stageCursorUsageExport,
} from './input-file';
import { createEngineUsageMergeService, EngineMergeError, type EngineUsageMergeService } from './merge';
import { type LegacyArtifactScavengeResult, scavengeLegacyUsageEngineArtifacts } from './recovery';
import {
  createInitialUsageEngineSourceControlView,
  createUsageEngineRuntime,
  UsageEngineCommandError,
  UsageEngineFatalConsistencyError,
  type UsageEngineMutationPort,
  type UsageEngineRuntimeHost,
  UsageEngineSoftSourceError,
  type UsageEngineSourceControlPort,
  type UsageEngineWriterLease,
} from './runtime';
import { createScheduledSourceRegistry, type ScheduledSource } from './source-adapters';
import {
  createSourceControl,
  type ReportPublicationPort,
  SourceControl,
  SourceControlCommandError,
  type SourceControlService,
  type SourcePolicyStore,
} from './source-control';
import { createUsageEngineWriterGate, type UsageEngineWriterGate } from './writer-gate';

const TERMINAL_SOURCE_OUTCOMES = new Set(['failed', 'timed-out']);
const MAX_SOURCE_SNAPSHOT_QUEUE = 64;

interface SourceSnapshotSubscriber {
  closed: boolean;
  pending: ((result: IteratorResult<SourceControlView>) => void) | undefined;
  readonly queue: SourceControlView[];
}

export interface TerminalSourceControlOptions {
  readonly beforeInitialCollection?: Effect.Effect<void>;
  readonly initialDetection?: 'automatic' | 'deferred';
  readonly instanceId: string;
  readonly policyStore: SourcePolicyStore;
  readonly publication: ReportPublicationPort;
  readonly sources: ReadonlyMap<CollectionSourceId, ScheduledSource>;
  readonly wideEventSinkLayer: Layer.Layer<WideEventResourceService | WideEventSink>;
  readonly writerGate?: UsageEngineWriterGate;
}

const abortedOperation = (): Error => {
  const error = new Error('The usage engine operation was aborted.');
  error.name = 'AbortError';
  return error;
};

const sourceEntry = (snapshot: SourceControlView, sourceId: CollectionSourceId) => {
  const source = snapshot.sources.find(({ id }) => id === sourceId);
  if (!source) {
    throw new Error('The source-control snapshot omitted a known source.');
  }
  return source;
};

const publicationIsSettled = (snapshot: SourceControlView): boolean => {
  const publication = snapshot.publication;
  return !(publication.dirty || publication.pendingDemand || publication.queued || publication.running);
};

export const createTerminalSourceControlPort = (
  options: TerminalSourceControlOptions,
): UsageEngineSourceControlPort => {
  const controlLayer = Layer.scoped(
    SourceControl,
    createSourceControl({
      autonomousCollection: options.initialDetection !== 'deferred',
      ...(options.beforeInitialCollection === undefined
        ? {}
        : { beforeInitialCollection: options.beforeInitialCollection }),
      initialDetection: options.initialDetection ?? 'automatic',
      initialPublicationOrder: 'externally-published',
      instanceId: options.instanceId,
      policyStore: options.policyStore,
      publication: options.publication,
      sources: options.sources,
      workerCount: 1,
      ...(options.writerGate === undefined ? {} : { writerGate: options.writerGate }),
    }),
  ).pipe(Layer.provideMerge(options.wideEventSinkLayer));
  const managedRuntime = ManagedRuntime.make(controlLayer);
  const subscribers = new Set<SourceSnapshotSubscriber>();
  const sourceCompletionGenerations = new Map<CollectionSourceId, number>(
    collectionSourceIds.map((sourceId) => [sourceId, 0]),
  );
  let latest: SourceControlView | undefined;
  let startPromise: Promise<SourceControlView> | undefined;
  let disposalPromise: Promise<void> | undefined;

  const withControl = <Value, Error>(
    operation: (service: SourceControlService) => Effect.Effect<Value, Error>,
  ): Effect.Effect<Value, Error, SourceControl> => SourceControl.pipe(Effect.flatMap(operation));
  const run = async <Value, Error>(
    operation: (service: SourceControlService) => Effect.Effect<Value, Error>,
    signal?: AbortSignal,
  ): Promise<Value> => {
    throwIfAborted(signal);
    const outcome = await managedRuntime.runPromise(
      withControl(operation).pipe(
        Effect.match({
          onFailure: (error) => ({ error, ok: false as const }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
      signal ? { signal } : undefined,
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  };

  const closeSubscriber = (subscriber: SourceSnapshotSubscriber): void => {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    subscriber.queue.length = 0;
    subscriber.pending?.({ done: true, value: undefined });
    subscriber.pending = undefined;
    subscribers.delete(subscriber);
  };

  const publishSnapshot = (snapshot: SourceControlView): void => {
    if (latest && snapshot.generation <= latest.generation) {
      return;
    }
    const previous = latest;
    if (previous) {
      for (const source of snapshot.sources) {
        const prior = sourceEntry(previous, source.id);
        const wasRunning = prior.lifecycle === 'running' || prior.lifecycle === 'pausing';
        const isRunning = source.lifecycle === 'running' || source.lifecycle === 'pausing';
        if (wasRunning && !isRunning) {
          sourceCompletionGenerations.set(source.id, (sourceCompletionGenerations.get(source.id) ?? 0) + 1);
        }
      }
    }
    latest = snapshot;
    for (const subscriber of subscribers) {
      if (subscriber.pending) {
        const resolve = subscriber.pending;
        subscriber.pending = undefined;
        resolve({ done: false, value: snapshot });
        continue;
      }
      if (subscriber.queue.length >= MAX_SOURCE_SNAPSHOT_QUEUE) {
        subscriber.queue.shift();
      }
      subscriber.queue.push(snapshot);
    }
  };

  const start = (): Promise<SourceControlView> => {
    startPromise ??= (async () => {
      const snapshot = await run((service) => service.getSnapshot);
      latest = snapshot;
      managedRuntime.runFork(
        withControl((service) =>
          Stream.runForEach(service.changes, (next) => Effect.sync(() => publishSnapshot(next))),
        ),
      );
      const initialPublicationTarget = snapshot.publication.requestedGeneration;
      let current = snapshot;
      while (current.publication.acknowledgedRequestGeneration < initialPublicationTarget) {
        if (current.publication.lastOutcome === 'failed') {
          throw new Error('The usage engine initial source-control publication failed.');
        }
        await hostScheduler.yield();
        current = await run((service) => service.getSnapshot);
      }
      while ((latest?.generation ?? -1) < current.generation) {
        await hostScheduler.yield();
      }
      return latest ?? current;
    })();
    return startPromise;
  };

  const currentSnapshot = async (signal?: AbortSignal): Promise<SourceControlView> => {
    throwIfAborted(signal);
    await start();
    throwIfAborted(signal);
    const snapshot = await run((service) => service.getSnapshot, signal);
    while ((latest?.generation ?? -1) < snapshot.generation) {
      throwIfAborted(signal);
      await hostScheduler.yield();
    }
    return latest ?? snapshot;
  };

  const waitForNextSnapshot = async (generation: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      throw abortedOperation();
    }
    if (latest && latest.generation > generation) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const subscriber: SourceSnapshotSubscriber = { closed: false, pending: undefined, queue: [] };
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        closeSubscriber(subscriber);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onAbort = (): void => finish(abortedOperation());
      const receive = ({ done, value }: IteratorResult<SourceControlView>): void => {
        if (done || value.generation > generation) {
          finish();
          return;
        }
        subscriber.pending = receive;
      };
      subscriber.pending = receive;
      subscribers.add(subscriber);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (latest && latest.generation > generation) {
        finish();
      }
    });
  };

  const waitForSnapshot = async (
    predicate: (snapshot: SourceControlView) => boolean,
    failure: (snapshot: SourceControlView) => Error | undefined,
    signal?: AbortSignal,
  ): Promise<SourceControlView> => {
    while (true) {
      const snapshot = latest ?? (await currentSnapshot(signal));
      const error = failure(snapshot);
      if (error) {
        throw error;
      }
      if (predicate(snapshot)) {
        return snapshot;
      }
      await waitForNextSnapshot(snapshot.generation, signal);
    }
  };

  const waitForPublicationSettled = (signal?: AbortSignal): Promise<SourceControlView> =>
    waitForSnapshot(
      publicationIsSettled,
      (snapshot) =>
        snapshot.publication.lastOutcome === 'failed' && !publicationIsSettled(snapshot)
          ? new Error('The usage engine publication failed.')
          : undefined,
      signal,
    );

  const waitForSourceTerminal = async (
    sourceId: CollectionSourceId,
    previousCompletionGeneration: number,
    signal?: AbortSignal,
  ): Promise<SourceControlView> => {
    const terminal = await waitForSnapshot(
      (snapshot) => {
        const source = sourceEntry(snapshot, sourceId);
        return (
          !(source.lifecycle === 'queued' || source.lifecycle === 'running') &&
          (sourceCompletionGenerations.get(sourceId) ?? 0) > previousCompletionGeneration
        );
      },
      () => undefined,
      signal,
    );
    const source = sourceEntry(terminal, sourceId);
    if (TERMINAL_SOURCE_OUTCOMES.has(source.lastOutcome)) {
      throw new UsageEngineSoftSourceError({
        reason: source.lastOutcome === 'timed-out' ? 'timed-out' : 'failed',
        snapshot: terminal,
        sourceId,
      });
    }
    return await waitForPublicationSettled(signal);
  };

  const runSource = async (sourceId: CollectionSourceId, signal?: AbortSignal): Promise<SourceControlView> => {
    if (options.initialDetection === 'deferred') {
      return await redetectAndRunSource(sourceId, signal);
    }
    await currentSnapshot(signal);
    const previousCompletionGeneration = sourceCompletionGenerations.get(sourceId) ?? 0;
    try {
      await run((service) => service.runNow(sourceId), signal);
    } catch (error) {
      if (
        error instanceof SourceControlCommandError &&
        (error.reason === 'disabled' || error.reason === 'not-detected')
      ) {
        throw new UsageEngineSoftSourceError({
          reason: error.reason,
          snapshot: await currentSnapshot(signal),
          sourceId,
        });
      }
      throw error;
    }
    await currentSnapshot(signal);
    return await waitForSourceTerminal(sourceId, previousCompletionGeneration, signal);
  };

  const redetectAndRunSource = async (
    sourceId: CollectionSourceId,
    signal?: AbortSignal,
  ): Promise<SourceControlView> => {
    await currentSnapshot(signal);
    const previousCompletionGeneration = sourceCompletionGenerations.get(sourceId) ?? 0;
    const admitted = await run((service) => service.detectSource(sourceId), signal);
    const after = await currentSnapshot(signal);
    const source = sourceEntry(after, sourceId);
    const alreadyCompleted = (sourceCompletionGenerations.get(sourceId) ?? 0) > previousCompletionGeneration;
    const joined = source.lifecycle === 'queued' || source.lifecycle === 'running' || source.lifecycle === 'pausing';
    if (!(admitted || alreadyCompleted || joined)) {
      throw new UsageEngineSoftSourceError({ reason: 'not-admitted', snapshot: after, sourceId });
    }
    return await waitForSourceTerminal(sourceId, previousCompletionGeneration, signal);
  };

  const runAllEnabled = async (signal?: AbortSignal): Promise<void> => {
    await currentSnapshot(signal);
    const previousCompletions = new Map(sourceCompletionGenerations);
    await run(
      (service) => (options.initialDetection === 'deferred' ? service.detectAll : service.runAllEnabled),
      signal,
    );
    await currentSnapshot(signal);
    const terminal = await waitForSnapshot(
      (snapshot) => snapshot.queueDepth === 0 && snapshot.runningCount === 0 && publicationIsSettled(snapshot),
      (snapshot) => {
        const failed = snapshot.sources.some(
          (source) =>
            (sourceCompletionGenerations.get(source.id) ?? 0) > (previousCompletions.get(source.id) ?? 0) &&
            TERMINAL_SOURCE_OUTCOMES.has(source.lastOutcome),
        );
        if (failed) {
          return new Error('A usage engine source run failed.');
        }
        return snapshot.publication.lastOutcome === 'failed' && !publicationIsSettled(snapshot)
          ? new Error('The usage engine publication failed.')
          : undefined;
      },
      signal,
    );
    if (
      terminal.sources.some(
        (source) =>
          (sourceCompletionGenerations.get(source.id) ?? 0) > (previousCompletions.get(source.id) ?? 0) &&
          TERMINAL_SOURCE_OUTCOMES.has(source.lastOutcome),
      )
    ) {
      throw new Error('A usage engine source run failed.');
    }
  };

  const detectAll = async (signal?: AbortSignal): Promise<void> => {
    await currentSnapshot(signal);
    await run((service) => service.detectAll, signal);
    await currentSnapshot(signal);
    await waitForSnapshot(
      (snapshot) => snapshot.queueDepth === 0 && snapshot.runningCount === 0 && publicationIsSettled(snapshot),
      (snapshot) =>
        snapshot.publication.lastOutcome === 'failed' && !publicationIsSettled(snapshot)
          ? new Error('The usage engine publication failed.')
          : undefined,
      signal,
    );
  };

  const publish = async (signal?: AbortSignal): Promise<SourceControlView> => {
    const before = await currentSnapshot(signal);
    const target = before.publication.requestedGeneration + 1;
    await run((service) => service.requestPublication, signal);
    await currentSnapshot(signal);
    return await waitForSnapshot(
      (snapshot) => snapshot.publication.acknowledgedRequestGeneration >= target,
      (snapshot) =>
        snapshot.publication.acknowledgedRequestGeneration < target && snapshot.publication.lastOutcome === 'failed'
          ? new Error('The usage engine publication failed.')
          : undefined,
      signal,
    );
  };

  const stopAutonomousCollection = async (): Promise<void> => await run((service) => service.stopAutonomousCollection);

  const setSourceEnabled = async (
    sourceId: CollectionSourceId,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void> => {
    const before = await currentSnapshot(signal);
    const previousCompletionGeneration = sourceCompletionGenerations.get(sourceId) ?? 0;
    const detectionAdmitted =
      enabled && options.initialDetection === 'deferred' && sourceEntry(before, sourceId).policy === 'disabled'
        ? await run((service) => service.detectSource(sourceId), signal)
        : false;
    await run((service) => service.setEnabled(sourceId, enabled), signal);
    const after = await currentSnapshot(signal);
    const publicationTarget = after.publication.requestedGeneration;
    const source = sourceEntry(after, sourceId);
    const joinedSourceRun =
      source.lifecycle === 'queued' || source.lifecycle === 'running' || source.lifecycle === 'pausing';
    if (enabled && (detectionAdmitted || joinedSourceRun)) {
      await waitForSourceTerminal(sourceId, previousCompletionGeneration, signal);
    }
    await waitForSnapshot(
      (snapshot) => snapshot.publication.acknowledgedRequestGeneration >= publicationTarget,
      (snapshot) =>
        snapshot.publication.acknowledgedRequestGeneration < publicationTarget &&
        snapshot.publication.lastOutcome === 'failed'
          ? new Error('The usage engine publication failed.')
          : undefined,
      signal,
    );
  };

  const changes = (signal: AbortSignal): AsyncIterable<SourceControlView> => ({
    [Symbol.asyncIterator]: () => {
      const subscriber: SourceSnapshotSubscriber = {
        closed: false,
        pending: undefined,
        queue: latest === undefined ? [] : [latest],
      };
      subscribers.add(subscriber);
      const close = (): void => closeSubscriber(subscriber);
      signal.addEventListener('abort', close, { once: true });
      return {
        next: () => {
          const snapshot = subscriber.queue.shift();
          if (snapshot) {
            return Promise.resolve({ done: false as const, value: snapshot });
          }
          if (subscriber.closed || signal.aborted) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          return new Promise<IteratorResult<SourceControlView>>((resolve) => {
            subscriber.pending = resolve;
          });
        },
        return: () => {
          signal.removeEventListener('abort', close);
          close();
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  });

  const dispose = (): Promise<void> => {
    disposalPromise ??= (async () => {
      for (const subscriber of [...subscribers]) {
        closeSubscriber(subscriber);
      }
      await managedRuntime.dispose();
    })();
    return disposalPromise;
  };

  return {
    changes,
    detectAll,
    dispose,
    publish,
    redetectAndRunSource,
    runAllEnabled,
    runSource,
    setSourceEnabled,
    start,
    stopAutonomousCollection,
  };
};

export interface DurableReportPublisher {
  readonly publish: () => Promise<{
    readonly changed: boolean;
    readonly publishedAt: string;
    readonly revision: string;
  }>;
}

export interface DurableReportPublisherOptions {
  readonly configCwd: string;
  readonly dbPath: string;
  readonly machine: UsageMachine;
  readonly now?: () => Date;
  readonly reportRetentionFailure?: (cause: unknown) => void;
  readonly retainRevisions?: (input: { readonly dbPath: string; readonly now: number }) => Promise<void>;
  readonly revision?: () => string;
  readonly storage: LocalHistoryStorageService;
  readonly writerGate?: UsageEngineWriterGate;
}

export interface LiveUsageEngineMutationOptions {
  readonly configCwd: string;
  readonly dbPath: string;
  readonly inboxDirectory: string;
  readonly machine: UsageMachine;
  readonly mergeService?: EngineUsageMergeService;
  readonly now?: () => Date;
  readonly operatorCwd: string;
  readonly readInput?: typeof readUsageEngineInput;
  readonly reportCleanupFailure?: (operation: 'confirm-merge' | 'cursor-import' | 'preview-merge') => void;
  readonly storage: LocalHistoryStorageService;
  readonly updateMachineLabel?: (input: UpdateUsageMachineLabelInput) => Promise<void>;
  readonly writeMachine?: (machine: UsageMachine) => Promise<void>;
  readonly writerGate?: UsageEngineWriterGate;
}

export interface LiveUsageEngineRuntimeOptions {
  readonly acquireWriterLease: () => Promise<UsageEngineWriterLease>;
  readonly codexLiveAvailable?: () => boolean;
  readonly configCwd: string;
  readonly dbPath: string;
  readonly inboxDirectory: string;
  readonly initialSourceDetection?: 'automatic' | 'deferred';
  readonly instanceId: string;
  readonly legacyArtifactGracePeriodMs?: number;
  readonly now?: () => Date;
  readonly operatorCwd: string;
  readonly readInput?: typeof readUsageEngineInput;
  readonly reportRecovery?: (result: UsageEngineRecoveryReport) => void;
  readonly retainRevisions?: (input: { readonly dbPath: string; readonly now: number }) => Promise<void>;
  readonly storage?: LocalHistoryStorageService;
  readonly temporaryRoot: string;
  readonly wideEventSinkLayer: Layer.Layer<WideEventResourceService | WideEventSink>;
  readonly writerGate?: UsageEngineWriterGate;
}

export interface UsageEngineRecoveryReport extends LegacyArtifactScavengeResult {
  readonly deletedInboxBytes: number;
  readonly deletedInboxFiles: number;
  readonly skippedSuspiciousInboxEntries: number;
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw abortedOperation();
  }
};

export const createLiveUsageEngineMutationPort = (options: LiveUsageEngineMutationOptions): UsageEngineMutationPort => {
  const runWithStorage = <Value, Error>(effect: Effect.Effect<Value, Error, LocalHistoryStorage>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, options.storage)));
  const runWithWriter = async <Value>(operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> => {
    if (!options.writerGate) {
      return await operation();
    }
    return await options.writerGate.run(async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof UsageEngineFatalConsistencyError) {
          options.writerGate?.close();
        }
        throw error;
      }
    }, signal);
  };
  const updateMachineLabel =
    options.updateMachineLabel ??
    (async (input: UpdateUsageMachineLabelInput): Promise<void> => {
      await Effect.runPromise(updateUsageMachineLabel(input));
    });
  const writeMachine =
    options.writeMachine ??
    (async (machineValue: UsageMachine): Promise<void> => {
      await runWithStorage(writeMachineConfig(machineValue));
    });
  const mergeService =
    options.mergeService ??
    createEngineUsageMergeService({
      dbPath: options.dbPath,
      localMachine: options.machine,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const readMergeInput = (input: Parameters<typeof readUsageEngineInput>[0]) =>
    (options.readInput ?? readUsageEngineInput)(input, {
      inboxDirectory: options.inboxDirectory,
      maximumBytes: MAX_PORTABLE_USAGE_BYTES,
      operatorCwd: options.operatorCwd,
    });
  const reportCleanupFailure = (operation: 'confirm-merge' | 'cursor-import' | 'preview-merge'): void => {
    try {
      options.reportCleanupFailure?.(operation);
    } catch {
      // Diagnostic callbacks cannot invalidate a durable mutation.
    }
  };
  const mergeCommandError = (error: unknown): unknown => {
    if (!(error instanceof EngineMergeError)) {
      return error;
    }
    switch (error.reason) {
      case 'invalid-input':
        return new UsageEngineCommandError('merge-invalid-input', 'The merge file is invalid.', { cause: error });
      case 'invalid-json':
        return new UsageEngineCommandError('merge-invalid-json', 'The merge file does not contain valid JSON.', {
          cause: error,
        });
      case 'preview-stale':
        return new UsageEngineCommandError('preview-stale', 'The merge file changed after it was previewed.', {
          cause: error,
        });
      case 'self-merge':
        return new UsageEngineCommandError('merge-self-merge', 'The merge file belongs to this machine.', {
          cause: error,
        });
      case 'store-failed':
        return new UsageEngineCommandError('merge-store-failed', 'The usage store could not apply the merge file.', {
          cause: error,
        });
      default: {
        const unsupportedReason: never = error.reason;
        return unsupportedReason;
      }
    }
  };
  const runMergeEffect = async <Value>(effect: Effect.Effect<Value, EngineMergeError>): Promise<Value> => {
    const outcome = await Effect.runPromise(
      effect.pipe(
        Effect.match({
          onFailure: (error) => ({ error, ok: false as const }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    );
    if (!outcome.ok) {
      throw mergeCommandError(outcome.error);
    }
    return outcome.value;
  };
  const removeMergeInput = async (
    input: Awaited<ReturnType<typeof readUsageEngineInput>>,
    operation: 'confirm-merge' | 'preview-merge',
  ): Promise<void> => {
    try {
      await input.remove?.();
    } catch {
      reportCleanupFailure(operation);
    }
  };
  const discardFileInput = async (
    command: Parameters<UsageEngineMutationPort['discardFileInput']>[0],
  ): Promise<void> => {
    try {
      await discardUsageEngineHandoff(command.input, options.inboxDirectory);
    } catch {
      reportCleanupFailure(command.command === 'import-cursor' ? 'cursor-import' : command.command);
    }
  };
  const runFileMutationWithWriter = async <Value>(
    command: Parameters<UsageEngineMutationPort['discardFileInput']>[0],
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> => {
    try {
      return await runWithWriter(operation, signal);
    } catch (error) {
      await discardFileInput(command);
      throw error;
    }
  };
  const projectSourceReferenceFor = (selector: ProjectSourceSelector): UsageEngineProjectSourceReference =>
    `project-source:${createHash('sha256').update(projectSourceSelectorKey(selector)).digest('hex')}` as UsageEngineProjectSourceReference;
  const resolveReferencedProjectGroups = async (
    command: Parameters<UsageEngineMutationPort['replaceProjectGroupsByReference']>[0],
  ) => {
    const [config, served] = await Promise.all([
      runWithStorage(readAiUsageConfig),
      Effect.runPromise(
        queryServedReportRevisionSupport({
          dbPath: options.dbPath,
          ...(options.now === undefined ? {} : { now: options.now().getTime() }),
          revision: command.revision,
        }),
      ),
    ]);
    const selectorsByReference = new Map<UsageEngineProjectSourceReference, ProjectSourceSelector>();
    const remember = (selector: ProjectSourceSelector): void => {
      selectorsByReference.set(projectSourceReferenceFor(selector), { ...selector });
    };
    for (const group of config.projectGroups ?? []) {
      for (const selector of group.sources) {
        remember(selector);
      }
    }
    for (const group of served.support.projectGroups ?? []) {
      for (const source of group.sources) {
        remember(projectSourceSelectorFor(source));
      }
    }
    return parseProjectGroupConfigs(
      command.projectGroups.map((group) => ({
        id: group.id,
        name: group.name,
        sources: group.sources.map((reference) => {
          const selector = selectorsByReference.get(reference);
          if (!selector) {
            throw new UsageEngineCommandError(
              'command-rejected',
              'The project source selection is stale; reload the report before saving.',
            );
          }
          return { ...selector };
        }),
      })),
    );
  };

  return {
    confirmMerge: async (command, signal) =>
      await runFileMutationWithWriter(
        command,
        async () => {
          throwIfAborted(signal);
          const input = await readMergeInput(command.input);
          try {
            throwIfAborted(signal);
            await runMergeEffect(
              mergeService.confirm({
                bytes: input.bytes,
                confirmationToken: command.confirmationToken,
                expectedDigest: command.documentDigest,
                text: input.text,
              }),
            );
          } finally {
            await removeMergeInput(input, 'confirm-merge');
          }
        },
        signal,
      ),
    discardFileInput,
    importCursor: async (command, signal) =>
      await runFileMutationWithWriter(
        command,
        async () => {
          if (signal?.aborted) {
            await discardUsageEngineHandoff(command.input, options.inboxDirectory);
            throwIfAborted(signal);
          }
          const staged = await stageCursorUsageExport(command.input, {
            configCwd: options.configCwd,
            inboxDirectory: options.inboxDirectory,
            operatorCwd: options.operatorCwd,
            reportCleanupFailure: () => reportCleanupFailure('cursor-import'),
            ...(signal === undefined ? {} : { signal }),
          });
          throwIfAborted(signal);
          return {
            alreadyImported: staged.alreadyImported,
            artifactName: basename(staged.path),
            kind: 'cursor-import' as const,
          };
        },
        signal,
      ),
    previewMerge: async (command, signal) =>
      await runFileMutationWithWriter(
        command,
        async () => {
          throwIfAborted(signal);
          const input = await readMergeInput(command.input);
          try {
            throwIfAborted(signal);
            const preview = await runMergeEffect(mergeService.preview({ bytes: input.bytes, text: input.text }));
            throwIfAborted(signal);
            return {
              bytes: preview.bytes,
              confirmationToken: preview.confirmationToken,
              documentDigest: preview.digest,
              kind: 'merge-preview' as const,
              result: {
                deleted: preview.deleted,
                fleetChanged: preview.fleetChanged,
                inserted: preview.inserted,
                superseded: preview.superseded,
                unchanged: preview.unchanged,
                updated: preview.updated,
                warnings: preview.warnings,
              },
              rows: preview.rows,
              warningCount: preview.warningCount,
            };
          } finally {
            await removeMergeInput(input, 'preview-merge');
          }
        },
        signal,
      ),
    replaceProjectAliases: async (command, signal) =>
      await runWithWriter(async () => {
        throwIfAborted(signal);
        await runWithStorage(
          updateAiUsageConfig((config) => ({ ...config, projectAliases: [...command.projectAliases] })),
        );
      }, signal),
    replaceProjectGroups: async (command, signal) =>
      await runWithWriter(async () => {
        throwIfAborted(signal);
        await runWithStorage(
          updateAiUsageConfig((config) => ({ ...config, projectGroups: [...command.projectGroups] })),
        );
      }, signal),
    replaceProjectGroupsByReference: async (command, signal) =>
      await runWithWriter(async () => {
        throwIfAborted(signal);
        const projectGroups = await resolveReferencedProjectGroups(command);
        throwIfAborted(signal);
        await runWithStorage(updateAiUsageConfig((config) => ({ ...config, projectGroups })));
      }, signal),
    setMachineLabel: async (label, signal) =>
      await runWithWriter(async () => {
        throwIfAborted(signal);
        const previousMachine = { ...options.machine };
        const nextMachine = { ...options.machine, label };
        await updateMachineLabel({
          dbPath: options.dbPath,
          machine: nextMachine,
          ...(options.now === undefined ? {} : { updatedAt: options.now() }),
        });
        try {
          await writeMachine(nextMachine);
        } catch (cause) {
          try {
            await updateMachineLabel({
              dbPath: options.dbPath,
              machine: previousMachine,
              ...(options.now === undefined ? {} : { updatedAt: options.now() }),
            });
          } catch (rollbackCause) {
            throw new UsageEngineFatalConsistencyError(
              [cause, rollbackCause],
              'Machine label config write and usage-store rollback both failed.',
            );
          }
          throw cause;
        }
        options.machine.label = label;
        return nextMachine;
      }, signal),
  };
};

export const createLiveUsageEngineRuntime = (options: LiveUsageEngineRuntimeOptions): UsageEngineRuntimeHost => {
  const now = options.now ?? (() => new Date());
  const storage = options.storage ?? createLocalHistoryStorage();
  const writerGate = options.writerGate ?? createUsageEngineWriterGate();
  const eventRuntime = ManagedRuntime.make(options.wideEventSinkLayer);
  const pendingDiagnostics = new Set<Promise<void>>();
  let sharedWideEventLayerPromise: Promise<Layer.Layer<WideEventResourceService | WideEventSink>> | undefined;
  let machine: UsageMachine | undefined;
  let publisher: DurableReportPublisher | undefined;
  let sourceControl: UsageEngineSourceControlPort | undefined;
  let mutation: UsageEngineMutationPort | undefined;

  const runWithStorage = <Value, Error>(effect: Effect.Effect<Value, Error, LocalHistoryStorage>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  const sharedWideEventLayer = (): Promise<Layer.Layer<WideEventResourceService | WideEventSink>> => {
    sharedWideEventLayerPromise ??= eventRuntime
      .runPromise(Effect.all([WideEventResourceService, WideEventSink] as const))
      .then(([resource, sink]) =>
        Layer.merge(Layer.succeed(WideEventResourceService, resource), Layer.succeed(WideEventSink, sink)),
      );
    return sharedWideEventLayerPromise;
  };
  const observe = async <Value>(
    boundary: string,
    operation: () => Promise<Value>,
    annotations?: Readonly<Record<string, boolean | number | string | null>>,
  ): Promise<Value> => {
    const outcome = await eventRuntime.runPromise(
      runBoundaryEffect(
        { boundary, ...(annotations === undefined ? {} : { annotations }) },
        Effect.tryPromise({ catch: (cause) => cause, try: operation }),
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ error, ok: false as const }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  };
  const reportCleanupFailure = (operation: 'confirm-merge' | 'cursor-import' | 'preview-merge'): void => {
    const diagnostic = observe(
      'handoff.cleanup',
      () => Promise.reject(new Error('A committed usage-engine handoff could not be removed.')),
      { operation },
    ).then(
      () => undefined,
      () => undefined,
    );
    pendingDiagnostics.add(diagnostic);
    diagnostic.then(() => pendingDiagnostics.delete(diagnostic));
  };
  const requireMachine = (): UsageMachine => {
    if (!machine) {
      throw new Error('Usage engine machine configuration is not initialized.');
    }
    return machine;
  };
  const requirePublisher = (): DurableReportPublisher => {
    publisher ??= createDurableReportPublisher({
      configCwd: options.configCwd,
      dbPath: options.dbPath,
      machine: requireMachine(),
      now,
      retainRevisions: async (input) =>
        await observe(
          'retention',
          async () => {
            if (options.retainRevisions) {
              await options.retainRevisions(input);
            } else {
              await Effect.runPromise(retainServedReportRevisions(input));
            }
          },
          { phase: 'publication' },
        ),
      storage,
    });
    return publisher;
  };
  const requireMutation = (): UsageEngineMutationPort => {
    mutation ??= createLiveUsageEngineMutationPort({
      configCwd: options.configCwd,
      dbPath: options.dbPath,
      inboxDirectory: options.inboxDirectory,
      machine: requireMachine(),
      now,
      operatorCwd: options.operatorCwd,
      ...(options.readInput === undefined ? {} : { readInput: options.readInput }),
      reportCleanupFailure,
      storage,
      writerGate,
    });
    return mutation;
  };

  const buildSourceControl = async (): Promise<UsageEngineSourceControlPort> => {
    if (sourceControl) {
      return sourceControl;
    }
    const sources = await runWithStorage(
      createScheduledSourceRegistry({
        ...(options.codexLiveAvailable === undefined ? {} : { codexLiveAvailable: options.codexLiveAvailable }),
        configCwd: options.configCwd,
        dbPath: options.dbPath,
        machine: requireMachine(),
        now,
      }),
    );
    const policyStore: SourcePolicyStore = {
      load: readAiUsageConfig.pipe(
        Effect.map((config) => config.sourcePolicies ?? {}),
        Effect.provideService(LocalHistoryStorage, storage),
      ),
      setEnabled: (sourceId, enabled) =>
        setSourcePolicyOverride(sourceId, enabled).pipe(
          Effect.asVoid,
          Effect.provideService(LocalHistoryStorage, storage),
        ),
    };
    sourceControl = createTerminalSourceControlPort({
      initialDetection: options.initialSourceDetection ?? 'automatic',
      instanceId: options.instanceId,
      policyStore,
      publication: {
        publish: Effect.tryPromise({
          try: () => requirePublisher().publish(),
          catch: (cause) => cause,
        }),
      },
      sources,
      wideEventSinkLayer: await sharedWideEventLayer(),
      writerGate,
    });
    return sourceControl;
  };

  const sourcePort: UsageEngineSourceControlPort = {
    changes: (signal) => ({
      async *[Symbol.asyncIterator]() {
        const live = await buildSourceControl();
        yield* live.changes(signal);
      },
    }),
    detectAll: async (signal) => await (await buildSourceControl()).detectAll(signal),
    dispose: async () => await sourceControl?.dispose(),
    publish: async (signal) => await (await buildSourceControl()).publish(signal),
    redetectAndRunSource: async (sourceId, signal) =>
      await (await buildSourceControl()).redetectAndRunSource(sourceId, signal),
    runAllEnabled: async (signal) => await (await buildSourceControl()).runAllEnabled(signal),
    runSource: async (sourceId, signal) => await (await buildSourceControl()).runSource(sourceId, signal),
    setSourceEnabled: async (sourceId, enabled, signal) =>
      await (await buildSourceControl()).setSourceEnabled(sourceId, enabled, signal),
    start: async () => await (await buildSourceControl()).start(),
    stopAutonomousCollection: async () => await (await buildSourceControl()).stopAutonomousCollection(),
  };
  const mutationPort: UsageEngineMutationPort = {
    confirmMerge: async (command, signal) => await requireMutation().confirmMerge(command, signal),
    discardFileInput: async (command) => await requireMutation().discardFileInput(command),
    importCursor: async (command, signal) => await requireMutation().importCursor(command, signal),
    previewMerge: async (command, signal) => await requireMutation().previewMerge(command, signal),
    replaceProjectAliases: async (command, signal) => await requireMutation().replaceProjectAliases(command, signal),
    replaceProjectGroups: async (command, signal) => await requireMutation().replaceProjectGroups(command, signal),
    replaceProjectGroupsByReference: async (command, signal) =>
      await requireMutation().replaceProjectGroupsByReference(command, signal),
    setMachineLabel: async (label, signal) => await requireMutation().setMachineLabel(label, signal),
  };

  return createUsageEngineRuntime({
    acquireWriterLease: options.acquireWriterLease,
    initialSourceControl: createInitialUsageEngineSourceControlView(options.instanceId, now()),
    initializeStore: async () =>
      await writerGate.run(
        async () =>
          await observe(
            'migration',
            async () => await Effect.runPromise(initializeUsageStore({ dbPath: options.dbPath })),
            { phase: 'startup' },
          ),
      ),
    instanceId: options.instanceId,
    mutation: mutationPort,
    now,
    observeCommand: async (command, operation) => await observe('engine.command', operation, { command }),
    publishInitialRevision: async () =>
      await writerGate.run(async () => {
        const publication = await observe('publication', async () => await requirePublisher().publish(), {
          phase: 'startup',
        });
        return {
          publishedAt: publication.publishedAt,
          revision: parseUsageEnginePublicationRevision(publication.revision),
        };
      }),
    quiesceStore: async () => {
      try {
        await writerGate.run(async () => {
          await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath: options.dbPath }));
        });
      } finally {
        await Promise.all([...pendingDiagnostics]);
        await eventRuntime.dispose().catch(() => undefined);
      }
    },
    recover: async () =>
      await writerGate.run(async () => {
        await observe(
          'retention',
          async () => {
            await Effect.runPromise(retainServedReportRevisions({ dbPath: options.dbPath, now: now().getTime() }));
          },
          { phase: 'startup' },
        );
        const gracePeriodMs = options.legacyArtifactGracePeriodMs ?? 5 * 60 * 1000;
        const recoveryTime = now().getTime();
        await repairManagedCursorUsageExportModes(options.configCwd);
        const [legacy, inbox] = await Promise.all([
          scavengeLegacyUsageEngineArtifacts({
            gracePeriodMs,
            now: recoveryTime,
            temporaryRoot: options.temporaryRoot,
          }),
          scavengeUsageEngineInbox({
            gracePeriodMs,
            inboxDirectory: options.inboxDirectory,
            now: recoveryTime,
          }),
        ]);
        options.reportRecovery?.({
          ...legacy,
          deletedInboxBytes: inbox.deletedBytes,
          deletedInboxFiles: inbox.deletedFiles,
          skippedSuspiciousInboxEntries: inbox.skippedSuspicious,
        });
      }),
    sourceControl: sourcePort,
    validateConfig: async () =>
      await writerGate.run(async () => {
        const configuredMachine = await runWithStorage(ensureMachineConfig);
        await runWithStorage(readMergedAiUsageConfigFrom(options.configCwd));
        await Effect.runPromise(
          updateUsageMachineLabel({
            dbPath: options.dbPath,
            machine: configuredMachine,
            updatedAt: now(),
          }),
        );
        machine = configuredMachine;
      }),
  });
};

const sameGenerations = (left: UsageStoreGenerations, right: UsageStoreGenerations): boolean =>
  left.machineFleetGeneration === right.machineFleetGeneration &&
  left.usageStoreGeneration === right.usageStoreGeneration;

export const createDurableReportPublisher = (options: DurableReportPublisherOptions): DurableReportPublisher => {
  const currentTime = options.now ?? (() => new Date());
  const nextRevision = options.revision ?? randomUUID;
  const retainRevisions =
    options.retainRevisions ??
    (async (input: { readonly dbPath: string; readonly now: number }): Promise<void> => {
      await Effect.runPromise(retainServedReportRevisions(input));
    });
  const fingerprintRequest = { configCwd: options.configCwd, dbPath: options.dbPath };
  const runWithStorage = <Value, Error>(effect: Effect.Effect<Value, Error, LocalHistoryStorage>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, options.storage)));

  const publish = async () => {
    const publicationTime = currentTime();
    const result = await Effect.runPromise(
      publishServedReportRevision({
        assemble: async ({ generations }) => {
          const before = await runWithStorage(readStoredReportSourceFingerprint(fingerprintRequest));
          if (!sameGenerations(before, generations)) {
            throw new Error('Stored report generations changed before publication assembly.');
          }
          const capture = await runWithStorage(
            createStoredReportCapture({
              configCwd: options.configCwd,
              dbPath: options.dbPath,
              generatedAt: publicationTime,
              harness: null,
              includeCursor: true,
              includeFacets: true,
              machine: options.machine,
              options: {
                limit: null,
                minTokens: 1,
                project: null,
                since: null,
                sort: 'date',
              },
            }),
          );
          const after = await runWithStorage(readStoredReportSourceFingerprint(fingerprintRequest));
          if (!(sameGenerations(after, generations) && before.configFingerprint === after.configFingerprint)) {
            throw new Error('Stored report sources changed during publication assembly.');
          }
          return toStoredReportPublicationCapture(capture, after.configFingerprint);
        },
        dbPath: options.dbPath,
        now: publicationTime.getTime(),
        revision: nextRevision(),
      }),
    );
    try {
      await retainRevisions({ dbPath: options.dbPath, now: publicationTime.getTime() });
    } catch (cause) {
      try {
        options.reportRetentionFailure?.(cause);
      } catch {
        // A diagnostic sink must not turn a committed publication into a failed command.
      }
    }
    return {
      changed: result.changed,
      publishedAt: new Date(result.manifest.publishedAt).toISOString(),
      revision: result.manifest.revision,
    };
  };

  return {
    publish: async () => (options.writerGate ? await options.writerGate.run(publish) : await publish()),
  };
};
