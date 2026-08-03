<script lang="ts">
  import WebQueryProvider from '../../query/provider.svelte';
  import type { SyncPageData } from './sync-load';
  import SyncRoot from './sync-root.svelte';

  let { data }: { data: SyncPageData } = $props();
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <SyncRoot connection="live" {data} />
</WebQueryProvider>
