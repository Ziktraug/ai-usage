<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import type { ReportPageData } from './report-bootstrap';
  import ReportRoot from './report-root.svelte';

  let { data }: { data: ReportPageData } = $props();
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <ReportRoot {data} />
</WebQueryProvider>
