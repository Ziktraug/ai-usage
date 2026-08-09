<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte/passive';
  import {
    formatFleetAge,
    INVALID_STORED_ROWS_EXPLANATION,
    invalidStoredRowsSummary,
    STALE_MACHINE_COLLECTION_GUIDANCE,
    type SyncFleetMachineView,
  } from '../../../manual-transfer-model';
  import { actionRow, panelHeader, statusPill, statusPillInfo, statusPillOk, statusPillWarn } from './styles';

  let {
    machines,
    now,
    omittedMachines,
    skipped,
  }: { machines: readonly SyncFleetMachineView[]; now: number; omittedMachines: number; skipped: number } = $props();

  const fleetGrid = css({
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
  });
  const machineCard = css({ display: 'grid', gap: '14px', minW: 0 });
  const machineCardCurrent = css({ borderColor: 'accent', boxShadow: '0 0 0 1px token(colors.accent)' });
  const machineHeader = css({
    alignItems: 'start',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '10px',
    justifyContent: 'space-between',
  });
  const machineTitle = css({ fontSize: '15px', fontWeight: 750, overflowWrap: 'anywhere' });
  const machineFacts = css({ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
  const machineFact = css({ display: 'grid', gap: '3px', minW: 0 });
  const machineFactLabel = css({ color: 'muted', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' });
  const disclosure = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5 });
  const snapshotCommand = css({
    bg: 'surfaceMuted',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    color: 'ink',
    display: 'block',
    fontFamily: 'mono',
    fontSize: '11px',
    maxW: '100%',
    overflowWrap: 'anywhere',
    p: '6px 8px',
    width: 'fit-content',
  });

  const freshnessLabel = (machine: Pick<SyncFleetMachineView, 'current' | 'stale'>): string => {
    if (!machine.stale) {
      return 'Fresh';
    }
    return machine.current ? 'Needs collection' : 'Stale';
  };
</script>

<section aria-labelledby="machine-fleet-title">
  <div class={panelHeader}>
    <h2 class={panelTitle} id="machine-fleet-title">Machine fleet</h2>
    <div class={panelSub}>Freshness is evaluated against the report's default 30-day window.</div>
  </div>
  <div class={fleetGrid}>
    {#each machines as machine (machine.id)}
      <article class={cx(panel, machineCard, machine.current && machineCardCurrent)} data-machine-stale={machine.stale}>
        <div class={machineHeader}>
          <h3 class={machineTitle}>{machine.label}</h3>
          <div class={actionRow}>
            {#if machine.current}
              <span class={cx(statusPill, statusPillInfo)}>Current machine</span>
            {/if}
            <span class={cx(statusPill, machine.stale ? statusPillWarn : statusPillOk)}>{freshnessLabel(machine)}</span>
          </div>
        </div>
        <div class={machineFacts}>
          <div class={machineFact}>
            <span class={machineFactLabel}>Sessions</span><span>{machine.sessionCount.toLocaleString()}</span>
          </div>
          <div class={machineFact}>
            <span class={machineFactLabel}>Newest session</span
            ><span>{formatFleetAge(machine.newestSessionAt, now)}</span>
          </div>
          <div class={machineFact}>
            <span class={machineFactLabel}>{machine.current ? 'Last observed' : 'Last import'}</span>
            <span>{formatFleetAge(machine.lastSeenAt, now)}</span>
          </div>
        </div>
        {#if machine.stale}
          <details
            aria-label={`Collection guidance for ${machine.label}`}
            class={disclosure}
            data-stale-machine-guidance
          >
            <summary>Collect a fresh snapshot</summary>
            <p>{STALE_MACHINE_COLLECTION_GUIDANCE.description}</p>
            <code class={snapshotCommand}>{STALE_MACHINE_COLLECTION_GUIDANCE.command}</code>
          </details>
        {/if}
      </article>
    {/each}
  </div>
  {#if skipped > 0}
    <details class={disclosure} data-invalid-stored-rows>
      <summary>{invalidStoredRowsSummary(skipped)}</summary>
      <p class={panelSub}>{INVALID_STORED_ROWS_EXPLANATION}</p>
    </details>
  {/if}
  {#if omittedMachines > 0}
    <p class={panelSub} role="status">
      {omittedMachines.toLocaleString()}
      additional machines were omitted from this bounded fleet view.
    </p>
  {/if}
</section>
