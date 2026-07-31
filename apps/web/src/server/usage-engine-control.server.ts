import { createUsageEngineControlClient, type UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import { loadUsageEngineRendezvous } from '@ai-usage/usage-engine-control/node';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

export const createLiveUsageEngineControlClient = (): UsageEngineControlClient =>
  createUsageEngineControlClient({
    resolveRendezvous: async () => await loadUsageEngineRendezvous(resolveUsageWebRuntimePaths().rendezvousPath),
  });
