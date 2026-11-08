<script lang="ts">
  import ProviderQuotaQueryShell from '#lib/features/shell/provider-quota-query-shell.svelte';
  import { transitionNavigation } from '#lib/features/shell/view-transitions.ts';
  import SourceControlProvider from '#lib/features/sources/source-control-provider.svelte';
  import SourceControlSummary from '#lib/features/sources/source-control-summary.svelte';
  import { mergeWebQueryHydrationStates } from '#lib/query/client.ts';
  import WebQueryProvider from '#lib/query/provider.svelte';
  import { onNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import type { LayoutProps } from './$types';
  import '../../src/index.css';

  let { children, data }: LayoutProps = $props();
  const hydrationState = $derived(mergeWebQueryHydrationStates(data.quotaQueryState, page.data.queryState));
  // onNavigate runs only after beforeNavigate guards have allowed the navigation.
  onNavigate(transitionNavigation);
</script>

<svelte:head>
  <title>ai-usage report</title>
</svelte:head>

{#snippet sourceControlSummary()}
  <SourceControlSummary navigationKey={page.url.href} />
{/snippet}

<WebQueryProvider {hydrationState}>
  <SourceControlProvider runtimeMode={data.runtimeMode}>
    <ProviderQuotaQueryShell
      quotaE2eFailure={data.quotaE2eFailure ?? false}
      runtimeMode={data.runtimeMode}
      {sourceControlSummary}
    >
      {@render children()}
    </ProviderQuotaQueryShell>
  </SourceControlProvider>
</WebQueryProvider>
