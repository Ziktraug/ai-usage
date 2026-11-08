<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { onMount, type Snippet, untrack } from 'svelte';
  import { createBrowserWebRpcClient, createWebRpcQueryUtils } from '../rpc/client';
  import { installBrowserQueryRuntime } from './browser-runtime';
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
    const orpc = createWebRpcQueryUtils(rpc);
    installWebQueryRpcContext({
      orpc,
      rpc,
    });
    onMount(() => installBrowserQueryRuntime({ queryClient, rpc, orpc }));
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
