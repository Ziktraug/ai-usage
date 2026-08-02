import { parseSessionDetailResponse } from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenServerResult,
  parseSessionNeighborServerResult,
  parseSessionPageServerResult,
} from '@ai-usage/report-core/session-query';
import { parseSessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
import {
  type SessionCampaignChildrenRequest,
  type SessionDetailRequest,
  type SessionNeighborRequest,
  type SessionQueryRequest,
  type SessionQueryServerResult,
  type SessionVcsResolveRequest,
  sessionContract,
} from '@ai-usage/web-contract/session';
import { implement } from '@orpc/server';

export type SessionRevisionQueryKind = 'campaign-children' | 'neighbors' | 'sessions';

interface SessionRevisionQueryInputByKind {
  'campaign-children': SessionCampaignChildrenRequest;
  neighbors: SessionNeighborRequest;
  sessions: SessionQueryRequest;
}

export interface SessionRpcDependencies {
  readonly getDetail: (request: SessionDetailRequest, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly resolveVcs: (request: SessionVcsResolveRequest, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly runRevisionQuery: <Kind extends SessionRevisionQueryKind>(
    kind: Kind,
    request: SessionRevisionQueryInputByKind[Kind],
    signal: AbortSignal | undefined,
  ) => Promise<unknown>;
}

interface ExactQueryErrorFactories {
  readonly incompatibleStore: () => Error;
  readonly revisionExpired: () => Error;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

const runExactQuery = async <Request, Result>(
  request: Request,
  signal: AbortSignal | undefined,
  execute: (request: Request, signal: AbortSignal | undefined) => Promise<unknown>,
  parse: (value: unknown, request: Request) => SessionQueryServerResult<Result>,
  errors: ExactQueryErrorFactories,
): Promise<SessionQueryServerResult<Result>> => {
  throwIfAborted(signal);
  let result: SessionQueryServerResult<Result>;
  try {
    const value = await execute(request, signal);
    throwIfAborted(signal);
    result = parse(value, request);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    throw errors.incompatibleStore();
  }

  if (!result.ok) {
    throw result.error.tag === 'RevisionExpired' ? errors.revisionExpired() : errors.incompatibleStore();
  }
  return result;
};

const runLocalRead = async <Request, Response>(
  request: Request,
  signal: AbortSignal | undefined,
  execute: (request: Request, signal: AbortSignal | undefined) => Promise<unknown>,
  parse: (value: unknown) => Response,
  unavailable: () => Error,
): Promise<Response> => {
  throwIfAborted(signal);
  try {
    const value = await execute(request, signal);
    throwIfAborted(signal);
    return parse(value);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    throw unavailable();
  }
};

export const createSessionRpcRouter = (dependencies: SessionRpcDependencies) => {
  const session = implement(sessionContract);

  return {
    campaignChildren: session.campaignChildren.handler(
      async ({ errors, input, signal }) =>
        await runExactQuery(
          input,
          signal,
          (request, requestSignal) => dependencies.runRevisionQuery('campaign-children', request, requestSignal),
          parseSessionCampaignChildrenServerResult,
          {
            incompatibleStore: () =>
              errors.IncompatibleStore({
                data: { reason: 'incompatible-store' },
                message: 'The exact Session campaign query is unavailable for this report store.',
              }),
            revisionExpired: () =>
              errors.RevisionExpired({
                data: { reason: 'revision-expired' },
                message: 'The requested report revision is no longer available.',
              }),
          },
        ),
    ),
    detail: session.detail.handler(
      async ({ errors, input, signal }) =>
        await runLocalRead(input, signal, dependencies.getDetail, parseSessionDetailResponse, () =>
          errors.Unavailable({
            data: { reason: 'session-detail-unavailable' },
            message: 'Session detail could not be read safely.',
          }),
        ),
    ),
    neighbors: session.neighbors.handler(
      async ({ errors, input, signal }) =>
        await runExactQuery(
          input,
          signal,
          (request, requestSignal) => dependencies.runRevisionQuery('neighbors', request, requestSignal),
          parseSessionNeighborServerResult,
          {
            incompatibleStore: () =>
              errors.IncompatibleStore({
                data: { reason: 'incompatible-store' },
                message: 'The exact Session neighbor query is unavailable for this report store.',
              }),
            revisionExpired: () =>
              errors.RevisionExpired({
                data: { reason: 'revision-expired' },
                message: 'The requested report revision is no longer available.',
              }),
          },
        ),
    ),
    page: session.page.handler(
      async ({ errors, input, signal }) =>
        await runExactQuery(
          input,
          signal,
          (request, requestSignal) => dependencies.runRevisionQuery('sessions', request, requestSignal),
          parseSessionPageServerResult,
          {
            incompatibleStore: () =>
              errors.IncompatibleStore({
                data: { reason: 'incompatible-store' },
                message: 'The exact Session page is unavailable for this report store.',
              }),
            revisionExpired: () =>
              errors.RevisionExpired({
                data: { reason: 'revision-expired' },
                message: 'The requested report revision is no longer available.',
              }),
          },
        ),
    ),
    vcs: session.vcs.handler(
      async ({ errors, input, signal }) =>
        await runLocalRead(input, signal, dependencies.resolveVcs, parseSessionVcsResolveResponse, () =>
          errors.Unavailable({
            data: { reason: 'session-vcs-unavailable' },
            message: 'Session version-control context could not be resolved safely.',
          }),
        ),
    ),
  };
};

export type SessionRpcRouter = ReturnType<typeof createSessionRpcRouter>;
