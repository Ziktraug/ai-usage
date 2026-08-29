import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import type { UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import { projectProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { createProviderStatusDataset, type ProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import {
  createSkillObservationDataset,
  type SkillObservationDataset,
} from '@ai-usage/report-core/skill-observation-summary';
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
  queryLatestProviderQuotaObservations,
  queryLocalMergeBundle,
  querySkillObservations,
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
  /**
   * Current quota heads only. This deliberately bypasses the report bootstrap: the navigation rail
   * renders on every route, and `readCurrentBootstrap` would make each of them pay for the whole
   * support blob to read a handful of percentages.
   */
  readonly readLatestProviderQuota: (options?: UsageReadModelCallOptions) => Promise<ProviderStatusDataset>;
  readonly readLocalMachine: (
    options?: UsageReadModelCallOptions,
  ) => Promise<{ readonly id: string; readonly label: string }>;
  readonly readLocalMergeBundle: (options?: UsageReadModelCallOptions) => Promise<UsageMergeBundle>;
  /**
   * The skill-observation fact family (ADR 0022), folded into its presented dataset.
   *
   * Like `readLatestProviderQuota` this deliberately bypasses the report bootstrap, and for a
   * sharper reason than cost: observations are collected on their own cycle and answer a question
   * about the *skills inventory*, not about a report revision. Routing them through the bootstrap
   * would make an inventory fact expire with a revision it has nothing to do with, and would make
   * `/skills` — which never renders report rows — unable to answer until a revision was published.
   */
  readonly readSkillObservations: (options?: UsageReadModelCallOptions) => Promise<SkillObservationDataset>;
  readonly readSyncFleet: (options?: UsageReadModelCallOptions) => Promise<QueryUsageSyncFleetResult>;
}

/**
 * One head exists per provider × machine × account scope. A handful is the realistic ceiling, and
 * the rail collapses them per provider anyway, so a small budget keeps a corrupt table from being
 * read into the shell of every page.
 */
const MAXIMUM_RAIL_QUOTA_OBSERVATIONS = 64;

/**
 * Skill observations are tens to hundreds per sweep and are retained for 400 days, so a few
 * thousand is the realistic ceiling for one machine's history. The bound exists so a corrupt or
 * runaway table cannot be read whole into a page render; when it bites, the reader reports it and
 * the dataset presents its counts as a lower bound rather than as numbers.
 */
const MAXIMUM_SKILL_OBSERVATIONS = 20_000;

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
  readLatestProviderQuota: async (callOptions) => {
    const result = await runReadEffect(
      queryLatestProviderQuotaObservations({
        dbPath: options.dbPath,
        maximumObservations: MAXIMUM_RAIL_QUOTA_OBSERVATIONS,
      }),
      callOptions,
    );
    return createProviderStatusDataset(
      result.observations.map(({ observation }) => projectProviderQuotaObservation(observation)),
      options.now === undefined ? undefined : new Date(options.now()),
    );
  },
  readLocalMergeBundle: (callOptions) =>
    runReadEffect(
      queryLocalMergeBundle({
        dbPath: options.dbPath,
        ...(options.now === undefined ? {} : { generatedAt: new Date(options.now()) }),
      }),
      callOptions,
    ),
  readLocalMachine: (callOptions) => runReadEffect(queryUsageLocalMachine({ dbPath: options.dbPath }), callOptions),
  readSkillObservations: async (callOptions) => {
    const result = await runReadEffect(
      querySkillObservations({
        dbPath: options.dbPath,
        maximumObservations: MAXIMUM_SKILL_OBSERVATIONS,
      }),
      callOptions,
    );
    return createSkillObservationDataset(
      result.observations.map(({ observation }) => observation),
      { lowerBound: result.truncated, skipped: result.skipped },
    );
  },
  readSyncFleet: (callOptions) => runReadEffect(queryUsageSyncFleet({ dbPath: options.dbPath }), callOptions),
});

export const createLiveUsageReadModel = (): UsageReadModel =>
  createSqliteUsageReadModel({ dbPath: resolveUsageWebRuntimePaths().databasePath });

export type UsageReadModelError = ServedRevisionQueryError | UsageStoreError;
