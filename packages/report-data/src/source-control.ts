import { randomUUID } from 'node:crypto';
import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  type SourceControlView,
  type SourcePolicyOverrides,
  type SourceProgress,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
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
  type PublicationJob,
  requestPublicationTransition,
  type SourceExecutionCompletion,
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

export const createSourceControl = (
  options: SourceControlOptions,
): Effect.Effect<SourceControlService, never, import('effect').Scope.Scope> =>
  Effect.gen(function* () {
    const workerCount = options.workerCount ?? 1;
    if (!(Number.isSafeInteger(workerCount) && workerCount > 0 && workerCount <= 8)) {
      return yield* Effect.die(new Error('Source control workerCount must be an integer from 1 through 8.'));
    }
    const sourceTimeout = Duration.decode(options.sourceTimeout ?? Duration.minutes(10));
    const sourceTimeoutMs = Duration.toMillis(sourceTimeout);
    if (!(sourceTimeoutMs > 0 && sourceTimeoutMs <= sourceControlBounds.maxDurationMs)) {
      return yield* Effect.die(new Error('Source control timeout must be positive and no longer than 24 hours.'));
    }
    const policies = yield* options.policyStore.load.pipe(Effect.orDie);
    const now = yield* Clock.currentTimeMillis;
    const sourceIds = [...options.sources.keys()];
    const stateRef = yield* SubscriptionRef.make(
      initialSourceControlState(options.instanceId ?? randomUUID(), sourceIds, policies, now),
    );
    const queue = yield* Queue.bounded<ControlPlaneJob>(collectionSourceDefinitions.length * 3 + 3);
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const timers = yield* FiberMap.make<CollectionSourceId>();

    const modifyState = <A>(
      update: (state: InternalControlState, modifiedAt: number) => StateTransition<A>,
    ): Effect.Effect<A> =>
      Effect.gen(function* () {
        const modifiedAt = yield* Clock.currentTimeMillis;
        return yield* SubscriptionRef.modify(stateRef, (state) => {
          const result = update(state, modifiedAt);
          return [result.decision, result.state] as const;
        });
      });

    const enqueueSource = (sourceId: CollectionSourceId): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const queued = yield* modifyState((state, queuedAt) =>
          admitSourceJob(state, sourceId, options.sources.has(sourceId), queuedAt),
        );
        if (!queued) {
          return false;
        }
        yield* queue.offer(queued);
        return true;
      });

    const ensurePublicationQueued: Effect.Effect<boolean> = Effect.gen(function* () {
      const job = yield* modifyState(admitPublicationJob);
      if (!job) {
        return false;
      }
      yield* queue.offer(job);
      return true;
    });

    const requestPublication: Effect.Effect<boolean> = Effect.gen(function* () {
      const decision = yield* modifyState(requestPublicationTransition);
      if (decision.shouldQueue) {
        yield* ensurePublicationQueued;
      }
      return true;
    });

    const scheduleCadence = (sourceId: CollectionSourceId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const source = options.sources.get(sourceId);
        if (!source) {
          return;
        }
        const currentTime = yield* Clock.currentTimeMillis;
        const dueAt = currentTime + Duration.toMillis(source.cadence);
        const scheduled = yield* modifyState((state, modifiedAt) =>
          scheduleSourceTransition(state, sourceId, dueAt, modifiedAt),
        );
        if (!scheduled) {
          return;
        }
        yield* FiberMap.run(
          timers,
          sourceId,
          Effect.sleep(source.cadence).pipe(
            Effect.flatMap(() => enqueueSource(sourceId)),
            Effect.asVoid,
          ),
        );
      });

    const runDetection = (sourceId: CollectionSourceId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const source = options.sources.get(sourceId);
        if (!source) {
          return;
        }
        const result = yield* source.detect;
        const decision = yield* modifyState((state, modifiedAt) =>
          applyDetectionTransition(state, sourceId, result, modifiedAt),
        );
        if (decision.cancelTimer) {
          yield* FiberMap.remove(timers, sourceId);
        }
        if (decision.shouldQueue) {
          yield* enqueueSource(sourceId);
        }
      });

    const detectAll: Effect.Effect<void> = Effect.forEach(sourceIds, runDetection, {
      concurrency: 1,
      discard: true,
    });

    const updateProgress = (sourceId: CollectionSourceId, progress: SourceProgress): Effect.Effect<void> =>
      modifyState((state, modifiedAt) => updateSourceProgressTransition(state, sourceId, progress, modifiedAt));

    const processSourceJob = (job: SourceJob): Effect.Effect<void> =>
      Effect.gen(function* () {
        const decision = yield* modifyState((state, startedAt) => startSourceJobTransition(state, job, startedAt));
        if (!decision.run) {
          if (decision.staleRequeue) {
            yield* enqueueSource(job.sourceId);
          }
          return;
        }
        const source = options.sources.get(job.sourceId);
        if (!source) {
          return;
        }
        const controller = new AbortController();
        const completion = yield* source
          .run({
            reportProgress: (progress) => updateProgress(job.sourceId, progress),
            signal: controller.signal,
          })
          .pipe(
            Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
            Effect.timeoutOption(sourceTimeout),
            Effect.match({
              onFailure: (): SourceExecutionCompletion => ({ _tag: 'failed' }),
              onSuccess: (value): SourceExecutionCompletion =>
                Option.isNone(value) ? { _tag: 'timed-out' } : { _tag: 'success', result: value.value },
            }),
          );
        if (completion._tag === 'timed-out') {
          controller.abort();
        }
        const completed = yield* modifyState((state, finishedAt) =>
          finishSourceJobTransition(
            state,
            job,
            decision.startedAt,
            decision.rtkTargetGeneration,
            completion,
            finishedAt,
          ),
        );
        if (completed.needsRtk || completed.needsRtkRerun) {
          yield* enqueueSource('rtk.savings');
        }
        if (completed.needsPublicationRequest) {
          yield* requestPublication;
        }
        if (completed.needsPublicationWake) {
          yield* ensurePublicationQueued;
        }
        if (completed.enabled && completed.detected) {
          yield* scheduleCadence(job.sourceId);
        } else {
          yield* FiberMap.remove(timers, job.sourceId);
        }
      });

    const processPublicationJob: Effect.Effect<void> = Effect.gen(function* () {
      const decision = yield* modifyState(startPublicationJobTransition);
      if (!decision.ready) {
        return;
      }
      const result = yield* options.publication.publish.pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (value) => value,
        }),
      );
      const remainsPending = yield* modifyState((state, finishedAt) =>
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
        yield* ensurePublicationQueued;
      }
    });

    const processJob = (job: ControlPlaneJob): Effect.Effect<void> =>
      job._tag === 'source' ? processSourceJob(job) : processPublicationJob;

    yield* detectAll;
    yield* requestPublication;
    for (let index = 0; index < workerCount; index++) {
      yield* Effect.forkScoped(Effect.forever(queue.take.pipe(Effect.flatMap(processJob))));
    }

    const runNow = (sourceId: CollectionSourceId): Effect.Effect<boolean, SourceControlCommandError> =>
      Effect.gen(function* () {
        if (!options.sources.has(sourceId)) {
          return yield* Effect.fail(
            new SourceControlCommandError({
              message: 'Unknown collection source.',
              reason: 'unknown-source',
              sourceId,
            }),
          );
        }
        const current = (yield* SubscriptionRef.get(stateRef)).sources[sourceId];
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
        yield* FiberMap.remove(timers, sourceId);
        return yield* enqueueSource(sourceId);
      });

    const runAllEnabled: Effect.Effect<number> = Effect.gen(function* () {
      let queued = 0;
      for (const sourceId of sourceIds) {
        const state = (yield* SubscriptionRef.get(stateRef)).sources[sourceId];
        if (!(state.enabled && state.availability === 'detected' && !state.queued && !state.running)) {
          continue;
        }
        yield* FiberMap.remove(timers, sourceId);
        if (yield* enqueueSource(sourceId)) {
          queued++;
        }
      }
      return queued;
    });

    const setEnabled = (
      sourceId: CollectionSourceId,
      enabled: boolean,
    ): Effect.Effect<void, SourceControlCommandError> =>
      Effect.gen(function* () {
        if (!options.sources.has(sourceId)) {
          return yield* Effect.fail(
            new SourceControlCommandError({
              message: 'Unknown collection source.',
              reason: 'unknown-source',
              sourceId,
            }),
          );
        }
        yield* options.policyStore.setEnabled(sourceId, enabled).pipe(
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
          yield* FiberMap.remove(timers, sourceId);
        }
        const decision = yield* modifyState((state, modifiedAt) =>
          setSourcePolicyTransition(state, sourceId, enabled, modifiedAt),
        );
        if (decision.shouldQueue) {
          yield* enqueueSource(sourceId);
        }
      });

    return {
      changes: Stream.map(stateRef.changes, sourceControlView),
      detectAll,
      getSnapshot: SubscriptionRef.get(stateRef).pipe(Effect.map(sourceControlView)),
      requestPublication,
      runAllEnabled,
      runNow,
      setEnabled,
    };
  });

export const sourceControlLayer = (options: SourceControlOptions): Layer.Layer<SourceControl> =>
  Layer.scoped(SourceControl, createSourceControl(options));
