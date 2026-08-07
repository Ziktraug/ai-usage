import type { QueryObserverOptions } from '@tanstack/svelte-query';

export const MILLISECONDS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;

export const SHORT_CONTROL_STALE_TIME_MS = 5 * MILLISECONDS_PER_SECOND;
export const FINITE_SWR_STALE_TIME_MS = 30 * MILLISECONDS_PER_SECOND;
export const SHORT_CONTROL_GC_TIME_MS = 2 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
export const DEFAULT_BOUNDED_GC_TIME_MS = 10 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export type WebQueryPolicyName = 'bounded-control-plane' | 'current-alias' | 'finite-swr' | 'immutable-revision';

export interface WebQueryPolicy {
  readonly gcTime: number;
  readonly refetchOnMount: boolean;
  readonly refetchOnReconnect: boolean;
  readonly refetchOnWindowFocus: boolean;
  readonly retry: false;
  readonly staleTime: number;
}

export const webQueryClientDefaultOptions = Object.freeze({
  mutations: Object.freeze({
    retry: false,
  }),
  queries: Object.freeze({
    gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  }),
});

const policy = (options: WebQueryPolicy): WebQueryPolicy => Object.freeze(options);

export const webQueryPolicies = {
  boundedControlPlane: policy({
    gcTime: SHORT_CONTROL_GC_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: SHORT_CONTROL_STALE_TIME_MS,
  }),
  currentAlias: policy({
    gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    // Publication events explicitly invalidate aliases. Keeping them fresh between events avoids
    // reacquiring the same bootstrap for every tab, filter, sort, and range transition.
    staleTime: Number.POSITIVE_INFINITY,
  }),
  finiteSwr: policy({
    gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: FINITE_SWR_STALE_TIME_MS,
  }),
  immutableRevision: policy({
    gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  }),
} as const satisfies Record<string, WebQueryPolicy>;

export type PolicyQueryOptions = Pick<
  QueryObserverOptions,
  'gcTime' | 'refetchOnMount' | 'refetchOnReconnect' | 'refetchOnWindowFocus' | 'retry' | 'staleTime'
>;

const policiesByName = {
  'bounded-control-plane': webQueryPolicies.boundedControlPlane,
  'current-alias': webQueryPolicies.currentAlias,
  'finite-swr': webQueryPolicies.finiteSwr,
  'immutable-revision': webQueryPolicies.immutableRevision,
} as const satisfies Record<WebQueryPolicyName, PolicyQueryOptions>;

export const queryPolicy = (name: WebQueryPolicyName): PolicyQueryOptions => policiesByName[name];
