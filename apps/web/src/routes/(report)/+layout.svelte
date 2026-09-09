<script lang="ts">
  import ReportRoot from '$lib/features/report/core/report-root.svelte';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
</script>

<!--
  The report is a layout, not a page, so a session or campaign detail route
  below it keeps the mounted table, its filters and its scroll position. The
  child page carries only the route identity; the panel reads it from the URL.
-->
<ReportRoot {data} />
{@render children()}
