<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { type Snippet, untrack } from 'svelte';
  import { createBrowserWebRpcClient, createWebRpcQueryUtils } from '../rpc/client';
  import {
    createHydratedWebQueryClient,
    createWebQueryClient,
    hydrateWebQueryClient,
    type WebQueryHydrationState,
  } from './client';
  import { installWebQueryHydrationContext } from './hydration-context.svelte';
  import { installWebQueryRpcContext } from './rpc-context.svelte';

  let {
    children,
    hydrationState,
  }: {
    children: Snippet;
    hydrationState?: WebQueryHydrationState;
  } = $props();

  const queryClient = untrack(() =>
    hydrationState ? createHydratedWebQueryClient(hydrationState) : createWebQueryClient(),
  );
  let observedHydrationState = untrack(() => hydrationState);
  let appliedHydrationState = $state.raw(observedHydrationState);
  installWebQueryHydrationContext(() => appliedHydrationState);

  if (typeof window !== 'undefined') {
    const rpc = untrack(() => createBrowserWebRpcClient('web-query-browser'));
    installWebQueryRpcContext({
      orpc: createWebRpcQueryUtils(rpc),
      rpc,
    });
  }

  $effect(() => {
    if (hydrationState && hydrationState !== observedHydrationState) {
      observedHydrationState = hydrationState;
      hydrateWebQueryClient(queryClient, hydrationState);
      appliedHydrationState = hydrationState;
    }
  });
</script>

<QueryClientProvider client={queryClient}> {@render children()} </QueryClientProvider>
