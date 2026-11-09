<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { resetQuotaRailForRecovery } from '../../query/options/quota';
  import AppShell from './app-shell.svelte';
  import ProviderQuotaQueryRail from './provider-quota-query-rail.svelte';
  import RecoverableRegion from './recoverable-region.svelte';

  let {
    children,
    runtimeMode,
    sourceControlSummary,
    quotaE2eFailure = false,
  }: {
    children: Snippet;
    runtimeMode: RuntimeMode;
    sourceControlSummary: Snippet;
    quotaE2eFailure?: boolean;
  } = $props();
  const queryClient = useQueryClient();
</script>

{#snippet quotaRail()}
  <RecoverableRegion compact label="Provider quota" onRetry={() => resetQuotaRailForRecovery(queryClient)}>
    <ProviderQuotaQueryRail {quotaE2eFailure} {runtimeMode} />
  </RecoverableRegion>
{/snippet}

<AppShell {quotaRail} {runtimeMode} {sourceControlSummary}>{@render children()}</AppShell>
