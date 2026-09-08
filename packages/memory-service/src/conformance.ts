import type { AuthorizedResourceScope } from '@ai-usage/authorization-contract';
import {
  createMemoryImportId,
  createMemoryItemId,
  createMemoryObservationId,
  createMemoryProposalId,
  createMemoryRelationId,
  createMemoryRevisionId,
  type PersonId,
  type ProjectId,
  parseInstant,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  MEMORY_REDACTION_RULE_SET_VERSION,
  type MemoryItem,
  type MemoryObservation,
  type MemoryProposal,
  type MemoryRevision,
  memoryContentHash,
} from './domain';
import { type MemoryAuditEvent, type MemoryRepository, MemoryRepositoryError } from './repository';

export interface MemoryRepositoryConformanceFixture {
  readonly close: () => Promise<void>;
  readonly createAuthorizationScope: (
    resourceIds: readonly string[],
  ) => AuthorizedResourceScope | Promise<AuthorizedResourceScope>;
  readonly personId: PersonId;
  readonly projectId: ProjectId | null;
  readonly repository: MemoryRepository;
  readonly spaceId: SpaceId;
}

export type CreateMemoryRepositoryConformanceFixture = () => Promise<MemoryRepositoryConformanceFixture>;

const firstInstant = parseInstant('2026-08-29T10:00:00.000Z');
const secondInstant = parseInstant('2026-08-29T10:01:00.000Z');
const thirdInstant = parseInstant('2026-08-29T10:02:00.000Z');

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(`Memory repository conformance failed: ${message}`);
  }
};

const expectRepositoryError = async (
  operation: Promise<unknown>,
  code: MemoryRepositoryError['code'],
): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof MemoryRepositoryError && error.code === code, `expected ${code} repository error`);
    return;
  }
  throw new Error(`Memory repository conformance failed: expected ${code} repository error`);
};

export const runMemoryRepositoryConformance = async (
  createFixture: CreateMemoryRepositoryConformanceFixture,
): Promise<void> => {
  const fixture = await createFixture();
  const principal = { kind: 'person' as const, personId: fixture.personId };
  const audit = (
    action: string,
    subjectId: string,
    subjectType: MemoryAuditEvent['subjectType'],
    recordedAt = firstInstant,
  ): MemoryAuditEvent => ({
    action,
    actor: principal,
    recordedAt,
    result: 'applied',
    spaceId: fixture.spaceId,
    subjectId,
    subjectType,
  });

  try {
    const observationContent = { evidence: 'synthetic repository conformance' } as const;
    const observation: MemoryObservation = {
      captureContextId: null,
      content: observationContent,
      contentHash: memoryContentHash(observationContent),
      createdByPrincipal: principal,
      fingerprint: 'a'.repeat(64),
      id: createMemoryObservationId(),
      observedAt: firstInstant,
      owningSpaceId: fixture.spaceId,
      projectId: fixture.projectId,
      redactionRuleSetVersion: MEMORY_REDACTION_RULE_SET_VERSION,
      sensitivity: 'normal',
      sourceKind: 'user',
      sourceLocator: 'synthetic:conformance',
    };
    const firstObservation = await fixture.repository.recordObservation({
      audit: audit('record-observation', observation.id, 'memory-observation'),
      observation,
    });
    const duplicateObservation = await fixture.repository.recordObservation({
      audit: audit('record-observation-duplicate', observation.id, 'memory-observation'),
      observation,
    });
    assert(firstObservation.created, 'first observation must be created');
    assert(!duplicateObservation.created && duplicateObservation.id === observation.id, 'observation must deduplicate');

    const proposal: MemoryProposal = {
      guidance: ['Keep the repository contract adapter-independent.'],
      id: createMemoryProposalId(),
      owningSpaceId: fixture.spaceId,
      projectId: fixture.projectId,
      proposedByPrincipal: principal,
      proposedKind: 'constraint',
      reviewedAt: null,
      reviewedByPersonId: null,
      reviewReason: null,
      sensitivity: 'normal',
      status: 'pending',
      structuredContent: { source: 'synthetic' },
      summary: 'One contract for both adapters.',
      title: 'Adapter-independent Memory',
      trustCandidate: 'harvest-accepted',
    };
    await fixture.repository.createProposal({
      audit: audit('create-proposal', proposal.id, 'memory-proposal'),
      observationIds: [observation.id],
      proposal,
    });
    const storedProposal = await fixture.repository.getProposal(fixture.spaceId, proposal.id);
    assert(storedProposal?.status === 'pending', 'proposal must remain pending before review');

    const itemId = createMemoryItemId();
    const firstRevisionId = createMemoryRevisionId();
    const item: MemoryItem = {
      currentRevisionId: firstRevisionId,
      id: itemId,
      kind: proposal.proposedKind,
      owningSpaceId: fixture.spaceId,
      projectId: fixture.projectId,
      scope: fixture.projectId === null ? 'space' : 'project',
      sensitivity: proposal.sensitivity,
      status: 'active',
      trust: proposal.trustCandidate,
    };
    const firstRevision: MemoryRevision = {
      createdAt: secondInstant,
      createdByPrincipal: principal,
      guidance: proposal.guidance,
      id: firstRevisionId,
      memoryItemId: itemId,
      reason: null,
      revisionNumber: 1,
      structuredContent: proposal.structuredContent,
      summary: proposal.summary,
      title: proposal.title,
    };
    await fixture.repository.acceptProposal({
      audit: audit('accept-proposal', itemId, 'memory-item', secondInstant),
      item,
      outboxEvent: null,
      proposalId: proposal.id,
      reviewedAt: secondInstant,
      reviewerPersonId: fixture.personId,
      revision: firstRevision,
    });
    const acceptedProposal = await fixture.repository.getProposal(fixture.spaceId, proposal.id);
    assert(acceptedProposal?.status === 'accepted', 'acceptance must review the proposal');
    const accepted = await fixture.repository.getItem(fixture.spaceId, itemId);
    assert(
      accepted?.item.currentRevisionId === firstRevisionId && accepted.revision.revisionNumber === 1,
      'acceptance must atomically create item and revision',
    );

    const secondRevision: MemoryRevision = {
      ...firstRevision,
      createdAt: thirdInstant,
      guidance: ['Keep the repository and application contracts adapter-independent.'],
      id: createMemoryRevisionId(),
      reason: 'clarify ownership',
      revisionNumber: 2,
    };
    await fixture.repository.reviseItem({
      audit: audit('revise-item', itemId, 'memory-item', thirdInstant),
      expectedCurrentRevisionId: firstRevisionId,
      outboxEvent: null,
      revision: secondRevision,
      sensitivity: 'normal',
      spaceId: fixture.spaceId,
    });
    await expectRepositoryError(
      fixture.repository.reviseItem({
        audit: audit('stale-revise-item', itemId, 'memory-item', thirdInstant),
        expectedCurrentRevisionId: firstRevisionId,
        outboxEvent: null,
        revision: { ...secondRevision, id: createMemoryRevisionId(), revisionNumber: 3 },
        sensitivity: 'normal',
        spaceId: fixture.spaceId,
      }),
      'stale',
    );
    const revised = await fixture.repository.getItem(fixture.spaceId, itemId);
    assert(
      revised?.item.currentRevisionId === secondRevision.id && revised.revision.revisionNumber === 2,
      'revision must advance the current pointer once',
    );

    const relatedProposal: MemoryProposal = {
      ...proposal,
      id: createMemoryProposalId(),
      proposedKind: 'decision',
      trustCandidate: 'explicit',
    };
    await fixture.repository.createProposal({
      audit: audit('create-related-proposal', relatedProposal.id, 'memory-proposal'),
      observationIds: [],
      proposal: relatedProposal,
    });
    const relatedItemId = createMemoryItemId();
    const relatedRevisionId = createMemoryRevisionId();
    const relatedItem: MemoryItem = {
      ...item,
      currentRevisionId: relatedRevisionId,
      id: relatedItemId,
      kind: relatedProposal.proposedKind,
      trust: relatedProposal.trustCandidate,
    };
    const relatedRevision: MemoryRevision = {
      ...firstRevision,
      id: relatedRevisionId,
      memoryItemId: relatedItemId,
    };
    await fixture.repository.acceptProposal({
      audit: audit('accept-related-proposal', relatedItemId, 'memory-item', secondInstant),
      item: relatedItem,
      outboxEvent: null,
      proposalId: relatedProposal.id,
      reviewedAt: secondInstant,
      reviewerPersonId: fixture.personId,
      revision: relatedRevision,
    });
    const historical = await fixture.repository.getItem(fixture.spaceId, itemId, firstRevisionId);
    assert(
      historical?.item.currentRevisionId === secondRevision.id &&
        historical.revision.id === firstRevisionId &&
        historical.revision.revisionNumber === 1,
      'an exact historical revision must retain the current item pointer and return the requested revision',
    );
    assert(
      (await fixture.repository.getItem(fixture.spaceId, itemId, relatedRevisionId)) === null,
      'a revision belonging to another item must not be addressable through this item',
    );
    assert(
      (await fixture.repository.getItem(fixture.spaceId, itemId, createMemoryRevisionId())) === null,
      'an unknown exact revision must not fall back to the current revision',
    );
    const relationId = createMemoryRelationId();
    await fixture.repository.createRelation(
      {
        createdAt: thirdInstant,
        createdByPrincipal: principal,
        fromMemoryItemId: itemId,
        id: relationId,
        kind: 'supports',
        owningSpaceId: fixture.spaceId,
        reason: 'synthetic relation',
        toMemoryItemId: relatedItemId,
      },
      audit('create-relation', relationId, 'memory-relation', thirdInstant),
    );
    await expectRepositoryError(
      fixture.repository.createRelation(
        {
          createdAt: thirdInstant,
          createdByPrincipal: principal,
          fromMemoryItemId: itemId,
          id: createMemoryRelationId(),
          kind: 'related-to',
          owningSpaceId: fixture.spaceId,
          reason: null,
          toMemoryItemId: createMemoryItemId(),
        },
        audit('create-invalid-relation', relationId, 'memory-relation', thirdInstant),
      ),
      'invalid-input',
    );

    const listScope = await fixture.createAuthorizationScope([itemId, relatedItemId]);
    const page = await fixture.repository.listItems({
      authorizationScope: listScope,
      pageSize: 1,
      spaceId: fixture.spaceId,
    });
    assert(page.items.length === 1 && page.nextCursor !== null, 'first bounded page must expose a cursor');
    const secondPage = await fixture.repository.listItems({
      authorizationScope: listScope,
      cursor: page.nextCursor,
      pageSize: 1,
      spaceId: fixture.spaceId,
    });
    assert(secondPage.items.length === 1 && secondPage.nextCursor === null, 'cursor must return the remaining item');

    const rejectedProposal: MemoryProposal = {
      ...relatedProposal,
      id: createMemoryProposalId(),
      title: 'Reject this synthetic proposal',
    };
    await fixture.repository.createProposal({
      audit: audit('create-rejected-proposal', rejectedProposal.id, 'memory-proposal'),
      observationIds: [],
      proposal: rejectedProposal,
    });
    await fixture.repository.rejectProposal({
      audit: audit('reject-proposal', rejectedProposal.id, 'memory-proposal', thirdInstant),
      proposalId: rejectedProposal.id,
      reason: 'synthetic rejection',
      reviewedAt: thirdInstant,
      reviewerPersonId: fixture.personId,
      spaceId: fixture.spaceId,
    });
    assert(
      (await fixture.repository.getProposal(fixture.spaceId, rejectedProposal.id))?.status === 'rejected',
      'rejection must never create an item',
    );

    await fixture.repository.supersedeItem({
      audit: audit('supersede-item', itemId, 'memory-item', thirdInstant),
      itemId,
      outboxEvent: null,
      reason: 'synthetic supersession',
      spaceId: fixture.spaceId,
      supersededAt: thirdInstant,
    });
    assert((await fixture.repository.getItem(fixture.spaceId, itemId))?.item.status === 'superseded', 'supersede');

    const importId = createMemoryImportId();
    const importedFingerprint = 'c'.repeat(64);
    const importedObservationContent = { evidence: 'synthetic imported evidence' } as const;
    const importedObservation: MemoryObservation = {
      captureContextId: null,
      content: importedObservationContent,
      contentHash: memoryContentHash(importedObservationContent),
      createdByPrincipal: principal,
      fingerprint: importedFingerprint,
      id: createMemoryObservationId(),
      observedAt: firstInstant,
      owningSpaceId: fixture.spaceId,
      projectId: fixture.projectId,
      redactionRuleSetVersion: MEMORY_REDACTION_RULE_SET_VERSION,
      sensitivity: 'normal',
      sourceKind: 'import',
      sourceLocator: 'synthetic:legacy-memory',
    };
    const importedProposal: MemoryProposal = {
      guidance: ['Preserve imported guidance.'],
      id: createMemoryProposalId(),
      owningSpaceId: fixture.spaceId,
      projectId: fixture.projectId,
      proposedByPrincipal: principal,
      proposedKind: 'handoff',
      reviewedAt: secondInstant,
      reviewedByPersonId: fixture.personId,
      reviewReason: 'synthetic import',
      sensitivity: 'normal',
      status: 'accepted',
      structuredContent: { source: 'synthetic import' },
      summary: 'Imported adapter conformance Memory.',
      title: 'Imported legacy handoff',
      trustCandidate: 'explicit',
    };
    const importedItemId = createMemoryItemId();
    const importedRevisionId = createMemoryRevisionId();
    const importedItem: MemoryItem = {
      currentRevisionId: importedRevisionId,
      id: importedItemId,
      kind: importedProposal.proposedKind,
      owningSpaceId: fixture.spaceId,
      projectId: fixture.projectId,
      scope: fixture.projectId === null ? 'space' : 'project',
      sensitivity: 'normal',
      status: 'active',
      trust: 'explicit',
    };
    const importedRevision: MemoryRevision = {
      createdAt: firstInstant,
      createdByPrincipal: principal,
      guidance: importedProposal.guidance,
      id: importedRevisionId,
      memoryItemId: importedItemId,
      reason: 'synthetic import',
      revisionNumber: 1,
      structuredContent: importedProposal.structuredContent,
      summary: importedProposal.summary,
      title: importedProposal.title,
    };
    const importPreview = await fixture.repository.previewImport({
      audit: audit('preview-import', importId, 'memory-import'),
      contentHash: 'd'.repeat(64),
      createdAt: firstInstant,
      destinationProjectId: fixture.projectId,
      destinationSpaceId: fixture.spaceId,
      fingerprint: 'e'.repeat(64),
      id: importId,
      observationFingerprints: [importedFingerprint],
      sourceKind: 'legacy-markdown',
      sourceLocator: 'synthetic:legacy-memory',
      status: 'previewed',
    });
    assert(!importPreview.alreadyConfirmed, 'first import preview must remain confirmable');
    const importConfirmation = await fixture.repository.confirmImport({
      audit: audit('confirm-import', importId, 'memory-import', secondInstant),
      confirmedAt: secondInstant,
      confirmedByPersonId: fixture.personId,
      importId,
      previewProof: importPreview.memoryImport.previewProof,
      records: [
        {
          item: importedItem,
          observation: importedObservation,
          outboxEvent: null,
          proposal: importedProposal,
          revision: importedRevision,
        },
      ],
      relations: [],
      spaceId: fixture.spaceId,
    });
    assert(
      importConfirmation.kind === 'confirmed' &&
        importConfirmation.importedObservationFingerprints[0] === importedFingerprint,
      'import confirmation must atomically create its mapped records',
    );
    assert(
      (await fixture.repository.getItem(fixture.spaceId, importedItemId))?.item.kind === 'handoff',
      'legacy handoff must remain a Memory kind',
    );
    const repeatedPreview = await fixture.repository.previewImport({
      audit: audit('preview-import-again', importId, 'memory-import', thirdInstant),
      contentHash: 'd'.repeat(64),
      createdAt: thirdInstant,
      destinationProjectId: fixture.projectId,
      destinationSpaceId: fixture.spaceId,
      fingerprint: 'e'.repeat(64),
      id: importId,
      observationFingerprints: [importedFingerprint],
      sourceKind: 'legacy-markdown',
      sourceLocator: 'synthetic:legacy-memory',
      status: 'previewed',
    });
    assert(
      repeatedPreview.alreadyConfirmed && repeatedPreview.duplicateObservationFingerprints[0] === importedFingerprint,
      'repeated import preview must report durable idempotency',
    );
    const exportScope = await fixture.createAuthorizationScope([itemId, relatedItemId, importedItemId]);
    const exported = await fixture.repository.exportMemory({
      authorizationScope: exportScope,
      spaceId: fixture.spaceId,
    });
    const exportedImport = exported.items.find(({ item: exportedItem }) => exportedItem.id === importedItemId);
    assert(
      exportedImport?.revisions.length === 1 && exportedImport.provenance.length === 1,
      'export must retain imported revision and bounded provenance',
    );
    await fixture.repository.purgeItem({
      audit: audit('purge-memory-item', importedItemId, 'memory-item', thirdInstant),
      itemId: importedItemId,
      outboxEvent: null,
      spaceId: fixture.spaceId,
    });
    assert(
      (await fixture.repository.getItem(fixture.spaceId, importedItemId)) === null,
      'privacy purge must remove item content and revisions',
    );
    const afterPurge = await fixture.repository.exportMemory({
      authorizationScope: exportScope,
      spaceId: fixture.spaceId,
    });
    assert(
      !afterPurge.items.some(({ item: exportedItem }) => exportedItem.id === importedItemId),
      'privacy purge must remove export derivatives',
    );
  } finally {
    await fixture.close();
  }
};
