import type { WebQueryHydrationState } from '../../query/client';
import type { WebQueryRuntime } from '../../query/composition';
import { type DelegationSettingsQueryClient, delegationSettingsQueryOptions } from '../../query/options/delegation';
import { createDelegationClient } from '../../rpc/delegation-client';
import { createAwaitedRouteQueryState, type RouteQueryLoadOptions } from '../shell/query-load';
import { type DelegationSection, delegationSectionFor } from './delegation-model';

export interface DelegationPageData {
  readonly queryState: WebQueryHydrationState;
  /** The section the URL names (`?section=`), `routes` by default. */
  readonly section: DelegationSection;
}

export interface DelegationPageLoadDependencies {
  readonly createClient?: (runtime: WebQueryRuntime) => DelegationSettingsQueryClient;
}

export const delegationSectionFromUrl = (url: URL): DelegationSection =>
  delegationSectionFor(url.searchParams.get('section'));

export const deferredDelegationPageData = (url: URL): DelegationPageData => ({
  queryState: { dehydratedState: { mutations: [], queries: [] } },
  section: delegationSectionFromUrl(url),
});

export const loadDelegationPageData = async (
  options: RouteQueryLoadOptions,
  dependencies: DelegationPageLoadDependencies = {},
): Promise<DelegationPageData> => ({
  queryState: await createAwaitedRouteQueryState(options, (runtime) => prefetchDelegationRoute(runtime, dependencies)),
  section: delegationSectionFromUrl(options.url),
});

export const prefetchDelegationRoute = async (
  runtime: WebQueryRuntime,
  dependencies: DelegationPageLoadDependencies = {},
): Promise<void> => {
  const client = dependencies.createClient?.(runtime) ?? createDelegationClient(runtime.rpc.delegation);
  await runtime.queryClient.query(delegationSettingsQueryOptions(client, { browser: false, enabled: true }));
};
