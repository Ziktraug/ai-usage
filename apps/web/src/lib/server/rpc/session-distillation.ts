import { MemoryServiceClientError } from '@ai-usage/memory-service/client';
import {
  parseDistillationBrowsePage,
  parseDistillationDiscoveryPreview,
  parseDistillationEvidenceResult,
  parseDistillationHistoryPage,
  parseDistillationProjectsPage,
  parseDistillationStatus,
  parseSessionAnalysis,
  type SessionDistillationBrowseRequest,
  type SessionDistillationDiscoverRequest,
  type SessionDistillationEvidenceRequest,
  type SessionDistillationGetRequest,
  type SessionDistillationHistoryRequest,
  type SessionDistillationProjectsRequest,
  type SessionDistillationStatusRequest,
  sessionDistillationContract,
} from '@ai-usage/web-contract/session-distillation';
import { implement } from '@orpc/server';

export type SessionDistillationReadRequest =
  | SessionDistillationEvidenceRequest
  | SessionDistillationGetRequest
  | SessionDistillationStatusRequest
  | SessionDistillationProjectsRequest
  | SessionDistillationDiscoverRequest
  | SessionDistillationBrowseRequest
  | SessionDistillationHistoryRequest;

export interface SessionDistillationRpcDependencies {
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly read: (input: SessionDistillationReadRequest, signal: AbortSignal | undefined) => Promise<unknown>;
}

interface ReadErrors {
  forbidden: () => Error;
  unavailable: (reason?: MemoryServiceClientError['code']) => Error;
}

const read = async <Output>(
  dependencies: SessionDistillationRpcDependencies,
  input: SessionDistillationReadRequest,
  signal: AbortSignal | undefined,
  parse: (value: unknown) => Output,
  errors: ReadErrors,
): Promise<Output> => {
  signal?.throwIfAborted();
  try {
    const result = await dependencies.read(input, signal);
    signal?.throwIfAborted();
    return parse(result);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    if (error instanceof MemoryServiceClientError && error.code === 'forbidden') {
      throw errors.forbidden();
    }
    if (error instanceof MemoryServiceClientError) {
      throw errors.unavailable(error.code);
    }
    throw errors.unavailable();
  }
};

export const createSessionDistillationRpcRouter = (dependencies: SessionDistillationRpcDependencies) => {
  const contract = implement(sessionDistillationContract);
  return {
    history: contract.history.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Local analyses are unavailable in demo mode.',
        });
      }
      return await read(dependencies, input, signal, parseDistillationHistoryPage, {
        forbidden: () =>
          errors.Forbidden({
            data: { reason: 'project-access-denied' },
            message: 'This analysis history is not accessible.',
          }),
        unavailable: (reason) =>
          errors.Unavailable({
            data: { reason: reason ?? 'analysis-history-unavailable' },
            message: 'Analysis history is unavailable.',
          }),
      });
    }),
    projects: contract.projects.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Local analyses are unavailable in demo mode.',
        });
      }
      return await read(dependencies, input, signal, parseDistillationProjectsPage, {
        forbidden: () =>
          errors.Forbidden({
            data: { reason: 'project-access-denied' },
            message: 'Project discovery is not permitted.',
          }),
        unavailable: (reason) =>
          errors.Unavailable({
            data: { reason: reason ?? 'memory-service-unavailable' },
            message: 'Project discovery requires the local Memory service.',
          }),
      });
    }),
    discover: contract.discover.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Local analyses are unavailable in demo mode.',
        });
      }
      return await read(dependencies, input, signal, parseDistillationDiscoveryPreview, {
        forbidden: () =>
          errors.Forbidden({
            data: { reason: 'project-access-denied' },
            message: 'Session discovery is not permitted.',
          }),
        unavailable: (reason) =>
          errors.Unavailable({
            data: { reason: reason ?? 'session-discovery-unavailable' },
            message: 'Session discovery requires an acknowledged local Project mapping.',
          }),
      });
    }),
    browse: contract.browse.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Local analyses are unavailable in demo mode.',
        });
      }
      return await read(dependencies, input, signal, parseDistillationBrowsePage, {
        forbidden: () =>
          errors.Forbidden({
            data: { reason: 'project-access-denied' },
            message: 'These analyses are not accessible.',
          }),
        unavailable: (reason) =>
          errors.Unavailable({
            data: { reason: reason ?? 'memory-service-unavailable' },
            message: 'The local analysis library is unavailable.',
          }),
      });
    }),
    evidence: contract.evidence.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Session analysis is unavailable in demo mode.',
        });
      }
      return await read(dependencies, input, signal, parseDistillationEvidenceResult, {
        forbidden: () =>
          errors.Forbidden({
            data: { reason: 'session-evidence-forbidden' },
            message: 'This Session evidence cannot be read on this machine.',
          }),
        unavailable: (reason) =>
          errors.Unavailable({
            data: { reason: reason ?? 'session-evidence-unavailable' },
            message: 'Session evidence could not be read safely.',
          }),
      });
    }),
    get: contract.get.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Session analysis is unavailable in demo mode.',
        });
      }
      return await read(dependencies, input, signal, parseSessionAnalysis, {
        forbidden: () =>
          errors.Forbidden({
            data: { reason: 'session-analysis-forbidden' },
            message: 'This Session analysis cannot be read on this machine.',
          }),
        unavailable: (reason) =>
          errors.Unavailable({
            data: { reason: reason ?? 'session-analysis-unavailable' },
            message: 'Session analysis could not be read safely.',
          }),
      });
    }),
    status: contract.status.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Session analysis is unavailable in demo mode.',
        });
      }
      return await read(dependencies, input, signal, parseDistillationStatus, {
        forbidden: () =>
          errors.Forbidden({
            data: { reason: 'session-analysis-forbidden' },
            message: 'Session analysis requires an authorized local Codex session.',
          }),
        unavailable: (reason) =>
          errors.Unavailable({
            data: { reason: reason ?? 'session-analysis-unavailable' },
            message: 'Session analysis status could not be read safely.',
          }),
      });
    }),
  };
};
