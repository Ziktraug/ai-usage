import { parseCheckoutResolutionAction, parseMemoryProposalReviewAction } from '@ai-usage/memory-service';
import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import { parseProjectId } from '@ai-usage/platform-core/identity';
import type { MemoryProposalReviewAction, MemorySearchInput } from '@ai-usage/web-contract/memory';
import type { ProjectResolutionAction } from '@ai-usage/web-contract/projects';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

const createClient = () => {
  const rendezvousPath = memoryServiceRendezvousPath(resolveUsageWebRuntimePaths().stateDirectory);
  return createMemoryServiceClient({
    resolveRendezvous: async () => await loadMemoryServiceRendezvous(rendezvousPath),
  });
};

export const getProjectResolutionReviewsForServer = async (signal?: AbortSignal) =>
  await createClient().listResolutionReviews(signal === undefined ? undefined : { signal });

export const applyProjectResolutionActionForServer = async (input: ProjectResolutionAction, signal?: AbortSignal) =>
  await createClient().applyResolutionAction(
    parseCheckoutResolutionAction(input),
    signal === undefined ? undefined : { signal },
  );

export const getMemoryProposalReviewsForServer = async (signal?: AbortSignal) =>
  await createClient().listProposalReviews(null, signal === undefined ? undefined : { signal });

export const applyMemoryProposalReviewActionForServer = async (
  input: MemoryProposalReviewAction,
  signal?: AbortSignal,
) =>
  await createClient().applyProposalReviewAction(
    parseMemoryProposalReviewAction(input),
    signal === undefined ? undefined : { signal },
  );

export const searchMemoryForServer = async (input: MemorySearchInput, signal?: AbortSignal) =>
  await createClient().searchMemory(
    {
      ...input,
      projectId: input.projectId === null ? null : parseProjectId(input.projectId),
    },
    signal === undefined ? undefined : { signal },
  );
