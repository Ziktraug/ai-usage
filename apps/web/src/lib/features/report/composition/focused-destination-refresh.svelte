<script lang="ts">
  import type { ServedReportSessionOwner } from '../lifecycle/served-report-session-owner.svelte';
  import type { FocusedReportDescriptor, FocusedReportDestination } from './report-destination';

  let {
    destination,
    owner,
    publicationRevision,
  }: {
    destination: FocusedReportDestination | null;
    owner: ServedReportSessionOwner<FocusedReportDestination, FocusedReportDescriptor>;
    publicationRevision: string | undefined;
  } = $props();

  let requestedFingerprint = '';
  $effect(() => {
    if (!destination) {
      owner.abort();
      requestedFingerprint = '';
      return;
    }
    const fingerprint = JSON.stringify({ destination, publicationRevision });
    if (fingerprint === requestedFingerprint) {
      return;
    }
    requestedFingerprint = fingerprint;
    owner.refresh(destination).catch(() => undefined);
  });
</script>
