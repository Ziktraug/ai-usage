<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onMount, type Snippet } from 'svelte';
  import type { RuntimeMode } from '../../../runtime-mode';
  import {
    createSourceControlClientForMode,
    type SourceControlClient,
    type SourceControlClientState,
  } from '../../../source-control-client';
  import { provideSourceControl } from './context';
  import { createSourceControlService } from './service';

  let {
    children,
    client: injectedClient,
    runtimeMode,
  }: {
    children: Snippet;
    client?: SourceControlClient;
    runtimeMode: RuntimeMode;
  } = $props();

  const queryClient = useQueryClient();
  const client = injectedClient ?? createSourceControlClientForMode(runtimeMode);
  const service = createSourceControlService({
    client,
    invalidateReportQuery: (queryKey) => {
      queryClient.invalidateQueries({ exact: true, queryKey }).catch(() => undefined);
    },
  });
  let state: SourceControlClientState = $state(service.getState());
  const unsubscribe = service.subscribe((nextState) => {
    state = nextState;
  });

  provideSourceControl({ execute: service.execute, state: () => state });

  onMount(() => {
    service.start();
    return () => {
      unsubscribe();
      service.stop();
    };
  });
</script>

{@render children()}
