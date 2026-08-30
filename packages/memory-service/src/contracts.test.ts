import { describe, expect, test } from 'bun:test';
import {
  parseCheckoutResolutionAction,
  parseMemoryProposalReviewAction,
  parseMemoryProposalReviewActionResult,
  parseMemoryProposalReviewSnapshot,
  parseMemoryResolutionReviewSnapshot,
  parseMemoryServiceResponse,
} from './contracts';

const spaceId = '0198f179-4837-7000-8000-000000000001';
const checkoutId = '0198f179-4837-7000-8000-000000000002';
const proposalId = '0198f179-4837-7000-8000-000000000004';

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
});
