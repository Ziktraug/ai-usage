import { queryOptions } from '@tanstack/svelte-query';
import type { ReplicationBrowserAdapter } from '../../rpc/replication-client';
import { type ControlPlaneQueryKey, controlPlaneKey } from '../keys';
import { webQueryPolicies } from '../policies';

export type ReplicationStatusClient = Pick<ReplicationBrowserAdapter, 'status'>;

export interface ReplicationStatusQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

export const replicationStatusKey = (): ControlPlaneQueryKey => controlPlaneKey('replication', 'status', 'v1');

export const replicationStatusQueryOptions = (
  client: ReplicationStatusClient,
  context: ReplicationStatusQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.status(signal),
    queryKey: replicationStatusKey(),
  });
