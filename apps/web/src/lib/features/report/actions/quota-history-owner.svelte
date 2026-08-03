<script lang="ts">
  import { parseProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
  import { createQuery } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';
  import {
    type ProviderQuotaHistoryRange,
    providerQuotaHistoryRequest,
  } from '../../../../provider-quota-history-model';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import { type QuotaQueryClient, quotaHistoryQueryOptions } from '../../../query/options/quota';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import { createReportClient } from '../../../rpc/report-client';

  type QuotaHistoryPanelModule = typeof import('./quota-history-panel.svelte');

  let {
    client: injectedClient,
    generation,
    onClose,
    open,
    runtimeMode,
  }: {
    client?: QuotaQueryClient;
    generation?: number | string;
    onClose: () => void;
    open: boolean;
    runtimeMode: RuntimeMode;
  } = $props();

  let browser = $state(false);
  let range: ProviderQuotaHistoryRange = $state('24h');
  let requestedAt = $state(new Date(0));
  let client: QuotaQueryClient | undefined;
  let panelModule = $state<QuotaHistoryPanelModule>();
  let panelLoadFailed = $state(false);
  let panelLoad: Promise<void> | undefined;
  const lazyClient: QuotaQueryClient = {
    getProviderQuotaHistory: async (...parameters) => {
      client ??= injectedClient ?? createReportClient(createBrowserWebRpcClient('svelte-quota-history'));
      return await client.getProviderQuotaHistory(...parameters);
    },
  };
  const request = $derived(providerQuotaHistoryRequest(range, requestedAt, { providerKey: 'codex' }));
  const query = createQuery(() => ({
    ...quotaHistoryQueryOptions(
      lazyClient,
      request,
      { ...(generation === undefined ? {} : { generation }), range },
      {
        browser,
        enabled: open && runtimeMode !== 'demo',
      },
    ),
    select: parseProviderQuotaHistoryResult,
  }));
  const changeRange = (nextRange: ProviderQuotaHistoryRange): void => {
    range = nextRange;
    requestedAt = new Date();
  };
  onMount(() => {
    browser = true;
    requestedAt = new Date();
  });
  $effect(() => {
    if (open && !panelModule) {
      panelLoad ??= import('./quota-history-panel.svelte')
        .then((module) => {
          panelModule = module;
        })
        .catch(() => {
          panelLoadFailed = true;
        });
    }
  });
</script>

{#if open && panelModule}
  {@const QuotaHistoryPanel = panelModule.default}
  <QuotaHistoryPanel
    errorMessage={query.error?.message ?? null}
    loading={query.isPending || query.isFetching}
    {onClose}
    onRangeChange={changeRange}
    {open}
    {range}
    result={query.data ?? null}
  />
{:else if open && panelLoadFailed}
  <p role="status">Quota history is temporarily unavailable.</p>
{/if}
