import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import type { SessionDistillationReadRequest } from '../lib/server/rpc/session-distillation';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

/** All selection authorization and native resolution belong to the local Memory runtime. */
export const readSessionDistillationForServer = async (
  input: SessionDistillationReadRequest,
  signal?: AbortSignal,
): Promise<unknown> => {
  const rendezvousPath = memoryServiceRendezvousPath(resolveUsageWebRuntimePaths().stateDirectory);
  const client = createMemoryServiceClient({
    resolveRendezvous: async () => await loadMemoryServiceRendezvous(rendezvousPath),
  });
  return await client.distillation(input, signal ? { signal } : {});
};
