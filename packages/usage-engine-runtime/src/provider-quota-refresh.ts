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
} from '@ai-usage/usage-store/writer';
import { Cause, Data, Deferred, Effect, Exit, Option } from 'effect';

const BACKFILL_DAYS = 35;
const DAY_MS = 86_400_000;

/**
 * Who a refresh is refreshing. The orchestration below is provider-agnostic in shape — it collects
 * from an injected source — so this carries the identity it must not invent: the keys written to the
 * store, and the name spoken in warnings.
 */
export interface ProviderQuotaSourceIdentity {
  /** Source key for the backfill pass. Unused when `backfillSource` is null. */
  readonly backfillSourceKey: string;
  /** Cursor key for the live pass. */
  readonly cursorKey: string;
  /** Source key for the live pass, recorded against every observation and attempt. */
  readonly liveSourceKey: string;
  /** Stable provider key: the value `providerStatusKeyForUsage` produces. */
  readonly providerKey: string;
  /** Human name used in warnings, such as `Codex` or `Claude`. */
  readonly providerLabel: string;
}

export const CODEX_QUOTA_SOURCE_IDENTITY: ProviderQuotaSourceIdentity = {
  backfillSourceKey: 'codex-rollout',
  cursorKey: 'refresh',
  liveSourceKey: 'codex-app-server',
  providerKey: 'codex',
  providerLabel: 'Codex',
};

/** Claude has no local quota history, so `backfillSourceKey` is declared but never written. */
export const CLAUDE_QUOTA_SOURCE_IDENTITY: ProviderQuotaSourceIdentity = {
  backfillSourceKey: 'claude-none',
  cursorKey: 'refresh',
  liveSourceKey: 'claude-agent-sdk',
  providerKey: 'claude',
  providerLabel: 'Claude',
};

export interface ProviderQuotaRefreshResult {
  backfill: 'advanced' | 'complete' | 'failed' | 'skipped';
  latest: ReturnType<typeof projectProviderQuotaObservation>[];
  live: 'refreshed' | 'skipped' | 'unsupported' | 'auth-required' | 'failed';
  warnings: string[];
}

export interface ResolvedProviderQuotaRefreshInput<SourceError = unknown> {
  backfillSource: ProviderQuotaBatchSource<SourceError> | null;
  dbPath: string;
  identity: ProviderQuotaSourceIdentity;
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

const quotaRefreshWasInterrupted = <A>(exit: Exit.Exit<A, unknown>): boolean => {
  if (Exit.isSuccess(exit)) {
    return false;
  }
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  return Cause.isInterruptedOnly(exit.cause) || failure instanceof ProviderQuotaRefreshAborted;
};

const classifyQuotaRefreshWaitOutcome = (exit: Exit.Exit<ProviderQuotaRefreshResult, unknown>): BoundaryOutcome => {
  if (Exit.isSuccess(exit)) {
    return 'success';
  }
  return quotaRefreshWasInterrupted(exit) ? 'interrupted' : 'failure';
};

const classifyQuotaRefreshOwnerOutcome = (exit: Exit.Exit<ProviderQuotaRefreshResult, unknown>): BoundaryOutcome => {
  if (Exit.isFailure(exit)) {
    return quotaRefreshWasInterrupted(exit) ? 'interrupted' : 'failure';
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

const liveWarning = (live: ProviderQuotaRefreshResult['live'], providerLabel: string): string => {
  if (live === 'auth-required') {
    return `${providerLabel} authentication is required to refresh quota history.`;
  }
  if (live === 'unsupported') {
    return `The ${providerLabel} CLI is unavailable, so stored quota history may be stale.`;
  }
  return `${providerLabel} quota refresh failed; the last successful history remains available.`;
};

const runRefresh = <PersistenceError, SourceError>(
  persistence: ProviderQuotaPersistence<PersistenceError>,
  input: Omit<ResolvedProviderQuotaRefreshInput<SourceError>, 'signal'> & { signal: AbortSignal },
): Effect.Effect<ProviderQuotaRefreshResult, PersistenceError, never> =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    const { backfillSourceKey, cursorKey, liveSourceKey, providerKey, providerLabel } = input.identity;
    let live: ProviderQuotaRefreshResult['live'] = 'skipped';
    let backfill: ProviderQuotaRefreshResult['backfill'] = 'skipped';
    const liveState = yield* persistence.queryLiveState({
      cursorKey,
      dbPath: input.dbPath,
      machineId: input.machine.id,
      providerKey,
      sourceKey: liveSourceKey,
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
          cursorKey,
          dbPath: input.dbPath,
          machineId: input.machine.id,
          providerKey,
          sourceKey: liveSourceKey,
          succeeded: true,
        });
        return 'refreshed' as const;
      }).pipe(
        Effect.catchAll((error) => {
          const failure = errorReason(error);
          warnings.push(liveWarning(failure, providerLabel));
          return persistence
            .recordAttempt({
              attemptedAt: input.now,
              cursorKey,
              dbPath: input.dbPath,
              machineId: input.machine.id,
              providerKey,
              sourceKey: liveSourceKey,
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
          providerKey,
          sourceKey: backfillSourceKey,
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
            providerKey,
            sourceKey: backfillSourceKey,
          })),
          dbPath: input.dbPath,
          items: batchItems(batch),
          importedAt: input.now,
        });
        return batch.hasMore ? ('advanced' as const) : ('complete' as const);
      }).pipe(
        Effect.catchAll(() => {
          warnings.push(
            `${providerLabel} backfill could not advance; live and previously stored history remain available.`,
          );
          return Effect.succeed('failed' as const);
        }),
      );
    }

    const latest = yield* persistence.queryLatest({
      dbPath: input.dbPath,
      machineId: input.machine.id,
      providerKey,
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
      // The provider belongs in the key. Without it two providers refreshing the same machine share
      // one in-flight refresh, and the second caller receives the first one's windows — written under
      // the wrong provider identity.
      const key = `${input.dbPath}|${input.machine.id}|${input.identity.providerKey}`;
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
            { classify: classifyQuotaRefreshWaitOutcome },
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
