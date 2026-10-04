import type { DistillationEvidencePacket } from '@ai-usage/platform-core/distillation-evidence';
import type {
  DistillationJobView,
  DistillationLease,
  DistillationSearchResult,
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
export interface DistillationRepository {
  cancel(projectId: string, jobId: string): Promise<DistillationJobView>;
  claim(projectId: string, jobId: string): Promise<DistillationLease>;
  cleanup(projectId: string, before: string): Promise<{ removedPackets: number }>;
  get(projectId: string, analysisId: string): Promise<SessionAnalysis>;
  getGrant(projectId: string, analysisId: string): Promise<DistillationSourceGrant>;
  isProducerSession(machineId: string, nativeSessionId: string): Promise<boolean>;
  prepare(input: {
    packet: DistillationEvidencePacket;
    grant: DistillationSourceGrant;
    producerSessionId: string | null;
    revisionKey: string | null;
  }): Promise<DistillationJobView>;
  retry(projectId: string, jobId: string): Promise<DistillationJobView>;
  search(projectId: string, query: string, limit: number): Promise<DistillationSearchResult>;
  status(
    grant: Pick<DistillationSourceGrant, 'projectId' | 'machineId' | 'nativeSessionId'>,
  ): Promise<DistillationStatus>;
  submit(input: {
    projectId: string;
    jobId: string;
    leaseId: string;
    packetDigest: string;
    content: SessionAnalysisContent;
  }): Promise<SessionAnalysis>;
}
