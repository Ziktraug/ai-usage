import type { MemoryContractClient, MemoryKnowledgeInput } from '@ai-usage/web-contract/memory';
import { queryOptions } from '@tanstack/svelte-query';
import { finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

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
