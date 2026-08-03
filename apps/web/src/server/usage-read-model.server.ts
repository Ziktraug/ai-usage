import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import type { UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import {
  queryServedRevisionData,
  type ServedRevisionQueryError,
  type ServedRevisionQueryKind,
  type ServedRevisionQueryResult,
} from '@ai-usage/report-data/served-revision-query';
import {
  type CurrentServedLocalProjectSources,
  type QueryUsageSyncFleetResult,
  queryCurrentServedLocalProjectSources,
  queryCurrentServedReportRevision,
  queryCurrentServedReportRevisionBootstrap,
  queryLocalMergeBundle,
  queryUsageLocalMachine,
  queryUsageSyncFleet,
  type ServedReportRevisionManifest,
  type ServedRevisionQueryTrace,
  type UsageStoreError,
} from '@ai-usage/usage-store/reader';
import { Effect, type Either } from 'effect';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

export interface UsageReadModelBootstrap {
  readonly manifest: ServedReportRevisionManifest;
  readonly support: FocusedSupportResult;
}

export interface UsageReadModelQuery {
  readonly kind: ServedRevisionQueryKind;
  readonly request: unknown;
  readonly revision: string;
  readonly trace?: (query: ServedRevisionQueryTrace) => void;
}

export interface UsageReadModelCallOptions {
  readonly signal?: AbortSignal;
}

export interface UsageReadModel {
  readonly queryRevision: (
    input: UsageReadModelQuery,
    options?: UsageReadModelCallOptions,
  ) => Promise<ServedRevisionQueryResult>;
  readonly readCurrentBootstrap: (options?: UsageReadModelCallOptions) => Promise<UsageReadModelBootstrap>;
  readonly readCurrentLocalProjectSources: (
    options?: UsageReadModelCallOptions,
  ) => Promise<CurrentServedLocalProjectSources>;
  readonly readCurrentManifest: (options?: UsageReadModelCallOptions) => Promise<ServedReportRevisionManifest>;
  readonly readLocalMachine: (
    options?: UsageReadModelCallOptions,
  ) => Promise<{ readonly id: string; readonly label: string }>;
  readonly readLocalMergeBundle: (options?: UsageReadModelCallOptions) => Promise<UsageMergeBundle>;
  readonly readSyncFleet: (options?: UsageReadModelCallOptions) => Promise<QueryUsageSyncFleetResult>;
}

export interface SqliteUsageReadModelOptions {
  readonly dbPath: string;
  readonly now?: () => number;
}

const optionalNow = (now: (() => number) | undefined): { readonly now?: number } =>
  now === undefined ? {} : { now: now() };

const runReadEffect = async <Value, Failure>(
  effect: Effect.Effect<Value, Failure>,
  options: UsageReadModelCallOptions = {},
): Promise<Value> => {
  options.signal?.throwIfAborted();
  let result: Either.Either<Value, Failure>;
  try {
    result = await Effect.runPromise(
      Effect.either(effect),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  }
  options.signal?.throwIfAborted();
  if (result._tag === 'Left') {
    throw result.left;
  }
  return result.right;
};

export const createSqliteUsageReadModel = (options: SqliteUsageReadModelOptions): UsageReadModel => ({
  queryRevision: (input, callOptions) =>
    runReadEffect(
      queryServedRevisionData({
        dbPath: options.dbPath,
        kind: input.kind,
        ...optionalNow(options.now),
        request: input.request,
        revision: input.revision,
        ...(input.trace === undefined ? {} : { trace: input.trace }),
      }),
      callOptions,
    ),
  readCurrentBootstrap: (callOptions) =>
    runReadEffect(
      queryCurrentServedReportRevisionBootstrap({
        dbPath: options.dbPath,
        ...optionalNow(options.now),
      }),
      callOptions,
    ),
  readCurrentLocalProjectSources: (callOptions) =>
    runReadEffect(
      queryCurrentServedLocalProjectSources({
        dbPath: options.dbPath,
        ...optionalNow(options.now),
      }),
      callOptions,
    ),
  readCurrentManifest: (callOptions) =>
    runReadEffect(
      queryCurrentServedReportRevision({
        dbPath: options.dbPath,
        ...optionalNow(options.now),
      }),
      callOptions,
    ),
  readLocalMergeBundle: (callOptions) =>
    runReadEffect(
      queryLocalMergeBundle({
        dbPath: options.dbPath,
        ...(options.now === undefined ? {} : { generatedAt: new Date(options.now()) }),
      }),
      callOptions,
    ),
  readLocalMachine: (callOptions) => runReadEffect(queryUsageLocalMachine({ dbPath: options.dbPath }), callOptions),
  readSyncFleet: (callOptions) => runReadEffect(queryUsageSyncFleet({ dbPath: options.dbPath }), callOptions),
});

export const createLiveUsageReadModel = (): UsageReadModel =>
  createSqliteUsageReadModel({ dbPath: resolveUsageWebRuntimePaths().databasePath });

export type UsageReadModelError = ServedRevisionQueryError | UsageStoreError;
