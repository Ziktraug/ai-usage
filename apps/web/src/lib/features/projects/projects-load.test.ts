import { describe, expect, test } from 'bun:test';
import type { ProjectResolutionReviewSnapshot } from '@ai-usage/web-contract/projects';
import { createHydratedWebQueryClient } from '../../query/client';
import { projectResolutionReviewsKey, projectResolutionReviewsQueryOptions } from '../../query/options/projects';
import { deferredProjectsPageData, loadProjectsPageData } from './projects-load';

const snapshot: ProjectResolutionReviewSnapshot = {
  reviews: [],
  spaceId: '0198f179-4837-7000-8000-000000000001',
};

describe('Projects SSR load identity', () => {
  test('returns an empty hydration delta for SPA entry', () => {
    expect(deferredProjectsPageData()).toEqual({ queryState: { dehydratedState: { mutations: [], queries: [] } } });
  });

  test('awaits and hydrates exactly one bounded review identity', async () => {
    let calls = 0;
    const client = {
      applyResolutionAction: () => Promise.reject(new Error('unused')),
      resolutionReviews: () => {
        calls += 1;
        return Promise.resolve(snapshot);
      },
    };
    const data = await loadProjectsPageData(
      {
        fetch: () => Promise.reject(new Error('Injected Projects client owns this acquisition.')),
        url: new URL('http://projects.invalid/projects'),
      },
      { createClient: () => client },
    );

    expect(calls).toBe(1);
    expect(data.queryState.dehydratedState.queries).toHaveLength(1);
    expect(data.queryState.dehydratedState.queries[0]?.queryKey).toEqual(projectResolutionReviewsKey());
    const hydrated = createHydratedWebQueryClient(data.queryState);
    expect(hydrated.getQueryData<ProjectResolutionReviewSnapshot>(projectResolutionReviewsKey())).toEqual(snapshot);
    expect(
      await hydrated.fetchQuery(projectResolutionReviewsQueryOptions(client, { browser: true, enabled: true })),
    ).toEqual(snapshot);
    expect(calls).toBe(1);
  });
});
