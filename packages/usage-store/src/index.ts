// biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127
import {
  createUsageMergeBundle,
  deserializeMergeRow,
  isSerializedMergeRow,
  type UsageMergeBundle,
} from '@ai-usage/report-core/merge-bundle';
import { MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { createClaudeDesktopSessionStore } from './claude-desktop-session-store';
import { createCodexWorkStore } from './codex-work-store';
import { withUsageStoreReader, withUsageStoreWriter } from './connections';
import { createDelegationStore } from './delegation-store';
import {
  type QueryEnrichableUsageRowsInput,
  type QueryEnrichableUsageRowsResult,
  queryEnrichableUsageRows,
  type UpsertRtkSavingsContributionsInput,
  upsertRtkSavingsContributions,
} from './enrichment';
import { type UsageStoreError, usageStoreError, usageStoreReadError, usageStoreServedReadError } from './errors';
import { createExecutorObservationStore } from './executor-observation-store';
import {
  type ImportLocalRowsInput,
  type ImportResult,
  importLocalRows,
  type RetireLocalRowsInput,
  type RetireLocalRowsResult,
  retireLocalRows,
  type UpdateUsageMachineLabelInput,
  type UpdateUsageMachineLabelResult,
  updateUsageMachineLabel,
} from './local-rows';
import {
  injectLocalProjectionReadPhase,
  type QueryUsageMachineFleetInput,
  type QueryUsageMachineFleetResult,
  queryUsageMachineFleet,
  queryUsageMachineFleetWithDatabase,
  readUsageLocalMachineWithDatabase,
} from './machine-fleet';
import {
  type ConfirmPeerMergeBundleInput,
  confirmPeerMergeBundle,
  type ImportPeerMergeBundleInput,
  importPeerMergeBundle,
  type PreviewPeerMergeBundleInput,
  type PreviewPeerMergeBundleResult,
  previewPeerMergeBundle,
} from './peer-merge';
import { createProviderQuotaStore } from './provider-quota-store';
import type { UsageStoreGenerations } from './report-rows';
import { createReviewAttemptStore } from './review-attempt-store';
import {
  type EnrichmentImportResult,
  enrichmentContentHash,
  isRtkSavingsContribution,
  RTK_SAVINGS_SCHEMA_VERSION,
  RTK_SAVINGS_SOURCE_ID,
  type RtkSavingsContribution,
  type StoredEnrichmentRecord,
  stripRtkSavings,
} from './rtk-savings';
import { createServedReportStore } from './served-report-store';
import { createSkillObservationStore } from './skill-observation-store';
import type { SqliteDatabase } from './sqlite-database';
import type { StoredRowRecord, StoredSourceAuthority, StoredUsageRowStatus } from './stored-usage-row';
import { createWorkFactStore } from './work-fact-store';
import { createWorkSessionJoinStore } from './work-session-join';
import { createWorkThreadStore } from './work-thread-store';

export type {
  CheckpointUsageStoreInput,
  CheckpointUsageStoreResult,
  InitializeUsageStoreInput,
  QuiesceUsageStoreForShutdownInput,
} from './connections';
export { checkpointUsageStore, initializeUsageStore, quiesceUsageStoreForShutdown } from './connections';
export type {
  EnrichableUsageRow,
  EnrichableUsageRowChange,
  LocalRowsWatermark,
  QueryEnrichableUsageRowChangesInput,
  QueryEnrichableUsageRowChangesResult,
  QueryEnrichableUsageRowsInput,
  QueryEnrichableUsageRowsResult,
  QueryLocalRowsWatermarkInput,
  RtkSavingsContributionInput,
  UpsertRtkSavingsContributionsInput,
} from './enrichment';
export {
  queryEnrichableUsageRowChanges,
  queryEnrichableUsageRows,
  queryLocalRowsWatermark,
  upsertRtkSavingsContributions,
} from './enrichment';
export type {
  ImportLocalRowsInput,
  ImportResult,
  RetireLocalRowsInput,
  RetireLocalRowsResult,
  UpdateUsageMachineLabelInput,
  UpdateUsageMachineLabelResult,
} from './local-rows';
export {
  importLocalRows,
  retireLocalRows,
  USAGE_ROW_FRESHNESS_HEARTBEAT_MS,
  updateUsageMachineLabel,
} from './local-rows';
export type {
  LocalProjectionReadPhase,
  QueryUsageLocalMachineInput,
  QueryUsageMachineFleetInput,
  QueryUsageMachineFleetResult,
  QueryUsageSyncFleetResult,
  UsageMachineFleetItem,
} from './machine-fleet';
export {
  MAX_USAGE_MACHINE_FLEET_MACHINES,
  queryUsageLocalMachine,
  queryUsageMachineFleet,
  queryUsageSyncFleet,
  setLocalProjectionReadFaultInjectorForTesting,
  usageStorePath,
} from './machine-fleet';
export { USAGE_STORE_SCHEMA_VERSION } from './migration';
export type {
  ConfirmPeerMergeBundleInput,
  ImportPeerMergeBundleInput,
  PreviewPeerMergeBundleInput,
  PreviewPeerMergeBundleResult,
} from './peer-merge';
export { confirmPeerMergeBundle, importPeerMergeBundle, previewPeerMergeBundle } from './peer-merge';

export type {
  ImportProviderQuotaBatchInput,
  ProviderQuotaCheckpointUpdate,
  ProviderQuotaImportItem,
  ProviderQuotaImportResult,
  ProviderQuotaSourceState,
  QueryLatestLocalProviderQuotaObservationsInput,
  QueryLatestProviderQuotaObservationsInput,
  QueryProviderQuotaObservationsInput,
  QueryProviderQuotaObservationsResult,
  QueryProviderQuotaSourceStateInput,
  QueryProviderQuotaSourceStatesInput,
  RecordProviderQuotaSourceAttemptInput,
  RetainProviderQuotaObservationsInput,
  RetainProviderQuotaObservationsResult,
  StoredProviderQuotaObservation,
} from './provider-quota-store';
export type { UsageStoreGenerations } from './report-rows';
export type { EnrichmentImportResult, RtkSavingsContribution } from './rtk-savings';
export type {
  CurrentServedLocalProjectSources,
  PublishServedReportRevisionCapture,
  PublishServedReportRevisionContext,
  PublishServedReportRevisionInput,
  PublishServedReportRevisionResult,
  PublishServedRevisionValidationCache,
  QueryServedReportRevisionInput,
  QueryServedReportRevisionLocalSnapshotInput,
  QueryServedRevisionDataInput,
  QueryServedSessionPullRequestLinksInput,
  RetainServedReportRevisionsInput,
  RetainServedReportRevisionsResult,
  ServedLocalProjectSource,
  ServedReportPublicationPhase,
  ServedReportReadPhase,
  ServedReportRevisionBootstrap,
  ServedReportRevisionLocalSnapshot,
  ServedReportRevisionManifest,
  ServedReportRevisionPortableConfig,
  ServedReportRevisionRows,
  ServedReportRevisionSlices,
  ServedReportRevisionSupport,
  ServedSessionPullRequestLink,
  ServedSessionPullRequestLinks,
} from './served-report-store';
export type {
  ImportSkillObservationsInput,
  QuerySkillObservationsInput,
  QuerySkillObservationsResult,
  RetainSkillObservationsInput,
  RetainSkillObservationsResult,
  SkillObservationImportResult,
  StoredSkillObservation,
} from './skill-observation-store';
export type { StoredSourceAuthority, StoredUsageRowStatus } from './stored-usage-row';
export type {
  ImportCheckoutStatusObservationsInput,
  ImportJiraIssueObservationsInput,
  ImportPullRequestObservationsInput,
  LatestCheckoutStatusObservations,
  LatestJiraIssueObservations,
  LatestPullRequestObservations,
  QueryLatestCheckoutStatusObservationsInput,
  QueryLatestJiraIssueObservationsInput,
  QueryLatestPullRequestObservationsInput,
  QueryWorkFactRunStatesInput,
  RecordWorkFactRunInput,
  WorkFactImportResult,
  WorkFactRunState,
  WorkFactRunStates,
} from './work-fact-store';

export interface ExportLocalMergeBundleInput {
  dbPath: string;
  generatedAt?: Date;
  machine: UsageMachine;
}

export interface QueryLocalMergeBundleInput {
  readonly dbPath: string;
  readonly generatedAt?: Date;
}

export interface QueryReportRowsInput {
  dbPath: string;
  harnessKeys?: string[];
  originMachineIds?: string[];
  sourceAuthorities?: StoredSourceAuthority[];
  statuses?: StoredUsageRowStatus[];
}

export interface QueryRowsResult {
  rows: CollectedUsageRow[];
  /** Stored rows that failed validation and were skipped so a single corrupt row cannot block the report. */
  skipped: number;
  sourceAuthorities: StoredSourceAuthority[];
}

export interface QueryStoredReportCaptureInput extends QueryReportRowsInput {
  maximumMachines?: number;
}

export interface QueryStoredReportCaptureResult {
  generations: UsageStoreGenerations;
  machineFleet: QueryUsageMachineFleetResult;
  reportRows: QueryRowsResult;
}

export interface QueryUsageStoreGenerationInput {
  dbPath: string;
}

export type { UsageStoreErrorReason } from './errors';
export { UsageStoreError } from './errors';

export interface UsageStore {
  confirmPeerMergeBundle: (input: ConfirmPeerMergeBundleInput) => Effect.Effect<ImportResult, UsageStoreError>;
  exportLocalMergeBundle: (input: ExportLocalMergeBundleInput) => Effect.Effect<UsageMergeBundle, UsageStoreError>;
  importLocalRows: (input: ImportLocalRowsInput) => Effect.Effect<ImportResult, UsageStoreError>;
  importPeerMergeBundle: (input: ImportPeerMergeBundleInput) => Effect.Effect<ImportResult, UsageStoreError>;
  previewPeerMergeBundle: (
    input: PreviewPeerMergeBundleInput,
  ) => Effect.Effect<PreviewPeerMergeBundleResult, UsageStoreError>;
  queryEnrichableUsageRows: (
    input?: QueryEnrichableUsageRowsInput,
  ) => Effect.Effect<QueryEnrichableUsageRowsResult, UsageStoreError>;
  queryReportRows: (input?: QueryReportRowsInput) => Effect.Effect<QueryRowsResult, UsageStoreError>;
  queryStoredReportCapture: (
    input?: QueryStoredReportCaptureInput,
  ) => Effect.Effect<QueryStoredReportCaptureResult, UsageStoreError>;
  queryUsageMachineFleet: (
    input?: QueryUsageMachineFleetInput,
  ) => Effect.Effect<QueryUsageMachineFleetResult, UsageStoreError>;
  queryUsageStoreGeneration: (input?: QueryUsageStoreGenerationInput) => Effect.Effect<number, UsageStoreError>;
  queryUsageStoreGenerations: (
    input?: QueryUsageStoreGenerationInput,
  ) => Effect.Effect<UsageStoreGenerations, UsageStoreError>;
  retireLocalRows: (input: RetireLocalRowsInput) => Effect.Effect<RetireLocalRowsResult, UsageStoreError>;
  updateUsageMachineLabel: (
    input: UpdateUsageMachineLabelInput,
  ) => Effect.Effect<UpdateUsageMachineLabelResult, UsageStoreError>;
  upsertRtkSavingsContributions: (
    input: UpsertRtkSavingsContributionsInput,
  ) => Effect.Effect<EnrichmentImportResult, UsageStoreError>;
}

const readReportRows = (db: SqliteDatabase, input: QueryReportRowsInput): QueryRowsResult => {
  const statuses = input.statuses?.length ? input.statuses : (['active'] satisfies StoredUsageRowStatus[]);
  const params: unknown[] = [...statuses];
  let sql = `SELECT row_key, row_json, source_authority FROM usage_rows WHERE status IN (${statuses.map(() => '?').join(', ')})`;

  if (input.originMachineIds?.length) {
    sql += ` AND origin_machine_id IN (${input.originMachineIds.map(() => '?').join(', ')})`;
    params.push(...input.originMachineIds);
  }

  if (input.harnessKeys?.length) {
    sql += ` AND harness_key IN (${input.harnessKeys.map(() => '?').join(', ')})`;
    params.push(...input.harnessKeys);
  }

  if (input.sourceAuthorities?.length) {
    sql += ` AND source_authority IN (${input.sourceAuthorities.map(() => '?').join(', ')})`;
    params.push(...input.sourceAuthorities);
  }

  sql += " ORDER BY COALESCE(active_date, '') DESC, row_key ASC";
  const records = db.query(sql).all(...params) as StoredRowRecord[];
  const rowKeys = records.map(({ row_key }) => row_key);
  const rowKeySet = new Set(rowKeys);
  const enrichments =
    rowKeys.length === 0
      ? []
      : (
          db
            .query(`
                  SELECT row_key, source_id, schema_version, content_hash, payload_json
                  FROM usage_row_enrichments
                  WHERE source_id = ?
                `)
            .all(RTK_SAVINGS_SOURCE_ID) as StoredEnrichmentRecord[]
        ).filter(({ row_key }) => rowKeySet.has(row_key));
  const rtkByRowKey = new Map<string, RtkSavingsContribution>();
  let skipped = 0;
  for (const enrichment of enrichments) {
    let payload: unknown;
    try {
      payload = JSON.parse(enrichment.payload_json) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (
      enrichment.schema_version !== RTK_SAVINGS_SCHEMA_VERSION ||
      enrichment.source_id !== RTK_SAVINGS_SOURCE_ID ||
      !isRtkSavingsContribution(payload) ||
      enrichment.content_hash !== enrichmentContentHash(payload)
    ) {
      skipped += 1;
      continue;
    }
    rtkByRowKey.set(enrichment.row_key, payload);
  }
  const rows: CollectedUsageRow[] = [];
  const sourceAuthorities: StoredSourceAuthority[] = [];
  for (const record of records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.row_json) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (isSerializedMergeRow(parsed)) {
      const base = stripRtkSavings(deserializeMergeRow(parsed));
      const contribution = rtkByRowKey.get(record.row_key);
      rows.push(contribution ? { ...base, ...contribution } : base);
      sourceAuthorities.push(record.source_authority);
    } else {
      skipped += 1;
    }
  }
  return { rows, skipped, sourceAuthorities };
};

export const queryReportRows = (input: QueryReportRowsInput): Effect.Effect<QueryRowsResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => readReportRows(db, input),
      catch: (cause) => usageStoreReadError('queryReportRows', input.dbPath, cause),
    }),
  );

const assertLocalMergeBundleRowBudget = (db: SqliteDatabase, dbPath: string, machineId: string): void => {
  const boundedRows = db
    .query(`
      SELECT row_key
      FROM usage_rows
      WHERE origin_machine_id = ? AND source_authority = 'local-observed' AND status = 'active'
      LIMIT ?
    `)
    .all(machineId, MAX_PORTABLE_USAGE_ROWS + 1);
  if (boundedRows.length <= MAX_PORTABLE_USAGE_ROWS) {
    return;
  }
  const record = db
    .query(`
      SELECT COUNT(*) AS row_count
      FROM usage_rows
      WHERE origin_machine_id = ? AND source_authority = 'local-observed' AND status = 'active'
    `)
    .get(machineId) as { row_count: number } | null;
  const rowCount = record?.row_count;
  if (!(Number.isSafeInteger(rowCount) && Number(rowCount) > MAX_PORTABLE_USAGE_ROWS)) {
    throw usageStoreError('queryLocalMergeBundle', dbPath, 'The local export row count is invalid.', 'corrupt');
  }
  throw usageStoreError(
    'queryLocalMergeBundle',
    dbPath,
    `Usage merge bundle contains ${rowCount} rows; maximum is ${MAX_PORTABLE_USAGE_ROWS}`,
    'invalid-input',
  );
};

export const queryLocalMergeBundle = (
  input: QueryLocalMergeBundleInput,
): Effect.Effect<UsageMergeBundle, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => db.exec('BEGIN'),
        catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
      });
      return yield* Effect.gen(function* () {
        const machine = yield* Effect.try({
          try: () => readUsageLocalMachineWithDatabase(db, input.dbPath),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        yield* Effect.tryPromise({
          try: () => injectLocalProjectionReadPhase('local-bundle-after-machine'),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        yield* Effect.try({
          try: () => assertLocalMergeBundleRowBudget(db, input.dbPath, machine.id),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        const result = yield* Effect.try({
          try: () =>
            readReportRows(db, {
              dbPath: input.dbPath,
              originMachineIds: [machine.id],
              sourceAuthorities: ['local-observed'],
            }),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        const bundle = yield* Effect.try({
          try: () =>
            createUsageMergeBundle({
              machine,
              rows: result.rows,
              ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
            }),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        yield* Effect.try({
          try: () => db.exec('COMMIT'),
          catch: (cause) => usageStoreReadError('queryLocalMergeBundle', input.dbPath, cause),
        });
        return bundle;
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            try {
              db.exec('ROLLBACK');
            } catch {
              // The read failure remains authoritative.
            }
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    }),
  );

const readUsageStoreGenerations = (db: SqliteDatabase): UsageStoreGenerations => {
  const records = db
    .query(`
      SELECT key, value
      FROM usage_store_metadata
      WHERE key IN ('generation', 'machine_fleet_generation')
    `)
    .all() as Array<{ key: string; value: number }>;
  const metadata = new Map(records.map(({ key, value }) => [key, value]));
  const machineFleetGeneration = metadata.get('machine_fleet_generation');
  const usageStoreGeneration = metadata.get('generation');
  if (
    !(
      Number.isSafeInteger(machineFleetGeneration) &&
      Number(machineFleetGeneration) >= 0 &&
      Number.isSafeInteger(usageStoreGeneration) &&
      Number(usageStoreGeneration) >= 0
    )
  ) {
    throw new Error('Usage store generation metadata is missing or invalid');
  }
  return {
    machineFleetGeneration: Number(machineFleetGeneration),
    usageStoreGeneration: Number(usageStoreGeneration),
  };
};

export const queryUsageStoreGenerations = (
  input: QueryUsageStoreGenerationInput,
): Effect.Effect<UsageStoreGenerations, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => readUsageStoreGenerations(db),
      catch: (cause) => usageStoreReadError('queryUsageStoreGenerations', input.dbPath, cause),
    }),
  );

export const queryUsageStoreGeneration = (
  input: QueryUsageStoreGenerationInput,
): Effect.Effect<number, UsageStoreError> =>
  queryUsageStoreGenerations(input).pipe(Effect.map(({ usageStoreGeneration }) => usageStoreGeneration));

export const queryStoredReportCapture = (
  input: QueryStoredReportCaptureInput,
): Effect.Effect<QueryStoredReportCaptureResult, UsageStoreError> =>
  withUsageStoreReader(input.dbPath, (db) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => db.exec('BEGIN'),
        catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
      });
      return yield* Effect.gen(function* () {
        const generations = yield* Effect.try({
          try: () => readUsageStoreGenerations(db),
          catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
        });
        const reportRows = yield* Effect.try({
          try: () => readReportRows(db, input),
          catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
        });
        const machineFleet = yield* queryUsageMachineFleetWithDatabase(db, {
          dbPath: input.dbPath,
          ...(input.maximumMachines === undefined ? {} : { maximumMachines: input.maximumMachines }),
        });
        yield* Effect.try({
          try: () => db.exec('COMMIT'),
          catch: (cause) => usageStoreReadError('queryStoredReportCapture', input.dbPath, cause),
        });
        return { generations, machineFleet, reportRows };
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            try {
              db.exec('ROLLBACK');
            } catch {
              // The capture failure remains authoritative.
            }
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    }),
  );

export const {
  setServedReportPublicationFaultInjectorForTesting,
  setServedReportReadFaultInjectorForTesting,
  queryServedRevisionData,
  queryCurrentServedReportRevision,
  queryCurrentServedReportRevisionBootstrap,
  queryCurrentServedLocalProjectSources,
  queryServedSessionPullRequestLinks,
  queryServedReportRevisionSupport,
  queryServedReportRevisionRows,
  queryServedReportRevisionSlices,
  queryServedReportRevisionPortableConfig,
  queryServedReportRevisionLocalSnapshot,
  publishServedReportRevision,
  retainServedReportRevisions,
} = createServedReportStore({
  readUsageLocalMachineWithDatabase,
  readUsageStoreGenerations,
  usageStoreError,
  usageStoreServedReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const {
  importProviderQuotaBatch,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryProviderQuotaSourceStates,
  queryLatestProviderQuotaObservations,
  queryLatestLocalProviderQuotaObservations,
  recordProviderQuotaSourceAttempt,
  retainProviderQuotaObservations,
} = createProviderQuotaStore({
  readUsageLocalMachineWithDatabase,
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const { importSkillObservations, querySkillObservations, retainSkillObservations } = createSkillObservationStore(
  {
    usageStoreError,
    usageStoreReadError,
    withUsageStoreReader,
    withUsageStoreWriter,
  },
);

export const {
  importExecutorObservations,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  queryLatestExecutorObservations,
} = createExecutorObservationStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export const {
  importCheckoutStatusObservations,
  importJiraIssueObservations,
  importPullRequestObservations,
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryWorkFactRunStates,
  recordWorkFactRun,
  queryJiraSyncState,
  recordJiraSyncState,
} = createWorkFactStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export { WORK_FACT_SOURCE_IDS, type WorkFactSourceId } from './work-fact-store';
export const {
  countClaudeDesktopSessions,
  importClaudeDesktopSessions,
  queryClaudeDesktopCollectionState,
  queryClaudeDesktopSessions,
  queryClaudeDesktopTurnDeclarations,
} = createClaudeDesktopSessionStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export const {
  markReviewAttemptsLost,
  queryReviewAttempts,
  queryReviewReservations,
  queryReviewTargetResolution,
  releaseReviewAttemptReservation,
  requestReviewAttempt,
  transitionReviewAttempt,
} = createReviewAttemptStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export const {
  countDelegationRetryChain,
  markDelegationJobsLost,
  queryDelegationEvaluations,
  queryDelegationJobs,
  readDelegationJob,
  readDelegationJobs,
  readDelegationQualification,
  recordDelegationEvaluation,
  recordDelegationQualification,
  releaseDelegationJobReservation,
  requestDelegationCancel,
  requestDelegationJob,
  transitionDelegationJob,
} = createDelegationStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const { importCodexWorkObservations, queryCodexWorkObservations } = createCodexWorkStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});

export const {
  applyWorkThreadCommand,
  applyWorkThreadWaitObservations,
  attachDeclaredWorkThreadSessions,
  countWorkThreads,
  queryActiveWorkThreadLinks,
  queryJiraIntake,
  queryWorkThreadById,
  queryWorkThreadCombinations,
  queryWorkThreadCombineSuggestions,
  queryWorkThreadEvents,
  queryWorkThreadLinks,
  queryWorkThreadProjects,
  queryWorkThreadWaitCandidates,
  queryWorkThreadSessionEvidence,
  queryWorkThreadsPage,
  reconcileWorkBranches,
  recordJiraIntake,
  seedWorkThreads,
} = createWorkThreadStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
  withUsageStoreWriter,
});
export type {
  ApplyWorkThreadCommandInput,
  ApplyWorkThreadWaitObservationsInput,
  ApplyWorkThreadWaitObservationsResult,
  AttachDeclaredWorkThreadSessionsInput,
  AttachDeclaredWorkThreadSessionsResult,
  DeclaredWorkThreadSession,
  JiraIntakeEntry,
  QueryActiveWorkThreadLinksInput,
  QueryActiveWorkThreadLinksResult,
  QueryJiraIntakeInput,
  QueryJiraIntakeResult,
  QueryWorkThreadByIdInput,
  QueryWorkThreadCombineSuggestionsResult,
  QueryWorkThreadLinksInput,
  QueryWorkThreadSessionEvidenceInput,
  QueryWorkThreadsPageInput,
  QueryWorkThreadsPageResult,
  QueryWorkThreadWaitCandidatesInput,
  QueryWorkThreadWaitCandidatesResult,
  ReconcileWorkBranchesInput,
  ReconcileWorkBranchesResult,
  RecordJiraIntakeInput,
  SeedWorkThreadsInput,
  SeedWorkThreadsResult,
  WorkThreadCombination,
  WorkThreadCombineSuggestionEntry,
  WorkThreadPageRow,
  WorkThreadSeed,
  WorkThreadSessionEvidence,
  WorkThreadWaitCandidate,
} from './work-thread-store';

export const exportLocalMergeBundle = (
  input: ExportLocalMergeBundleInput,
): Effect.Effect<UsageMergeBundle, UsageStoreError> =>
  queryReportRows({
    dbPath: input.dbPath,
    originMachineIds: [input.machine.id],
    sourceAuthorities: ['local-observed'],
  }).pipe(
    Effect.map((result) =>
      createUsageMergeBundle({
        machine: input.machine,
        rows: result.rows,
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      }),
    ),
  );

export const createUsageStore = (dbPath: string): UsageStore => ({
  exportLocalMergeBundle: (input) => exportLocalMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  importLocalRows: (input) => importLocalRows({ ...input, dbPath: input.dbPath ?? dbPath }),
  importPeerMergeBundle: (input) => importPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  previewPeerMergeBundle: (input) => previewPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  confirmPeerMergeBundle: (input) => confirmPeerMergeBundle({ ...input, dbPath: input.dbPath ?? dbPath }),
  queryReportRows: (input) => queryReportRows({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryStoredReportCapture: (input) => queryStoredReportCapture({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryEnrichableUsageRows: (input) => queryEnrichableUsageRows({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageMachineFleet: (input) => queryUsageMachineFleet({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageStoreGenerations: (input) =>
    queryUsageStoreGenerations({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  queryUsageStoreGeneration: (input) =>
    queryUsageStoreGeneration({ ...(input ?? {}), dbPath: input?.dbPath ?? dbPath }),
  retireLocalRows: (input) => retireLocalRows({ ...input, dbPath: input.dbPath ?? dbPath }),
  updateUsageMachineLabel: (input) => updateUsageMachineLabel({ ...input, dbPath: input.dbPath ?? dbPath }),
  upsertRtkSavingsContributions: (input) => upsertRtkSavingsContributions({ ...input, dbPath: input.dbPath ?? dbPath }),
});

export const { queryRecentServedHarnessSessions, querySessionRowsBySourceSessionIds } = createWorkSessionJoinStore({
  usageStoreError,
  usageStoreReadError,
  withUsageStoreReader,
});
