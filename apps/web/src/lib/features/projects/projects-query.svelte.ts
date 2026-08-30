import type {
  ProjectResolutionAction,
  ProjectResolutionActionResult,
  ProjectResolutionReviewSnapshot,
} from '@ai-usage/web-contract/projects';
import { type CreateQueryResult, createQuery } from '@tanstack/svelte-query';
import { type ProjectResolutionReviewClient, projectResolutionReviewsQueryOptions } from '../../query/options/projects';
import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
import { createProjectsBrowserAdapter } from '../../rpc/projects-client';

const unavailableReviews = (): Promise<never> =>
  Promise.reject(new Error('Project resolution RPC is unavailable during SSR.'));

const createLazyClient = (): ProjectResolutionReviewClient => {
  let client: ProjectResolutionReviewClient | undefined;
  return {
    resolutionReviews: async (...parameters) => {
      client ??= createProjectsBrowserAdapter(useWebQueryRpcContext().rpc.projects);
      return await client.resolutionReviews(...parameters);
    },
  };
};

export const createHydratedProjectResolutionQuery = (
  browser: boolean,
): CreateQueryResult<ProjectResolutionReviewSnapshot, Error> =>
  createQuery(() =>
    projectResolutionReviewsQueryOptions(browser ? createLazyClient() : { resolutionReviews: unavailableReviews }, {
      browser,
      enabled: true,
    }),
  );

export const createProjectResolutionActor = (
  browser: boolean,
): ((action: ProjectResolutionAction) => Promise<ProjectResolutionActionResult>) | undefined => {
  if (!browser) {
    return;
  }
  const client = createProjectsBrowserAdapter(useWebQueryRpcContext().rpc.projects);
  return async (action) => await client.applyResolutionAction(action);
};
