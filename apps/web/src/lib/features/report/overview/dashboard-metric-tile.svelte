<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';
  import { metricDelta, metricDeltaArrow, metricLabel, metricTile, metricValue } from '@ai-usage/design-system/report';

  const metricLabelRow = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    minH: '24px',
  });
</script>

<script lang="ts">
  import type { Metric } from '../../../../dashboard-metric-model';
  import DashboardMetricHint from './dashboard-metric-hint.svelte';
  import { metricDeltaLabel } from './view-model';

  let { metric }: { metric: Metric } = $props();
</script>

<div class={metricTile} data-metric-tile>
  <div class={metricLabelRow}>
    <div class={metricLabel}>{metric.label}</div>
    <DashboardMetricHint {metric} />
  </div>
  <div>
    <div class={metricValue} data-metric-value>{metric.value}</div>
    {#if metric.delta}
      <div class={metricDelta} data-metric-delta>
        <span aria-hidden="true" class={metricDeltaArrow}>{metric.delta.pct >= 0 ? '▲' : '▼'}</span>
        {' '}{metricDeltaLabel(metric.delta)}
      </div>
    {/if}
  </div>
</div>
