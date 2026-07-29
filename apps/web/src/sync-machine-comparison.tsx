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
import { For, Show } from 'solid-js';
import type { SyncFleetComparisonRow } from './sync-machine-comparison-model';

const machineComparisonSection = css({ minW: 0 });

const freshnessStyles: Record<SyncFleetComparisonRow['freshness'], string> = {
  fresh: statusPillOk,
  stale: statusPillWarn,
  unavailable: statusPillInfo,
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
            <th class={numCell} scope="col">
              Sessions
            </th>
            <th class={numCell} scope="col">
              Fleet share
            </th>
            <th scope="col">Newest session</th>
            <th scope="col">Freshness</th>
            <th class={right} scope="col">
              Current
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr data-machine-id={row.id}>
                <td>
                  <div class={row.current ? strongCell : undefined}>{row.label}</div>
                </td>
                <td class={numCell}>{row.sessionCount.toLocaleString()}</td>
                <td class={numCell}>{row.sessionShareLabel}</td>
                <td>{row.newestSessionLabel}</td>
                <td data-machine-freshness={row.freshness}>
                  <span class={cx(statusPill, freshnessStyles[row.freshness])}>{row.freshnessLabel}</span>
                </td>
                <td class={right}>{row.current ? 'Yes' : 'No'}</td>
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
              <div class={projectSummaryMetric}>
                <dt>Sessions</dt>
                <dd>{row.sessionCount.toLocaleString()}</dd>
              </div>
              <div class={projectSummaryMetric}>
                <dt>Fleet share</dt>
                <dd>{row.sessionShareLabel}</dd>
              </div>
              <div class={projectSummaryMetric}>
                <dt>Newest session</dt>
                <dd>{row.newestSessionLabel}</dd>
              </div>
              <div class={projectSummaryMetric}>
                <dt>Freshness</dt>
                <dd data-machine-freshness={row.freshness}>
                  <span class={cx(statusPill, freshnessStyles[row.freshness])}>{row.freshnessLabel}</span>
                </dd>
              </div>
              <div class={projectSummaryMetric}>
                <dt>Current</dt>
                <dd>{row.current ? 'Yes' : 'No'}</dd>
              </div>
            </dl>
          </li>
        )}
      </For>
    </ul>
  </section>
);
