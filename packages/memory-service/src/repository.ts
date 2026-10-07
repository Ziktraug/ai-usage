import type { AuthorizationPrincipal, AuthorizedResourceScope } from '@ai-usage/authorization-contract';
import type {
  Instant,
  MemoryImportId,
  MemoryItemId,
  MemoryObservationId,
  MemoryProposalId,
  MemoryRevisionId,
  PersonId,
  SpaceId,
} from '@ai-usage/platform-core/identity';
import type {
  CurrentMemoryItemResult,
  MemoryExportSnapshot,
  MemoryImport,
  MemoryItem,
  MemoryItemPage,
  MemoryItemResult,
  MemoryKind,
  MemoryObservation,
  MemoryProposal,
  MemoryProposalPage,
  MemoryRelation,
  MemoryRevision,
  MemorySensitivity,
  ReplicationOutboxEvent,
} from './domain';
import type { MemorySearchPage, SearchMemoryRepositoryQuery } from './search';

export type MemoryRepositoryErrorCode =
  | 'cancelled'
  | 'conflict'
  | 'invalid-input'
  | 'not-found'
  | 'stale'
  | 'timeout'
  | 'unavailable';

export class MemoryRepositoryError extends Error {
  readonly code: MemoryRepositoryErrorCode;
  readonly operation: string;

  constructor(code: MemoryRepositoryErrorCode, operation: string) {
    super('The Memory repository operation failed.');
    this.name = 'MemoryRepositoryError';
    this.code = code;
    this.operation = operation;
  }
}

export interface MemoryAuditEvent {
  readonly action: string;
  readonly actor: AuthorizationPrincipal;
  readonly recordedAt: Instant;
  readonly result: 'allowed' | 'applied' | 'denied' | 'rejected';
  readonly spaceId: SpaceId;
  readonly subjectId: string;
  readonly subjectType: 'memory-import' | 'memory-item' | 'memory-observation' | 'memory-proposal' | 'memory-relation';
}

export interface RecordObservationInput {
  readonly audit: MemoryAuditEvent;
  readonly observation: MemoryObservation;
}

export interface CreateProposalInput {
  readonly audit: MemoryAuditEvent;
  /** Paired with localAnalysisSource; revalidate that source and commit both records atomically, or reject. */
  readonly localAnalysisObservation?: RecordObservationInput;
  readonly localAnalysisSource?: LocalAnalysisPromotionSource;
  readonly observationIds: readonly MemoryObservationId[];
  readonly proposal: MemoryProposal;
}

/** Local publication consent is independent of sensitivity and survives acceptance. */
export interface LocalAnalysisPromotionSource {
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly elementKey: string;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly snapshotDigest: string;
}

export interface AcceptProposalInput {
  readonly audit: MemoryAuditEvent;
  readonly item: MemoryItem;
  readonly outboxEvent: ReplicationOutboxEvent | null;
  readonly proposalId: MemoryProposalId;
  readonly reviewedAt: Instant;
  readonly reviewerPersonId: PersonId;
  readonly revision: MemoryRevision;
}

export interface RejectProposalInput {
  readonly audit: MemoryAuditEvent;
  readonly proposalId: MemoryProposalId;
  readonly reason: string;
  readonly reviewedAt: Instant;
  readonly reviewerPersonId: PersonId;
  readonly spaceId: SpaceId;
}

export interface ReviseMemoryItemInput {
  readonly audit: MemoryAuditEvent;
  readonly expectedCurrentRevisionId: MemoryRevisionId;
  readonly outboxEvent: ReplicationOutboxEvent | null;
  readonly revision: MemoryRevision;
  readonly sensitivity: MemorySensitivity;
  readonly spaceId: SpaceId;
}

export interface SupersedeMemoryItemInput {
  readonly audit: MemoryAuditEvent;
  readonly itemId: MemoryItemId;
  readonly outboxEvent: ReplicationOutboxEvent | null;
  readonly reason: string;
  readonly spaceId: SpaceId;
  readonly supersededAt: Instant;
}

export interface PurgeMemoryItemInput {
  readonly audit: MemoryAuditEvent;
  readonly itemId: MemoryItemId;
  readonly outboxEvent: ReplicationOutboxEvent | null;
  readonly spaceId: SpaceId;
}

export interface ListMemoryItemsQuery {
  readonly authorizationScope: AuthorizedResourceScope;
  readonly cursor?: string | null;
  readonly kind?: MemoryKind | null;
  readonly pageSize: number;
  readonly projectId?: string | null;
  readonly spaceId: SpaceId;
  readonly status?: MemoryItem['status'];
}

export interface ListMemoryProposalsQuery {
  readonly authorizationScope: AuthorizedResourceScope;
  readonly cursor?: string | null;
  /**
   * Addresses one proposal: the page starts at it (inclusive) instead of after `cursor`, so a
   * proposal is reachable wherever it sits in the queue without reading the pages before it. A
   * proposal that is absent, unauthorized or not in `status` fails as `not-found`.
   */
  readonly fromProposalId?: MemoryProposalId | null;
  readonly pageSize: number;
  readonly spaceId: SpaceId;
  readonly status: MemoryProposal['status'];
}

export interface PreviewMemoryImportInput {
  readonly audit: MemoryAuditEvent;
  readonly contentHash: string;
  readonly createdAt: Instant;
  readonly destinationProjectId: string | null;
  readonly destinationSpaceId: SpaceId;
  readonly fingerprint: string;
  readonly id: MemoryImportId;
  readonly observationFingerprints: readonly string[];
  readonly sourceKind: MemoryImport['sourceKind'];
  readonly sourceLocator: string;
  readonly status: 'previewed' | 'quarantined';
}

export interface PreviewMemoryImportResult {
  readonly alreadyConfirmed: boolean;
  readonly duplicateObservationFingerprints: readonly string[];
  readonly memoryImport: MemoryImport;
}

export interface ConfirmMemoryImportRecord {
  readonly item: MemoryItem | null;
  readonly observation: MemoryObservation;
  readonly outboxEvent: ReplicationOutboxEvent | null;
  readonly proposal: MemoryProposal;
  readonly revision: MemoryRevision | null;
}

export interface ConfirmMemoryImportInput {
  readonly audit: MemoryAuditEvent;
  readonly confirmedAt: Instant;
  readonly confirmedByPersonId: PersonId;
  readonly importId: MemoryImportId;
  readonly previewProof: string;
  readonly records: readonly ConfirmMemoryImportRecord[];
  readonly relations: readonly MemoryRelation[];
  readonly spaceId: SpaceId;
}

export type ConfirmMemoryImportResult =
  | { readonly kind: 'already-confirmed' }
  | { readonly kind: 'confirmed'; readonly importedObservationFingerprints: readonly string[] }
  | { readonly kind: 'quarantined' }
  | { readonly kind: 'stale' };

export interface ExportMemoryQuery {
  readonly authorizationScope: AuthorizedResourceScope;
  readonly projectId?: string | null;
  readonly spaceId: SpaceId;
}

export interface MemoryRepository {
  readonly acceptProposal: (input: AcceptProposalInput) => Promise<CurrentMemoryItemResult>;
  readonly confirmImport: (input: ConfirmMemoryImportInput) => Promise<ConfirmMemoryImportResult>;
  readonly createProposal: (input: CreateProposalInput) => Promise<MemoryProposalId>;
  readonly createRelation: (relation: MemoryRelation, audit: MemoryAuditEvent) => Promise<void>;
  readonly exportMemory: (query: ExportMemoryQuery) => Promise<MemoryExportSnapshot>;
  readonly getItem: (
    spaceId: SpaceId,
    itemId: MemoryItemId,
    revisionId?: MemoryRevisionId | null,
  ) => Promise<MemoryItemResult | null>;
  readonly getProposal: (spaceId: SpaceId, proposalId: MemoryProposalId) => Promise<MemoryProposal | null>;
  readonly listAuthorizationResourceIds: (spaceId: SpaceId) => Promise<readonly string[]>;
  readonly listItems: (query: ListMemoryItemsQuery) => Promise<MemoryItemPage>;
  readonly listProposals: (query: ListMemoryProposalsQuery) => Promise<MemoryProposalPage>;
  readonly previewImport: (input: PreviewMemoryImportInput) => Promise<PreviewMemoryImportResult>;
  readonly purgeItem: (input: PurgeMemoryItemInput) => Promise<void>;
  readonly recordAuditEvent: (audit: MemoryAuditEvent) => Promise<void>;
  readonly recordObservation: (
    input: RecordObservationInput,
  ) => Promise<{ readonly created: boolean; readonly id: MemoryObservationId }>;
  readonly rejectProposal: (input: RejectProposalInput) => Promise<void>;
  readonly reviseItem: (input: ReviseMemoryItemInput) => Promise<MemoryRevision>;
  readonly searchItems: (query: SearchMemoryRepositoryQuery) => Promise<MemorySearchPage>;
  readonly supersedeItem: (input: SupersedeMemoryItemInput) => Promise<void>;
}
