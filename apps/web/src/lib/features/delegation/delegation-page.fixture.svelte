<script lang="ts">
  import WebQueryProvider from '../../query/provider.svelte';
  import type { DelegationPageData } from './delegation-load';
  import DelegationPage from './delegation-page.svelte';

  let { data }: { data: DelegationPageData } = $props();
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <DelegationPage {data} />
</WebQueryProvider>
