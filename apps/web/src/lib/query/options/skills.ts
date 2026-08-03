import type {
  ProjectSkillMarkdownInput,
  SkillMarkdownDocument,
  SkillMarkdownSaveResult,
} from '@ai-usage/web-contract/skills';
import type { QueryClient } from '@tanstack/svelte-query';
import { queryOptions } from '@tanstack/svelte-query';
import type { SkillsClient, SkillsClientResult } from '../../rpc/skills-client';
import {
  managedSkillMarkdownKey,
  projectSkillMarkdownKey,
  skillsKnownProjectPathsKey,
  skillsProjectInventoriesKey,
  skillsSnapshotKey,
  unwrapSkillsQueryResult,
} from '../identities/skills';
import type { FiniteSwrQueryKey } from '../keys';
import { webQueryPolicies } from '../policies';

export {
  managedSkillMarkdownKey,
  projectSkillMarkdownKey,
  SkillsQueryError,
  skillsKnownProjectPathsKey,
  skillsProjectInventoriesKey,
  skillsSnapshotKey,
  unwrapSkillsQueryResult,
} from '../identities/skills';

export type SkillsQueryClient = Pick<
  SkillsClient,
  | 'getKnownSkillProjectPaths'
  | 'getManagedSkillMarkdown'
  | 'getProjectSkillMarkdown'
  | 'getSkillManagementSnapshot'
  | 'getSkillProjectInventories'
>;

export type SkillsInvalidationTarget = 'known-project-paths' | 'project-inventories' | 'snapshot';

export interface SkillsQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

export const skillsSnapshotQueryOptions = (client: SkillsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getSkillManagementSnapshot({ signal })),
    queryKey: skillsSnapshotKey(),
  });

export const skillsKnownProjectPathsQueryOptions = (client: SkillsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getKnownSkillProjectPaths({ signal })),
    queryKey: skillsKnownProjectPathsKey(),
  });

export const skillsProjectInventoriesQueryOptions = (client: SkillsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getSkillProjectInventories({ signal })),
    queryKey: skillsProjectInventoriesKey(),
  });

export const managedSkillMarkdownQueryOptions = (
  client: SkillsQueryClient,
  skillName: string,
  context: SkillsQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getManagedSkillMarkdown(skillName, { signal })),
    queryKey: managedSkillMarkdownKey(skillName),
  });

export const projectSkillMarkdownQueryOptions = (
  client: SkillsQueryClient,
  input: ProjectSkillMarkdownInput,
  context: SkillsQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getProjectSkillMarkdown(input, { signal })),
    queryKey: projectSkillMarkdownKey(input),
  });

const invalidationKeys = {
  'known-project-paths': skillsKnownProjectPathsKey,
  'project-inventories': skillsProjectInventoriesKey,
  snapshot: skillsSnapshotKey,
} as const satisfies Record<SkillsInvalidationTarget, () => FiniteSwrQueryKey>;

export const invalidateSkillsQueries = async (
  client: QueryClient,
  targets: readonly SkillsInvalidationTarget[],
): Promise<void> => {
  const uniqueTargets = new Set(targets);
  await Promise.all(
    [...uniqueTargets].map(async (target) => {
      await client.invalidateQueries({ exact: true, queryKey: invalidationKeys[target]() });
    }),
  );
};

export const applyManagedMarkdownSaveToCache = (
  client: QueryClient,
  skillName: string,
  result: SkillsClientResult<SkillMarkdownSaveResult>,
): boolean => {
  if (!(result.ok && 'document' in result.data && result.data.document.skillName === skillName)) {
    return false;
  }
  const nextDocument: SkillMarkdownDocument = result.data.document;
  client.setQueryData(managedSkillMarkdownKey(skillName), nextDocument);
  return true;
};
