<script lang="ts">
  import { page } from '$app/state';
  import AppShell from '$lib/features/shell/app-shell.svelte';
  import WebQueryProvider from '$lib/query/provider.svelte';
  import type { LayoutProps } from './$types';
  import '../../src/index.css';

  let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
  <title>ai-usage report</title>
</svelte:head>

<WebQueryProvider hydrationState={page.data.queryState ?? data.queryState}>
  <AppShell runtimeMode={data.runtimeMode}> {@render children()} </AppShell>
</WebQueryProvider>
