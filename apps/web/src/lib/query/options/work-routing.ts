import { queryOptions } from '@tanstack/svelte-query';
import type { WorkRoutingClient } from '../../rpc/work-routing-client';
import { type FiniteSwrQueryKey, finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

export type WorkRoutingQueryClient = Pick<WorkRoutingClient, 'getContext'>;

export interface WorkRoutingQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

/**
 * Its own identity: declarations change when the operator edits the config and observations on
 * the engine's 15-minute cadence, neither of which is the quota rail's or a report revision's
 * lifecycle. Finite SWR: a mount re-reads, nothing polls.
 */
export const workRoutingContextKey = (): FiniteSwrQueryKey => finiteSwrKey('work-routing', 'context');

export const workRoutingContextQueryOptions = (client: WorkRoutingQueryClient, context: WorkRoutingQueryContext) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.getContext({ signal }),
    queryKey: workRoutingContextKey(),
  });
