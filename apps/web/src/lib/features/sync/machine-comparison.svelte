<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex: the horizontally scrollable comparison must remain keyboard-reachable -->
<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panelSub, panelTitle } from '@ai-usage/design-system/svelte/passive';
  import type { SyncFleetComparisonRow } from '../../../sync-machine-comparison-model';
  import {
    desktopTableSurface,
    mobileSummarySurface,
    numCell,
    panelHeader,
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
  } from './styles';

  let { rows }: { rows: readonly SyncFleetComparisonRow[] } = $props();
  const section = css({ minW: 0 });
  const freshnessStyles: Record<SyncFleetComparisonRow['freshness'], string> = {
    fresh: statusPillOk,
    stale: statusPillWarn,
    unavailable: statusPillInfo,
  };
</script>

<section aria-labelledby="machine-contribution-title" class={section}>
  <div class={panelHeader}>
    <h2 class={panelTitle} id="machine-contribution-title">Machine contributions</h2>
    <div class={panelSub}>Session share across the loaded fleet.</div>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- comparison table remains keyboard-reachable -->
  <div class={cx(tableWrap, desktopTableSurface)} tabindex="0">
    <table aria-labelledby="machine-contribution-title" class={table}>
      <thead>
        <tr>
          <th scope="col">Machine</th>
          <th class={numCell} scope="col">Sessions</th>
          <th class={numCell} scope="col">Fleet share</th>
          <th scope="col">Newest session</th>
          <th scope="col">Freshness</th>
          <th class={right} scope="col">Current</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-machine-id={row.id}>
            <td><span class={row.current ? strongCell : undefined}>{row.label}</span></td>
            <td class={numCell}>{row.sessionCount.toLocaleString()}</td>
            <td class={numCell}>{row.sessionShareLabel}</td>
            <td>{row.newestSessionLabel}</td>
            <td data-machine-freshness={row.freshness}>
              <span class={cx(statusPill, freshnessStyles[row.freshness])}>{row.freshnessLabel}</span>
            </td>
            <td class={right}>{row.current ? 'Yes' : 'No'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <ul aria-label="Machine contribution summaries" class={cx(mobileSummarySurface, projectSummaryList)}>
    {#each rows as row (row.id)}
      <li class={projectSummaryCard} data-machine-id={row.id}>
        <header class={projectSummaryHeader}>
          <span class={strongCell}>{row.label}</span>
          {#if row.current}
            <span class={cx(statusPill, statusPillInfo)}>Current machine</span>
          {/if}
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
            <dd data-machine-freshness={row.freshness}>{row.freshnessLabel}</dd>
          </div>
          <div class={projectSummaryMetric}>
            <dt>Current</dt>
            <dd>{row.current ? 'Yes' : 'No'}</dd>
          </div>
        </dl>
      </li>
    {/each}
  </ul>
</section>
