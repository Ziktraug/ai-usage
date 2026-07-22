import { type BoundaryOutcome, withMeasuredIfAvailable } from '@ai-usage/effect-runtime';
import type { ProviderQuotaBatch, ProviderQuotaBatchSource } from '@ai-usage/local-collectors';
import { projectProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type {
  ImportProviderQuotaBatchInput,
  ProviderQuotaImportItem,
  ProviderQuotaImportResult,
  ProviderQuotaSourceState,
  QueryLatestProviderQuotaObservationsInput,
  QueryProviderQuotaObservationsResult,
  QueryProviderQuotaSourceStateInput,
  QueryProviderQuotaSourceStatesInput,
  RecordProviderQuotaSourceAttemptInput,
} from '@ai-usage/usage-store';
import { Cause, Data, Deferred, Effect, Exit } from 'effect';

const LIVE_SOURCE_KEY = 'codex-app-server';
const LIVE_CURSOR_KEY = 'refresh';
const BACKFILL_SOURCE_KEY = 'codex-rollout';
const BACKFILL_DAYS = 35;
const DAY_MS = 86_400_000;

export interface ProviderQuotaRefreshResult {
  backfill: 'advanced' | 'complete' | 'failed' | 'skipped';
  latest: ReturnType<typeof projectProviderQuotaObservation>[];
  live: 'refreshed' | 'skipped' | 'unsupported' | 'auth-required' | 'failed';
  warnings: string[];
}

export interface ResolvedProviderQuotaRefreshInput<SourceError = unknown> {
  backfillSource: ProviderQuotaBatchSource<SourceError> | null;
  dbPath: string;
  liveCadenceMs: number;
  liveSource: ProviderQuotaBatchSource<SourceError>;
  machine: UsageMachine;
  now: Date;
  signal?: AbortSignal;
}

export interface ProviderQuotaPersistence<Error> {
  importBatch(input: ImportProviderQuotaBatchInput): Effect.Effect<ProviderQuotaImportResult, Error>;
  queryBackfillStates(input: QueryProviderQuotaSourceStatesInput): Effect.Effect<ProviderQuotaSourceState[], Error>;
  queryLatest(
    input: QueryLatestProviderQuotaObservationsInput,
  ): Effect.Effect<QueryProviderQuotaObservationsResult, Error>;
  queryLiveState(input: QueryProviderQuotaSourceStateInput): Effect.Effect<ProviderQuotaSourceState | null, Error>;
  recordAttempt(input: RecordProviderQuotaSourceAttemptInput): Effect.Effect<void, Error>;
}

interface ProviderQuotaFlight<Error> {
  readonly result: Deferred.Deferred<ProviderQuotaRefreshResult, Error>;
}

export class ProviderQuotaRefreshAborted extends Data.TaggedError('ProviderQuotaRefreshAborted')<{
  readonly message: string;
}> {}

const abortError = (): ProviderQuotaRefreshAborted =>
  new ProviderQuotaRefreshAborted({ message: 'Provider quota refresh was aborted' });

const waitForAbort = (signal: AbortSignal): Effect.Effect<never, ProviderQuotaRefreshAborted> =>
  Effect.async<never, ProviderQuotaRefreshAborted>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError()));
      return;
    }
    const onAbort = (): void => resume(Effect.fail(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

const classifyQuotaRefreshOwnerOutcome = (exit: Exit.Exit<ProviderQuotaRefreshResult, unknown>): BoundaryOutcome => {
  if (Exit.isFailure(exit)) {
    return Cause.isInterruptedOnly(exit.cause) ? 'interrupted' : 'failure';
  }
  const { backfill, latest, live } = exit.value;
  const hasPartialFailure = live === 'failed' || backfill === 'failed';
  const hasUsableLatest = latest.length > 0;
  if (!hasPartialFailure) {
    return 'success';
  }
  return hasUsableLatest ? 'degraded' : 'failure';
};

const withAbortSignal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E | ProviderQuotaRefreshAborted, R> =>
  signal ? Effect.raceFirst(effect, waitForAbort(signal)) : effect;

const errorReason = (error: unknown): ProviderQuotaRefreshResult['live'] => {
  if (typeof error === 'object' && error !== null) {
    const reason = (error as Record<string, unknown>).reason;
    if (reason === 'unsupported' || reason === 'auth-required') {
      return reason;
    }
  }
  return 'failed';
};

const batchItems = (batch: ProviderQuotaBatch): ProviderQuotaImportItem[] => {
  const sourceEventByIndex = new Map(batch.sourceEvents.map((event) => [event.observationIndex, event.key]));
  return batch.observations.map((observation, index) => {
    const sourceEventKey = sourceEventByIndex.get(index);
    return { observation, ...(sourceEventKey === undefined ? {} : { sourceEventKey }) };
  });
};

const liveWarning = (live: ProviderQuotaRefreshResult['live']): string => {
  if (live === 'auth-required') {
    return 'Codex authentication is required to refresh quota history.';
  }
  if (live === 'unsupported') {
    return 'The Codex CLI is unavailable, so stored quota history may be stale.';
  }
  return 'Codex quota refresh failed; the last successful history remains available.';
};

const runRefresh = <PersistenceError, SourceError>(
  persistence: ProviderQuotaPersistence<PersistenceError>,
  input: Omit<ResolvedProviderQuotaRefreshInput<SourceError>, 'signal'> & { signal: AbortSignal },
): Effect.Effect<ProviderQuotaRefreshResult, PersistenceError, never> =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    let live: ProviderQuotaRefreshResult['live'] = 'skipped';
    let backfill: ProviderQuotaRefreshResult['backfill'] = 'skipped';
    const liveState = yield* persistence.queryLiveState({
      cursorKey: LIVE_CURSOR_KEY,
      dbPath: input.dbPath,
      machineId: input.machine.id,
      providerKey: 'codex',
      sourceKey: LIVE_SOURCE_KEY,
    });
    const lastSuccess = liveState?.lastSuccessAt ? Date.parse(liveState.lastSuccessAt) : Number.NEGATIVE_INFINITY;
    if (input.now.getTime() - lastSuccess >= input.liveCadenceMs) {
      const liveResult = yield* Effect.gen(function* () {
        const batch = yield* input.liveSource.collect({
          machineId: input.machine.id,
          machineLabel: input.machine.label,
          observedAt: input.now,
          signal: input.signal,
        });
        yield* persistence.importBatch({
          checkpointUpdates: [],
          dbPath: input.dbPath,
          items: batchItems(batch),
          importedAt: input.now,
        });
        yield* persistence.recordAttempt({
          attemptedAt: input.now,
          cursorKey: LIVE_CURSOR_KEY,
          dbPath: input.dbPath,
          machineId: input.machine.id,
          providerKey: 'codex',
          sourceKey: LIVE_SOURCE_KEY,
          succeeded: true,
        });
        return 'refreshed' as const;
      }).pipe(
        Effect.catchAll((error) => {
          const failure = errorReason(error);
          warnings.push(liveWarning(failure));
          return persistence
            .recordAttempt({
              attemptedAt: input.now,
              cursorKey: LIVE_CURSOR_KEY,
              dbPath: input.dbPath,
              machineId: input.machine.id,
              providerKey: 'codex',
              sourceKey: LIVE_SOURCE_KEY,
              succeeded: false,
            })
            .pipe(Effect.as(failure));
        }),
      );
      live = liveResult;
    }

    const backfillSource = input.backfillSource;
    if (backfillSource) {
      backfill = yield* Effect.gen(function* () {
        const states = yield* persistence.queryBackfillStates({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          providerKey: 'codex',
          sourceKey: BACKFILL_SOURCE_KEY,
        });
        const cursors = Object.fromEntries(states.map((state) => [state.cursorKey, state.cursor]));
        const batch = yield* backfillSource.collect({
          cursors,
          from: new Date(input.now.getTime() - BACKFILL_DAYS * DAY_MS),
          machineId: input.machine.id,
          machineLabel: input.machine.label,
          observedAt: input.now,
          signal: input.signal,
        });
        yield* persistence.importBatch({
          checkpointUpdates: batch.checkpoints.map((checkpoint) => ({
            cursor: checkpoint.value,
            cursorKey: checkpoint.key,
            machineId: input.machine.id,
            providerKey: 'codex',
            sourceKey: BACKFILL_SOURCE_KEY,
          })),
          dbPath: input.dbPath,
          items: batchItems(batch),
          importedAt: input.now,
        });
        return batch.hasMore ? ('advanced' as const) : ('complete' as const);
      }).pipe(
        Effect.catchAll(() => {
          warnings.push(
            'Codex rollout backfill could not advance; live and previously stored history remain available.',
          );
          return Effect.succeed('failed' as const);
        }),
      );
    }

    const latest = yield* persistence.queryLatest({
      dbPath: input.dbPath,
      machineId: input.machine.id,
      providerKey: 'codex',
    });
    return {
      backfill,
      latest: latest.observations.map(({ observation }) => projectProviderQuotaObservation(observation)),
      live,
      warnings,
    };
  });

export const createProviderQuotaRefresh = <PersistenceError>(
  persistence: ProviderQuotaPersistence<PersistenceError>,
) => {
  const flights = new Map<string, ProviderQuotaFlight<PersistenceError | ProviderQuotaRefreshAborted>>();

  return <SourceError>(
    input: ResolvedProviderQuotaRefreshInput<SourceError>,
  ): Effect.Effect<ProviderQuotaRefreshResult, PersistenceError | ProviderQuotaRefreshAborted> =>
    Effect.gen(function* () {
      if (input.signal?.aborted) {
        return yield* Effect.fail(abortError());
      }
      const candidate = yield* Deferred.make<
        ProviderQuotaRefreshResult,
        PersistenceError | ProviderQuotaRefreshAborted
      >();
      const key = `${input.dbPath}|${input.machine.id}`;
      const selection = yield* Effect.sync(() => {
        const existing = flights.get(key);
        if (existing) {
          return { flight: existing, owner: false } as const;
        }
        const flight = { result: candidate };
        flights.set(key, flight);
        return { flight, owner: true } as const;
      });
      if (!selection.owner) {
        return yield* withAbortSignal(Deferred.await(selection.flight.result), input.signal).pipe(
          withMeasuredIfAvailable<ProviderQuotaRefreshResult, PersistenceError | ProviderQuotaRefreshAborted>(
            'quota.refresh.wait',
          ),
        );
      }

      const controller = new AbortController();
      const ownerInput = { ...input, signal: controller.signal };
      const owner = runRefresh(persistence, ownerInput).pipe(
        withMeasuredIfAvailable<ProviderQuotaRefreshResult, PersistenceError>('quota.refresh', {
          classify: classifyQuotaRefreshOwnerOutcome,
        }),
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
      );
      return yield* withAbortSignal(owner, input.signal).pipe(
        Effect.onExit((exit) =>
          Deferred.done(selection.flight.result, exit).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (flights.get(key) === selection.flight) {
                  flights.delete(key);
                }
              }),
            ),
          ),
        ),
      );
    });
};
