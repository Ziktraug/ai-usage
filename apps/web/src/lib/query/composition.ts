import type { WebContractClient } from '@ai-usage/web-contract';
import type { QueryClient } from '@tanstack/svelte-query';
import { createWebRpcClient, createWebRpcQueryUtils, type WebRpcQueryUtils } from '../rpc/client';
import {
  createWebQueryClient,
  dehydrateWebQueryClient,
  hydrateWebQueryClient,
  type WebQueryHydrationState,
} from './client';
import { invalidateCurrentReportAliases } from './options/report';
import type { WebQueryPolicyName } from './policies';

export interface WebQueryRuntime {
  readonly orpc: WebRpcQueryUtils;
  readonly queryClient: QueryClient;
  readonly rpc: WebContractClient;
}

export interface WebQueryRuntimeOptions {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly hydrationState?: WebQueryHydrationState;
  readonly requestOwner?: string;
  readonly url: URL;
}

export type PublicationQueryEffect = 'invalidate-current-alias' | 'none';

export interface WebQueryOwnership {
  readonly family:
    | 'memory'
    | 'projects'
    | 'quota'
    | 'replication'
    | 'report-current'
    | 'report-exact'
    | 'session'
    | 'skills'
    | 'sources'
    | 'sync';
  readonly policy: WebQueryPolicyName;
  readonly publication: PublicationQueryEffect;
  readonly rendering: 'browser-only' | 'ssr-awaited';
}

export const webQueryOwnership = [
  {
    family: 'report-current',
    policy: 'current-alias-swr',
    publication: 'invalidate-current-alias',
    rendering: 'ssr-awaited',
  },
  {
    family: 'report-exact',
    policy: 'immutable-revision',
    publication: 'none',
    rendering: 'ssr-awaited',
  },
  {
    family: 'session',
    policy: 'immutable-revision',
    publication: 'none',
    rendering: 'ssr-awaited',
  },
  {
    family: 'quota',
    policy: 'finite-swr',
    publication: 'none',
    rendering: 'ssr-awaited',
  },
  {
    family: 'skills',
    policy: 'finite-swr',
    publication: 'none',
    rendering: 'ssr-awaited',
  },
  {
    family: 'memory',
    policy: 'bounded-control-plane',
    publication: 'none',
    rendering: 'ssr-awaited',
  },
  {
    family: 'projects',
    policy: 'bounded-control-plane',
    publication: 'none',
    rendering: 'ssr-awaited',
  },
  {
    family: 'sync',
    policy: 'bounded-control-plane',
    publication: 'none',
    rendering: 'ssr-awaited',
  },
  {
    family: 'replication',
    policy: 'bounded-control-plane',
    publication: 'none',
    rendering: 'browser-only',
  },
  {
    family: 'sources',
    policy: 'bounded-control-plane',
    publication: 'none',
    rendering: 'browser-only',
  },
] as const satisfies readonly WebQueryOwnership[];

export const createWebQueryRuntime = ({
  fetch,
  hydrationState,
  requestOwner,
  url,
}: WebQueryRuntimeOptions): WebQueryRuntime => {
  const queryClient = createWebQueryClient();
  if (hydrationState) {
    hydrateWebQueryClient(queryClient, hydrationState);
  }
  const rpc = createWebRpcClient({
    fetch,
    // Only headers a browser can reproduce may be sent here. `load` runs on the server and again
    // during hydration, and SvelteKit keys its serialised SSR fetch cache on the request headers.
    // `Origin` is a forbidden header name the browser silently drops, so setting it server-side
    // desynchronises the two cache keys and forces the hydrating client to refetch over the network.
    headers: requestOwner === undefined ? {} : { 'x-ai-usage-request-owner': requestOwner },
    url: new URL('/rpc', url),
  });
  return { orpc: createWebRpcQueryUtils(rpc), queryClient, rpc };
};

export const createWebQueryLoadState = (options: WebQueryRuntimeOptions): WebQueryHydrationState => {
  const runtime = createWebQueryRuntime(options);
  try {
    return dehydrateWebQueryClient(runtime.queryClient);
  } finally {
    runtime.queryClient.clear();
  }
};

export const createPublicationQueryInvalidator = (queryClient: QueryClient) => {
  let observedRevision: string | undefined;
  return async (revision: string): Promise<boolean> => {
    if (revision === observedRevision) {
      return false;
    }
    observedRevision = revision;
    await invalidateCurrentReportAliases(queryClient);
    return true;
  };
};
