<script lang="ts">
  import ReportRoot from '$lib/features/report/core/report-root.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<ReportRoot {data} />
