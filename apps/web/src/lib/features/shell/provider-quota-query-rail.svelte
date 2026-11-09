<script lang="ts">
  import { ORPCError } from '@orpc/client';
  import { createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { browser } from '$app/env';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { type QuotaQueryClient, quotaRailQueryOptions } from '../../query/options/quota';
  import { useOptionalWebQueryRpcContext } from '../../query/rpc-context.svelte';
  import { createReportClient } from '../../rpc/report-client';
  import { buildProviderQuotaRail } from './provider-quota-rail';
  import ProviderQuotaRail from './provider-quota-rail.svelte';
  import UnavailableRegion from './unavailable-region.svelte';

  let { runtimeMode, quotaE2eFailure = false }: { runtimeMode: RuntimeMode; quotaE2eFailure?: boolean } = $props();
  const fixtureEnabled = untrack(() => runtimeMode === 'e2e' && quotaE2eFailure);
  let failOnce = fixtureEnabled;
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  const client: QuotaQueryClient = {
    getProviderQuotaHistory: async (...parameters) => {
      if (failOnce) {
        failOnce = false;
        throw new ORPCError('Unavailable');
      }
      if (!rpc) {
        throw new Error('The shared browser RPC context is unavailable.');
      }
      return await createReportClient(rpc).getProviderQuotaHistory(...parameters);
    },
  };
  const query = createQuery(() =>
    quotaRailQueryOptions(client, {
      browser,
      enabled: runtimeMode === 'live' || fixtureEnabled,
    }),
  );
  const entries = $derived(
    buildProviderQuotaRail(
      query.data ? { generatedAt: query.data.generatedAt, providers: query.data.latest, schemaVersion: 1 } : null,
      query.data?.generatedAt ?? new Date(),
    ),
  );
</script>

{#if query.error}
  <UnavailableRegion
    compact
    label="Provider quota"
    onRetry={async () => {
      await query.refetch({ throwOnError: true });
    }}
  />
{:else}
  <ProviderQuotaRail {entries} />
{/if}
