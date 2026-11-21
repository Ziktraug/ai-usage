import { createClaudeDesktopSessionStore } from './claude-desktop-session-store';
import { withUsageStoreReader, withUsageStoreWriter } from './connections';
import { createDelegationStore } from './delegation-store';
import { usageStoreError, usageStoreReadError, usageStoreServedReadError } from './errors';
import { readUsageLocalMachineWithDatabase } from './machine-fleet';
import { createProviderQuotaStore } from './provider-quota-store';
import { readUsageStoreGenerations } from './report-rows';
import { createReviewAttemptStore } from './review-attempt-store';
import { createServedReportStore } from './served-report-store';
import { createSkillObservationStore } from './skill-observation-store';
import { createWorkFactStore } from './work-fact-store';
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

export {
  importExecutorObservations,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  queryLatestExecutorObservations,
} from './executor-observation-store';
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

export { importCodexWorkObservations, queryCodexWorkObservations } from './codex-work-store';

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
