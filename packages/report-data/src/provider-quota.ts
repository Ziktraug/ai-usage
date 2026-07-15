import {
  collectCodexRolloutQuotaBatch,
  createCodexAppServerBatchSource,
  ensureMachineConfig,
  type ProviderQuotaBatch,
  type ProviderQuotaBatchSource,
} from '@ai-usage/local-collectors';
import type { LocalHistoryError } from '@ai-usage/local-collectors/errors';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import {
  downsampleProviderQuotaHistoryPoints,
  type ProviderQuotaCoverage,
  type ProviderQuotaHistoryPoint,
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  parseProviderQuotaHistoryRequest,
  projectProviderQuotaObservation,
} from '@ai-usage/report-core/provider-quota';
import { createProviderStatusDataset, parseProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  importProviderQuotaBatch,
  type ProviderQuotaImportItem,
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryProviderQuotaSourceStates,
  recordProviderQuotaSourceAttempt,
  type UsageStoreError,
  usageStorePath,
} from '@ai-usage/usage-store';
import { Effect } from 'effect';

const LIVE_SOURCE_KEY = 'codex-app-server';
const LIVE_CURSOR_KEY = 'refresh';
const BACKFILL_SOURCE_KEY = 'codex-rollout';
const LIVE_CADENCE_MS = 5 * 60 * 1000;
const BACKFILL_DAYS = 35;

export interface ProviderQuotaRuntimeOptions {
  backfillSource?: ProviderQuotaBatchSource | null;
  liveCadenceMs?: number;
  liveSource?: ProviderQuotaBatchSource;
  now?: () => Date;
}

export interface ProviderQuotaRefreshInput {
  dbPath?: string;
  machine?: UsageMachine;
  options?: ProviderQuotaRuntimeOptions;
  signal?: AbortSignal;
}

export interface ProviderQuotaRefreshResult {
  backfill: 'advanced' | 'complete' | 'failed' | 'skipped';
  latest: ReturnType<typeof projectProviderQuotaObservation>[];
  live: 'refreshed' | 'skipped' | 'unsupported' | 'auth-required' | 'failed';
  warnings: string[];
}

export const parseProviderQuotaRefreshResult = (value: unknown): ProviderQuotaRefreshResult => {
  if (!(typeof value === 'object' && value !== null)) {
    throw new Error('Invalid provider quota refresh result');
  }
  const result = value as Record<string, unknown>;
  const resultKeys = new Set(['backfill', 'latest', 'live', 'warnings']);
  const liveStates = new Set(['refreshed', 'skipped', 'unsupported', 'auth-required', 'failed']);
  const backfillStates = new Set(['advanced', 'complete', 'failed', 'skipped']);
  const latest = Array.isArray(result.latest) ? result.latest : [];
  const parsedLatest = parseProviderStatusDataset(createProviderStatusDataset(latest as never[]));
  if (
    !(
      Object.keys(result).every((key) => resultKeys.has(key)) &&
      liveStates.has(String(result.live)) &&
      backfillStates.has(String(result.backfill)) &&
      Array.isArray(result.warnings) &&
      result.warnings.every((warning) => typeof warning === 'string') &&
      parsedLatest
    )
  ) {
    throw new Error('Invalid provider quota refresh result');
  }
  return { ...result, latest: parsedLatest.providers } as ProviderQuotaRefreshResult;
};

export interface QueryLocalProviderQuotaHistoryInput extends ProviderQuotaHistoryRequest {
  dbPath?: string;
}

interface ResolvedRefreshInput {
  backfillSource: ProviderQuotaBatchSource | null;
  dbPath: string;
  liveCadenceMs: number;
  liveSource: ProviderQuotaBatchSource;
  machine: UsageMachine;
  now: Date;
  signal?: AbortSignal;
}

const refreshes = new Map<string, Promise<ProviderQuotaRefreshResult>>();

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

const runRefresh = async (input: ResolvedRefreshInput): Promise<ProviderQuotaRefreshResult> => {
  const warnings: string[] = [];
  let live: ProviderQuotaRefreshResult['live'] = 'skipped';
  let backfill: ProviderQuotaRefreshResult['backfill'] = 'skipped';
  const liveState = await Effect.runPromise(
    queryProviderQuotaSourceState({
      cursorKey: LIVE_CURSOR_KEY,
      dbPath: input.dbPath,
      machineId: input.machine.id,
      providerKey: 'codex',
      sourceKey: LIVE_SOURCE_KEY,
    }),
  );
  const lastSuccess = liveState?.lastSuccessAt ? Date.parse(liveState.lastSuccessAt) : Number.NEGATIVE_INFINITY;
  if (input.now.getTime() - lastSuccess >= input.liveCadenceMs) {
    try {
      const batch = await Effect.runPromise(
        input.liveSource.collect({
          machineId: input.machine.id,
          machineLabel: input.machine.label,
          observedAt: input.now,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
      await Effect.runPromise(
        importProviderQuotaBatch({
          checkpointUpdates: [],
          dbPath: input.dbPath,
          items: batchItems(batch),
          importedAt: input.now,
        }),
      );
      await Effect.runPromise(
        recordProviderQuotaSourceAttempt({
          attemptedAt: input.now,
          cursorKey: LIVE_CURSOR_KEY,
          dbPath: input.dbPath,
          machineId: input.machine.id,
          providerKey: 'codex',
          sourceKey: LIVE_SOURCE_KEY,
          succeeded: true,
        }),
      );
      live = 'refreshed';
    } catch (error) {
      live = errorReason(error);
      let warning = 'Codex quota refresh failed; the last successful history remains available.';
      if (live === 'auth-required') {
        warning = 'Codex authentication is required to refresh quota history.';
      } else if (live === 'unsupported') {
        warning = 'The Codex CLI is unavailable, so stored quota history may be stale.';
      }
      warnings.push(warning);
      await Effect.runPromise(
        recordProviderQuotaSourceAttempt({
          attemptedAt: input.now,
          cursorKey: LIVE_CURSOR_KEY,
          dbPath: input.dbPath,
          machineId: input.machine.id,
          providerKey: 'codex',
          sourceKey: LIVE_SOURCE_KEY,
          succeeded: false,
        }),
      );
    }
  }

  if (input.backfillSource) {
    try {
      const states = await Effect.runPromise(
        queryProviderQuotaSourceStates({
          dbPath: input.dbPath,
          machineId: input.machine.id,
          providerKey: 'codex',
          sourceKey: BACKFILL_SOURCE_KEY,
        }),
      );
      const cursors = Object.fromEntries(states.map((state) => [state.cursorKey, state.cursor]));
      const batch = await Effect.runPromise(
        input.backfillSource.collect({
          cursors,
          from: new Date(input.now.getTime() - BACKFILL_DAYS * 86_400_000),
          machineId: input.machine.id,
          machineLabel: input.machine.label,
          observedAt: input.now,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
      await Effect.runPromise(
        importProviderQuotaBatch({
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
        }),
      );
      backfill = batch.hasMore ? 'advanced' : 'complete';
    } catch {
      backfill = 'failed';
      warnings.push('Codex rollout backfill could not advance; live and previously stored history remain available.');
    }
  }

  const latest = await Effect.runPromise(
    queryLatestProviderQuotaObservations({ dbPath: input.dbPath, machineId: input.machine.id, providerKey: 'codex' }),
  );
  return {
    backfill,
    latest: latest.observations.map(({ observation }) => projectProviderQuotaObservation(observation)),
    live,
    warnings,
  };
};

const productionBackfillSource = (storage: LocalHistoryStorageService): ProviderQuotaBatchSource => ({
  collect: (request) =>
    collectCodexRolloutQuotaBatch(request).pipe(Effect.provideService(LocalHistoryStorage, storage)),
});

export const refreshLocalProviderQuotas = (
  input: ProviderQuotaRefreshInput = {},
): Effect.Effect<ProviderQuotaRefreshResult, LocalHistoryError | UsageStoreError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const machine = input.machine ?? (yield* ensureMachineConfig);
    const resolved: ResolvedRefreshInput = {
      backfillSource:
        input.options?.backfillSource === undefined ? productionBackfillSource(storage) : input.options.backfillSource,
      dbPath: input.dbPath ?? usageStorePath(storage.home),
      liveCadenceMs: input.options?.liveCadenceMs ?? LIVE_CADENCE_MS,
      liveSource: input.options?.liveSource ?? createCodexAppServerBatchSource(),
      machine,
      now: input.options?.now?.() ?? new Date(),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const key = `${resolved.dbPath}|${machine.id}`;
    const existing = refreshes.get(key);
    if (existing) {
      return yield* Effect.tryPromise({ try: () => existing, catch: (cause) => cause as UsageStoreError });
    }
    const promise = runRefresh(resolved).finally(() => {
      if (refreshes.get(key) === promise) {
        refreshes.delete(key);
      }
    });
    refreshes.set(key, promise);
    return yield* Effect.tryPromise({ try: () => promise, catch: (cause) => cause as UsageStoreError });
  });

const coverageForPoints = (points: ProviderQuotaHistoryPoint[]): ProviderQuotaCoverage[] => {
  const groups = new Map<string, ProviderQuotaHistoryPoint[]>();
  for (const point of points) {
    const key = `${point.providerKey}|${point.machineId}|${point.accountScope ?? ''}|${point.source.key}|${point.windowId}`;
    const rows = groups.get(key) ?? [];
    rows.push(point);
    groups.set(key, rows);
  }
  return [...groups.values()].map((rows) => {
    rows.sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt));
    const first = rows[0] as ProviderQuotaHistoryPoint;
    let largestGapMs = 0;
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous && current) {
        largestGapMs = Math.max(
          largestGapMs,
          Date.parse(current.firstObservedAt) - Date.parse(previous.lastObservedAt),
        );
      }
    }
    const last = rows.at(-1) as ProviderQuotaHistoryPoint;
    return {
      accountScope: first.accountScope,
      firstObservedAt: first.firstObservedAt,
      lastObservedAt: last.lastObservedAt,
      largestGapMs,
      machineId: first.machineId,
      pointCount: rows.length,
      providerKey: first.providerKey,
      sourceConfidence: first.source.confidence,
      sourceKey: first.source.key,
      windowId: first.windowId,
    };
  });
};

export const queryLocalProviderQuotaHistory = (
  input: QueryLocalProviderQuotaHistoryInput,
): Effect.Effect<ProviderQuotaHistoryResult, UsageStoreError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const request = parseProviderQuotaHistoryRequest({
      from: input.from,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.maximumPoints === undefined ? {} : { maximumPoints: input.maximumPoints }),
      ...(input.providerKey === undefined ? {} : { providerKey: input.providerKey }),
      to: input.to,
    });
    const stored = yield* queryProviderQuotaObservations({
      dbPath: input.dbPath ?? usageStorePath(storage.home),
      from: request.from,
      ...(request.machineId === undefined ? {} : { machineId: request.machineId }),
      maximumObservations: (request.maximumPoints ?? 1000) * 4,
      ...(request.providerKey === undefined ? {} : { providerKey: request.providerKey }),
      to: request.to,
    });
    const points: ProviderQuotaHistoryPoint[] = stored.observations.flatMap(
      ({ firstObservedAt, lastObservedAt, observation }) =>
        observation.windows.map((window) => ({
          accountScope: observation.accountScope,
          blocked: window.blocked,
          firstObservedAt,
          group: window.group,
          lastObservedAt,
          limitSeconds: window.limitSeconds,
          machineId: observation.machineId,
          machineLabel: observation.machineLabel,
          providerKey: observation.providerKey,
          providerLabel: observation.providerLabel,
          resetAt: window.resetsAt,
          source: observation.source,
          usedPercent: window.usedPercent,
          windowId: window.id,
          windowLabel: window.label,
        })),
    );
    const reduced = downsampleProviderQuotaHistoryPoints(points, request.maximumPoints ?? 1000);
    const latest = yield* queryLatestProviderQuotaObservations({
      dbPath: input.dbPath ?? usageStorePath(storage.home),
      ...(request.machineId === undefined ? {} : { machineId: request.machineId }),
      ...(request.providerKey === undefined ? {} : { providerKey: request.providerKey }),
    });
    return {
      coverage: coverageForPoints(points),
      generatedAt: new Date().toISOString(),
      latest: latest.observations.map(({ observation }) => projectProviderQuotaObservation(observation)),
      points: reduced.points,
      skipped: stored.skipped + latest.skipped,
      truncated: stored.truncated || reduced.truncated,
    };
  });
