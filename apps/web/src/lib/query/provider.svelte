<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { type Snippet, untrack } from 'svelte';
  import {
    createHydratedWebQueryClient,
    createWebQueryClient,
    hydrateWebQueryClient,
    type WebQueryHydrationState,
  } from './client';
  import { installWebQueryHydrationContext, webQueryHydrationSignature } from './hydration-context.svelte';

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
  let appliedHydrationSignature = $state(webQueryHydrationSignature(observedHydrationState));
  installWebQueryHydrationContext(() => appliedHydrationSignature);

  $effect(() => {
    if (hydrationState && hydrationState !== observedHydrationState) {
      observedHydrationState = hydrationState;
      hydrateWebQueryClient(queryClient, hydrationState);
      appliedHydrationSignature = webQueryHydrationSignature(hydrationState);
    }
  });
</script>

<QueryClientProvider client={queryClient}> {@render children()} </QueryClientProvider>
