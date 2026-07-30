import { randomUUID } from 'node:crypto';
import { scheduler as hostScheduler } from 'node:timers/promises';
import {
  annotateWideEvent,
  type BoundaryClassification,
  classifyExit,
  type LogValue,
  runBoundaryEffect,
  type WideEventResourceService,
  type WideEventService,
  type WideEventSink,
  withMeasured,
} from '@ai-usage/effect-runtime';
import {
  type CollectionSourceId,
  type SourceControlView,
  type SourcePolicyOverrides,
  sanitizeSourceWarningCodes,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Queue,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { ScheduledSource } from './source-adapters';
import {
  admitPublicationJob,
  admitSourceJob,
  applyDetectionTransition,
  cancelQueuedSourceJobTransition,
  finishPublicationJobTransition,
  finishSourceJobTransition,
  type InternalControlState,
  initialSourceControlState,
  outcomeAfterRun,
  type PublicationJob,
  requestPublicationTransition,
  type SourceExecutionCompletion,
  type SourceFinishDecision,
  type SourceJob,
  type SourceJobTrigger,
  type StateTransition,
  scheduleSourceTransition,
  setSourcePolicyTransition,
  sourceControlView,
  startPublicationJobTransition,
  startSourceJobTransition,
  updateSourceProgressTransition,
} from './source-control-state';
import type { UsageEngineWriterGate } from './writer-gate';

const AUTONOMOUS_SOURCE_TRIGGERS = new Set<SourceJobTrigger>(['cadence', 'detection']);

export interface SourcePolicyStore {
  readonly load: Effect.Effect<SourcePolicyOverrides, unknown>;
  readonly setEnabled: (sourceId: CollectionSourceId, enabled: boolean) => Effect.Effect<void, unknown>;
}

export interface ReportPublicationResult {
  readonly changed: boolean;
  readonly publishedAt?: string;
  readonly revision?: string;
}

export interface ReportPublicationPort {
  readonly publish: Effect.Effect<ReportPublicationResult, unknown>;
}

export interface SourceControlOptions {
  readonly autonomousCollection?: boolean;
  readonly beforeInitialCollection?: Effect.Effect<void>;
  readonly initialDetection?: 'automatic' | 'deferred';
  readonly initialPublicationOrder?: 'after-collection' | 'before-collection' | 'externally-published';
  readonly instanceId?: string;
  readonly policyStore: SourcePolicyStore;
  readonly publication: ReportPublicationPort;
  readonly sources: ReadonlyMap<CollectionSourceId, ScheduledSource>;
  readonly sourceTimeout?: Duration.DurationInput;
  readonly workerCount?: number;
  readonly writerGate?: UsageEngineWriterGate;
}

export type SourceControlCommandErrorReason = 'disabled' | 'not-detected' | 'policy-write-failed' | 'unknown-source';

export class SourceControlCommandError extends Data.TaggedError('SourceControlCommandError')<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: SourceControlCommandErrorReason;
  readonly sourceId?: CollectionSourceId;
}> {}

export interface SourceControlService {
  readonly changes: Stream.Stream<SourceControlView>;
  readonly detectAll: Effect.Effect<void>;
  readonly detectSource: (sourceId: CollectionSourceId) => Effect.Effect<boolean>;
  readonly getSnapshot: Effect.Effect<SourceControlView>;
  readonly requestPublication: Effect.Effect<boolean>;
  readonly runAllEnabled: Effect.Effect<number>;
  readonly runNow: (sourceId: CollectionSourceId) => Effect.Effect<boolean, SourceControlCommandError>;
  readonly setEnabled: (
    sourceId: CollectionSourceId,
    enabled: boolean,
  ) => Effect.Effect<void, SourceControlCommandError>;
  readonly stopAutonomousCollection: Effect.Effect<void>;
}

export class SourceControl extends Context.Tag('@ai-usage/usage-engine-runtime/SourceControl')<
  SourceControl,
  SourceControlService
>() {}

type ControlPlaneJob = PublicationJob | SourceJob;

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_SOURCE_TIMEOUT = Duration.minutes(10);
const yieldToHost = Effect.promise(() => hostScheduler.yield());

interface ValidatedSourceControlOptions {
  readonly sourceTimeout: Duration.Duration;
  readonly workerCount: number;
}

interface SourceControlRuntime {
  readonly autonomousCollection: { open: boolean };
  readonly beforeInitialCollection: Effect.Effect<void>;
  readonly options: SourceControlOptions;
  readonly queue: Queue.Queue<ControlPlaneJob>;
  readonly sourceIds: readonly CollectionSourceId[];
  readonly sourceTimeout: Duration.Duration;
  readonly stateRef: SubscriptionRef.SubscriptionRef<InternalControlState>;
  readonly timers: FiberMap.FiberMap<CollectionSourceId>;
}

interface SourceControlScheduler {
  readonly detectAll: Effect.Effect<void>;
  readonly detectSource: (sourceId: CollectionSourceId) => Effect.Effect<boolean>;
  readonly enqueueSource: (sourceId: CollectionSourceId, trigger: SourceJobTrigger) => Effect.Effect<boolean>;
  readonly ensurePublicationQueued: Effect.Effect<boolean>;
  readonly requestPublication: Effect.Effect<boolean>;
  readonly scheduleCadence: (sourceId: CollectionSourceId) => Effect.Effect<void>;
  readonly scheduleCadenceAt: (sourceId: CollectionSourceId, dueAt: number) => Effect.Effect<void>;
}

const validateSourceControlOptions = (options: SourceControlOptions): Effect.Effect<ValidatedSourceControlOptions> =>
  Effect.gen(function* () {
    const workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    if (!(Number.isSafeInteger(workerCount) && workerCount > 0 && workerCount <= sourceControlBounds.maxRunningCount)) {
      return yield* Effect.die(
        new Error(
          `Source control workerCount must be an integer from 1 through ${sourceControlBounds.maxRunningCount}.`,
        ),
      );
    }
    const sourceTimeout = Duration.decode(options.sourceTimeout ?? DEFAULT_SOURCE_TIMEOUT);
    const sourceTimeoutMs = Duration.toMillis(sourceTimeout);
    if (!(sourceTimeoutMs > 0 && sourceTimeoutMs <= sourceControlBounds.maxDurationMs)) {
      return yield* Effect.die(new Error('Source control timeout must be positive and no longer than 24 hours.'));
    }
    return { sourceTimeout, workerCount };
  });

const createSourceControlRuntime = (
  options: SourceControlOptions,
  sourceTimeout: Duration.Duration,
): Effect.Effect<SourceControlRuntime, never, import('effect').Scope.Scope> =>
  Effect.gen(function* () {
    const policies = yield* options.policyStore.load.pipe(Effect.orDie);
    const beforeInitialCollection = yield* Effect.cached(options.beforeInitialCollection ?? Effect.void);
    const now = yield* Clock.currentTimeMillis;
    const sourceIds = [...options.sources.keys()];
    const stateRef = yield* SubscriptionRef.make(
      initialSourceControlState(options.instanceId ?? randomUUID(), sourceIds, policies, now),
    );
    const queue = yield* Queue.bounded<ControlPlaneJob>(sourceControlBounds.maxQueueDepth);
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const timers = yield* FiberMap.make<CollectionSourceId>();
    return {
      autonomousCollection: { open: options.autonomousCollection ?? true },
      beforeInitialCollection,
      options,
      queue,
      sourceIds,
      sourceTimeout,
      stateRef,
      timers,
    };
  });

const modifyControlState = <Decision>(
  runtime: SourceControlRuntime,
  update: (state: InternalControlState, modifiedAt: number) => StateTransition<Decision>,
): Effect.Effect<Decision> =>
  Effect.gen(function* () {
    const modifiedAt = yield* Clock.currentTimeMillis;
    return yield* SubscriptionRef.modify(runtime.stateRef, (state) => {
      const result = update(state, modifiedAt);
      return [result.decision, result.state] as const;
    });
  });

const createSourceControlScheduler = (runtime: SourceControlRuntime): SourceControlScheduler => {
  const enqueueSource = (sourceId: CollectionSourceId, trigger: SourceJobTrigger): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (AUTONOMOUS_SOURCE_TRIGGERS.has(trigger) && !runtime.autonomousCollection.open) {
        return false;
      }
      const queued = yield* modifyControlState(runtime, (state, queuedAt) =>
        admitSourceJob(state, sourceId, runtime.options.sources.has(sourceId), queuedAt, trigger),
      );
      if (!queued) {
        return false;
      }
      yield* runtime.queue.offer(queued);
      return true;
    });

  const ensurePublicationQueued: Effect.Effect<boolean> = Effect.gen(function* () {
    const job = yield* modifyControlState(runtime, admitPublicationJob);
    if (!job) {
      return false;
    }
    yield* runtime.queue.offer(job);
    return true;
  });

  const requestPublication: Effect.Effect<boolean> = Effect.gen(function* () {
    const decision = yield* modifyControlState(runtime, requestPublicationTransition);
    if (decision.shouldQueue) {
      yield* ensurePublicationQueued;
    }
    return true;
  });

  const scheduleCadenceAt = (sourceId: CollectionSourceId, dueAt: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!runtime.autonomousCollection.open) {
        return;
      }
      const source = runtime.options.sources.get(sourceId);
      if (!source) {
        return;
      }
      const currentTime = yield* Clock.currentTimeMillis;
      const scheduled = yield* modifyControlState(runtime, (state, modifiedAt) =>
        scheduleSourceTransition(state, sourceId, dueAt, modifiedAt),
      );
      if (!scheduled) {
        return;
      }
      yield* FiberMap.run(
        runtime.timers,
        sourceId,
        Effect.sleep(Duration.millis(Math.max(0, dueAt - currentTime))).pipe(
          Effect.flatMap(() => enqueueSource(sourceId, 'cadence')),
          Effect.asVoid,
        ),
      );
    });

  const scheduleCadence = (sourceId: CollectionSourceId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const source = runtime.options.sources.get(sourceId);
      if (!source) {
        return;
      }
      const currentTime = yield* Clock.currentTimeMillis;
      yield* scheduleCadenceAt(sourceId, currentTime + Duration.toMillis(source.cadence));
    });

  const runDetection = (
    sourceId: CollectionSourceId,
    trigger: Extract<SourceJobTrigger, 'detection' | 'manual'>,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const source = runtime.options.sources.get(sourceId);
      if (!source) {
        return false;
      }
      const result = yield* source.detect;
      const decision = yield* modifyControlState(runtime, (state, modifiedAt) =>
        applyDetectionTransition(state, sourceId, result, modifiedAt),
      );
      if (decision.cancelTimer) {
        yield* FiberMap.remove(runtime.timers, sourceId);
      }
      if (decision.shouldQueue) {
        return yield* enqueueSource(sourceId, trigger);
      }
      return false;
    });

  const explicitDetectionTrigger = (): Extract<SourceJobTrigger, 'detection' | 'manual'> =>
    runtime.autonomousCollection.open ? 'detection' : 'manual';

  return {
    detectAll: Effect.suspend(() => {
      const trigger = explicitDetectionTrigger();
      return Effect.forEach(runtime.sourceIds, (sourceId) => runDetection(sourceId, trigger), {
        concurrency: 1,
        discard: true,
      });
    }),
    detectSource: (sourceId) => runDetection(sourceId, explicitDetectionTrigger()),
    enqueueSource,
    ensurePublicationQueued,
    requestPublication,
    scheduleCadence,
    scheduleCadenceAt,
  };
};

const sourceRunAnnotations = (
  completion: SourceExecutionCompletion,
  changed: boolean,
  servedProjectionChanged: boolean,
): Readonly<Record<string, LogValue>> => {
  const result = completion._tag === 'success' ? completion.result : undefined;
  const domainOutcome = outcomeAfterRun(completion, result?.unavailable, result?.warnings.length ?? 0);
  const warningCodes = sanitizeSourceWarningCodes(result?.warnings ?? []);
  return {
    changed,
    domainOutcome,
    servedProjectionChanged,
    ...(completion._tag === 'success' && completion.result.unavailable
      ? { unavailableCode: completion.result.unavailable.code }
      : {}),
    ...(completion._tag === 'success'
      ? {
          inputCount: completion.result.inputCount,
          outputCount: completion.result.outputCount,
          warningsCount: completion.result.warnings.length,
          ...(warningCodes.length === 0 ? {} : { warningCodes }),
        }
      : { failureKind: completion.failureKind }),
  };
};

const boundedQueueDelayMs = (queuedAt: number, startedAt: number): number => {
  const elapsed = startedAt - queuedAt;
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? Math.min(elapsed, sourceControlBounds.maxQueueDelayMs) : 0;
};

const classifySourceRunOutcome = (exit: Exit.Exit<SourceExecutionCompletion, never>): BoundaryClassification => {
  if (Exit.isFailure(exit)) {
    return classifyExit(exit);
  }
  const completion = exit.value;
  if (completion._tag === 'timed-out') {
    return { outcome: 'timed-out', annotations: { failureKind: completion.failureKind } };
  }
  if (completion._tag === 'failed') {
    return { outcome: 'failure', annotations: { failureKind: completion.failureKind } };
  }
  const { unavailable, warnings } = completion.result;
  return { outcome: unavailable || warnings.length > 0 ? 'degraded' : 'success' };
};

const runSourceJobBody = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
  job: SourceJob,
  source: ScheduledSource,
  decision: { readonly rtkTargetGeneration: number; readonly startedAt: number },
): Effect.Effect<SourceExecutionCompletion, never, WideEventResourceService | WideEventService | WideEventSink> =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const sourceExecution = source
      .run({
        reportProgress: (progress) =>
          modifyControlState(runtime, (state, modifiedAt) =>
            updateSourceProgressTransition(state, job.sourceId, progress, modifiedAt),
          ),
        signal: controller.signal,
      })
      .pipe(
        withMeasured('source.execute'),
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
        Effect.timeoutOption(runtime.sourceTimeout),
        Effect.match({
          onFailure: (): SourceExecutionCompletion => ({ _tag: 'failed', failureKind: 'source-run-error' }),
          onSuccess: (value): SourceExecutionCompletion =>
            Option.isNone(value)
              ? { _tag: 'timed-out', failureKind: 'source-timeout' }
              : { _tag: 'success', result: value.value },
        }),
      );
    const observedExecution =
      job.sourceId === 'rtk.savings'
        ? runBoundaryEffect(
            {
              boundary: 'enrichment',
              annotations: { sourceId: job.sourceId, trigger: job.trigger },
              classify: classifySourceRunOutcome,
            },
            sourceExecution,
          )
        : sourceExecution;
    const completion = yield* observedExecution;
    if (completion._tag === 'timed-out') {
      controller.abort();
    }
    const completed: SourceFinishDecision = yield* modifyControlState(runtime, (state, finishedAt) =>
      finishSourceJobTransition(state, job, decision.startedAt, decision.rtkTargetGeneration, completion, finishedAt),
    );
    yield* annotateWideEvent({
      ...sourceRunAnnotations(completion, completed.changed, completed.servedProjectionChanged),
      ...(completed.publicationDataGeneration === undefined
        ? {}
        : { publicationDataGeneration: completed.publicationDataGeneration }),
    });
    if (completed.needsRtk || completed.needsRtkRerun) {
      yield* scheduler.enqueueSource('rtk.savings', 'dependency');
    }
    if (completed.needsPublicationWake) {
      yield* scheduler.ensurePublicationQueued;
    }
    if (completed.enabled && completed.detected) {
      yield* scheduler.scheduleCadence(job.sourceId);
    } else {
      yield* FiberMap.remove(runtime.timers, job.sourceId);
    }
    return completion;
  });

const processSourceJob = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
  job: SourceJob,
): Effect.Effect<void, never, WideEventResourceService | WideEventSink> =>
  Effect.gen(function* () {
    if (AUTONOMOUS_SOURCE_TRIGGERS.has(job.trigger) && !runtime.autonomousCollection.open) {
      yield* modifyControlState(runtime, (state, modifiedAt) =>
        cancelQueuedSourceJobTransition(state, job, modifiedAt),
      );
      return;
    }
    const decision = yield* modifyControlState(runtime, (state, startedAt) =>
      startSourceJobTransition(state, job, startedAt),
    );
    if (!decision.run) {
      if (decision.staleRequeue) {
        yield* scheduler.enqueueSource(job.sourceId, job.trigger);
      }
      return;
    }
    const source = runtime.options.sources.get(job.sourceId);
    if (!source) {
      return;
    }
    const sourceOperation = runSourceJobBody(runtime, scheduler, job, source, decision);
    yield* runBoundaryEffect(
      {
        boundary: 'source.run',
        annotations: {
          queueDelayMs: boundedQueueDelayMs(job.queuedAt, decision.startedAt),
          sourceId: job.sourceId,
          trigger: job.trigger,
        },
        classify: classifySourceRunOutcome,
      },
      sourceOperation,
    );
  });

const classifyPublicationOutcome = (
  exit: Exit.Exit<ReportPublicationResult | undefined, never>,
): BoundaryClassification => {
  if (Exit.isFailure(exit)) {
    return classifyExit(exit);
  }
  return exit.value === undefined
    ? { outcome: 'failure', annotations: { failureKind: 'publication-failed' } }
    : { outcome: 'success' };
};

const runPublicationJobBody = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
  decision: {
    readonly dataTarget: number;
    readonly previousPublishedGeneration: number;
    readonly requestTarget: number;
    readonly startedAt: number;
  },
): Effect.Effect<ReportPublicationResult | undefined, never, WideEventService> =>
  Effect.gen(function* () {
    const result = yield* runtime.options.publication.publish.pipe(
      withMeasured('publication.publish'),
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (value) => value,
      }),
    );
    if (result !== undefined) {
      yield* annotateWideEvent({
        changed: result.changed,
        dataTarget: decision.dataTarget,
        previousPublishedGeneration: decision.previousPublishedGeneration,
        ...(result.publishedAt === undefined ? {} : { publishedAt: result.publishedAt }),
        requestTarget: decision.requestTarget,
        ...(result.revision === undefined ? {} : { revision: result.revision }),
      });
    }
    const remainsPending = yield* modifyControlState(runtime, (state, finishedAt) =>
      finishPublicationJobTransition(
        state,
        decision.startedAt,
        decision.requestTarget,
        decision.dataTarget,
        result,
        finishedAt,
      ),
    );
    if (remainsPending) {
      yield* scheduler.ensurePublicationQueued;
    }
    return result;
  });

const processPublicationJob = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
  job: PublicationJob,
): Effect.Effect<void, never, WideEventResourceService | WideEventSink> =>
  Effect.gen(function* () {
    const decision = yield* modifyControlState(runtime, startPublicationJobTransition);
    if (!decision.ready) {
      return;
    }
    yield* runBoundaryEffect(
      {
        boundary: 'publication',
        annotations: {
          dataTarget: decision.dataTarget,
          previousPublishedGeneration: decision.previousPublishedGeneration,
          queueDelayMs: boundedQueueDelayMs(job.queuedAt, decision.startedAt),
          requestTarget: decision.requestTarget,
        },
        classify: classifyPublicationOutcome,
      },
      Effect.uninterruptible(runPublicationJobBody(runtime, scheduler, decision)),
    );
  });

const startSourceControlWorkers = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
  workerCount: number,
): Effect.Effect<void, never, import('effect').Scope.Scope | WideEventResourceService | WideEventSink> =>
  Effect.gen(function* () {
    const cancelJobAfterWriterGateClosed = (job: ControlPlaneJob): Effect.Effect<void> =>
      job._tag === 'source'
        ? modifyControlState(runtime, (state, modifiedAt) => cancelQueuedSourceJobTransition(state, job, modifiedAt))
        : Effect.gen(function* () {
            const decision = yield* modifyControlState(runtime, startPublicationJobTransition);
            if (!decision.ready) {
              return;
            }
            yield* modifyControlState(runtime, (state, finishedAt) =>
              finishPublicationJobTransition(
                state,
                decision.startedAt,
                decision.requestTarget,
                decision.dataTarget,
                undefined,
                finishedAt,
              ),
            );
          });
    const processJobWithoutGate = (
      job: ControlPlaneJob,
    ): Effect.Effect<void, never, WideEventResourceService | WideEventSink> =>
      job._tag === 'source'
        ? runtime.beforeInitialCollection.pipe(Effect.andThen(processSourceJob(runtime, scheduler, job)))
        : processPublicationJob(runtime, scheduler, job);
    const processJob = (job: ControlPlaneJob): Effect.Effect<void, never, WideEventResourceService | WideEventSink> => {
      const operation = processJobWithoutGate(job);
      const gate = runtime.options.writerGate;
      return gate
        ? gate.withPermit(Effect.suspend(() => (gate.isClosed() ? cancelJobAfterWriterGateClosed(job) : operation)))
        : operation;
    };
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
      yield* Effect.forkScoped(
        Effect.forever(
          runtime.queue.take.pipe(Effect.flatMap((job) => yieldToHost.pipe(Effect.andThen(processJob(job))))),
        ),
      );
    }
  });

const createSourceControlCommands = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
): Pick<SourceControlService, 'runAllEnabled' | 'runNow' | 'setEnabled'> => {
  const policyMutationSemaphore = Effect.runSync(Effect.makeSemaphore(1));
  const runNow = (sourceId: CollectionSourceId): Effect.Effect<boolean, SourceControlCommandError> =>
    Effect.gen(function* () {
      if (!runtime.options.sources.has(sourceId)) {
        return yield* Effect.fail(
          new SourceControlCommandError({ message: 'Unknown collection source.', reason: 'unknown-source', sourceId }),
        );
      }
      const current = (yield* SubscriptionRef.get(runtime.stateRef)).sources[sourceId];
      if (!current.enabled) {
        return yield* Effect.fail(
          new SourceControlCommandError({
            message: 'The collection source is disabled.',
            reason: 'disabled',
            sourceId,
          }),
        );
      }
      if (current.availability !== 'detected') {
        return yield* Effect.fail(
          new SourceControlCommandError({
            message: 'The collection source is not detected.',
            reason: 'not-detected',
            sourceId,
          }),
        );
      }
      if (current.queued || current.running) {
        return false;
      }
      yield* FiberMap.remove(runtime.timers, sourceId);
      return yield* scheduler.enqueueSource(sourceId, 'manual');
    });

  const runAllEnabled: Effect.Effect<number> = Effect.gen(function* () {
    let queuedCount = 0;
    for (const sourceId of runtime.sourceIds) {
      const state = (yield* SubscriptionRef.get(runtime.stateRef)).sources[sourceId];
      if (!(state.enabled && state.availability === 'detected' && !state.queued && !state.running)) {
        continue;
      }
      yield* FiberMap.remove(runtime.timers, sourceId);
      if (yield* scheduler.enqueueSource(sourceId, 'manual')) {
        queuedCount++;
      }
    }
    return queuedCount;
  });

  const setEnabledOptimistically = (
    sourceId: CollectionSourceId,
    enabled: boolean,
  ): Effect.Effect<void, SourceControlCommandError> =>
    Effect.gen(function* () {
      if (!runtime.options.sources.has(sourceId)) {
        return yield* Effect.fail(
          new SourceControlCommandError({ message: 'Unknown collection source.', reason: 'unknown-source', sourceId }),
        );
      }
      const previous = (yield* SubscriptionRef.get(runtime.stateRef)).sources[sourceId];
      if (!enabled) {
        yield* FiberMap.remove(runtime.timers, sourceId);
      }
      const decision = yield* modifyControlState(runtime, (state, modifiedAt) =>
        setSourcePolicyTransition(state, sourceId, enabled, modifiedAt),
      );
      const rollback = Effect.gen(function* () {
        const rollbackDecision = yield* modifyControlState(runtime, (state, modifiedAt) =>
          setSourcePolicyTransition(state, sourceId, previous.enabled, modifiedAt),
        );
        if (!previous.enabled) {
          yield* FiberMap.remove(runtime.timers, sourceId);
          return;
        }
        if (previous.queued && rollbackDecision.shouldQueue) {
          yield* scheduler.enqueueSource(sourceId, 'manual');
          return;
        }
        const previousDueAt = previous.nextDueAt === undefined ? Number.NaN : Date.parse(previous.nextDueAt);
        if (Number.isFinite(previousDueAt)) {
          yield* scheduler.scheduleCadenceAt(sourceId, previousDueAt);
          return;
        }
        yield* scheduler.scheduleCadence(sourceId);
      });
      const commit = Effect.gen(function* () {
        yield* runtime.options.policyStore.setEnabled(sourceId, enabled).pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlCommandError({
                cause,
                message: 'The source policy could not be saved.',
                reason: 'policy-write-failed',
                sourceId,
              }),
          ),
        );
        if (decision.shouldQueue) {
          yield* scheduler.enqueueSource(sourceId, 'manual');
        }
        yield* scheduler.requestPublication;
      }).pipe(Effect.catchAll((error) => rollback.pipe(Effect.andThen(Effect.fail(error)))));
      yield* runtime.options.writerGate ? runtime.options.writerGate.withEffect(commit) : commit;
    });
  const setEnabled = (sourceId: CollectionSourceId, enabled: boolean): Effect.Effect<void, SourceControlCommandError> =>
    policyMutationSemaphore.withPermits(1)(Effect.uninterruptible(setEnabledOptimistically(sourceId, enabled)));

  return { runAllEnabled, runNow, setEnabled };
};

export const createSourceControl = (
  options: SourceControlOptions,
): Effect.Effect<
  SourceControlService,
  never,
  import('effect').Scope.Scope | WideEventResourceService | WideEventSink
> =>
  Effect.gen(function* () {
    const validatedOptions = yield* validateSourceControlOptions(options);
    const runtime = yield* createSourceControlRuntime(options, validatedOptions.sourceTimeout);
    const scheduler = createSourceControlScheduler(runtime);
    const commands = createSourceControlCommands(runtime, scheduler);
    const stopAutonomousCollection = Effect.gen(function* () {
      runtime.autonomousCollection.open = false;
      yield* Effect.forEach(runtime.sourceIds, (sourceId) => FiberMap.remove(runtime.timers, sourceId), {
        discard: true,
      });
    });
    if (options.initialPublicationOrder === 'before-collection') {
      yield* scheduler.requestPublication;
    }
    if (options.initialDetection !== 'deferred') {
      yield* scheduler.detectAll;
    }
    if (
      options.initialPublicationOrder !== 'before-collection' &&
      options.initialPublicationOrder !== 'externally-published'
    ) {
      yield* scheduler.requestPublication;
    }
    yield* startSourceControlWorkers(runtime, scheduler, validatedOptions.workerCount);
    return {
      changes: Stream.map(runtime.stateRef.changes, sourceControlView),
      detectAll: scheduler.detectAll,
      detectSource: scheduler.detectSource,
      getSnapshot: SubscriptionRef.get(runtime.stateRef).pipe(Effect.map(sourceControlView)),
      requestPublication: scheduler.requestPublication,
      stopAutonomousCollection,
      ...commands,
    };
  });

export const sourceControlLayer = (
  options: SourceControlOptions,
): Layer.Layer<SourceControl, never, WideEventResourceService | WideEventSink> =>
  Layer.scoped(SourceControl, createSourceControl(options));
