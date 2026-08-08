<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import { browser } from '$app/environment';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { type QuotaQueryClient, quotaRailQueryOptions } from '../../query/options/quota';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import AppShell from './app-shell.svelte';
  import { buildProviderQuotaRail } from './provider-quota-rail';

  let {
    children,
    runtimeMode,
    sourceControlSummary,
  }: {
    children: Snippet;
    runtimeMode: RuntimeMode;
    sourceControlSummary: Snippet;
  } = $props();

  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  let reportClient: QuotaQueryClient | undefined;
  const client: QuotaQueryClient = {
    getProviderQuotaHistory: async (...parameters) => {
      if (!rpc) {
        throw new Error('The shared browser RPC context is unavailable.');
      }
      reportClient ??= createReportClient(rpc);
      return await reportClient.getProviderQuotaHistory(...parameters);
    },
  };
  const query = createQuery(() =>
    quotaRailQueryOptions(client, {
      browser,
      enabled: runtimeMode === 'live',
    }),
  );
  const providerQuota = $derived(
    buildProviderQuotaRail(
      query.data
        ? {
            generatedAt: query.data.generatedAt,
            providers: query.data.latest,
            schemaVersion: 1,
          }
        : null,
      query.data?.generatedAt ?? new Date(),
    ),
  );
</script>

<AppShell {providerQuota} {runtimeMode} {sourceControlSummary}> {@render children()} </AppShell>
