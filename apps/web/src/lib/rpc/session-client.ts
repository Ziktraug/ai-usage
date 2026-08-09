import {
  parseSessionDetailRequest,
  parseSessionDetailResponse,
  SessionDetailValidationError,
} from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionCampaignChildrenServerResult,
  parseSessionNeighborRequest,
  parseSessionNeighborServerResult,
  parseSessionPageServerResult,
  parseSessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import { parseSessionVcsResolveRequest, parseSessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
import type {
  SessionCampaignChildrenRequest,
  SessionCampaignChildrenResult,
  SessionContractClient,
  SessionDetailRequest,
  SessionDetailResponse,
  SessionNeighborRequest,
  SessionNeighborResult,
  SessionPageResult,
  SessionQueryRequest,
  SessionQueryServerResult,
  SessionVcsResolveRequest,
  SessionVcsResolveResponse,
} from '@ai-usage/web-contract/session';

export type SessionRpcTransport = Pick<
  SessionContractClient,
  'campaignChildren' | 'detail' | 'neighbors' | 'page' | 'vcs'
>;

interface SessionCallOptions {
  readonly signal?: AbortSignal;
}

const signalOptions = (signal: AbortSignal | undefined): SessionCallOptions => (signal === undefined ? {} : { signal });

export interface SessionClientAdapter {
  campaignChildren: (
    input: SessionCampaignChildrenRequest,
    signal?: AbortSignal,
  ) => Promise<SessionQueryServerResult<SessionCampaignChildrenResult>>;
  detail: (input: SessionDetailRequest, signal?: AbortSignal) => Promise<SessionDetailResponse>;
  neighbors: (
    input: SessionNeighborRequest,
    signal?: AbortSignal,
  ) => Promise<SessionQueryServerResult<SessionNeighborResult>>;
  page: (input: SessionQueryRequest, signal?: AbortSignal) => Promise<SessionQueryServerResult<SessionPageResult>>;
  vcs: (input: SessionVcsResolveRequest, signal?: AbortSignal) => Promise<SessionVcsResolveResponse>;
}

export const createSessionClientAdapter = (transport: SessionRpcTransport): SessionClientAdapter => ({
  campaignChildren: async (input, signal) => {
    const request = parseSessionCampaignChildrenRequest(input);
    const response = await transport.campaignChildren(request, signalOptions(signal));
    return parseSessionCampaignChildrenServerResult(response, request);
  },
  detail: async (input, signal) => {
    const request = parseSessionDetailRequest(input);
    const response = parseSessionDetailResponse(await transport.detail(request, signalOptions(signal)));
    if (response.status === 'available' && response.revision !== request.revision) {
      throw new SessionDetailValidationError('Session detail response does not match its requested revision');
    }
    return response;
  },
  neighbors: async (input, signal) => {
    const request = parseSessionNeighborRequest(input);
    const response = await transport.neighbors(request, signalOptions(signal));
    return parseSessionNeighborServerResult(response, request);
  },
  page: async (input, signal) => {
    const request = parseSessionQueryRequest(input);
    const response = await transport.page(request, signalOptions(signal));
    return parseSessionPageServerResult(response, request);
  },
  vcs: async (input, signal) => {
    const request = parseSessionVcsResolveRequest(input);
    return parseSessionVcsResolveResponse(await transport.vcs(request, signalOptions(signal)));
  },
});
