import type { SkillManagementSnapshot } from '@ai-usage/skills';
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
  skillObservationsKey,
  skillsKnownProjectPathsKey,
  skillsProjectInventoriesKey,
  skillsSnapshotKey,
  unwrapSkillsQueryResult,
} from '../identities/skills';
import type { CollectionSwrQueryKey, FiniteSwrQueryKey } from '../keys';
import { webQueryPolicies } from '../policies';
import { skillObservationProducerProofStaleTime } from '../skill-observation-proof';

export {
  managedSkillMarkdownKey,
  projectSkillMarkdownKey,
  SkillsQueryError,
  skillObservationsKey,
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
  | 'getSkillObservations'
  | 'getSkillProjectInventories'
>;
export type SkillsInventoryQueryClient = Pick<SkillsQueryClient, 'getSkillProjectInventories'>;
export type SkillObservationsQueryClient = Pick<SkillsQueryClient, 'getSkillObservations'>;

export type SkillsInvalidationTarget = 'known-project-paths' | 'observations' | 'project-inventories' | 'snapshot';

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
    structuralSharing: false,
  });

export const skillsKnownProjectPathsQueryOptions = (client: SkillsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getKnownSkillProjectPaths({ signal })),
    queryKey: skillsKnownProjectPathsKey(),
  });

export const skillsProjectInventoriesQueryOptions = (client: SkillsInventoryQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getSkillProjectInventories({ signal })),
    queryKey: skillsProjectInventoriesKey(),
  });

/**
 * The one query for the skill-observation identity, on the collection cadence rather than the
 * snapshot's. Collection publication remains the prompt path, while interval, focus, and mount
 * revalidation prevent the producer-completeness proof from outliving its budget. That distinct
 * lifecycle is why observations do not share the snapshot's policy.
 */
export const skillObservationsQueryOptions = (client: SkillObservationsQueryClient, context: SkillsQueryContext) =>
  queryOptions({
    ...webQueryPolicies.collectionSwr,
    enabled: context.browser && context.enabled,
    queryFn: async ({ signal }) => unwrapSkillsQueryResult(await client.getSkillObservations({ signal })),
    queryKey: skillObservationsKey(),
    staleTime: (query) =>
      skillObservationProducerProofStaleTime(
        query.state.data?.producerProofValidUntil ?? null,
        query.state.dataUpdatedAt,
      ),
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

export const fetchManagedSkillMarkdown = async (
  queryClient: QueryClient,
  client: SkillsQueryClient,
  skillName: string,
): Promise<SkillMarkdownDocument> =>
  await queryClient.fetchQuery(managedSkillMarkdownQueryOptions(client, skillName, { browser: true, enabled: true }));

export const skillsMutationOptions = <Variables, Result>(
  identity: string,
  mutationFn: (variables: Variables) => Promise<Result>,
) => ({
  mutationFn,
  mutationKey: ['web', 'mutation', 'skills', identity] as const,
  retry: false as const,
});

const invalidationKeys = {
  'known-project-paths': skillsKnownProjectPathsKey,
  observations: skillObservationsKey,
  'project-inventories': skillsProjectInventoriesKey,
  snapshot: skillsSnapshotKey,
} as const satisfies Record<SkillsInvalidationTarget, () => CollectionSwrQueryKey | FiniteSwrQueryKey>;

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
export const applySkillsSnapshotToCache = async <Snapshot>(
  queryClient: QueryClient,
  snapshot: Snapshot,
): Promise<void> => {
  queryClient.setQueryData(skillsSnapshotKey(), snapshot);
  // The observations procedure joins durable facts to this inventory on the
  // server. A new snapshot therefore invalidates the joined answer even when
  // no collection ran.
  await invalidateSkillsQueries(queryClient, ['observations']);
};
export const applySkillsConfigurationSnapshotToCache = async (
  queryClient: QueryClient,
  skillsClient: SkillsInventoryQueryClient,
  snapshot: SkillManagementSnapshot,
  refreshDependents: boolean,
): Promise<void> => {
  await applySkillsSnapshotToCache(queryClient, snapshot);
  if (!refreshDependents) {
    return;
  }
  await invalidateSkillsQueries(queryClient, ['known-project-paths', 'project-inventories']);
  if (!snapshot.configured) {
    return;
  }
  await queryClient.fetchQuery(skillsProjectInventoriesQueryOptions(skillsClient, { browser: true, enabled: true }));
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
