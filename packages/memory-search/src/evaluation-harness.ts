import { createHash } from 'node:crypto';
import type { AuthorizationPrincipal } from '@ai-usage/authorization-contract';
import {
  MEMORY_REDACTION_RULE_SET_VERSION,
  type MemoryItem,
  type MemoryObservation,
  type MemoryProposal,
  type MemoryRevision,
  memoryContentHash,
} from '@ai-usage/memory-service/domain';
import type { MemoryAuditEvent, MemoryRepository } from '@ai-usage/memory-service/repository';
import {
  type PersonId,
  type ProjectId,
  parseInstant,
  parseMemoryObservationId,
  parseMemoryProposalId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import type { MemorySearchEvaluationDocument } from './evaluation';

export interface SeedMemorySearchEvaluationInput {
  readonly documents: readonly MemorySearchEvaluationDocument[];
  readonly personId: PersonId;
  readonly projectId: ProjectId | null;
  readonly repository: MemoryRepository;
  readonly spaceId: SpaceId;
}

const evaluationInstant = parseInstant('2026-08-30T10:00:00.000Z');

const deterministicUuid = (kind: string, id: string): string => {
  const digest = createHash('sha256').update(`${kind}:${id}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const audit = (
  principal: AuthorizationPrincipal,
  spaceId: SpaceId,
  subjectId: string,
  subjectType: MemoryAuditEvent['subjectType'],
  action: string,
): MemoryAuditEvent => ({
  action,
  actor: principal,
  recordedAt: evaluationInstant,
  result: 'applied',
  spaceId,
  subjectId,
  subjectType,
});

export const seedMemorySearchEvaluationCorpus = async (
  input: SeedMemorySearchEvaluationInput,
): Promise<readonly MemoryItem[]> => {
  const principal = { kind: 'person' as const, personId: input.personId };
  const items: MemoryItem[] = [];
  for (const document of input.documents) {
    const projectId = document.projectId === null ? null : input.projectId;
    const observationId = parseMemoryObservationId(deterministicUuid('search-observation', document.id));
    const proposalId = parseMemoryProposalId(deterministicUuid('search-proposal', document.id));
    const observationContent = {
      evidence: `Synthetic evaluation evidence for ${document.title}`,
      fixture: 'memory-search-evaluation-v1',
    } as const;
    const observation: MemoryObservation = {
      captureContextId: null,
      content: observationContent,
      contentHash: memoryContentHash(observationContent),
      createdByPrincipal: principal,
      fingerprint: createHash('sha256').update(`search-observation:${document.id}`).digest('hex'),
      id: observationId,
      observedAt: evaluationInstant,
      owningSpaceId: input.spaceId,
      projectId,
      redactionRuleSetVersion: MEMORY_REDACTION_RULE_SET_VERSION,
      sensitivity: document.sensitivity,
      sourceKind: 'user',
      sourceLocator: 'synthetic:memory-search-evaluation',
    };
    await input.repository.recordObservation({
      audit: audit(principal, input.spaceId, observationId, 'memory-observation', 'seed-search-observation'),
      observation,
    });
    const proposal: MemoryProposal = {
      guidance: document.guidance,
      id: proposalId,
      owningSpaceId: input.spaceId,
      projectId,
      proposedByPrincipal: principal,
      proposedKind: document.kind,
      reviewedAt: null,
      reviewedByPersonId: null,
      reviewReason: null,
      sensitivity: document.sensitivity,
      status: 'pending',
      structuredContent: document.structuredContent,
      summary: document.summary,
      title: document.title,
      trustCandidate: document.trust,
    };
    await input.repository.createProposal({
      audit: audit(principal, input.spaceId, proposalId, 'memory-proposal', 'seed-search-proposal'),
      observationIds: [observationId],
      proposal,
    });
    const item: MemoryItem = {
      currentRevisionId: document.revisionId,
      id: document.id,
      kind: document.kind,
      owningSpaceId: input.spaceId,
      projectId,
      scope: document.scope,
      sensitivity: document.sensitivity,
      status: document.status,
      trust: document.trust,
    };
    const revision: MemoryRevision = {
      createdAt: evaluationInstant,
      createdByPrincipal: principal,
      guidance: document.guidance,
      id: document.revisionId,
      memoryItemId: document.id,
      reason: 'synthetic-search-evaluation',
      revisionNumber: document.revisionNumber,
      structuredContent: document.structuredContent,
      summary: document.summary,
      title: document.title,
    };
    await input.repository.acceptProposal({
      audit: audit(principal, input.spaceId, item.id, 'memory-item', 'seed-search-item'),
      item,
      outboxEvent: null,
      proposalId,
      reviewedAt: evaluationInstant,
      reviewerPersonId: input.personId,
      revision,
    });
    items.push(item);
  }
  return Object.freeze(items);
};
