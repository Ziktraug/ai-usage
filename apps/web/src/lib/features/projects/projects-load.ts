import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntime, WebQueryRuntimeOptions } from '../../query/composition';
import { projectResolutionReviewsQueryOptions } from '../../query/options/projects';
import { createProjectsBrowserAdapter, type ProjectsBrowserAdapter } from '../../rpc/projects-client';
import { createAwaitedRouteQueryState } from '../shell/query-load';

export interface ProjectsPageData {
  readonly queryState: WebQueryHydrationState;
}

export interface ProjectsPageLoadDependencies {
  readonly createClient?: (runtime: WebQueryRuntime) => ProjectsBrowserAdapter;
}

export const deferredProjectsPageData = (): ProjectsPageData => ({
  queryState: { dehydratedState: { mutations: [], queries: [] } },
});

export const loadProjectsPageData = async (
  options: WebQueryRuntimeOptions,
  dependencies: ProjectsPageLoadDependencies = {},
): Promise<ProjectsPageData> => ({
  queryState: await createAwaitedRouteQueryState(options, async (runtime) => {
    const client = dependencies.createClient?.(runtime) ?? createProjectsBrowserAdapter(runtime.rpc.projects);
    await runtime.queryClient.fetchQuery(
      projectResolutionReviewsQueryOptions(client, { browser: false, enabled: true }),
    );
  }),
});
