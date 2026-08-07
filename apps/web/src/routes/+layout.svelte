<script lang="ts">
  import { page } from '$app/state';
  import AppShell from '$lib/features/shell/app-shell.svelte';
  import SourceControlProvider from '$lib/features/sources/source-control-provider.svelte';
  import SourceControlSummary from '$lib/features/sources/source-control-summary.svelte';
  import WebQueryProvider from '$lib/query/provider.svelte';
  import type { LayoutProps } from './$types';
  import '../../src/index.css';

  let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
  <title>ai-usage report</title>
</svelte:head>

{#snippet sourceControlSummary()}
  <SourceControlSummary />
{/snippet}

<WebQueryProvider hydrationState={page.data.queryState ?? data.queryState}>
  <SourceControlProvider runtimeMode={data.runtimeMode}>
    <AppShell providerQuota={data.providerQuota} runtimeMode={data.runtimeMode} {sourceControlSummary}>
      {@render children()}
    </AppShell>
  </SourceControlProvider>
</WebQueryProvider>
