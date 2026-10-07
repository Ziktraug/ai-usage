import { parseCheckoutResolutionAction, parseMemoryProposalReviewAction } from '@ai-usage/memory-service';
import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import { parseMemoryItemReadRequest } from '@ai-usage/memory-service/read-contract';
import { parseProjectId } from '@ai-usage/platform-core/identity';
import type {
  MemoryKnowledgeGetInput,
  MemoryKnowledgeInput,
  MemoryPromotionInput,
  MemoryProposalReviewAction,
  MemoryProposalReviewInput,
  MemorySearchInput,
} from '@ai-usage/web-contract/memory';
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

export const getMemoryProposalReviewsForServer = async (
  signal?: AbortSignal,
  position: MemoryProposalReviewInput = {},
) => await createClient().listProposalReviews(position, signal === undefined ? undefined : { signal });

export const listMemoryKnowledgeForServer = async (input: MemoryKnowledgeInput, signal?: AbortSignal) => {
  const page = await createClient().listMemoryItems(
    {
      pageSize: input.pageSize,
      cursor: input.cursor,
      ...(input.projectId === null ? {} : { projectId: parseProjectId(input.projectId) }),
      ...(input.kind === null ? {} : { kind: input.kind }),
    },
    signal ? { signal } : {},
  );
  return page;
};
export const promoteMemoryAnalysisForServer = async (input: MemoryPromotionInput, signal?: AbortSignal) =>
  await createClient().promoteAnalysis(input, signal ? { signal } : {});
export const getMemoryKnowledgeForServer = async (input: MemoryKnowledgeGetInput, signal?: AbortSignal) => {
  const { item, revision } = await createClient().getMemoryItem(
    parseMemoryItemReadRequest(input),
    signal ? { signal } : {},
  );
  return {
    id: item.id,
    revisionId: revision.id,
    title: revision.title,
    summary: revision.summary,
    guidance: revision.guidance,
    structuredContent: revision.structuredContent,
  };
};

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
