import { describe, expect, test } from 'bun:test';
import {
  parseCheckoutResolutionAction,
  parseMemoryProposalReviewAction,
  parseMemoryProposalReviewActionResult,
  parseMemoryProposalReviewSnapshot,
  parseMemoryResolutionReviewSnapshot,
  parseMemoryServiceResponse,
} from './contracts';
import { parseMemoryItemReadResult, parseMemoryProjectContext } from './read-contract';

const spaceId = '0198f179-4837-7000-8000-000000000001';
const checkoutId = '0198f179-4837-7000-8000-000000000002';
const proposalId = '0198f179-4837-7000-8000-000000000004';
const itemId = '0198f179-4837-7000-8000-000000000006';
const historicalRevisionId = '0198f179-4837-7000-8000-000000000007';
const currentRevisionId = '0198f179-4837-7000-8000-000000000008';

const historicalItemResult = {
  item: {
    currentRevisionId,
    id: itemId,
    kind: 'constraint',
    owningSpaceId: spaceId,
    projectId: null,
    scope: 'space',
    sensitivity: 'normal',
    status: 'active',
    trust: 'explicit',
  },
  revision: {
    createdAt: '2026-08-29T12:00:00.000Z',
    createdByPrincipal: { id: 'memory-import', kind: 'service' },
    guidance: ['Keep the current and historical contracts distinct.'],
    id: historicalRevisionId,
    memoryItemId: itemId,
    reason: 'Historical fixture',
    revisionNumber: 1,
    structuredContent: {},
    summary: 'Historical Memory revision.',
    title: 'Historical revision',
  },
};

describe('Memory service protocol contracts', () => {
  test('parses closed actions without accepting a local path', () => {
    expect(JSON.stringify(parseCheckoutResolutionAction({ checkoutId, kind: 'leave-unassigned', spaceId }))).toBe(
      JSON.stringify({ checkoutId, kind: 'leave-unassigned', spaceId }),
    );
    expect(() =>
      parseCheckoutResolutionAction({ checkoutId, kind: 'leave-unassigned', localPath: '/private', spaceId }),
    ).toThrow();
  });

  test('parses a bounded review snapshot and a closed response envelope', () => {
    const snapshot = {
      reviews: [
        {
          candidateMatches: [],
          checkoutId,
          destinationSpaceId: spaceId,
          deviceId: '0198f179-4837-7000-8000-000000000003',
          deviceLabel: 'Local device',
          localLabel: 'checkout:0198f179',
          normalizedRemote: null,
          status: 'unassigned',
        },
      ],
      spaceId,
    };
    expect(JSON.stringify(parseMemoryResolutionReviewSnapshot(snapshot))).toBe(JSON.stringify(snapshot));
    expect(
      JSON.stringify(
        parseMemoryServiceResponse(
          { data: snapshot, ok: true, protocolVersion: 1 },
          parseMemoryResolutionReviewSnapshot,
        ),
      ),
    ).toBe(JSON.stringify({ data: snapshot, ok: true, protocolVersion: 1 }));
  });

  test('parses closed proposal review snapshots and actions', () => {
    const snapshot = {
      nextCursor: null,
      proposals: [
        {
          guidance: ['Review before accepting.'],
          observationSources: [
            {
              id: '0198f179-4837-7000-8000-000000000005',
              observedAt: '2026-08-29T12:00:00.000Z',
              sensitivity: 'normal',
              sourceKind: 'session',
              sourceLocator: 'synthetic:session',
            },
          ],
          projectId: null,
          proposalId,
          proposedByKind: 'person',
          proposedKind: 'constraint',
          sensitivity: 'normal',
          structuredContent: { source: 'synthetic' },
          summary: 'Pending guidance.',
          title: 'Review boundary',
          trustCandidate: 'harvest-accepted',
        },
      ],
      spaceId,
    };
    expect(JSON.stringify(parseMemoryProposalReviewSnapshot(snapshot))).toBe(JSON.stringify(snapshot));
    expect(
      JSON.stringify(parseMemoryProposalReviewAction({ kind: 'accept', proposalId, scope: 'space', spaceId })),
    ).toBe(JSON.stringify({ kind: 'accept', proposalId, scope: 'space', spaceId }));
    expect(
      parseMemoryProposalReviewActionResult({
        itemId: '0198f179-4837-7000-8000-000000000006',
        kind: 'accepted',
        revisionId: '0198f179-4837-7000-8000-000000000007',
      }),
    ).toMatchObject({ kind: 'accepted' });
    expect(() =>
      parseMemoryProposalReviewAction({ kind: 'accept', localPath: '/private', proposalId, scope: 'space', spaceId }),
    ).toThrow();
  });

  test('accepts exact historical reads but rejects them from current Project context', () => {
    expect(String(parseMemoryItemReadResult(historicalItemResult).revision.id)).toBe(historicalRevisionId);
    expect(() =>
      parseMemoryProjectContext({
        items: [historicalItemResult],
        projectId: '0198f179-4837-7000-8000-000000000009',
        spaceId,
        truncated: false,
      }),
    ).toThrow();

    const currentItemResult = {
      ...historicalItemResult,
      item: { ...historicalItemResult.item, currentRevisionId: historicalRevisionId },
    };
    expect(
      parseMemoryProjectContext({
        items: [currentItemResult],
        projectId: '0198f179-4837-7000-8000-000000000009',
        spaceId,
        truncated: false,
      }).items,
    ).toHaveLength(1);
  });
});
