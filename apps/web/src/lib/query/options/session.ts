import { parseSessionDetailRequest, sessionDetailRequestFingerprint } from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { parseSessionVcsResolveRequest } from '@ai-usage/report-core/session-vcs';
import type {
  SessionCampaignChildrenRequest,
  SessionDetailRequest,
  SessionNeighborRequest,
  SessionQueryRequest,
  SessionVcsResolveRequest,
} from '@ai-usage/web-contract/session';
import { keepPreviousData, queryOptions } from '@tanstack/svelte-query';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { immutableRevisionKey } from '../keys';
import { webQueryPolicies } from '../policies';

const sessionFamily = 'session';

export interface SessionQueryExecution {
  readonly browser: boolean;
}

const pageDestination = (cursor: string | null): string =>
  cursor === null ? 'page:initial' : `page:cursor:${JSON.stringify(cursor)}`;

const campaignChildrenDestination = (cursor: string | null): string =>
  cursor === null ? 'campaign-children:initial' : `campaign-children:cursor:${JSON.stringify(cursor)}`;

interface SessionPageIdentity {
  readonly fingerprint: string;
  readonly revision: string;
}

const isPageFromIdentity = (key: readonly unknown[] | undefined, identity: SessionPageIdentity): boolean =>
  key?.[0] === 'web' &&
  key[1] === 'immutable-revision' &&
  key[2] === sessionFamily &&
  key[3] === identity.revision &&
  key[4] === identity.fingerprint &&
  typeof key[5] === 'string' &&
  key[5].startsWith('page:');

export const sessionPageKey = (request: SessionQueryRequest) => {
  const parsed = parseSessionQueryRequest(request);
  return immutableRevisionKey(
    sessionFamily,
    parsed.revision,
    sessionQueryFingerprint(parsed),
    pageDestination(parsed.cursor),
  );
};

export const sessionCampaignChildrenKey = (request: SessionCampaignChildrenRequest) => {
  const parsed = parseSessionCampaignChildrenRequest(request);
  return immutableRevisionKey(
    sessionFamily,
    parsed.query.revision,
    sessionCampaignChildrenFingerprint(parsed),
    campaignChildrenDestination(parsed.query.cursor),
  );
};

export const sessionNeighborsKey = (request: SessionNeighborRequest) => {
  const parsed = parseSessionNeighborRequest(request);
  return immutableRevisionKey(sessionFamily, parsed.query.revision, sessionNeighborFingerprint(parsed), 'neighbors');
};

export const sessionDetailKey = (request: SessionDetailRequest) => {
  const parsed = parseSessionDetailRequest(request);
  return immutableRevisionKey(sessionFamily, parsed.revision, sessionDetailRequestFingerprint(parsed), 'detail');
};

export const sessionVcsKey = (request: SessionVcsResolveRequest) => {
  const parsed = parseSessionVcsResolveRequest(request);
  return immutableRevisionKey(sessionFamily, parsed.revision, parsed.rowId, 'vcs');
};

export const sessionPageQueryOptions = (
  client: SessionClientAdapter,
  request: SessionQueryRequest,
  execution: SessionQueryExecution,
) => {
  const parsed = parseSessionQueryRequest(request);
  const identity = { fingerprint: sessionQueryFingerprint(parsed), revision: parsed.revision };
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    placeholderData: (previousData, previousQuery) =>
      isPageFromIdentity(previousQuery?.queryKey, identity) ? keepPreviousData(previousData) : undefined,
    queryFn: async ({ signal }) => await client.page(parsed, signal),
    queryKey: sessionPageKey(parsed),
  });
};

export const sessionCampaignChildrenQueryOptions = (
  client: SessionClientAdapter,
  request: SessionCampaignChildrenRequest,
  execution: SessionQueryExecution,
) => {
  const parsed = parseSessionCampaignChildrenRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.campaignChildren(parsed, signal),
    queryKey: sessionCampaignChildrenKey(parsed),
  });
};

export const sessionNeighborsQueryOptions = (
  client: SessionClientAdapter,
  request: SessionNeighborRequest,
  execution: SessionQueryExecution,
) => {
  const parsed = parseSessionNeighborRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.neighbors(parsed, signal),
    queryKey: sessionNeighborsKey(parsed),
  });
};

export const sessionDetailQueryOptions = (
  client: SessionClientAdapter,
  request: SessionDetailRequest,
  execution: SessionQueryExecution,
) => {
  const parsed = parseSessionDetailRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.detail(parsed, signal),
    queryKey: sessionDetailKey(parsed),
  });
};

export const sessionVcsQueryOptions = (
  client: SessionClientAdapter,
  request: SessionVcsResolveRequest,
  execution: SessionQueryExecution,
) => {
  const parsed = parseSessionVcsResolveRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.vcs(parsed, signal),
    queryKey: sessionVcsKey(parsed),
  });
};
