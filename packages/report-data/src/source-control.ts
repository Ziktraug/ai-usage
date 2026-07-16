import { randomUUID } from 'node:crypto';
import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  getCollectionSourceDefinition,
  resolveSourceEnabled,
  type SourceAvailability,
  type SourceControlEntryView,
  type SourceControlView,
  type SourceLastOutcome,
  type SourceLifecycle,
  type SourcePolicyOverrides,
  type SourceProgress,
  type SourceReason,
  type SourceRunResult,
  type SourceWarning,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import { Clock, Context, Data, Duration, Effect, FiberMap, Layer, Queue, Stream, SubscriptionRef } from 'effect';
import type { ScheduledSource } from './source-adapters';

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

interface InternalSourceState {
  readonly availability: SourceAvailability;
  readonly durationMs?: number;
  readonly enabled: boolean;
  readonly inputCount?: number;
  readonly lastFinishedAt?: string;
  readonly lastOutcome: SourceLastOutcome;
  readonly lastStartedAt?: string;
  readonly lastSuccessAt?: string;
  readonly lifecycle: SourceLifecycle;
  readonly nextDueAt?: string;
  readonly outputCount?: number;
  readonly policyRevision: number;
  readonly progress?: SourceProgress;
  readonly queueDelayMs?: number;
  readonly queued: boolean;
  readonly reason: SourceReason;
  readonly running: boolean;
  readonly warnings: readonly SourceWarning[];
}

interface InternalPublicationState {
  readonly dirtyGeneration: number;
  readonly lastDurationMs?: number;
  readonly lastPublishedAt?: string;
  readonly publishedGeneration: number;
  readonly queued: boolean;
  readonly revision?: string;
  readonly running: boolean;
}

interface InternalControlState {
  readonly generatedAt: string;
  readonly generation: number;
  readonly instanceId: string;
  readonly publication: InternalPublicationState;
  readonly queueDepth: number;
  readonly rtkCompletedGeneration: number;
  readonly rtkRequiredGeneration: number;
  readonly sources: Readonly<Record<CollectionSourceId, InternalSourceState>>;
}

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
  | { readonly ready: true; readonly startedAt: number; readonly target: number };

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const lifecycleForIdleSource = (state: InternalSourceState): SourceLifecycle =>
  state.enabled && state.availability === 'detected' ? 'scheduled' : 'dormant';

const lifecycleAfterDetection = (source: InternalSourceState, availability: SourceAvailability): SourceLifecycle => {
  if (source.running) {
    return source.enabled ? 'running' : 'pausing';
  }
  if (source.queued) {
    return source.lifecycle;
  }
  return source.enabled && availability === 'detected' ? 'scheduled' : 'dormant';
};

const outcomeAfterRun = (
  failed: boolean,
  unavailable: SourceReason | undefined,
  warningCount: number,
): SourceLastOutcome => {
  if (failed) {
    return 'failed';
  }
  if (unavailable) {
    return 'skipped';
  }
  return warningCount > 0 ? 'warning' : 'success';
};

const reasonAfterRun = (failed: boolean, unavailable: SourceReason | undefined, enabled: boolean): SourceReason => {
  if (failed) {
    return { code: 'run-failed', message: 'The source run failed; previously stored data was preserved.' };
  }
  if (unavailable) {
    return unavailable;
  }
  return enabled ? { code: 'none' } : { code: 'policy-disabled', message: 'Collection is disabled.' };
};

const lifecycleAfterPolicyChange = (source: InternalSourceState, enabled: boolean): SourceLifecycle => {
  if (source.running) {
    return enabled ? 'running' : 'pausing';
  }
  return enabled && source.availability === 'detected' && !source.queued ? 'scheduled' : 'dormant';
};

const sanitizeCount = (value: number): number => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

const sanitizeWarnings = (warnings: readonly SourceWarning[]): readonly SourceWarning[] =>
  warnings.slice(0, sourceControlBounds.maxWarningsPerSource).map((warning) => ({
    code: warning.code.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'source-warning',
    ...(warning.message === undefined
      ? {}
      : { message: warning.message.slice(0, sourceControlBounds.maxMessageLength) }),
  }));

const sanitizeProgress = (progress: SourceProgress): SourceProgress => ({
  phase: progress.phase,
  ...(progress.completed === undefined ? {} : { completed: sanitizeCount(progress.completed) }),
  ...(progress.total === undefined ? {} : { total: sanitizeCount(progress.total) }),
  ...(progress.message === undefined
    ? {}
    : { message: progress.message.slice(0, sourceControlBounds.maxMessageLength) }),
});

const initialSourceState = (enabled: boolean): InternalSourceState => ({
  availability: 'not-detected',
  enabled,
  lastOutcome: 'not-run',
  lifecycle: 'dormant',
  policyRevision: 0,
  queued: false,
  reason: enabled
    ? { code: 'input-missing', message: 'Source detection has not completed.' }
    : { code: 'policy-disabled', message: 'Collection is disabled.' },
  running: false,
  warnings: [],
});

const initialState = (
  instanceId: string,
  sourceIds: readonly CollectionSourceId[],
  policies: SourcePolicyOverrides,
  now: number,
): InternalControlState => {
  const sources = Object.fromEntries(
    collectionSourceDefinitions.map(({ id }) => [
      id,
      initialSourceState(sourceIds.includes(id) && resolveSourceEnabled(id, policies)),
    ]),
  ) as Record<CollectionSourceId, InternalSourceState>;
  return {
    generatedAt: toIso(now),
    generation: 0,
    instanceId,
    publication: {
      dirtyGeneration: 0,
      publishedGeneration: 0,
      queued: false,
      running: false,
    },
    queueDepth: 0,
    rtkCompletedGeneration: 0,
    rtkRequiredGeneration: 0,
    sources,
  };
};

const sourceEntryView = (sourceId: CollectionSourceId, state: InternalSourceState): SourceControlEntryView => {
  const definition = getCollectionSourceDefinition(sourceId);
  return {
    availability: state.availability,
    cadenceMs: definition.cadenceMs,
    id: sourceId,
    label: definition.label,
    lastOutcome: state.lastOutcome,
    lifecycle: state.lifecycle,
    policy: state.enabled ? 'enabled' : 'disabled',
    reason: state.reason,
    warnings: state.warnings,
    ...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
    ...(state.inputCount === undefined ? {} : { inputCount: state.inputCount }),
    ...(state.lastFinishedAt === undefined ? {} : { lastFinishedAt: state.lastFinishedAt }),
    ...(state.lastStartedAt === undefined ? {} : { lastStartedAt: state.lastStartedAt }),
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.nextDueAt === undefined ? {} : { nextDueAt: state.nextDueAt }),
    ...(state.outputCount === undefined ? {} : { outputCount: state.outputCount }),
    ...(state.progress === undefined ? {} : { progress: state.progress }),
    ...(state.queueDelayMs === undefined ? {} : { queueDelayMs: state.queueDelayMs }),
  };
};

const toView = (state: InternalControlState): SourceControlView => ({
  generatedAt: state.generatedAt,
  generation: state.generation,
  instanceId: state.instanceId,
  publication: {
    dirty: state.publication.dirtyGeneration > state.publication.publishedGeneration,
    running: state.publication.running,
    ...(state.publication.lastDurationMs === undefined ? {} : { lastDurationMs: state.publication.lastDurationMs }),
    ...(state.publication.lastPublishedAt === undefined ? {} : { lastPublishedAt: state.publication.lastPublishedAt }),
    ...(state.publication.revision === undefined ? {} : { revision: state.publication.revision }),
  },
  queueDepth: state.queueDepth,
  runningCount: Object.values(state.sources).filter(({ running }) => running).length,
  sources: collectionSourceDefinitions.map(({ id }) => sourceEntryView(id, state.sources[id])),
});

const withSourceState = (
  state: InternalControlState,
  sourceId: CollectionSourceId,
  update: (source: InternalSourceState) => InternalSourceState,
): InternalControlState => ({
  ...state,
  sources: { ...state.sources, [sourceId]: update(state.sources[sourceId]) },
});

const sourceNeedsRtk = (sourceId: CollectionSourceId): boolean =>
  sourceId === 'claude.sessions' ||
  sourceId === 'codex.sessions' ||
  sourceId === 'opencode.sessions' ||
  sourceId === 'cursor.sessions';

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
      initialState(options.instanceId ?? randomUUID(), sourceIds, policies, now),
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

    const enqueuePublication: Effect.Effect<boolean> = Effect.gen(function* () {
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
      result: SourceRunResult | undefined,
    ): Effect.Effect<{
      changed: boolean;
      detected: boolean;
      enabled: boolean;
      needsPublication: boolean;
      needsRtk: boolean;
      needsRtkRerun: boolean;
    }> =>
      modifyState((state, finishedAt) => {
        const source = state.sources[job.sourceId];
        const failed = result === undefined;
        const unavailable = result?.unavailable;
        const warnings = result ? sanitizeWarnings(result.warnings) : [];
        const availability = unavailable ? 'not-detected' : source.availability;
        const lastOutcome = outcomeAfterRun(failed, unavailable, warnings.length);
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
        const { progress: _progress, ...sourceWithoutProgress } = source;
        const nextSource: InternalSourceState = {
          ...sourceWithoutProgress,
          availability,
          durationMs: Math.max(0, finishedAt - startedAt),
          lastFinishedAt: toIso(finishedAt),
          lastOutcome,
          lifecycle: source.enabled && availability === 'detected' ? 'scheduled' : 'dormant',
          reason: reasonAfterRun(failed, unavailable, source.enabled),
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
            needsPublication: changed || job.sourceId === 'rtk.savings',
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
        const result = yield* source
          .run({
            reportProgress: (progress) => updateProgress(job.sourceId, progress),
          })
          .pipe(
            Effect.timeoutFail({
              duration: sourceTimeout,
              onTimeout: () => new Error('source-timeout'),
            }),
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (value) => value,
            }),
          );
        const completed = yield* completeSource(job, decision.startedAt, decision.rtkTargetGeneration, result);
        if (completed.needsRtk || completed.needsRtkRerun) {
          yield* enqueueSource('rtk.savings');
        }
        if (completed.needsPublication) {
          yield* enqueuePublication;
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
            target: state.publication.dirtyGeneration,
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
      target: number,
      result: ReportPublicationResult | undefined,
    ): Effect.Effect<boolean> =>
      modifyState((state, finishedAt) => {
        const publishedGeneration = result
          ? Math.max(state.publication.publishedGeneration, target)
          : state.publication.publishedGeneration;
        const dirty = state.publication.dirtyGeneration > publishedGeneration;
        return [
          dirty,
          {
            ...state,
            publication: {
              ...state.publication,
              lastDurationMs: Math.max(0, finishedAt - startedAt),
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
      const remainsDirty = yield* finishPublication(decision.startedAt, decision.target, result);
      if (remainsDirty) {
        yield* enqueuePublication;
      }
    });

    const processJob = (job: ControlPlaneJob): Effect.Effect<void> =>
      job._tag === 'source' ? processSourceJob(job) : processPublicationJob;

    yield* detectAll;
    yield* enqueuePublication;
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
              reason: enabled ? entry.reason : { code: 'policy-disabled', message: 'Collection is disabled.' },
            };
          });
          return [enabled && current.availability === 'detected' && !current.queued && !current.running, next] as const;
        });
        if (shouldQueue) {
          yield* enqueueSource(sourceId);
        }
      });

    return {
      changes: Stream.map(stateRef.changes, toView),
      detectAll,
      getSnapshot: SubscriptionRef.get(stateRef).pipe(Effect.map(toView)),
      requestPublication: enqueuePublication,
      runAllEnabled,
      runNow,
      setEnabled,
    };
  });

export const sourceControlLayer = (options: SourceControlOptions): Layer.Layer<SourceControl> =>
  Layer.scoped(SourceControl, createSourceControl(options));
