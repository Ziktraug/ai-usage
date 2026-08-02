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
import { Effect } from 'effect';
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

export interface UsageReadModel {
  readonly queryRevision: (input: UsageReadModelQuery) => Promise<ServedRevisionQueryResult>;
  readonly readCurrentBootstrap: () => Promise<UsageReadModelBootstrap>;
  readonly readCurrentLocalProjectSources: () => Promise<CurrentServedLocalProjectSources>;
  readonly readCurrentManifest: () => Promise<ServedReportRevisionManifest>;
  readonly readLocalMachine: () => Promise<{ readonly id: string; readonly label: string }>;
  readonly readLocalMergeBundle: () => Promise<UsageMergeBundle>;
  readonly readSyncFleet: () => Promise<QueryUsageSyncFleetResult>;
}

export interface SqliteUsageReadModelOptions {
  readonly dbPath: string;
  readonly now?: () => number;
}

const optionalNow = (now: (() => number) | undefined): { readonly now?: number } =>
  now === undefined ? {} : { now: now() };

const runReadEffect = async <Value, Failure>(effect: Effect.Effect<Value, Failure>): Promise<Value> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === 'Left') {
    throw result.left;
  }
  return result.right;
};

export const createSqliteUsageReadModel = (options: SqliteUsageReadModelOptions): UsageReadModel => ({
  queryRevision: (input) =>
    runReadEffect(
      queryServedRevisionData({
        dbPath: options.dbPath,
        kind: input.kind,
        ...optionalNow(options.now),
        request: input.request,
        revision: input.revision,
        ...(input.trace === undefined ? {} : { trace: input.trace }),
      }),
    ),
  readCurrentBootstrap: () =>
    runReadEffect(
      queryCurrentServedReportRevisionBootstrap({
        dbPath: options.dbPath,
        ...optionalNow(options.now),
      }),
    ),
  readCurrentLocalProjectSources: () =>
    runReadEffect(
      queryCurrentServedLocalProjectSources({
        dbPath: options.dbPath,
        ...optionalNow(options.now),
      }),
    ),
  readCurrentManifest: () =>
    runReadEffect(
      queryCurrentServedReportRevision({
        dbPath: options.dbPath,
        ...optionalNow(options.now),
      }),
    ),
  readLocalMergeBundle: () =>
    runReadEffect(
      queryLocalMergeBundle({
        dbPath: options.dbPath,
        ...(options.now === undefined ? {} : { generatedAt: new Date(options.now()) }),
      }),
    ),
  readLocalMachine: () => runReadEffect(queryUsageLocalMachine({ dbPath: options.dbPath })),
  readSyncFleet: () => runReadEffect(queryUsageSyncFleet({ dbPath: options.dbPath })),
});

export const createLiveUsageReadModel = (): UsageReadModel =>
  createSqliteUsageReadModel({ dbPath: resolveUsageWebRuntimePaths().databasePath });

export type UsageReadModelError = ServedRevisionQueryError | UsageStoreError;
