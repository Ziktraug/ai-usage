import {
  type ProjectResolutionAction,
  type ProjectResolutionActionResult,
  type ProjectResolutionReviewSnapshot,
  type ProjectsContractClient,
  parseProjectResolutionActionResult,
  parseProjectResolutionReviewSnapshot,
} from '@ai-usage/web-contract/projects';

export type ProjectsRpcTransport = Pick<ProjectsContractClient, 'applyResolutionAction' | 'resolutionReviews'>;

export interface ProjectsBrowserAdapter {
  readonly applyResolutionAction: (
    action: ProjectResolutionAction,
    signal?: AbortSignal,
  ) => Promise<ProjectResolutionActionResult>;
  readonly resolutionReviews: (signal?: AbortSignal) => Promise<ProjectResolutionReviewSnapshot>;
}

export const createProjectsBrowserAdapter = (transport: ProjectsRpcTransport): ProjectsBrowserAdapter => ({
  applyResolutionAction: async (action, signal) => {
    signal?.throwIfAborted();
    const result = await transport.applyResolutionAction(action, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseProjectResolutionActionResult(result);
  },
  resolutionReviews: async (signal) => {
    signal?.throwIfAborted();
    const result = await transport.resolutionReviews({}, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseProjectResolutionReviewSnapshot(result);
  },
});
