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
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  projectProviderQuotaObservation,
} from '@ai-usage/report-core/provider-quota';
import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
import { createProviderStatusDataset, parseProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  queryLatestProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryProviderQuotaSourceStates,
  type UsageStoreError,
  usageStorePath,
} from '@ai-usage/usage-store/reader';
import { importProviderQuotaBatch, recordProviderQuotaSourceAttempt } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { queryProviderQuotaHistory } from './provider-quota-history';
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

export const queryLocalProviderQuotaHistory = (
  input: QueryLocalProviderQuotaHistoryInput,
): Effect.Effect<ProviderQuotaHistoryResult, UsageStoreError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    return yield* queryProviderQuotaHistory({
      dbPath: input.dbPath ?? usageStorePath(storage.home),
      from: input.from,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.maximumPoints === undefined ? {} : { maximumPoints: input.maximumPoints }),
      ...(input.providerKey === undefined ? {} : { providerKey: input.providerKey }),
      to: input.to,
    });
  });
