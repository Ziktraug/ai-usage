import { parseSessionDetailRequest, parseSessionDetailResponse } from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
  type SessionCampaignChildrenResult,
  type SessionNeighborResult,
  type SessionPageResult,
} from '@ai-usage/report-core/session-query';
import { parseSessionVcsResolveRequest, parseSessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
import { type ContractRouterClient, oc } from '@orpc/contract';
import { custom, literal, minLength, picklist, pipe, strictObject, string, transform, union } from 'valibot';
import { publicErrorMap } from './errors';
import { isJsonWireValue } from './schema-conventions';

const parses = <Output>(parser: (input: unknown) => Output, input: unknown): boolean => {
  try {
    parser(input);
    return true;
  } catch {
    return false;
  }
};

const parserSchema = <Output>(parser: (input: unknown) => Output, message: string) =>
  pipe(
    custom<unknown>((input) => parses(parser, input), message),
    transform((input) => parser(input)),
  );

const exactSessionErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  IncompatibleStore: publicErrorMap.IncompatibleStore,
  InvalidInput: publicErrorMap.InvalidInput,
  RevisionExpired: publicErrorMap.RevisionExpired,
} as const;

const localSessionErrors = {
  Forbidden: publicErrorMap.Forbidden,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: publicErrorMap.InvalidInput,
  Unavailable: publicErrorMap.Unavailable,
} as const;

export const sessionQueryRequestSchema = parserSchema(
  parseSessionQueryRequest,
  'Expected an exact bounded Session page request.',
);
export const sessionCampaignChildrenRequestSchema = parserSchema(
  parseSessionCampaignChildrenRequest,
  'Expected an exact bounded Session campaign-children request.',
);
export const sessionNeighborRequestSchema = parserSchema(
  parseSessionNeighborRequest,
  'Expected an exact bounded Session neighbor request.',
);
export const sessionDetailRequestSchema = parserSchema(
  parseSessionDetailRequest,
  'Expected an exact bounded Session detail request.',
);
export const sessionVcsResolveRequestSchema = parserSchema(
  parseSessionVcsResolveRequest,
  'Expected an exact bounded Session VCS request.',
);

const sessionQueryDataSchema = <Output>() =>
  custom<Output>(
    isJsonWireValue,
    'Expected finite JSON Session query data without files, streams, dates, class instances, or accessors.',
  );

const sessionQueryOutputSchema = <Output>() =>
  pipe(
    custom<unknown>(
      isJsonWireValue,
      'Expected a finite JSON Session query envelope without files, streams, dates, class instances, or accessors.',
    ),
    union([
      strictObject({
        data: sessionQueryDataSchema<Output>(),
        ok: literal(true),
        requestFingerprint: string(),
        revision: string(),
      }),
      strictObject({
        error: strictObject({
          message: pipe(string(), minLength(1, 'Session query errors must not be empty.')),
          revision: string(),
          tag: picklist(['QueryFailed', 'RevisionExpired']),
        }),
        ok: literal(false),
        requestFingerprint: string(),
        revision: string(),
      }),
    ]),
  );

export const sessionPageOutputSchema = sessionQueryOutputSchema<SessionPageResult>();
export const sessionCampaignChildrenOutputSchema = sessionQueryOutputSchema<SessionCampaignChildrenResult>();
export const sessionNeighborOutputSchema = sessionQueryOutputSchema<SessionNeighborResult>();
export const sessionDetailResponseSchema = parserSchema(
  parseSessionDetailResponse,
  'Expected an exact bounded Session detail response.',
);
export const sessionVcsResolveResponseSchema = parserSchema(
  parseSessionVcsResolveResponse,
  'Expected an exact bounded Session VCS response.',
);

export const sessionContract = {
  campaignChildren: oc
    .route({ method: 'POST', path: '/session/campaign-children' })
    .input(sessionCampaignChildrenRequestSchema)
    .output(sessionCampaignChildrenOutputSchema)
    .errors(exactSessionErrors),
  detail: oc
    .route({ method: 'POST', path: '/session/detail' })
    .input(sessionDetailRequestSchema)
    .output(sessionDetailResponseSchema)
    .errors(localSessionErrors),
  neighbors: oc
    .route({ method: 'POST', path: '/session/neighbors' })
    .input(sessionNeighborRequestSchema)
    .output(sessionNeighborOutputSchema)
    .errors(exactSessionErrors),
  page: oc
    .route({ method: 'POST', path: '/session/page' })
    .input(sessionQueryRequestSchema)
    .output(sessionPageOutputSchema)
    .errors(exactSessionErrors),
  vcs: oc
    .route({ method: 'POST', path: '/session/vcs' })
    .input(sessionVcsResolveRequestSchema)
    .output(sessionVcsResolveResponseSchema)
    .errors(localSessionErrors),
} as const;

export type SessionContractClient = ContractRouterClient<typeof sessionContract>;
export type { SessionDetailRequest, SessionDetailResponse } from '@ai-usage/report-core/session-detail';
export type {
  SessionCampaignChildrenRequest,
  SessionCampaignChildrenResult,
  SessionNeighborRequest,
  SessionNeighborResult,
  SessionPageResult,
  SessionQueryRequest,
  SessionQueryServerResult,
} from '@ai-usage/report-core/session-query';
export type { SessionVcsResolveRequest, SessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
