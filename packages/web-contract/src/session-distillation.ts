import {
  DistillationError,
  type DistillationRequest,
  parseDistillationEvidenceResult,
  parseDistillationRequest,
  parseDistillationStatus,
  parseSessionAnalysis,
} from '@ai-usage/platform-core/session-distillation';
import { type ContractRouterClient, oc } from '@orpc/contract';
import { custom, pipe, transform } from 'valibot';
import { publicErrorMap } from './errors';
import { isJsonWireValue } from './schema-conventions';

export type SessionDistillationStatusRequest = Extract<DistillationRequest, { kind: 'status' }>;
export type SessionDistillationGetRequest = Extract<DistillationRequest, { kind: 'get'; selection: unknown }>;
export type SessionDistillationEvidenceRequest = Extract<DistillationRequest, { kind: 'evidence'; selection: unknown }>;

const parserSchema = <Output>(parser: (input: unknown) => Output) =>
  pipe(
    custom<unknown>((input) => {
      if (!isJsonWireValue(input)) {
        return false;
      }
      try {
        parser(input);
        return true;
      } catch {
        return false;
      }
    }, 'Expected a bounded Session analysis value.'),
    transform(parser),
  );

export const parseSessionDistillationStatusRequest = (input: unknown): SessionDistillationStatusRequest => {
  const request = parseDistillationRequest(input);
  if (request.kind !== 'status') {
    throw new DistillationError('invalid-status-request');
  }
  return request;
};

export const parseSessionDistillationGetRequest = (input: unknown): SessionDistillationGetRequest => {
  const request = parseDistillationRequest(input);
  if (request.kind !== 'get' || !('selection' in request)) {
    throw new DistillationError('invalid-analysis-read-request');
  }
  return request;
};

export const parseSessionDistillationEvidenceRequest = (input: unknown): SessionDistillationEvidenceRequest => {
  const request = parseDistillationRequest(input);
  if (request.kind !== 'evidence' || !('selection' in request)) {
    throw new DistillationError('invalid-evidence-read-request');
  }
  return request;
};

const errors = {
  Forbidden: publicErrorMap.Forbidden,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: publicErrorMap.InvalidInput,
  Unavailable: publicErrorMap.Unavailable,
} as const;

/** Browser readers cannot enqueue work, submit output, or select native file authority. */
export const sessionDistillationContract = {
  evidence: oc
    .route({ method: 'POST', path: '/session-distillation/evidence' })
    .input(parserSchema(parseSessionDistillationEvidenceRequest))
    .output(parserSchema(parseDistillationEvidenceResult))
    .errors(errors),
  get: oc
    .route({ method: 'POST', path: '/session-distillation/get' })
    .input(parserSchema(parseSessionDistillationGetRequest))
    .output(parserSchema(parseSessionAnalysis))
    .errors(errors),
  status: oc
    .route({ method: 'POST', path: '/session-distillation/status' })
    .input(parserSchema(parseSessionDistillationStatusRequest))
    .output(parserSchema(parseDistillationStatus))
    .errors(errors),
} as const;

export type SessionDistillationContractClient = ContractRouterClient<typeof sessionDistillationContract>;
export type {
  AnalysisRevisionMetadata,
  AssertionBasis,
  DistillationEvidenceResult,
  DistillationSelection,
  DistillationStatus,
  EpisodeOutcome,
  EvidenceRef,
  SessionAnalysis,
  SourcedAssertion,
  WorkEpisode,
} from '@ai-usage/platform-core/session-distillation';
export {
  parseDistillationEvidenceResult,
  parseDistillationStatus,
  parseSessionAnalysis,
} from '@ai-usage/platform-core/session-distillation';
