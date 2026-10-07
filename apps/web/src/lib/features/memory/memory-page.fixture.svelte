<script lang="ts">
  import WebQueryProvider from '../../query/provider.svelte';
  import type { MemoryPageData } from './memory-load';
  import MemoryPage from './memory-page.svelte';

  let { data, address = '/memory?view=review' }: { data: MemoryPageData; address?: string } = $props();
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <MemoryPage {address} {data} />
</WebQueryProvider>
