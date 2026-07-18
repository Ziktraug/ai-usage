import {
  collectCodexRolloutQuotaBatch,
  createCodexAppServerBatchSource,
  ensureMachineConfig,
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
import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
import { createProviderStatusDataset, parseProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  importProviderQuotaBatch,
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryProviderQuotaSourceStates,
  recordProviderQuotaSourceAttempt,
  type UsageStoreError,
  usageStorePath,
} from '@ai-usage/usage-store';
import { Effect } from 'effect';
import {
  createProviderQuotaRefresh,
  type ProviderQuotaRefreshAborted,
  type ProviderQuotaRefreshResult,
  type ResolvedProviderQuotaRefreshInput,
} from './provider-quota-refresh';

const LIVE_CADENCE_MS = 5 * 60 * 1000;

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

export type { ProviderQuotaRefreshResult } from './provider-quota-refresh';
export { ProviderQuotaRefreshAborted } from './provider-quota-refresh';

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

export interface QueryLatestLocalProviderQuotasInput {
  dbPath?: string;
  machineId?: string;
  providerKey?: string;
}

export const queryLatestLocalProviderQuotas = (
  input: QueryLatestLocalProviderQuotasInput = {},
): Effect.Effect<readonly ProviderStatus[], UsageStoreError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const stored = yield* queryLatestProviderQuotaObservations({
      dbPath: input.dbPath ?? usageStorePath(storage.home),
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.providerKey === undefined ? {} : { providerKey: input.providerKey }),
    });
    return stored.observations.map(({ observation }) => projectProviderQuotaObservation(observation));
  });

const productionBackfillSource = (storage: LocalHistoryStorageService): ProviderQuotaBatchSource => ({
  collect: (request) =>
    collectCodexRolloutQuotaBatch(request).pipe(Effect.provideService(LocalHistoryStorage, storage)),
});

const runProviderQuotaRefresh = createProviderQuotaRefresh<UsageStoreError>({
  importBatch: importProviderQuotaBatch,
  queryBackfillStates: queryProviderQuotaSourceStates,
  queryLatest: queryLatestProviderQuotaObservations,
  queryLiveState: queryProviderQuotaSourceState,
  recordAttempt: recordProviderQuotaSourceAttempt,
});

export const refreshLocalProviderQuotas = (
  input: ProviderQuotaRefreshInput = {},
): Effect.Effect<
  ProviderQuotaRefreshResult,
  LocalHistoryError | ProviderQuotaRefreshAborted | UsageStoreError,
  LocalHistoryStorageService
> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const machine = input.machine ?? (yield* ensureMachineConfig);
    const resolved: ResolvedProviderQuotaRefreshInput = {
      backfillSource:
        input.options?.backfillSource === undefined ? productionBackfillSource(storage) : input.options.backfillSource,
      dbPath: input.dbPath ?? usageStorePath(storage.home),
      liveCadenceMs: input.options?.liveCadenceMs ?? LIVE_CADENCE_MS,
      liveSource: input.options?.liveSource ?? createCodexAppServerBatchSource(),
      machine,
      now: input.options?.now?.() ?? new Date(),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    return yield* runProviderQuotaRefresh(resolved);
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
