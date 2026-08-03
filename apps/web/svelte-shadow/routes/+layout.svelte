<script lang="ts">
  import WebQueryProvider from '$lib/query/provider.svelte';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
</script>

<WebQueryProvider hydrationState={data.queryState}> {@render children()} </WebQueryProvider>
