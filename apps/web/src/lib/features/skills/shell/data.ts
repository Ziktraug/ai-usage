import type { RuntimeMode } from '../../../../runtime-mode';
import type { WebQueryHydrationState } from '../../../query/client';
import type { WebQueryRuntime, WebQueryRuntimeOptions } from '../../../query/composition';
import {
  managedSkillMarkdownQueryOptions,
  projectSkillMarkdownQueryOptions,
  skillsKnownProjectPathsQueryOptions,
  skillsProjectInventoriesQueryOptions,
  skillsSnapshotQueryOptions,
} from '../../../query/options/skills';
import { createSkillsClient } from '../../../rpc/skills-client';
import { createAwaitedRouteQueryState } from '../../shell/query-load';
import { createSkillsShellViewModel } from './model';

const serverQueryContext = { browser: true, enabled: true } as const;

export type SkillsShellRouteLoadResult =
  | { readonly decision: 'redirect-report' }
  | {
      readonly decision: 'render';
      readonly queryState: WebQueryHydrationState;
    };

type SkillsPrefetchRuntime = Pick<WebQueryRuntime, 'queryClient'> & {
  readonly rpc: Pick<WebQueryRuntime['rpc'], 'skills'>;
};

export const prefetchSkillsShellQueries = async (runtime: SkillsPrefetchRuntime, pathname: string): Promise<void> => {
  const client = createSkillsClient(runtime.rpc.skills);
  const [snapshot, knownProjectPaths] = await Promise.all([
    runtime.queryClient.fetchQuery(skillsSnapshotQueryOptions(client, serverQueryContext)),
    runtime.queryClient.fetchQuery(skillsKnownProjectPathsQueryOptions(client, serverQueryContext)),
  ]);
  const inventories = snapshot.configured
    ? await runtime.queryClient.fetchQuery(skillsProjectInventoriesQueryOptions(client, serverQueryContext))
    : [];
  const view = createSkillsShellViewModel({ inventories, knownProjectPaths, pathname, snapshot });
  if (view.selectionDetail.kind === 'global-skill') {
    await runtime.queryClient.fetchQuery(
      managedSkillMarkdownQueryOptions(client, view.selectionDetail.skill.name, serverQueryContext),
    );
    return;
  }
  if (view.selectionDetail.kind !== 'project-skill') {
    return;
  }
  const observation = view.selectionDetail.skill.observations.at(0);
  if (observation === undefined) {
    return;
  }
  await runtime.queryClient.fetchQuery(
    projectSkillMarkdownQueryOptions(
      client,
      {
        projectPath: observation.projectPath,
        runtimeDirId: observation.runtimeDirId,
        skillName: view.selectionDetail.skill.name,
      },
      serverQueryContext,
    ),
  );
};

export const loadSkillsShellRoute = async (input: {
  readonly mode: RuntimeMode;
  readonly options: WebQueryRuntimeOptions;
  readonly pathname: string;
}): Promise<SkillsShellRouteLoadResult> => {
  if (input.mode === 'demo') {
    return { decision: 'redirect-report' };
  }
  return {
    decision: 'render',
    queryState: await createAwaitedRouteQueryState(input.options, async (runtime) => {
      await prefetchSkillsShellQueries(runtime, input.pathname);
    }),
  };
};
