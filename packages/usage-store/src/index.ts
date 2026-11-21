// biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127
import type { UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { Effect } from 'effect';
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
  type QueryUsageMachineFleetInput,
  type QueryUsageMachineFleetResult,
  queryUsageMachineFleet,
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
import {
  type ExportLocalMergeBundleInput,
  exportLocalMergeBundle,
  type QueryReportRowsInput,
  type QueryRowsResult,
  type QueryStoredReportCaptureInput,
  type QueryStoredReportCaptureResult,
  type QueryUsageStoreGenerationInput,
  queryReportRows,
  queryStoredReportCapture,
  queryUsageStoreGeneration,
  queryUsageStoreGenerations,
  readUsageStoreGenerations,
  type UsageStoreGenerations,
} from './report-rows';
import { createReviewAttemptStore } from './review-attempt-store';
import type { EnrichmentImportResult } from './rtk-savings';
import { createServedReportStore } from './served-report-store';
import { createSkillObservationStore } from './skill-observation-store';
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
export type { UsageStoreErrorReason } from './errors';
export { UsageStoreError } from './errors';
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
export type {
  ExportLocalMergeBundleInput,
  QueryLocalMergeBundleInput,
  QueryReportRowsInput,
  QueryRowsResult,
  QueryStoredReportCaptureInput,
  QueryStoredReportCaptureResult,
  QueryUsageStoreGenerationInput,
  UsageStoreGenerations,
} from './report-rows';
export {
  exportLocalMergeBundle,
  queryLocalMergeBundle,
  queryReportRows,
  queryStoredReportCapture,
  queryUsageStoreGeneration,
  queryUsageStoreGenerations,
} from './report-rows';
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
