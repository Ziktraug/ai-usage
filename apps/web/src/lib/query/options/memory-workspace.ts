import type { MemoryContractClient, MemoryKnowledgeInput } from '@ai-usage/web-contract/memory';
import type {
  SessionDistillationBrowseRequest,
  SessionDistillationContractClient,
  SessionDistillationDiscoverRequest,
} from '@ai-usage/web-contract/session-distillation';
import { queryOptions } from '@tanstack/svelte-query';
import { finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

/** Query owns continuation; the view contributes only its currently visible range. */
export const continueMemoryAnalysisWindow = (
  query: {
    isFetching: boolean;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
    fetchPreviousPage: () => Promise<unknown>;
    fetchNextPage: () => Promise<unknown>;
  },
  window: {
    active: boolean;
    firstIndex: number;
    rowCount: number;
    visibleStart: number;
    visibleEnd: number;
    overscan: number;
  },
): void => {
  if (!window.active || query.isFetching || window.rowCount === 0) {
    return;
  }
  if (window.visibleStart < window.firstIndex + window.overscan && query.hasPreviousPage) {
    query.fetchPreviousPage();
    return;
  }
  if (window.visibleEnd > window.firstIndex + window.rowCount - window.overscan && query.hasNextPage) {
    query.fetchNextPage();
  }
};
export const memoryWorkspaceProjectsOptions = (
  client: SessionDistillationContractClient,
  enabled: boolean,
  cursor: string | null = null,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled,
    queryKey: finiteSwrKey('memory', 'projects', cursor ?? ''),
    queryFn: ({ signal }) => client.projects({ kind: 'projects', limit: 50, cursor }, { signal }),
  });
export const memoryWorkspaceBrowseOptions = (
  client: SessionDistillationContractClient,
  input: SessionDistillationBrowseRequest,
  enabled: boolean,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled,
    queryKey: finiteSwrKey('memory', 'analyses', JSON.stringify(input)),
    queryFn: ({ signal }) => client.browse(input, { signal }),
  });
export const memoryWorkspaceDiscoveryOptions = (
  client: SessionDistillationContractClient,
  input: SessionDistillationDiscoverRequest | undefined,
  enabled: boolean,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: enabled && input !== undefined,
    queryKey: finiteSwrKey('memory', 'discovery', JSON.stringify(input ?? null)),
    queryFn: ({ signal }) => {
      if (!input) {
        throw new Error('Choose a Project before discovery.');
      }
      return client.discover(input, { signal });
    },
  });
export const memoryKnowledgeOptions = (client: MemoryContractClient, input: MemoryKnowledgeInput, enabled: boolean) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled,
    queryKey: finiteSwrKey('memory', 'knowledge', JSON.stringify(input)),
    queryFn: ({ signal }) => client.knowledge(input, { signal }),
  });
