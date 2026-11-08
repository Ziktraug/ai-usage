<script lang="ts">
  import { buildCampaignMap } from '@ai-usage/report-core/campaign-map';
  import { sessionCampaignIdentityForRow } from '@ai-usage/report-core/session-query';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';
  import { createWebQueryClient } from '../../query/client';
  import { syntheticSessionRow } from '../sessions/table/session-table.fixtures';
  import CampaignReplay from './campaign-replay.svelte';
  import { fractionalCampaignReplayFixture } from './campaign-replay-fixture';
  import { createSyntheticCampaignClient } from './campaigns-synthetic';

  const queryClient = createWebQueryClient();
  onDestroy(() => queryClient.clear());
  let duration = $state(500);
  const revision = $derived(`fractional-replay-${duration}`);
  const response = $derived(fractionalCampaignReplayFixture(revision, duration));
  const map = $derived.by(() => {
    if (response.status !== 'available') {
      throw new Error('Expected an available fixture');
    }
    const root = {
      ...syntheticSessionRow(0),
      date: response.detail.startedAt,
      activeDate: response.detail.endedAt,
      endDate: response.detail.endedAt,
      durationMs: duration,
    };
    return buildCampaignMap({
      campaignKey: sessionCampaignIdentityForRow(root).campaignKey,
      root,
      children: [],
      totalCount: 1,
    });
  });
  const client = $derived({ ...createSyntheticCampaignClient(), detail: () => Promise.resolve(response) });
</script>

<h1>Fractional replay endpoint fixture</h1>
<label
  >Duration<select aria-label="Fixture duration" bind:value={duration}>
    <option value={500}>500 ms</option>
    <option value={1500}>1500 ms</option>
  </select></label
>
<QueryClientProvider client={queryClient}>
  {#key duration}
    <CampaignReplay {client} {map} onOpen={() => undefined} {revision} />
  {/key}
</QueryClientProvider>
