import { randomUUID } from 'node:crypto';
import {
  annotateWideEvent,
  type BoundaryClassification,
  classifyExit,
  type LogValue,
  runBoundaryEffect,
  type WideEventService,
  type WideEventSink,
  withMeasured,
} from '@ai-usage/effect-runtime';
import {
  type CollectionSourceId,
  type SourceControlView,
  type SourcePolicyOverrides,
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
  type StateTransition,
  scheduleSourceTransition,
  setSourcePolicyTransition,
  sourceControlView,
  startPublicationJobTransition,
  startSourceJobTransition,
  updateSourceProgressTransition,
} from './source-control-state';

export interface SourcePolicyStore {
  readonly load: Effect.Effect<SourcePolicyOverrides, unknown>;
  readonly setEnabled: (sourceId: CollectionSourceId, enabled: boolean) => Effect.Effect<void, unknown>;
}

export interface ReportPublicationResult {
  readonly changed: boolean;
  readonly revision?: string;
}

export interface ReportPublicationPort {
  readonly publish: Effect.Effect<ReportPublicationResult, unknown>;
}

export interface SourceControlOptions {
  readonly instanceId?: string;
  readonly policyStore: SourcePolicyStore;
  readonly publication: ReportPublicationPort;
  readonly sources: ReadonlyMap<CollectionSourceId, ScheduledSource>;
  readonly sourceTimeout?: Duration.DurationInput;
  readonly workerCount?: number;
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
  readonly getSnapshot: Effect.Effect<SourceControlView>;
  readonly requestPublication: Effect.Effect<boolean>;
  readonly runAllEnabled: Effect.Effect<number>;
  readonly runNow: (sourceId: CollectionSourceId) => Effect.Effect<boolean, SourceControlCommandError>;
  readonly setEnabled: (
    sourceId: CollectionSourceId,
    enabled: boolean,
  ) => Effect.Effect<void, SourceControlCommandError>;
}

export class SourceControl extends Context.Tag('@ai-usage/report-data/SourceControl')<
  SourceControl,
  SourceControlService
>() {}

type ControlPlaneJob = PublicationJob | SourceJob;

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_SOURCE_TIMEOUT = Duration.minutes(10);

interface ValidatedSourceControlOptions {
  readonly sourceTimeout: Duration.Duration;
  readonly workerCount: number;
}

interface SourceControlRuntime {
  readonly options: SourceControlOptions;
  readonly queue: Queue.Queue<ControlPlaneJob>;
  readonly sourceIds: readonly CollectionSourceId[];
  readonly sourceTimeout: Duration.Duration;
  readonly stateRef: SubscriptionRef.SubscriptionRef<InternalControlState>;
  readonly timers: FiberMap.FiberMap<CollectionSourceId>;
}

interface SourceControlScheduler {
  readonly detectAll: Effect.Effect<void>;
  readonly enqueueSource: (sourceId: CollectionSourceId) => Effect.Effect<boolean>;
  readonly ensurePublicationQueued: Effect.Effect<boolean>;
  readonly requestPublication: Effect.Effect<boolean>;
  readonly scheduleCadence: (sourceId: CollectionSourceId) => Effect.Effect<void>;
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
    const now = yield* Clock.currentTimeMillis;
    const sourceIds = [...options.sources.keys()];
    const stateRef = yield* SubscriptionRef.make(
      initialSourceControlState(options.instanceId ?? randomUUID(), sourceIds, policies, now),
    );
    const queue = yield* Queue.bounded<ControlPlaneJob>(sourceControlBounds.maxQueueDepth);
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const timers = yield* FiberMap.make<CollectionSourceId>();
    return { options, queue, sourceIds, sourceTimeout, stateRef, timers };
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
  const enqueueSource = (sourceId: CollectionSourceId): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const queued = yield* modifyControlState(runtime, (state, queuedAt) =>
        admitSourceJob(state, sourceId, runtime.options.sources.has(sourceId), queuedAt),
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

  const scheduleCadence = (sourceId: CollectionSourceId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const source = runtime.options.sources.get(sourceId);
      if (!source) {
        return;
      }
      const currentTime = yield* Clock.currentTimeMillis;
      const dueAt = currentTime + Duration.toMillis(source.cadence);
      const scheduled = yield* modifyControlState(runtime, (state, modifiedAt) =>
        scheduleSourceTransition(state, sourceId, dueAt, modifiedAt),
      );
      if (!scheduled) {
        return;
      }
      yield* FiberMap.run(
        runtime.timers,
        sourceId,
        Effect.sleep(source.cadence).pipe(
          Effect.flatMap(() => enqueueSource(sourceId)),
          Effect.asVoid,
        ),
      );
    });

  const runDetection = (sourceId: CollectionSourceId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const source = runtime.options.sources.get(sourceId);
      if (!source) {
        return;
      }
      const result = yield* source.detect;
      const decision = yield* modifyControlState(runtime, (state, modifiedAt) =>
        applyDetectionTransition(state, sourceId, result, modifiedAt),
      );
      if (decision.cancelTimer) {
        yield* FiberMap.remove(runtime.timers, sourceId);
      }
      if (decision.shouldQueue) {
        yield* enqueueSource(sourceId);
      }
    });

  return {
    detectAll: Effect.forEach(runtime.sourceIds, runDetection, { concurrency: 1, discard: true }),
    enqueueSource,
    ensurePublicationQueued,
    requestPublication,
    scheduleCadence,
  };
};

const sourceRunAnnotations = (
  completion: SourceExecutionCompletion,
  changed: boolean,
): Readonly<Record<string, LogValue>> => {
  const result = completion._tag === 'success' ? completion.result : undefined;
  const domainOutcome = outcomeAfterRun(completion, result?.unavailable, result?.warnings.length ?? 0);
  return {
    changed,
    domainOutcome,
    ...(result === undefined
      ? {}
      : { inputCount: result.inputCount, outputCount: result.outputCount, warningsCount: result.warnings.length }),
  };
};

const classifySourceRunOutcome = (exit: Exit.Exit<SourceExecutionCompletion, never>): BoundaryClassification => {
  if (Exit.isFailure(exit)) {
    return classifyExit(exit);
  }
  const completion = exit.value;
  if (completion._tag === 'timed-out') {
    return { outcome: 'timed-out' };
  }
  if (completion._tag === 'failed') {
    return { outcome: 'failure' };
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
): Effect.Effect<SourceExecutionCompletion, never, WideEventService> =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const completion = yield* source
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
          onFailure: (): SourceExecutionCompletion => ({ _tag: 'failed' }),
          onSuccess: (value): SourceExecutionCompletion =>
            Option.isNone(value) ? { _tag: 'timed-out' } : { _tag: 'success', result: value.value },
        }),
      );
    if (completion._tag === 'timed-out') {
      controller.abort();
    }
    const completed: SourceFinishDecision = yield* modifyControlState(runtime, (state, finishedAt) =>
      finishSourceJobTransition(state, job, decision.startedAt, decision.rtkTargetGeneration, completion, finishedAt),
    );
    yield* annotateWideEvent(sourceRunAnnotations(completion, completed.changed));
    if (completed.needsRtk || completed.needsRtkRerun) {
      yield* scheduler.enqueueSource('rtk.savings');
    }
    if (completed.needsPublicationRequest) {
      yield* scheduler.requestPublication;
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
): Effect.Effect<void, never, WideEventSink> =>
  Effect.gen(function* () {
    const decision = yield* modifyControlState(runtime, (state, startedAt) =>
      startSourceJobTransition(state, job, startedAt),
    );
    if (!decision.run) {
      if (decision.staleRequeue) {
        yield* scheduler.enqueueSource(job.sourceId);
      }
      return;
    }
    const source = runtime.options.sources.get(job.sourceId);
    if (!source) {
      return;
    }
    yield* runBoundaryEffect(
      {
        boundary: 'source.run',
        annotations: { sourceId: job.sourceId },
        classify: classifySourceRunOutcome,
      },
      runSourceJobBody(runtime, scheduler, job, source, decision),
    );
  });

const classifyPublicationOutcome = (
  exit: Exit.Exit<ReportPublicationResult | undefined, never>,
): BoundaryClassification => {
  if (Exit.isFailure(exit)) {
    return classifyExit(exit);
  }
  return { outcome: exit.value === undefined ? 'failure' : 'success' };
};

const runPublicationJobBody = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
  decision: { readonly dataTarget: number; readonly requestTarget: number; readonly startedAt: number },
): Effect.Effect<ReportPublicationResult | undefined, never, WideEventService> =>
  Effect.gen(function* () {
    const result = yield* runtime.options.publication.publish.pipe(
      withMeasured('publication.publish'),
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (value) => value,
      }),
    );
    if (result?.revision !== undefined) {
      yield* annotateWideEvent({ revision: result.revision });
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
): Effect.Effect<void, never, WideEventSink> =>
  Effect.gen(function* () {
    const decision = yield* modifyControlState(runtime, startPublicationJobTransition);
    if (!decision.ready) {
      return;
    }
    yield* runBoundaryEffect(
      { boundary: 'publication', classify: classifyPublicationOutcome },
      runPublicationJobBody(runtime, scheduler, decision),
    );
  });

const startSourceControlWorkers = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
  workerCount: number,
): Effect.Effect<void, never, import('effect').Scope.Scope | WideEventSink> =>
  Effect.gen(function* () {
    const processJob = (job: ControlPlaneJob): Effect.Effect<void, never, WideEventSink> =>
      job._tag === 'source' ? processSourceJob(runtime, scheduler, job) : processPublicationJob(runtime, scheduler);
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
      yield* Effect.forkScoped(Effect.forever(runtime.queue.take.pipe(Effect.flatMap(processJob))));
    }
  });

const createSourceControlCommands = (
  runtime: SourceControlRuntime,
  scheduler: SourceControlScheduler,
): Pick<SourceControlService, 'runAllEnabled' | 'runNow' | 'setEnabled'> => {
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
      return yield* scheduler.enqueueSource(sourceId);
    });

  const runAllEnabled: Effect.Effect<number> = Effect.gen(function* () {
    let queuedCount = 0;
    for (const sourceId of runtime.sourceIds) {
      const state = (yield* SubscriptionRef.get(runtime.stateRef)).sources[sourceId];
      if (!(state.enabled && state.availability === 'detected' && !state.queued && !state.running)) {
        continue;
      }
      yield* FiberMap.remove(runtime.timers, sourceId);
      if (yield* scheduler.enqueueSource(sourceId)) {
        queuedCount++;
      }
    }
    return queuedCount;
  });

  const setEnabled = (sourceId: CollectionSourceId, enabled: boolean): Effect.Effect<void, SourceControlCommandError> =>
    Effect.gen(function* () {
      if (!runtime.options.sources.has(sourceId)) {
        return yield* Effect.fail(
          new SourceControlCommandError({ message: 'Unknown collection source.', reason: 'unknown-source', sourceId }),
        );
      }
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
      if (!enabled) {
        yield* FiberMap.remove(runtime.timers, sourceId);
      }
      const decision = yield* modifyControlState(runtime, (state, modifiedAt) =>
        setSourcePolicyTransition(state, sourceId, enabled, modifiedAt),
      );
      if (decision.shouldQueue) {
        yield* scheduler.enqueueSource(sourceId);
      }
    });

  return { runAllEnabled, runNow, setEnabled };
};

export const createSourceControl = (
  options: SourceControlOptions,
): Effect.Effect<SourceControlService, never, import('effect').Scope.Scope | WideEventSink> =>
  Effect.gen(function* () {
    const validatedOptions = yield* validateSourceControlOptions(options);
    const runtime = yield* createSourceControlRuntime(options, validatedOptions.sourceTimeout);
    const scheduler = createSourceControlScheduler(runtime);
    const commands = createSourceControlCommands(runtime, scheduler);
    yield* scheduler.detectAll;
    yield* scheduler.requestPublication;
    yield* startSourceControlWorkers(runtime, scheduler, validatedOptions.workerCount);
    return {
      changes: Stream.map(runtime.stateRef.changes, sourceControlView),
      detectAll: scheduler.detectAll,
      getSnapshot: SubscriptionRef.get(runtime.stateRef).pipe(Effect.map(sourceControlView)),
      requestPublication: scheduler.requestPublication,
      ...commands,
    };
  });

export const sourceControlLayer = (options: SourceControlOptions): Layer.Layer<SourceControl, never, WideEventSink> =>
  Layer.scoped(SourceControl, createSourceControl(options));
