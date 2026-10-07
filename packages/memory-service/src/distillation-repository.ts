import type { DistillationCatalog } from '@ai-usage/platform-core/distillation-discovery';
import type { DistillationEvidencePacket } from '@ai-usage/platform-core/distillation-evidence';
import type {
  DistillationExtractorVersion,
  DistillationJobView,
  DistillationLease,
  DistillationSelection,
  DistillationStatus,
  SessionAnalysis,
  SessionAnalysisContent,
} from '@ai-usage/platform-core/session-distillation';

/** Internal runtime grant. Never accepted from a worker or exposed in a packet/browser response. */
export interface DistillationSourceGrant {
  checkoutPath: string;
  machineId: string;
  nativeSessionId: string;
  projectId: string;
  projectSourceId: string;
  selection: DistillationSelection;
}
export interface DistillationRepository extends DistillationCatalog {
  advance(
    input: DistillationStepSubmission & { nextPacket: DistillationEvidencePacket | null },
  ): Promise<DistillationJobView>;
  cancel(projectId: string, jobId: string): Promise<DistillationJobView>;
  claim(projectId: string, jobId: string): Promise<DistillationLease>;
  cleanup(projectId: string, before: string): Promise<{ removedPackets: number }>;
  get(projectId: string, analysisId: string): Promise<SessionAnalysis>;
  getEvidencePackets(
    projectId: string,
    analysisId: string,
    eventIds: string[],
  ): Promise<{ packet: Pick<DistillationEvidencePacket, 'packetDigest' | 'source' | 'window'>; eventIds: string[] }[]>;
  getGrant(projectId: string, analysisId: string): Promise<DistillationSourceGrant>;
  getJobPacket(
    projectId: string,
    jobId: string,
  ): Promise<{ packet: DistillationEvidencePacket; grant: DistillationSourceGrant }>;
  isProducerSession(machineId: string, nativeSessionId: string): Promise<boolean>;
  prepare(input: {
    packet: DistillationEvidencePacket;
    grant: DistillationSourceGrant;
    producerSessionId: string | null;
    revisionKey: string | null;
  }): Promise<DistillationJobView>;
  removalPreview(projectId: string, analysisId: string): Promise<DistillationRemovalPreview>;
  remove(
    projectId: string,
    analysisId: string,
    mode: 'withdraw' | 'purge',
  ): Promise<
    DistillationRemovalPreview & { mode: 'withdraw' | 'purge'; removedAnalyses: number; nativeHistoryUntouched: true }
  >;
  retry(projectId: string, jobId: string): Promise<DistillationJobView>;
  segment(
    projectId: string,
    jobId: string,
    snapshotDigest: string,
    segmentIndex: number,
  ): Promise<{ packet: DistillationEvidencePacket; checkpoint: SessionAnalysisContent | null; historical: true }>;
  status(
    grant: Pick<DistillationSourceGrant, 'projectId' | 'machineId' | 'nativeSessionId'>,
  ): Promise<DistillationStatus>;
  submit(input: {
    projectId: string;
    jobId: string;
    leaseId: string;
    packetDigest: string;
    content: SessionAnalysisContent;
    snapshotDigest?: string;
    segmentIndex?: number;
    extractorVersion?: DistillationExtractorVersion;
  }): Promise<SessionAnalysis>;
}

export interface DistillationRemovalPreview {
  analysesOmitted: number;
  analysisCount: number;
  analysisIds: string[];
  dependencies: { proposalId: string; acceptedItemId: string | null }[];
  dependenciesOmitted: number;
  dependencyCount: number;
  retainsKnowledge: true;
}

export interface DistillationStepSubmission {
  content: SessionAnalysisContent;
  extractorVersion?: DistillationExtractorVersion;
  jobId: string;
  leaseId: string;
  packetDigest: string;
  projectId: string;
  segmentIndex?: number;
  snapshotDigest?: string;
}
