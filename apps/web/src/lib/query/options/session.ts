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

export interface ExactSessionQueryIdentity {
  readonly fingerprint: string;
  readonly revision: string;
}

export interface SessionRowQueryIdentity {
  readonly revision: string;
  readonly rowIdentity: string;
}

const pageDestination = (cursor: string | null): string =>
  cursor === null ? 'page:initial' : `page:cursor:${JSON.stringify(cursor)}`;

const isPageFromIdentity = (key: readonly unknown[] | undefined, identity: ExactSessionQueryIdentity): boolean =>
  key?.[0] === 'web' &&
  key[1] === 'immutable-revision' &&
  key[2] === sessionFamily &&
  key[3] === identity.revision &&
  key[4] === identity.fingerprint &&
  typeof key[5] === 'string' &&
  key[5].startsWith('page:');

export const sessionPageKey = ({ fingerprint, revision }: ExactSessionQueryIdentity, cursor: string | null) =>
  immutableRevisionKey(sessionFamily, revision, fingerprint, pageDestination(cursor));

export const sessionCampaignChildrenKey = ({ fingerprint, revision }: ExactSessionQueryIdentity) =>
  immutableRevisionKey(sessionFamily, revision, fingerprint, 'campaign-children');

export const sessionNeighborsKey = ({ fingerprint, revision }: ExactSessionQueryIdentity) =>
  immutableRevisionKey(sessionFamily, revision, fingerprint, 'neighbors');

export const sessionDetailKey = ({ revision, rowIdentity }: SessionRowQueryIdentity) =>
  immutableRevisionKey(sessionFamily, revision, rowIdentity, 'detail');

export const sessionVcsKey = ({ revision, rowIdentity }: SessionRowQueryIdentity) =>
  immutableRevisionKey(sessionFamily, revision, rowIdentity, 'vcs');

export const sessionPageQueryOptions = (
  client: SessionClientAdapter,
  request: SessionQueryRequest,
  identity: ExactSessionQueryIdentity,
  execution: SessionQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    placeholderData: (previousData, previousQuery) =>
      isPageFromIdentity(previousQuery?.queryKey, identity) ? keepPreviousData(previousData) : undefined,
    queryFn: async ({ signal }) => await client.page(request, signal),
    queryKey: sessionPageKey(identity, request.cursor),
  });

export const sessionCampaignChildrenQueryOptions = (
  client: SessionClientAdapter,
  request: SessionCampaignChildrenRequest,
  identity: ExactSessionQueryIdentity,
  execution: SessionQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.campaignChildren(request, signal),
    queryKey: sessionCampaignChildrenKey(identity),
  });

export const sessionNeighborsQueryOptions = (
  client: SessionClientAdapter,
  request: SessionNeighborRequest,
  identity: ExactSessionQueryIdentity,
  execution: SessionQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.neighbors(request, signal),
    queryKey: sessionNeighborsKey(identity),
  });

export const sessionDetailQueryOptions = (
  client: SessionClientAdapter,
  request: SessionDetailRequest,
  identity: SessionRowQueryIdentity,
  execution: SessionQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.detail(request, signal),
    queryKey: sessionDetailKey(identity),
  });

export const sessionVcsQueryOptions = (
  client: SessionClientAdapter,
  request: SessionVcsResolveRequest,
  identity: SessionRowQueryIdentity,
  execution: SessionQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser,
    queryFn: async ({ signal }) => await client.vcs(request, signal),
    queryKey: sessionVcsKey(identity),
  });
