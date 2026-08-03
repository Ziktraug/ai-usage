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
  import QuotaHistoryPanel from './quota-history-panel.svelte';

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
</script>

<QuotaHistoryPanel
  errorMessage={query.error?.message ?? null}
  loading={query.isPending || query.isFetching}
  {onClose}
  onRangeChange={changeRange}
  {open}
  {range}
  result={query.data ?? null}
/>
