<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, type Snippet, untrack } from 'svelte';
  import type { RuntimeMode } from '../../../runtime-mode';
  import {
    createSourceControlClientForMode,
    type SourceControlClient,
    type SourceControlClientState,
  } from '../../../source-control-client';
  import {
    sourceControlCommandMutationOptions,
    sourceControlStateQueryOptions,
    updateSourceControlState,
  } from '../../query/options/source-control';
  import { provideSourceControl } from './context.svelte';
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
  const client = untrack(() => injectedClient ?? createSourceControlClientForMode(runtimeMode));
  const service = createSourceControlService({
    client,
    invalidatePublishedQuery: (queryKey) => {
      queryClient.invalidateQueries({ exact: true, queryKey }).catch(() => undefined);
    },
  });
  const stateQuery = createQuery(() => sourceControlStateQueryOptions(service.getState()));
  const commandMutation = createMutation(() =>
    sourceControlCommandMutationOptions({
      execute: service.execute,
      rejectedError: () => service.getState().commandError,
    }),
  );
  const unsubscribe = service.subscribe((nextState) => {
    updateSourceControlState(queryClient, nextState);
  });
  const state = $derived<SourceControlClientState>({
    ...(stateQuery.data ?? service.getState()),
    commandError:
      commandMutation.error instanceof Error
        ? commandMutation.error.message
        : (stateQuery.data?.commandError ?? service.getState().commandError),
    pendingCommand: commandMutation.isPending ? (commandMutation.variables ?? null) : null,
  });

  provideSourceControl({
    execute: async (command) => await commandMutation.mutateAsync(command),
    state: () => state,
  });

  onMount(() => {
    service.start();
    return () => {
      unsubscribe();
      service.stop();
    };
  });
</script>

{@render children()}
