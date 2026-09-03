import { SKILL_OBSERVATION_PRODUCER_REVALIDATION_MS } from '@ai-usage/report-core/skill-observation-evidence';

export const MILLISECONDS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;

export const SHORT_CONTROL_STALE_TIME_MS = 5 * MILLISECONDS_PER_SECOND;
export const FINITE_SWR_STALE_TIME_MS = 30 * MILLISECONDS_PER_SECOND;
/**
 * The producer proof has a five-minute end-to-end lifetime. Server reads reserve its last minute
 * for this cache, so an answer accepted near the read cutoff is revalidated before the underlying
 * proof expires instead of receiving a second full freshness window.
 */
export const COLLECTION_SWR_STALE_TIME_MS = SKILL_OBSERVATION_PRODUCER_REVALIDATION_MS;
export const SHORT_CONTROL_GC_TIME_MS = 2 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
export const DEFAULT_BOUNDED_GC_TIME_MS = 10 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export type WebQueryPolicyName =
  | 'bounded-control-plane'
  | 'collection-swr'
  | 'current-alias-swr'
  | 'finite-swr'
  | 'immutable-revision';

export interface WebQueryPolicy {
  readonly gcTime: number;
  readonly refetchInterval?: number;
  readonly refetchOnMount: boolean | 'always';
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
  /**
   * For data whose only producer is a background collection cycle. A finished collection is
   * announced through explicit invalidation, while the completeness proof inside the response also
   * expires with time. The interval and focus revalidation cover that temporal transition even when
   * no producer event can arrive (disabled, stopped, or suspended collection).
   *
   * Mount is different, and the difference is not cosmetic. Each observer starts a new interval,
   * so leaving and returning just before the cached answer becomes stale could restart the timer
   * beyond the proof's remaining lifetime. Always refetching on mount gives the returned surface a
   * new server-qualified answer instead of extending the previous interval. It also honours an
   * invalidation that arrived while nothing was subscribed.
   */
  collectionSwr: policy({
    gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
    refetchInterval: COLLECTION_SWR_STALE_TIME_MS,
    refetchOnMount: 'always',
    refetchOnReconnect: false,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: COLLECTION_SWR_STALE_TIME_MS,
  }),
  currentAliasSwr: policy({
    gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: FINITE_SWR_STALE_TIME_MS,
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

export type PolicyQueryOptions = WebQueryPolicy;

const policiesByName = {
  'bounded-control-plane': webQueryPolicies.boundedControlPlane,
  'collection-swr': webQueryPolicies.collectionSwr,
  'current-alias-swr': webQueryPolicies.currentAliasSwr,
  'finite-swr': webQueryPolicies.finiteSwr,
  'immutable-revision': webQueryPolicies.immutableRevision,
} as const satisfies Record<WebQueryPolicyName, PolicyQueryOptions>;

export const queryPolicy = (name: WebQueryPolicyName): PolicyQueryOptions => policiesByName[name];
