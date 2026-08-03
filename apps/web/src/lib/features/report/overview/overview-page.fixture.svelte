<script lang="ts">
  import type { FocusedOverviewResult } from '@ai-usage/report-core/focused-report-query';
  import OverviewPage from './overview-page.svelte';

  let { result }: { result: FocusedOverviewResult } = $props();
</script>

<OverviewPage range={{ mode: '30d' }} {result} />
