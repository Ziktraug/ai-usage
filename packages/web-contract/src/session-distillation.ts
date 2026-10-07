import {
  type DistillationDiscoveryRequest,
  parseDistillationBrowsePage,
  parseDistillationDiscoveryPreview,
  parseDistillationDiscoveryRequest,
  parseDistillationHistoryPage,
  parseDistillationProjectsPage,
} from '@ai-usage/platform-core/distillation-discovery';
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
export type SessionDistillationGetRequest = Extract<DistillationRequest, { kind: 'get' }>;
export type SessionDistillationEvidenceRequest = Extract<DistillationRequest, { kind: 'evidence' }>;

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
  if (request.kind !== 'get') {
    throw new DistillationError('invalid-analysis-read-request');
  }
  return request;
};

export const parseSessionDistillationEvidenceRequest = (input: unknown): SessionDistillationEvidenceRequest => {
  const request = parseDistillationRequest(input);
  if (request.kind !== 'evidence') {
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

export type SessionDistillationProjectsRequest = Extract<DistillationDiscoveryRequest, { kind: 'projects' }>;
export type SessionDistillationDiscoverRequest = Extract<DistillationDiscoveryRequest, { kind: 'discover' }>;
export type SessionDistillationBrowseRequest = Extract<DistillationDiscoveryRequest, { kind: 'browse' }>;
const discoveryRequest =
  <Kind extends 'projects' | 'discover' | 'browse' | 'history'>(kind: Kind) =>
  (input: unknown): Extract<DistillationDiscoveryRequest, { kind: Kind }> => {
    const request = parseDistillationDiscoveryRequest(input);
    if (request.kind !== kind) {
      throw new DistillationError('invalid-discovery-request');
    }
    return request as Extract<DistillationDiscoveryRequest, { kind: Kind }>;
  };

/** Browser readers cannot enqueue work, submit output, or select native file authority. */
export type SessionDistillationHistoryRequest = Extract<DistillationDiscoveryRequest, { kind: 'history' }>;
export const sessionDistillationContract = {
  history: oc
    .route({ method: 'POST', path: '/session-distillation/history' })
    .input(parserSchema(discoveryRequest('history')))
    .output(parserSchema(parseDistillationHistoryPage))
    .errors(errors),
  projects: oc
    .route({ method: 'POST', path: '/session-distillation/projects' })
    .input(parserSchema(discoveryRequest('projects')))
    .output(parserSchema(parseDistillationProjectsPage))
    .errors(errors),
  discover: oc
    .route({ method: 'POST', path: '/session-distillation/discover' })
    .input(parserSchema(discoveryRequest('discover')))
    .output(parserSchema(parseDistillationDiscoveryPreview))
    .errors(errors),
  browse: oc
    .route({ method: 'POST', path: '/session-distillation/browse' })
    .input(parserSchema(discoveryRequest('browse')))
    .output(parserSchema(parseDistillationBrowsePage))
    .errors(errors),
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
  DistillationBrowseItem,
  DistillationBrowsePage,
  DistillationDiscoveryPreview,
  DistillationHistoryPage,
  DistillationProjectsPage,
} from '@ai-usage/platform-core/distillation-discovery';
export {
  parseDistillationBrowsePage,
  parseDistillationDiscoveryPreview,
  parseDistillationHistoryPage,
  parseDistillationProjectsPage,
} from '@ai-usage/platform-core/distillation-discovery';
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
