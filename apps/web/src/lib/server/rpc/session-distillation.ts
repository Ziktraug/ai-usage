import { MemoryServiceClientError } from '@ai-usage/memory-service/client';
import {
  parseDistillationEvidenceResult,
  parseDistillationStatus,
  parseSessionAnalysis,
  type SessionDistillationEvidenceRequest,
  type SessionDistillationGetRequest,
  type SessionDistillationStatusRequest,
  sessionDistillationContract,
} from '@ai-usage/web-contract/session-distillation';
import { implement } from '@orpc/server';

export type SessionDistillationReadRequest =
  | SessionDistillationEvidenceRequest
  | SessionDistillationGetRequest
  | SessionDistillationStatusRequest;

export interface SessionDistillationRpcDependencies {
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly read: (input: SessionDistillationReadRequest, signal: AbortSignal | undefined) => Promise<unknown>;
}

interface ReadErrors {
  forbidden: () => Error;
  unavailable: () => Error;
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
    throw errors.unavailable();
  }
};

export const createSessionDistillationRpcRouter = (dependencies: SessionDistillationRpcDependencies) => {
  const contract = implement(sessionDistillationContract);
  return {
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
        unavailable: () =>
          errors.Unavailable({
            data: { reason: 'session-evidence-unavailable' },
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
        unavailable: () =>
          errors.Unavailable({
            data: { reason: 'session-analysis-unavailable' },
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
        unavailable: () =>
          errors.Unavailable({
            data: { reason: 'session-analysis-unavailable' },
            message: 'Session analysis status could not be read safely.',
          }),
      });
    }),
  };
};
