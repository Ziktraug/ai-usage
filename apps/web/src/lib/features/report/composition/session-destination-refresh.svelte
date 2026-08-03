<script lang="ts">
  import type { SessionTableDestination } from '../../sessions/table/session-table-query-owner';
  import type { ServedReportSessionOwner } from '../lifecycle/served-report-session-owner.svelte';
  import type { FocusedReportDescriptor } from './report-destination';
  import type { SessionQueryScopeSnapshot } from './report-search';

  let {
    owner,
    destinationScope,
  }: {
    owner: ServedReportSessionOwner<SessionTableDestination, FocusedReportDescriptor>;
    destinationScope: SessionQueryScopeSnapshot;
  } = $props();

  let requestedFingerprint = '';
  $effect(() => {
    const fingerprint = JSON.stringify(destinationScope);
    if (fingerprint === requestedFingerprint) {
      return;
    }
    requestedFingerprint = fingerprint;
    owner.refresh({ scope: destinationScope }).catch(() => undefined);
  });
</script>
