import { randomUUID } from 'node:crypto';
import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  type SourceControlView,
  type SourcePolicyOverrides,
  type SourceProgress,
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
  type InternalControlState,
  type InternalSourceState,
  initialSourceControlState,
  lifecycleAfterDetection,
  lifecycleAfterPolicyChange,
  lifecycleForIdleSource,
  outcomeAfterRun,
  reasonAfterCompletion,
  reasonForAvailability,
  type SourceExecutionCompletion,
  sanitizeCount,
  sanitizeProgress,
  sanitizeWarnings,
  sourceControlView,
  sourceNeedsRtk,
  toIso,
  withSourceState,
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

interface SourceJob {
  readonly _tag: 'source';
  readonly policyRevision: number;
  readonly queuedAt: number;
  readonly sourceId: CollectionSourceId;
}

interface PublicationJob {
  readonly _tag: 'publication';
  readonly queuedAt: number;
}

type ControlPlaneJob = PublicationJob | SourceJob;

interface SourceStartDecision {
  readonly rtkTargetGeneration: number;
  readonly run: boolean;
  readonly staleRequeue: boolean;
  readonly startedAt: number;
}

type PublicationStartDecision =
  | { readonly ready: false }
  | {
      readonly dataTarget: number;
      readonly ready: true;
      readonly requestTarget: number;
      readonly startedAt: number;
    };

export const createSourceControl = (
  options: SourceControlOptions,
): Effect.Effect<SourceControlService, never, import('effect').Scope.Scope> =>
  Effect.gen(function* () {
    const workerCount = options.workerCount ?? 1;
    if (!(Number.isSafeInteger(workerCount) && workerCount > 0 && workerCount <= 8)) {
      return yield* Effect.die(new Error('Source control workerCount must be an integer from 1 through 8.'));
    }
    const sourceTimeout = Duration.decode(options.sourceTimeout ?? Duration.minutes(10));
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
      update: (state: InternalControlState, modifiedAt: number) => readonly [A, InternalControlState],
    ): Effect.Effect<A> =>
      Effect.gen(function* () {
        const modifiedAt = yield* Clock.currentTimeMillis;
        return yield* SubscriptionRef.modify(stateRef, (state) => {
          const [value, next] = update(state, modifiedAt);
          if (next === state) {
            return [value, state] as const;
          }
          return [
            value,
            {
              ...next,
              generatedAt: toIso(modifiedAt),
              generation: state.generation + 1,
            },
          ] as const;
        });
      });

    const enqueueSource = (sourceId: CollectionSourceId): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const queued = yield* modifyState((state, queuedAt) => {
          const source = state.sources[sourceId];
          if (
            !(options.sources.has(sourceId) && source.enabled) ||
            source.availability !== 'detected' ||
            source.queued ||
            source.running
          ) {
            return [undefined, state] as const;
          }
          const job: SourceJob = {
            _tag: 'source',
            policyRevision: source.policyRevision,
            queuedAt,
            sourceId,
          };
          return [
            job,
            withSourceState({ ...state, queueDepth: state.queueDepth + 1 }, sourceId, (current) => {
              const { nextDueAt: _nextDueAt, ...rest } = current;
              return {
                ...rest,
                lifecycle: 'queued',
                queued: true,
                reason: { code: 'none' },
              };
            }),
          ] as const;
        });
        if (!queued) {
          return false;
        }
        yield* queue.offer(queued);
        return true;
      });

    const ensurePublicationQueued: Effect.Effect<boolean> = Effect.gen(function* () {
      const job = yield* modifyState((state, queuedAt) => {
        if (state.publication.queued || state.publication.running) {
          return [undefined, state] as const;
        }
        return [
          { _tag: 'publication', queuedAt } satisfies PublicationJob,
          {
            ...state,
            publication: { ...state.publication, queued: true },
            queueDepth: state.queueDepth + 1,
          },
        ] as const;
      });
      if (!job) {
        return false;
      }
      yield* queue.offer(job);
      return true;
    });

    const requestPublication: Effect.Effect<boolean> = Effect.gen(function* () {
      const shouldQueue = yield* modifyState((state) => [
        !(state.publication.queued || state.publication.running),
        {
          ...state,
          publication: {
            ...state.publication,
            requestedGeneration: state.publication.requestedGeneration + 1,
          },
        },
      ]);
      if (shouldQueue) {
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
        const scheduled = yield* modifyState((state) => {
          const current = state.sources[sourceId];
          if (!current.enabled || current.availability !== 'detected' || current.queued || current.running) {
            return [false, state] as const;
          }
          return [
            true,
            withSourceState(state, sourceId, (entry) => ({
              ...entry,
              lifecycle: 'scheduled',
              nextDueAt: toIso(dueAt),
            })),
          ] as const;
        });
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
        const shouldCancel = result.availability !== 'detected';
        if (shouldCancel) {
          yield* FiberMap.remove(timers, sourceId);
        }
        const shouldQueue = yield* modifyState((state) => {
          const current = state.sources[sourceId];
          const lifecycle = lifecycleAfterDetection(current, result.availability);
          const next = withSourceState(state, sourceId, (entry) => {
            const { nextDueAt: _nextDueAt, ...entryWithoutDueAt } = entry;
            return {
              ...(shouldCancel ? entryWithoutDueAt : entry),
              availability: result.availability,
              lifecycle,
              reason: entry.enabled ? result.reason : { code: 'policy-disabled', message: 'Collection is disabled.' },
            };
          });
          return [
            current.enabled && result.availability === 'detected' && !current.queued && !current.running,
            next,
          ] as const;
        });
        if (shouldQueue) {
          yield* enqueueSource(sourceId);
        }
      });

    const detectAll: Effect.Effect<void> = Effect.forEach(sourceIds, runDetection, {
      concurrency: 1,
      discard: true,
    });

    const beginSourceJob = (job: SourceJob): Effect.Effect<SourceStartDecision> =>
      modifyState<SourceStartDecision>((state, startedAt) => {
        const source = state.sources[job.sourceId];
        const valid =
          source.queued &&
          source.enabled &&
          source.availability === 'detected' &&
          source.policyRevision === job.policyRevision;
        const queueDepth = Math.max(0, state.queueDepth - 1);
        if (!valid) {
          const staleRequeue =
            source.enabled && source.availability === 'detected' && source.policyRevision !== job.policyRevision;
          return [
            {
              rtkTargetGeneration: state.rtkRequiredGeneration,
              run: false,
              staleRequeue,
              startedAt,
            },
            withSourceState({ ...state, queueDepth }, job.sourceId, (entry) => ({
              ...entry,
              lastOutcome: 'skipped',
              lifecycle: lifecycleForIdleSource(entry),
              queued: false,
              reason: entry.enabled
                ? { code: 'stale-policy', message: 'A stale queued job was skipped.' }
                : { code: 'policy-disabled', message: 'Collection is disabled.' },
            })),
          ] as const;
        }
        return [
          {
            rtkTargetGeneration: state.rtkRequiredGeneration,
            run: true,
            staleRequeue: false,
            startedAt,
          },
          withSourceState({ ...state, queueDepth }, job.sourceId, (entry) => {
            const { progress: _progress, ...rest } = entry;
            return {
              ...rest,
              lastStartedAt: toIso(startedAt),
              lifecycle: 'running',
              queueDelayMs: Math.max(0, startedAt - job.queuedAt),
              queued: false,
              reason: { code: 'none' },
              running: true,
              warnings: [],
            };
          }),
        ] as const;
      });

    const updateProgress = (sourceId: CollectionSourceId, progress: SourceProgress): Effect.Effect<void> =>
      modifyState((state) => {
        const source = state.sources[sourceId];
        if (!source.running) {
          return [undefined, state] as const;
        }
        return [
          undefined,
          withSourceState(state, sourceId, (entry) => ({
            ...entry,
            progress: sanitizeProgress(progress),
          })),
        ] as const;
      });

    const completeSource = (
      job: SourceJob,
      startedAt: number,
      rtkTargetGeneration: number,
      completion: SourceExecutionCompletion,
    ): Effect.Effect<{
      changed: boolean;
      detected: boolean;
      enabled: boolean;
      needsPublicationRequest: boolean;
      needsPublicationWake: boolean;
      needsRtk: boolean;
      needsRtkRerun: boolean;
    }> =>
      modifyState((state, finishedAt) => {
        const source = state.sources[job.sourceId];
        const result = completion._tag === 'success' ? completion.result : undefined;
        const failed = completion._tag === 'failed';
        const unavailable = result?.unavailable;
        const warnings = result ? sanitizeWarnings(result.warnings) : [];
        const availability = unavailable ? 'not-detected' : source.availability;
        const lastOutcome = outcomeAfterRun(completion, unavailable, warnings.length);
        const changed = result?.changed === true && !unavailable;
        let dirtyGeneration = state.publication.dirtyGeneration;
        let rtkRequiredGeneration = state.rtkRequiredGeneration;
        let rtkCompletedGeneration = state.rtkCompletedGeneration;
        const rtkAvailable = state.sources['rtk.savings'];
        const needsRtk =
          changed && sourceNeedsRtk(job.sourceId) && rtkAvailable.enabled && rtkAvailable.availability === 'detected';
        if (changed) {
          dirtyGeneration++;
          if (needsRtk) {
            rtkRequiredGeneration = dirtyGeneration;
          }
        }
        if (job.sourceId === 'rtk.savings') {
          rtkCompletedGeneration = Math.max(rtkCompletedGeneration, rtkTargetGeneration);
        }
        const releasedRtkDependency =
          job.sourceId === 'rtk.savings' &&
          state.rtkRequiredGeneration > state.rtkCompletedGeneration &&
          rtkCompletedGeneration >= state.rtkRequiredGeneration;
        const { progress: _progress, ...sourceWithoutProgress } = source;
        const nextSource: InternalSourceState = {
          ...sourceWithoutProgress,
          availability,
          durationMs: Math.max(0, finishedAt - startedAt),
          lastFinishedAt: toIso(finishedAt),
          lastOutcome,
          lifecycle: source.enabled && availability === 'detected' ? 'scheduled' : 'dormant',
          reason: reasonAfterCompletion(completion, unavailable, source.enabled),
          running: false,
          warnings,
          ...(result === undefined
            ? {}
            : {
                inputCount: sanitizeCount(result.inputCount),
                outputCount: sanitizeCount(result.outputCount),
              }),
          ...(failed || unavailable ? {} : { lastSuccessAt: toIso(finishedAt) }),
        };
        const nextState = withSourceState(
          {
            ...state,
            publication: { ...state.publication, dirtyGeneration },
            rtkCompletedGeneration,
            rtkRequiredGeneration,
          },
          job.sourceId,
          () => nextSource,
        );
        return [
          {
            changed,
            detected: availability === 'detected',
            enabled: source.enabled,
            needsPublicationRequest: changed,
            needsPublicationWake: releasedRtkDependency,
            needsRtk,
            needsRtkRerun: job.sourceId === 'rtk.savings' && rtkRequiredGeneration > rtkCompletedGeneration,
          },
          nextState,
        ] as const;
      });

    const processSourceJob = (job: SourceJob): Effect.Effect<void> =>
      Effect.gen(function* () {
        const decision = yield* beginSourceJob(job);
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
        const completed = yield* completeSource(job, decision.startedAt, decision.rtkTargetGeneration, completion);
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

    const beginPublication = (): Effect.Effect<PublicationStartDecision> =>
      modifyState<PublicationStartDecision>((state, startedAt) => {
        const queueDepth = Math.max(0, state.queueDepth - 1);
        const rtk = state.sources['rtk.savings'];
        const waitingForRtk =
          rtk.enabled && rtk.availability === 'detected' && state.rtkRequiredGeneration > state.rtkCompletedGeneration;
        if (waitingForRtk) {
          return [
            { ready: false },
            {
              ...state,
              publication: { ...state.publication, queued: false },
              queueDepth,
            },
          ] as const;
        }
        return [
          {
            ready: true,
            startedAt,
            dataTarget: state.publication.dirtyGeneration,
            requestTarget: state.publication.requestedGeneration,
          },
          {
            ...state,
            publication: { ...state.publication, queued: false, running: true },
            queueDepth,
          },
        ] as const;
      });

    const finishPublication = (
      startedAt: number,
      requestTarget: number,
      dataTarget: number,
      result: ReportPublicationResult | undefined,
    ): Effect.Effect<boolean> =>
      modifyState((state, finishedAt) => {
        const publishedGeneration = result
          ? Math.max(state.publication.publishedGeneration, dataTarget)
          : state.publication.publishedGeneration;
        const acknowledgedRequestGeneration = result
          ? Math.max(state.publication.acknowledgedRequestGeneration, requestTarget)
          : state.publication.acknowledgedRequestGeneration;
        const pending =
          state.publication.dirtyGeneration > publishedGeneration ||
          state.publication.requestedGeneration > acknowledgedRequestGeneration;
        return [
          pending,
          {
            ...state,
            publication: {
              ...state.publication,
              acknowledgedRequestGeneration,
              lastDurationMs: Math.max(0, finishedAt - startedAt),
              lastOutcome: result ? 'success' : 'failed',
              publishedGeneration,
              running: false,
              ...(result
                ? {
                    lastPublishedAt: toIso(finishedAt),
                    ...(result.revision === undefined ? {} : { revision: result.revision }),
                  }
                : {}),
            },
          },
        ] as const;
      });

    const processPublicationJob: Effect.Effect<void> = Effect.gen(function* () {
      const decision = yield* beginPublication();
      if (!decision.ready) {
        return;
      }
      const result = yield* options.publication.publish.pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (value) => value,
        }),
      );
      const remainsPending = yield* finishPublication(
        decision.startedAt,
        decision.requestTarget,
        decision.dataTarget,
        result,
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
        const shouldQueue = yield* modifyState((state) => {
          const current = state.sources[sourceId];
          if (current.enabled === enabled) {
            return [false, state] as const;
          }
          const next = withSourceState(state, sourceId, (entry) => {
            const { nextDueAt: _nextDueAt, ...entryWithoutDueAt } = entry;
            return {
              ...(enabled ? entry : entryWithoutDueAt),
              enabled,
              lifecycle: lifecycleAfterPolicyChange(entry, enabled),
              policyRevision: entry.policyRevision + 1,
              reason: enabled
                ? reasonForAvailability(entry.availability)
                : { code: 'policy-disabled', message: 'Collection is disabled.' },
            };
          });
          return [enabled && current.availability === 'detected' && !current.queued && !current.running, next] as const;
        });
        if (shouldQueue) {
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
