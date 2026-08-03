<script lang="ts">
  import type { ServedReportSession } from '../../../../served-report-session';
  import ReportLifecycleOwner from './report-lifecycle-owner.svelte';

  let { session }: { session: ServedReportSession<string> } = $props();
</script>

<ReportLifecycleOwner {session}>
  {#snippet children(_owner)}
    <span data-report-lifecycle-owner>{_owner.snapshot.pending ? 'pending' : 'settled'}</span>
  {/snippet}
</ReportLifecycleOwner>
