<script lang="ts">
  import { page } from '$app/state';
  import ProviderQuotaQueryShell from '$lib/features/shell/provider-quota-query-shell.svelte';
  import SourceControlProvider from '$lib/features/sources/source-control-provider.svelte';
  import SourceControlSummary from '$lib/features/sources/source-control-summary.svelte';
  import { mergeWebQueryHydrationStates } from '$lib/query/client';
  import WebQueryProvider from '$lib/query/provider.svelte';
  import type { LayoutProps } from './$types';
  import '../../src/index.css';

  let { children, data }: LayoutProps = $props();
  const hydrationState = $derived(mergeWebQueryHydrationStates(data.quotaQueryState, page.data.queryState));
</script>

<svelte:head>
  <title>ai-usage report</title>
</svelte:head>

{#snippet sourceControlSummary()}
  <SourceControlSummary />
{/snippet}

<WebQueryProvider {hydrationState}>
  <SourceControlProvider runtimeMode={data.runtimeMode}>
    <ProviderQuotaQueryShell runtimeMode={data.runtimeMode} {sourceControlSummary}>
      {@render children()}
    </ProviderQuotaQueryShell>
  </SourceControlProvider>
</WebQueryProvider>
