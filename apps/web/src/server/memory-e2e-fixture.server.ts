import type {
  MemoryProposalReviewAction,
  MemoryProposalReviewActionResult,
  MemoryProposalReviewSnapshot,
  MemorySearchInput,
  MemorySearchPage,
} from '@ai-usage/web-contract/memory';

const spaceId = '0198f179-4837-7000-8000-000000000001';
const proposalId = '0198f179-4837-7000-8000-000000000010';
let reviewed = false;

export const readE2EMemoryProposalReviews = (): MemoryProposalReviewSnapshot => ({
  nextCursor: null,
  proposals: reviewed
    ? []
    : [
        {
          guidance: ['Keep the local Memory authority available without an account or network.'],
          observationSources: [
            {
              id: '0198f179-4837-7000-8000-000000000011',
              observedAt: '2026-08-29T08:30:00.000Z',
              sensitivity: 'normal',
              sourceKind: 'commit',
              sourceLocator: 'commit:0123456789ab',
            },
          ],
          projectId: null,
          proposalId,
          proposedByKind: 'service',
          proposedKind: 'decision',
          sensitivity: 'normal',
          structuredContent: { authority: 'sqlite', topology: 'local' },
          summary: 'The local Memory authority remains SQLite and offline-first.',
          title: 'Keep local Memory offline-first',
          trustCandidate: 'harvest-accepted',
        },
      ],
  spaceId,
});

export const applyE2EMemoryProposalReviewAction = (
  action: MemoryProposalReviewAction,
): MemoryProposalReviewActionResult => {
  if (action.proposalId !== proposalId || action.spaceId !== spaceId) {
    throw new Error('Unknown E2E Memory proposal action.');
  }
  reviewed = true;
  return action.kind === 'accept'
    ? {
        itemId: '0198f179-4837-7000-8000-000000000012',
        kind: 'accepted',
        revisionId: '0198f179-4837-7000-8000-000000000013',
      }
    : { kind: 'rejected', proposalId };
};

export const resetE2EMemoryProposalReviews = (): void => {
  reviewed = false;
};

export const searchE2EMemory = (input: MemorySearchInput): MemorySearchPage => {
  const matches = input.query.toLocaleLowerCase('en').includes('authorized');
  return {
    items: matches
      ? [
          {
            chunkerVersion: 'memory-search-chunker-v1',
            contentHash: 'a'.repeat(64),
            guidance: ['Join the complete authorized relation before ranking candidates.'],
            id: '0198f179-4837-7000-8000-000000000020',
            kind: 'constraint',
            matchedBecause: [
              { excerpt: 'complete authorized relation before ranking', field: 'guidance', kind: 'lexical' },
            ],
            projectId: null,
            provenance: [
              {
                observationId: '0198f179-4837-7000-8000-000000000021',
                observedAt: '2026-08-29T08:30:00.000Z',
                sensitivity: 'normal',
                sourceKind: 'commit',
                verification: 'accepted-proposal-evidence',
              },
            ],
            rank: { exact: 0, lexical: 2.75, total: 2.75, trigram: 0 },
            resourceKind: 'memory',
            revisionId: '0198f179-4837-7000-8000-000000000022',
            revisionNumber: 2,
            sensitivity: 'normal',
            status: 'active',
            summary: 'Authorization is part of the retrieval query, not a result post-filter.',
            title: 'Authorize before ranking',
            trust: 'explicit',
          },
        ]
      : [],
    nextCursor: null,
    queryFingerprint: 'b'.repeat(64),
    rankingVersion: 'memory-search-lexical-v1',
    total: matches ? 1 : 0,
  };
};
