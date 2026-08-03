<script lang="ts" module>
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { QueryClient } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import type { ServedRevisionDescriptor } from '../../../../served-report-session';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import type { ServedReportSessionOwner } from '../../report/lifecycle/served-report-session-owner.svelte';
  import type {
    SessionTableDestination,
    SessionTableQueryOwner,
    SessionTableQueryState,
  } from './session-table-query-owner';

  export interface OwnedSessionTable<Descriptor extends ServedRevisionDescriptor> {
    readonly lifecycle: ServedReportSessionOwner<SessionTableDestination, Descriptor>;
    readonly query: SessionTableQueryOwner;
    readonly rows: readonly SessionPresentationRow[];
    readonly snapshot: SessionTableQueryState | undefined;
  }

  export interface SessionTableOwnerProps<Descriptor extends ServedRevisionDescriptor> {
    readonly acquire: (signal: AbortSignal) => Promise<Descriptor>;
    readonly children: Snippet<[OwnedSessionTable<Descriptor>]>;
    readonly client: SessionClientAdapter;
    readonly queryClient: QueryClient;
  }
</script>

<script generics="Descriptor extends ServedRevisionDescriptor" lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { createServedReportSession } from '../../../../served-report-session';
  import ReportLifecycleOwner from '../../report/lifecycle/report-lifecycle-owner.svelte';
  import {
    createSessionTableQueryOwner,
    createSessionTableServedAdapter,
    sessionRowsForTableState,
  } from './session-table-query-owner';

  let { acquire, children, client, queryClient }: SessionTableOwnerProps<Descriptor> = $props();
  let snapshot = $state<SessionTableQueryState>();
  const query = untrack(() =>
    createSessionTableQueryOwner({
      client,
      onStateChange: (nextState) => {
        snapshot = nextState;
      },
      queryClient,
    }),
  );
  const session = untrack(() => createServedReportSession(createSessionTableServedAdapter({ acquire, owner: query })));
  const rows = $derived(sessionRowsForTableState(snapshot));
  const connectLifecycle = (
    lifecycle: ServedReportSessionOwner<SessionTableDestination, Descriptor>,
  ): OwnedSessionTable<Descriptor> => {
    query.setRevisionRefresh(async (scope) => await lifecycle.refresh({ scope }));
    return { lifecycle, query, rows, snapshot };
  };
  onDestroy(() => query.close());
</script>

<ReportLifecycleOwner {session}>
  {#snippet children(_lifecycle)}
    {@const owned = connectLifecycle(_lifecycle)}
    {@render children(owned)}
  {/snippet}
</ReportLifecycleOwner>
