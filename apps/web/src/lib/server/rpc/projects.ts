import {
  type ProjectResolutionAction,
  projectResolutionActionResultSchema,
  projectResolutionReviewSnapshotSchema,
  projectsContract,
} from '@ai-usage/web-contract/projects';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export interface ProjectsRpcDependencies {
  readonly applyResolutionAction: (input: ProjectResolutionAction, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly listResolutionReviews: (signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

export const createProjectsRpcRouter = (dependencies: ProjectsRpcDependencies) => {
  const projects = implement(projectsContract);
  return {
    applyResolutionAction: projects.applyResolutionAction.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Project resolution is read-only in demo mode.',
        });
      }
      try {
        return parse(projectResolutionActionResultSchema, await dependencies.applyResolutionAction(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        throw errors.Unavailable({
          data: { reason: 'project-resolution-unavailable' },
          message: 'The project resolution action could not be applied.',
        });
      }
    }),
    resolutionReviews: projects.resolutionReviews.handler(async ({ errors, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Project resolution is unavailable in demo mode.',
        });
      }
      try {
        return parse(projectResolutionReviewSnapshotSchema, await dependencies.listResolutionReviews(signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        throw errors.Unavailable({
          data: { reason: 'project-resolution-unavailable' },
          message: 'Project resolution reviews could not be read safely.',
        });
      }
    }),
  };
};

export type ProjectsRpcRouter = ReturnType<typeof createProjectsRpcRouter>;
