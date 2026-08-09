import type { QueryClient } from '@tanstack/svelte-query';
import { queryOptions } from '@tanstack/svelte-query';
import type { SyncBrowserAdapter } from '../../rpc/sync-client';
import { type ControlPlaneQueryKey, controlPlaneKey } from '../keys';
import { webQueryPolicies } from '../policies';

export type SyncFleetClient = Pick<SyncBrowserAdapter, 'fleet'>;

export interface SyncFleetQueryContext {
  readonly browser: boolean;
  readonly compatibleGeneration: string;
  readonly enabled: boolean;
}

export const syncFleetKey = (compatibleGeneration: string): ControlPlaneQueryKey =>
  controlPlaneKey('sync', 'fleet', 'compatible-generation', compatibleGeneration);

export const syncFleetQueryOptions = (client: SyncFleetClient, context: SyncFleetQueryContext) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.fleet(signal),
    queryKey: syncFleetKey(context.compatibleGeneration),
  });

export const invalidateSyncFleet = async (client: QueryClient, compatibleGeneration: string): Promise<void> => {
  await client.invalidateQueries({ exact: true, queryKey: syncFleetKey(compatibleGeneration) });
};
