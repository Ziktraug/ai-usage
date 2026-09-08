<script lang="ts">
  import WebQueryProvider from '../../query/provider.svelte';
  import type { MemoryPageData } from './memory-load';
  import MemoryPage from './memory-page.svelte';

  let { data }: { data: MemoryPageData } = $props();
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <MemoryPage {data} />
</WebQueryProvider>
