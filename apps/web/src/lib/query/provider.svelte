<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { type Snippet, untrack } from 'svelte';
  import { createHydratedWebQueryClient, createWebQueryClient, type WebQueryHydrationState } from './client';

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
</script>

<QueryClientProvider client={queryClient}> {@render children()} </QueryClientProvider>
