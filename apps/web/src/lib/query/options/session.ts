import { parseSessionDetailRequest, sessionDetailRequestFingerprint } from '@ai-usage/report-core/session-detail';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionLookupRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionLookupFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { parseSessionVcsResolveRequest } from '@ai-usage/report-core/session-vcs';
import type {
  SessionCampaignChildrenRequest,
  SessionDetailRequest,
  SessionLookupRequest,
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

const sessionCampaignChildrenKeyFromParsed = (request: SessionCampaignChildrenRequest) =>
  immutableRevisionKey(
    sessionFamily,
    request.query.revision,
    sessionCampaignChildrenFingerprint(request),
    campaignChildrenDestination(request.query.cursor),
  );

export const sessionCampaignChildrenKey = (request: SessionCampaignChildrenRequest) => {
  const parsed = parseSessionCampaignChildrenRequest(request);
  return sessionCampaignChildrenKeyFromParsed(parsed);
};

export const sessionNeighborsKey = (request: SessionNeighborRequest) => {
  const parsed = parseSessionNeighborRequest(request);
  return immutableRevisionKey(sessionFamily, parsed.query.revision, sessionNeighborFingerprint(parsed), 'neighbors');
};

export const sessionLookupKey = (request: SessionLookupRequest) => {
  const parsed = parseSessionLookupRequest(request);
  return immutableRevisionKey(sessionFamily, parsed.revision, sessionLookupFingerprint(parsed), 'lookup');
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
    queryKey: sessionCampaignChildrenKeyFromParsed(parsed),
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

export const sessionLookupQueryOptions = (
  client: SessionClientAdapter,
  request: SessionLookupRequest,
  execution: SessionQueryExecution,
) => {
  const parsed = parseSessionLookupRequest(request);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    placeholderData: (previousData: Awaited<ReturnType<SessionClientAdapter['lookup']>> | undefined, previousQuery) => {
      const previousRevision = previousQuery?.queryKey[3];
      return typeof previousRevision === 'string' &&
        previousQuery?.queryKey[4] === sessionLookupFingerprint({ ...parsed, revision: previousRevision })
        ? previousData
        : undefined;
    },
    queryFn: async ({ signal }) => await client.lookup(parsed, signal),
    queryKey: sessionLookupKey(parsed),
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
    // A publication changes the revision even when this session has not changed.
    // Keep its last available detail, with its original revision, while reading
    // the new one. Never carry history into a different row or a disabled query.
    placeholderData: (previousData: Awaited<ReturnType<SessionClientAdapter['detail']>> | undefined, previousQuery) => {
      const previousRevision = previousQuery?.queryKey[3];
      return previousData?.status === 'available' &&
        typeof previousRevision === 'string' &&
        previousQuery?.queryKey[4] === sessionDetailRequestFingerprint({ ...parsed, revision: previousRevision })
        ? previousData
        : undefined;
    },
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

const disabledSessionRequest = parseSessionQueryRequest({
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 1,
  range: { from: null, to: null },
  revision: 'disabled-session-query',
  sort: [{ desc: true, id: 'date' }],
});

/**
 * One exact page for a detail route the window does not hold (a campaign
 * aggregate by key). Retain only the same campaign and scope across a
 * publication, never another campaign while its route resolves.
 */
export const optionalSessionPageQueryOptions = (
  client: SessionClientAdapter,
  request: SessionQueryRequest | undefined,
  execution: SessionQueryExecution,
) => {
  const parsed = parseSessionQueryRequest(request ?? disabledSessionRequest);
  return queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser && request !== undefined,
    placeholderData: (previousData: Awaited<ReturnType<SessionClientAdapter['page']>> | undefined, previousQuery) => {
      const previousRevision = previousQuery?.queryKey[3];
      return request !== undefined &&
        typeof previousRevision === 'string' &&
        previousQuery?.queryKey[4] === sessionQueryFingerprint({ ...parsed, revision: previousRevision })
        ? previousData
        : undefined;
    },
    queryFn: async ({ signal }) => await client.page(parsed, signal),
    queryKey: sessionPageKey(parsed),
  });
};

export const optionalSessionNeighborsQueryOptions = (
  client: SessionClientAdapter,
  request: SessionNeighborRequest | undefined,
  execution: SessionQueryExecution,
) =>
  sessionNeighborsQueryOptions(client, request ?? { query: disabledSessionRequest, rowId: 'disabled-session-row' }, {
    browser: execution.browser && request !== undefined,
  });

export const optionalSessionLookupQueryOptions = (
  client: SessionClientAdapter,
  request: SessionLookupRequest | undefined,
  execution: SessionQueryExecution,
) =>
  sessionLookupQueryOptions(client, request ?? { revision: 'disabled-session-query', rowId: 'disabled-session-row' }, {
    browser: execution.browser && request !== undefined,
  });

export const optionalSessionDetailQueryOptions = (
  client: SessionClientAdapter,
  request: SessionDetailRequest | undefined,
  execution: SessionQueryExecution,
) =>
  sessionDetailQueryOptions(client, request ?? { revision: 'disabled-session-query', rowId: 'disabled-session-row' }, {
    browser: execution.browser && request !== undefined,
  });

export const optionalSessionVcsQueryOptions = (
  client: SessionClientAdapter,
  request: SessionVcsResolveRequest | undefined,
  execution: SessionQueryExecution,
) =>
  sessionVcsQueryOptions(client, request ?? { revision: 'disabled-session-query', rowId: 'disabled-session-row' }, {
    browser: execution.browser && request !== undefined,
  });
