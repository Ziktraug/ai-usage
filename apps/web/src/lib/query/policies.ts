export const MILLISECONDS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;

export const SHORT_CONTROL_STALE_TIME_MS = 5 * MILLISECONDS_PER_SECOND;
export const FINITE_SWR_STALE_TIME_MS = 30 * MILLISECONDS_PER_SECOND;
/**
 * Skill observations advance only when the background engine finishes a collection sweep, which is
 * minutes apart, not seconds. A shorter window would re-ask the store on every navigation for an
 * answer that provably cannot have changed.
 */
export const COLLECTION_SWR_STALE_TIME_MS = 5 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
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
  /**
   * For data whose only producer is a background collection cycle. Focus and reconnect cannot have
   * changed it, so it ignores both; a finished collection is announced through explicit
   * invalidation instead.
   *
   * Mount is different, and the difference is not cosmetic. TanStack refetches on mount only when
   * the entry is *stale*, and an invalidated entry is stale, so `refetchOnMount: false` does not
   * merely skip a pointless fetch — it strands an invalidation that arrived while nothing was
   * subscribed. Leaving `/skills`, letting a collection cycle finish, and coming back would serve
   * the pre-cycle value for the rest of the session, because the one event that could refresh it
   * had already been discarded. With mount honouring staleness, a fresh entry still refetches
   * nothing and a stale one recovers.
   */
  collectionSwr: policy({
    gcTime: DEFAULT_BOUNDED_GC_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
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
