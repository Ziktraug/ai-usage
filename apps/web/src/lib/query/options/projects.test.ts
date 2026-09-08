import { describe, expect, test } from 'bun:test';
import type { ProjectResolutionReviewSnapshot } from '@ai-usage/web-contract/projects';
import { createWebQueryClient } from '../client';
import {
  acknowledgeProjectResolutionReview,
  projectResolutionReviewsKey,
  projectResolutionReviewsQueryOptions,
} from './projects';

const snapshot: ProjectResolutionReviewSnapshot = {
  reviews: [
    {
      candidateMatches: [],
      checkoutId: '0198f179-4837-7000-8000-000000000002',
      destinationSpaceId: '0198f179-4837-7000-8000-000000000001',
      deviceId: '0198f179-4837-7000-8000-000000000003',
      deviceLabel: 'Development device',
      localLabel: 'checkout:first',
      normalizedRemote: null,
      status: 'candidate',
    },
    {
      candidateMatches: [],
      checkoutId: '0198f179-4837-7000-8000-000000000004',
      destinationSpaceId: '0198f179-4837-7000-8000-000000000001',
      deviceId: '0198f179-4837-7000-8000-000000000003',
      deviceLabel: 'Development device',
      localLabel: 'checkout:second',
      normalizedRemote: null,
      status: 'unassigned',
    },
  ],
  spaceId: '0198f179-4837-7000-8000-000000000001',
};

describe('Project resolution Query options', () => {
  test('uses one bounded control-plane identity and forwards cancellation', async () => {
    const observedSignals: AbortSignal[] = [];
    const client = createWebQueryClient();
    const options = projectResolutionReviewsQueryOptions(
      {
        resolutionReviews: (signal) => {
          if (signal) {
            observedSignals.push(signal);
          }
          return Promise.resolve(snapshot);
        },
      },
      { browser: true, enabled: true },
    );

    await expect(client.fetchQuery(options)).resolves.toEqual(snapshot);
    expect(options).toMatchObject({
      queryKey: ['web', 'control-plane', 'projects', 'resolution-reviews', 'v1'],
      refetchOnMount: true,
      retry: false,
    });
    expect(observedSignals).toHaveLength(1);
  });

  test('acknowledges only the successful Checkout and leaves the snapshot stale', async () => {
    const client = createWebQueryClient();
    client.setQueryData(projectResolutionReviewsKey(), snapshot);

    await acknowledgeProjectResolutionReview(client, '0198f179-4837-7000-8000-000000000002');

    const remaining = client.getQueryData<ProjectResolutionReviewSnapshot>(projectResolutionReviewsKey());
    expect(remaining?.reviews.map((review) => review.checkoutId)).toEqual(['0198f179-4837-7000-8000-000000000004']);
    expect(remaining?.spaceId).toBe(snapshot.spaceId);
    expect(client.getQueryState(projectResolutionReviewsKey())?.isInvalidated).toBe(true);
  });
});
