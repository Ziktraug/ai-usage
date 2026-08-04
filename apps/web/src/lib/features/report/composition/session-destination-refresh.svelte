<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { SessionTableQueryOwner } from '../../sessions/table/session-table-query-owner';
  import type { ServedReportSessionOwner } from '../lifecycle/served-report-session-owner.svelte';
  import type { FocusedReportDescriptor, FocusedReportDestination } from './report-destination';

  let {
    destination,
    owner,
    queryOwner,
  }: {
    destination: FocusedReportDestination | null;
    owner: ServedReportSessionOwner<FocusedReportDestination, FocusedReportDescriptor>;
    queryOwner: SessionTableQueryOwner;
  } = $props();

  $effect(() => {
    const activeDestination = destination;
    if (activeDestination?.kind !== 'sessions') {
      queryOwner.setRevisionRefresh(undefined);
      return;
    }
    queryOwner.setRevisionRefresh(async (scope) => await owner.refresh({ ...activeDestination, sessions: scope }));
  });

  onDestroy(() => queryOwner.setRevisionRefresh(undefined));
</script>

<!-- Binds exact paging expiry recovery back to the single combined report lifecycle. -->