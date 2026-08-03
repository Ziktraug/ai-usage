import type {
  ProjectSkillMarkdownInput,
  SkillMarkdownDocument,
  SkillMarkdownSaveResult,
} from '@ai-usage/web-contract/skills';
import type { QueryClient } from '@tanstack/svelte-query';
import { queryOptions } from '@tanstack/svelte-query';
import type { SkillsClient, SkillsClientResult } from '../../rpc/skills-client';
import { type FiniteSwrQueryKey, finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

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

export class SkillsQueryError extends Error {
  readonly tag: string;

  constructor(error: { readonly message: string; readonly tag: string }) {
    super(error.message);
    this.name = 'SkillsQueryError';
    this.tag = error.tag;
  }
}

const unwrapSkillsResult = <Value>(result: SkillsClientResult<Value>): Value => {
  if (!result.ok) {
    throw new SkillsQueryError(result.error);
  }
  return result.data;
};

export const skillsSnapshotKey = (): FiniteSwrQueryKey => finiteSwrKey('skills', 'snapshot');

export const skillsKnownProjectPathsKey = (): FiniteSwrQueryKey => finiteSwrKey('skills', 'known-project-paths');

export const skillsProjectInventoriesKey = (): FiniteSwrQueryKey => finiteSwrKey('skills', 'project-inventories');

export const managedSkillMarkdownKey = (skillName: string): FiniteSwrQueryKey =>
  finiteSwrKey('skills', 'markdown', 'scope', 'managed', 'skill', skillName);

export const projectSkillMarkdownKey = ({
  projectPath,
  runtimeDirId,
  skillName,
}: ProjectSkillMarkdownInput): FiniteSwrQueryKey =>
  finiteSwrKey(
    'skills',
    'markdown',
    'scope',
    'project',
    'project-path',
    projectPath,
    'runtime-dir',
    runtimeDirId,
    'skill',
    skillName,
  );

export const skillsSnapshotQueryOptions = (client: SkillsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsResult(await client.getSkillManagementSnapshot({ signal })),
    queryKey: skillsSnapshotKey(),
  });

export const skillsKnownProjectPathsQueryOptions = (client: SkillsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsResult(await client.getKnownSkillProjectPaths({ signal })),
    queryKey: skillsKnownProjectPathsKey(),
  });

export const skillsProjectInventoriesQueryOptions = (client: SkillsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsResult(await client.getSkillProjectInventories({ signal })),
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
    queryFn: async ({ signal }) => unwrapSkillsResult(await client.getManagedSkillMarkdown(skillName, { signal })),
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
    queryFn: async ({ signal }) => unwrapSkillsResult(await client.getProjectSkillMarkdown(input, { signal })),
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
