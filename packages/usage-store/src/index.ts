import { withUsageStoreReader, withUsageStoreWriter } from './connections';
import { usageStoreError, usageStoreReadError, usageStoreServedReadError } from './errors';
import { readUsageLocalMachineWithDatabase } from './machine-fleet';
import { readUsageStoreGenerations } from './report-rows';
import { createServedReportStore } from './served-report-store';
import { createSkillObservationStore } from './skill-observation-store';
import { createWorkThreadStore } from './work-thread-store';

export { initializeUsageStore } from './connections';
export {
  queryEnrichableUsageRowChanges,
  queryEnrichableUsageRows,
  queryLocalRowsWatermark,
  upsertRtkSavingsContributions,
} from './enrichment';
export { UsageStoreError } from './errors';
export type { ImportResult } from './local-rows';
export {
  importLocalRows,
  retireLocalRows,
  USAGE_ROW_FRESHNESS_HEARTBEAT_MS,
  updateUsageMachineLabel,
} from './local-rows';
export { queryUsageMachineFleet, usageStorePath } from './machine-fleet';
export { USAGE_STORE_SCHEMA_VERSION } from './migration';
export type { PreviewPeerMergeBundleResult } from './peer-merge';
export { confirmPeerMergeBundle, importPeerMergeBundle, previewPeerMergeBundle } from './peer-merge';
export {
  exportLocalMergeBundle,
  queryReportRows,
  queryStoredReportCapture,
  queryUsageStoreGeneration,
  queryUsageStoreGenerations,
} from './report-rows';

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

export {
  importProviderQuotaBatch,
  queryLatestLocalProviderQuotaObservations,
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryProviderQuotaSourceStates,
  recordProviderQuotaSourceAttempt,
  retainProviderQuotaObservations,
} from './provider-quota-store';

export const { importSkillObservations, querySkillObservations, retainSkillObservations } = createSkillObservationStore(
  {
    usageStoreError,
    usageStoreReadError,
    withUsageStoreReader,
    withUsageStoreWriter,
  },
);

export {
  countClaudeDesktopSessions,
  importClaudeDesktopSessions,
  queryClaudeDesktopCollectionState,
  queryClaudeDesktopSessions,
  queryClaudeDesktopTurnDeclarations,
} from './claude-desktop-session-store';
export { importCodexWorkObservations, queryCodexWorkObservations } from './codex-work-store';
export {
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
} from './delegation-store';
export {
  importExecutorObservations,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  queryLatestExecutorObservations,
} from './executor-observation-store';
export {
  markReviewAttemptsLost,
  queryReviewAttempts,
  queryReviewReservations,
  queryReviewTargetResolution,
  releaseReviewAttemptReservation,
  requestReviewAttempt,
  transitionReviewAttempt,
} from './review-attempt-store';
export {
  importCheckoutStatusObservations,
  importJiraIssueObservations,
  importPullRequestObservations,
  queryJiraSyncState,
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryWorkFactRunStates,
  recordJiraSyncState,
  recordWorkFactRun,
} from './work-fact-store';

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

export { queryRecentServedHarnessSessions, querySessionRowsBySourceSessionIds } from './work-session-join';
