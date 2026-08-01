import { css, cx } from '@ai-usage/design-system/css';
import {
  actionRow,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  statusPill,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
} from '@ai-usage/design-system/report';
import { For, Show } from 'solid-js';
import {
  formatFleetAge,
  INVALID_STORED_ROWS_EXPLANATION,
  invalidStoredRowsSummary,
  STALE_MACHINE_COLLECTION_GUIDANCE,
  type SyncFleetMachineView,
} from './manual-transfer-model';

const fleetGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
  gap: '12px',
});

const machineCard = css({
  display: 'grid',
  gap: '14px',
  minW: 0,
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
});

const machineCardCurrent = css({
  borderColor: 'accent',
  boxShadow: '0 0 0 1px token(colors.accent)',
});

const machineHeader = css({
  display: 'flex',
  alignItems: 'start',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '10px',
});

const machineTitle = css({
  fontSize: '15px',
  fontWeight: 750,
  overflowWrap: 'anywhere',
});

const machineFacts = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '10px',
});

const machineFact = css({
  display: 'grid',
  gap: '3px',
  minW: 0,
});

const machineFactLabel = css({
  color: 'muted',
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
});

const fleetDisclosure = css({
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
  '& > summary': {
    cursor: 'pointer',
    fontWeight: 650,
  },
  '&[open] > summary': {
    mb: '6px',
  },
});

const guidanceBody = css({
  display: 'grid',
  gap: '6px',
  m: 0,
});

const snapshotCommand = css({
  display: 'block',
  width: 'fit-content',
  maxW: '100%',
  p: '6px 8px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'ink',
  fontFamily: 'mono',
  fontSize: '11px',
  overflowWrap: 'anywhere',
});

const machineFreshnessLabel = (machine: Pick<SyncFleetMachineView, 'current' | 'stale'>): string => {
  if (!machine.stale) {
    return 'Fresh';
  }
  return machine.current ? 'Needs collection' : 'Stale';
};

interface MachineFleetPanelProps {
  machines: readonly SyncFleetMachineView[];
  omittedMachines: number;
  skipped: number;
}

export const MachineFleetPanel = (props: MachineFleetPanelProps) => (
  <section aria-labelledby="machine-fleet-title">
    <div class={panelHeader}>
      <h2 class={panelTitle} id="machine-fleet-title">
        Machine fleet
      </h2>
      <div class={panelSub}>Freshness is evaluated against the report's default 30-day window.</div>
    </div>
    <div class={fleetGrid}>
      <For each={props.machines}>
        {(machine) => (
          <article
            class={cx(panel, machineCard, machine.current && machineCardCurrent)}
            data-machine-stale={machine.stale ? 'true' : 'false'}
          >
            <div class={machineHeader}>
              <h3 class={machineTitle}>{machine.label}</h3>
              <div class={actionRow}>
                <Show when={machine.current}>
                  <span class={cx(statusPill, statusPillInfo)}>Current machine</span>
                </Show>
                <span class={cx(statusPill, machine.stale ? statusPillWarn : statusPillOk)}>
                  {machineFreshnessLabel(machine)}
                </span>
              </div>
            </div>
            <div class={machineFacts}>
              <div class={machineFact}>
                <span class={machineFactLabel}>Sessions</span>
                <span>{machine.sessionCount.toLocaleString()}</span>
              </div>
              <div class={machineFact}>
                <span class={machineFactLabel}>Newest session</span>
                <span>{formatFleetAge(machine.newestSessionAt)}</span>
              </div>
              <div class={machineFact}>
                <span class={machineFactLabel}>{machine.current ? 'Last observed' : 'Last import'}</span>
                <span>{formatFleetAge(machine.lastSeenAt)}</span>
              </div>
            </div>
            <Show when={machine.stale}>
              <details
                aria-label={`Collection guidance for ${machine.label}`}
                class={fleetDisclosure}
                data-stale-machine-guidance
              >
                <summary>Collect a fresh snapshot</summary>
                <div class={guidanceBody}>
                  <span>{STALE_MACHINE_COLLECTION_GUIDANCE.description}</span>
                  <code class={snapshotCommand}>{STALE_MACHINE_COLLECTION_GUIDANCE.command}</code>
                </div>
              </details>
            </Show>
          </article>
        )}
      </For>
    </div>
    <Show when={props.skipped > 0}>
      <details class={fleetDisclosure} data-invalid-stored-rows>
        <summary>{invalidStoredRowsSummary(props.skipped)}</summary>
        <p class={panelSub}>{INVALID_STORED_ROWS_EXPLANATION}</p>
      </details>
    </Show>
    <Show when={props.omittedMachines > 0}>
      <p class={panelSub} role="status">
        {props.omittedMachines.toLocaleString()} additional machines were omitted from this bounded fleet view.
      </p>
    </Show>
  </section>
);
