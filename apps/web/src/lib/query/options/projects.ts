import type { ProjectResolutionReviewSnapshot } from '@ai-usage/web-contract/projects';
import type { QueryClient } from '@tanstack/svelte-query';
import { queryOptions } from '@tanstack/svelte-query';
import type { ProjectsBrowserAdapter } from '../../rpc/projects-client';
import { type ControlPlaneQueryKey, controlPlaneKey } from '../keys';
import { webQueryPolicies } from '../policies';

export type ProjectResolutionReviewClient = Pick<ProjectsBrowserAdapter, 'resolutionReviews'>;

export interface ProjectResolutionReviewQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

export const projectResolutionReviewsKey = (): ControlPlaneQueryKey =>
  controlPlaneKey('projects', 'resolution-reviews', 'v1');

export const projectResolutionReviewsQueryOptions = (
  client: ProjectResolutionReviewClient,
  context: ProjectResolutionReviewQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.resolutionReviews(signal),
    queryKey: projectResolutionReviewsKey(),
  });

export const invalidateProjectResolutionReviews = async (client: QueryClient): Promise<void> => {
  await client.invalidateQueries({ exact: true, queryKey: projectResolutionReviewsKey() });
};

export const acknowledgeProjectResolutionReview = async (client: QueryClient, checkoutId: string): Promise<void> => {
  client.setQueryData<ProjectResolutionReviewSnapshot>(projectResolutionReviewsKey(), (snapshot) =>
    snapshot === undefined
      ? undefined
      : {
          ...snapshot,
          reviews: snapshot.reviews.filter((review) => review.checkoutId !== checkoutId),
        },
  );
  await client.invalidateQueries({
    exact: true,
    queryKey: projectResolutionReviewsKey(),
    refetchType: 'none',
  });
};
