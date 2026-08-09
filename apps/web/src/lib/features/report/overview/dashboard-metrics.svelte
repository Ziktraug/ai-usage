<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    meta,
    metricDelta,
    metricDeltaArrow,
    metricLabel,
    metricTile,
    metricValue,
  } from '@ai-usage/design-system/report';

  const secondaryMetrics = css({
    my: '20px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'card',
  });
  const secondaryMetricsHeader = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    p: '14px 16px',
    color: 'ink',
    fontWeight: 600,
    borderBottom: '1px solid token(colors.line)',
  });
  const secondaryMetricsTitle = css({ m: 0, fontSize: 'inherit', fontWeight: 'inherit' });
  const secondaryMetricsGrid = css({
    display: 'block',
    px: '14px',
    pb: '14px',
    '& > div': { my: '14px' },
  });
  const metricGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
    gap: '10px',
    my: '20px',
  });
  const metricComparisonNotice = css({
    gridColumn: '1 / -1',
    m: 0,
    color: 'muted',
    fontSize: '13px',
    lineHeight: 1.5,
  });
  const valueBasesPanel = css({
    gridColumn: { base: '1 / -1', md: 'span 2' },
    gap: 0,
    overflow: 'hidden',
    p: 0,
  });
  const valueBasesTitle = css({
    p: '12px 16px',
    borderBottom: '1px solid token(colors.line)',
    color: 'ink',
    fontSize: '13px',
    fontWeight: 650,
    m: 0,
  });
  const valueBasesList = css({ display: 'grid', m: 0 });
  const valueBasesRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px 16px',
    alignItems: 'center',
    p: '10px 16px',
    '& + &': { borderTop: '1px solid token(colors.line)' },
  });
  const valueBasesTerm = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    minW: 0,
  });
  const valueBasesDefinition = css({ display: 'grid', justifyItems: 'end', m: 0 });
</script>

<script lang="ts">
  import type { Metric, MetricComparisonState } from '../../../../dashboard-metric-model';
  import {
    metricComparisonMessage,
    splitDashboardMetrics,
    valueBasisLabelFor,
  } from '../../../../dashboard-metric-model';
  import DashboardMetricHint from './dashboard-metric-hint.svelte';
  import DashboardMetricTile from './dashboard-metric-tile.svelte';
  import { metricDeltaLabel } from './view-model';

  let { comparisonState, metrics }: { comparisonState: MetricComparisonState; metrics: readonly Metric[] } = $props();
  const groups = $derived(splitDashboardMetrics(metrics));
  const comparisonMessage = $derived(metricComparisonMessage(comparisonState));
</script>

<section aria-labelledby="additional-report-metrics-title" class={secondaryMetrics}>
  <header class={secondaryMetricsHeader}>
    <h2 class={secondaryMetricsTitle} id="additional-report-metrics-title">More report metrics</h2>
    <span class={meta}>{metrics.length}</span>
  </header>
  <div class={secondaryMetricsGrid} id="additional-report-metrics">
    <div class={metricGrid} data-metric-grid>
      {#if comparisonMessage}
        <p class={metricComparisonNotice} data-metric-comparison-state={comparisonState}>{comparisonMessage}</p>
      {/if}
      <section aria-labelledby="value-bases-title" class={cx(metricTile, valueBasesPanel)} data-value-bases-panel>
        <h3 class={valueBasesTitle} id="value-bases-title">Value bases</h3>
        <dl class={valueBasesList}>
          {#each groups.valueBases as metric (metric.kind)}
            <div class={valueBasesRow} data-value-bases-row>
              <dt class={valueBasesTerm}>
                <span class={metricLabel}>{valueBasisLabelFor(metric)}</span>
                <DashboardMetricHint {metric} />
              </dt>
              <dd class={valueBasesDefinition}>
                <span class={metricValue} data-metric-value>{metric.value}</span>
                {#if metric.delta}
                  <span class={metricDelta} data-metric-delta>
                    <span aria-hidden="true" class={metricDeltaArrow}>{metric.delta.pct >= 0 ? '▲' : '▼'}</span>
                    {' '}{metricDeltaLabel(metric.delta)}
                  </span>
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      </section>

      {#each groups.remainingMetrics as metric (metric.kind)}
        <DashboardMetricTile {metric} />
      {/each}
    </div>
  </div>
</section>
