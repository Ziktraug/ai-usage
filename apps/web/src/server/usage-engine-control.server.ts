import { createUsageEngineControlClient, type UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import {
  assertUsageEngineRendezvousTarget,
  loadUsageEngineRendezvous,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';
import { resolveUsageWebRuntimePaths, type UsageWebRuntimePaths } from './usage-runtime-paths.server';

export const loadUsageEngineRendezvousForWeb = async (paths: UsageWebRuntimePaths) => {
  const rendezvous = await loadUsageEngineRendezvous(paths.rendezvousPath);
  assertUsageEngineRendezvousTarget(rendezvous, usageEngineTargetIdFor(paths));
  return rendezvous;
};

export const createLiveUsageEngineControlClient = (): UsageEngineControlClient =>
  createUsageEngineControlClient({
    resolveRendezvous: async () => await loadUsageEngineRendezvousForWeb(resolveUsageWebRuntimePaths()),
  });
