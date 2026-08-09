<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { header, meta, page, shell, title, titleBlock } from '@ai-usage/design-system/svelte';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { browser } from '$app/environment';
  import { buildSyncFleetMachineViews, manualTransferMutationAvailability } from '../../../manual-transfer-model';
  import type { SourceControlConnectionState } from '../../../source-control-client';
  import { buildSyncFleetComparisonRows } from '../../../sync-machine-comparison-model';
  import { invalidateSyncFleet } from '../../query/options/sync';
  import MachineComparison from './machine-comparison.svelte';
  import MachineFleet from './machine-fleet.svelte';
  import ManualTransfer from './manual-transfer.svelte';
  import { headerTop, pageStack, unavailablePanel, unavailableText } from './styles';
  import type { SyncPageData } from './sync-load';
  import { createHydratedSyncFleetQuery } from './sync-query.svelte';

  let { connection = 'connecting', data }: { connection?: SourceControlConnectionState; data: SyncPageData } = $props();
  const queryClient = useQueryClient();
  const fleetQuery = createHydratedSyncFleetQuery(browser, () => data.compatibleGeneration);
  const fleet = $derived(fleetQuery.data);
  const machines = $derived(
    fleet ? buildSyncFleetMachineViews(fleet.currentMachine, fleet.machines, data.renderedAt) : [],
  );
  const comparison = $derived(
    fleet ? buildSyncFleetComparisonRows(fleet.currentMachine, fleet.machines, data.renderedAt) : [],
  );
  const mutation = $derived(manualTransferMutationAvailability(connection));
  const operationPanel = css({
    bg: 'surfaceMuted',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    display: 'grid',
    fontSize: '13px',
    gap: '4px',
    p: '10px 12px',
  });
</script>

<div class={shell}>
  <header class={header}>
    <div class={headerTop}>
      <div class={titleBlock}>
        <p class={meta}>File transfer</p>
        <h1 class={title}>Sync</h1>
      </div>
    </div>
  </header>
  <main class={page} data-route-shell="sync">
    <div class={pageStack}>
      {#if fleet}
        {#if mutation.message}
          <div class={operationPanel} role="status">{mutation.message}</div>
        {/if}
        <MachineFleet
          {machines}
          now={data.renderedAt}
          omittedMachines={fleet.omittedMachines}
          skipped={fleet.skipped}
        />
        <MachineComparison rows={comparison} />
      {:else if fleetQuery.isPending}
        <section aria-live="polite" class={unavailablePanel}>
          <div class={unavailableText}>Loading machine fleet…</div>
        </section>
      {:else}
        <section aria-live="polite" class={unavailablePanel}>
          <div class={unavailableText}>Sync fleet data could not be read safely.</div>
        </section>
      {/if}
      <ManualTransfer
        mutationAvailable={mutation.available}
        onCompleted={async () => await invalidateSyncFleet(queryClient, data.compatibleGeneration)}
      />
    </div>
  </main>
</div>
