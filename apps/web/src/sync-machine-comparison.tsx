import { css, cx } from '@ai-usage/design-system/css';
import {
  desktopTableSurface,
  mobileSummarySurface,
  numCell,
  panelHeader,
  panelSub,
  panelTitle,
  projectSummaryCard,
  projectSummaryHeader,
  projectSummaryList,
  projectSummaryMetric,
  projectSummaryMetrics,
  right,
  statusPill,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
  strongCell,
  table,
  tableWrap,
} from '@ai-usage/design-system/report';
import { For, type JSX, Show } from 'solid-js';
import type { SyncFleetComparisonRow } from './sync-machine-comparison-model';

const machineComparisonSection = css({ minW: 0 });

const freshnessStyles: Record<SyncFleetComparisonRow['freshness'], string> = {
  fresh: statusPillOk,
  stale: statusPillWarn,
  unavailable: statusPillInfo,
};

interface MachineComparisonField {
  align: 'default' | 'numeric' | 'right';
  freshness: boolean;
  label: string;
  render: (row: SyncFleetComparisonRow) => JSX.Element;
}

const machineComparisonFields: readonly MachineComparisonField[] = [
  {
    align: 'numeric',
    freshness: false,
    label: 'Sessions',
    render: (row) => row.sessionCount.toLocaleString(),
  },
  {
    align: 'numeric',
    freshness: false,
    label: 'Fleet share',
    render: (row) => row.sessionShareLabel,
  },
  {
    align: 'default',
    freshness: false,
    label: 'Newest session',
    render: (row) => row.newestSessionLabel,
  },
  {
    align: 'default',
    freshness: true,
    label: 'Freshness',
    render: (row) => <span class={cx(statusPill, freshnessStyles[row.freshness])}>{row.freshnessLabel}</span>,
  },
  {
    align: 'right',
    freshness: false,
    label: 'Current',
    render: (row) => (row.current ? 'Yes' : 'No'),
  },
];

const comparisonFieldClass = (field: MachineComparisonField): string | undefined => {
  if (field.align === 'numeric') {
    return numCell;
  }
  return field.align === 'right' ? right : undefined;
};

export const MachineFleetComparison = (props: { rows: readonly SyncFleetComparisonRow[] }) => (
  <section aria-labelledby="machine-contribution-title" class={machineComparisonSection}>
    <div class={panelHeader}>
      <h2 class={panelTitle} id="machine-contribution-title">
        Machine contributions
      </h2>
      <div class={panelSub}>Session share across the loaded fleet.</div>
    </div>
    {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The horizontally scrollable table must be keyboard-reachable. */}
    <div class={cx(tableWrap, desktopTableSurface)} tabIndex={0}>
      <table aria-labelledby="machine-contribution-title" class={table}>
        <thead>
          <tr>
            <th scope="col">Machine</th>
            <For each={machineComparisonFields}>
              {(field) => (
                <th class={comparisonFieldClass(field)} scope="col">
                  {field.label}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr data-machine-id={row.id}>
                <td>
                  <div class={row.current ? strongCell : undefined}>{row.label}</div>
                </td>
                <For each={machineComparisonFields}>
                  {(field) => (
                    <td
                      class={comparisonFieldClass(field)}
                      data-machine-freshness={field.freshness ? row.freshness : undefined}
                    >
                      {field.render(row)}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
    <ul aria-label="Machine contribution summaries" class={cx(mobileSummarySurface, projectSummaryList)}>
      <For each={props.rows}>
        {(row) => (
          <li class={projectSummaryCard} data-machine-id={row.id}>
            <header class={projectSummaryHeader}>
              <div>
                <div class={strongCell}>{row.label}</div>
              </div>
              <Show when={row.current}>
                <span class={cx(statusPill, statusPillInfo)}>Current machine</span>
              </Show>
            </header>
            <dl class={projectSummaryMetrics}>
              <For each={machineComparisonFields}>
                {(field) => (
                  <div class={projectSummaryMetric}>
                    <dt>{field.label}</dt>
                    <dd data-machine-freshness={field.freshness ? row.freshness : undefined}>{field.render(row)}</dd>
                  </div>
                )}
              </For>
            </dl>
          </li>
        )}
      </For>
    </ul>
  </section>
);
