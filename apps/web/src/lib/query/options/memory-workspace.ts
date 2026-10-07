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
/**
 * The RPC context is installed only in the browser, so an absent client is the server render: Memory
 * reads stay disabled there rather than borrowing the report owners' SSR placeholder client.
 */
export const browserMemoryClient = <Client>(client: Client | undefined): Client => {
  if (client === undefined) {
    throw new Error('Memory reads run only in the browser.');
  }
  return client;
};
export const memoryWorkspaceProjectsOptions = (
  client: SessionDistillationContractClient | undefined,
  cursor: string | null = null,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: client !== undefined,
    queryKey: finiteSwrKey('memory', 'projects', cursor ?? ''),
    queryFn: ({ signal }) => browserMemoryClient(client).projects({ kind: 'projects', limit: 50, cursor }, { signal }),
  });
export const memoryWorkspaceBrowseOptions = (
  client: SessionDistillationContractClient | undefined,
  input: SessionDistillationBrowseRequest,
  enabled: boolean,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: enabled && client !== undefined,
    queryKey: finiteSwrKey('memory', 'analyses', JSON.stringify(input)),
    queryFn: ({ signal }) => browserMemoryClient(client).browse(input, { signal }),
  });
export const memoryWorkspaceDiscoveryOptions = (
  client: SessionDistillationContractClient | undefined,
  input: SessionDistillationDiscoverRequest | undefined,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: client !== undefined && input !== undefined,
    queryKey: finiteSwrKey('memory', 'discovery', JSON.stringify(input ?? null)),
    queryFn: ({ signal }) => {
      if (!input) {
        throw new Error('Choose a Project before discovery.');
      }
      return browserMemoryClient(client).discover(input, { signal });
    },
  });
export const memoryKnowledgeOptions = (
  client: MemoryContractClient | undefined,
  input: MemoryKnowledgeInput,
  enabled: boolean,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: enabled && client !== undefined,
    queryKey: finiteSwrKey('memory', 'knowledge', JSON.stringify(input)),
    queryFn: ({ signal }) => browserMemoryClient(client).knowledge(input, { signal }),
  });
