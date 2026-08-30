import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  type ProjectResolutionReviewSnapshot,
  parseProjectResolutionActionResult,
  parseProjectResolutionReviewSnapshot,
  projectResolutionActionSchema,
  projectResolutionReviewSnapshotSchema,
} from './projects';

const spaceId = '0198f179-4837-7000-8000-000000000001';
const checkoutId = '0198f179-4837-7000-8000-000000000002';
const repositoryId = '0198f179-4837-7000-8000-000000000003';

describe('Projects contract', () => {
  test('accepts only the bounded privacy-safe review shape', () => {
    const value: ProjectResolutionReviewSnapshot = {
      reviews: [
        {
          candidateMatches: [{ canonicalLabel: 'github.com/openai/ai-usage', repositoryId }],
          checkoutId,
          destinationSpaceId: spaceId,
          deviceId: '0198f179-4837-7000-8000-000000000004',
          deviceLabel: 'Local device',
          localLabel: 'checkout:0198f179',
          normalizedRemote: 'github.com/openai/ai-usage',
          status: 'candidate',
        },
      ],
      spaceId,
    };
    expect(parseProjectResolutionReviewSnapshot(value)).toEqual(value);
    expect(
      safeParse(projectResolutionReviewSnapshotSchema, {
        ...value,
        reviews: [{ ...value.reviews[0], localPath: '/private/operator/path' }],
      }).success,
    ).toBe(false);
  });

  test('closes create, link, and leave-unassigned actions and their results', () => {
    for (const action of [
      { checkoutId, displayName: 'Local project', kind: 'create-project', spaceId },
      { checkoutId, kind: 'link', projectId: null, repositoryId, spaceId },
      { checkoutId, kind: 'leave-unassigned', spaceId },
    ] as const) {
      expect(safeParse(projectResolutionActionSchema, action).success).toBe(true);
    }
    expect(
      safeParse(projectResolutionActionSchema, { checkoutId, kind: 'leave-unassigned', localPath: '/private', spaceId })
        .success,
    ).toBe(false);
    expect(parseProjectResolutionActionResult({ kind: 'linked', projectId: null, repositoryId })).toEqual({
      kind: 'linked',
      projectId: null,
      repositoryId,
    });
  });
});
