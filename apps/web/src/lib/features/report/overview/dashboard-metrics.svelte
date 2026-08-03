<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const metricGrid = css({
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' },
  });
  const valuePanel = css({
    display: 'grid',
    gridColumn: { base: 'auto', sm: 'span 2', lg: 'span 4' },
    gap: '8px',
    p: '14px 16px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
  });
  const valueTitle = css({ fontSize: '12px', fontWeight: 700 });
  const valueRows = css({ display: 'grid', gap: '6px' });
  const valueRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    gap: '10px',
    alignItems: 'center',
  });
  const valueLabel = css({ color: 'muted', fontSize: '12px' });
  const valueAmount = css({ fontSize: '13px', fontWeight: 650, textStyle: 'numeric' });
  const help = css({
    display: 'grid',
    placeItems: 'center',
    minW: '24px',
    minH: '24px',
    borderRadius: 'full',
    color: 'muted',
    cursor: 'pointer',
  });
  const notice = css({ color: 'muted', fontSize: '12px', gridColumn: '1 / -1' });
</script>

<script lang="ts">
  import { MetricTile, Popover } from '@ai-usage/design-system/svelte';
  import type { Metric, MetricComparisonState } from '../../../../dashboard-metric-model';
  import {
    metricComparisonMessage,
    splitDashboardMetrics,
    valueBasisLabelFor,
  } from '../../../../dashboard-metric-model';
  import { metricDeltaLabel } from './view-model';

  let { comparisonState, metrics }: { comparisonState: MetricComparisonState; metrics: readonly Metric[] } = $props();
  const groups = $derived(splitDashboardMetrics(metrics));
  const comparisonMessage = $derived(metricComparisonMessage(comparisonState));
</script>

<section aria-label="More report metrics">
  <div class={metricGrid} data-metric-grid>
    <section class={valuePanel} data-value-bases-panel>
      <h2 class={valueTitle}>Value bases</h2>
      <dl class={valueRows}>
        {#each groups.valueBases as metric (metric.kind)}
          <div class={valueRow} data-value-bases-row>
            <dt class={valueLabel}>{valueBasisLabelFor(metric)}</dt>
            <dd class={valueAmount}>{metric.value}</dd>
            <dd>
              {#if metric.hint}
                <Popover
                  triggerAriaLabel={`About ${metric.label}`}
                  triggerClass={help}
                  triggerTitle={`About ${metric.label}`}
                >
                  {#snippet trigger()}
                    <span aria-hidden="true">?</span>
                  {/snippet}
                  <p>{metric.hint}</p>
                </Popover>
              {/if}
            </dd>
          </div>
        {/each}
      </dl>
    </section>

    {#each groups.remainingMetrics as metric (metric.kind)}
      <div data-metric-tile>
        <div data-metric-delta={metric.delta ? '' : undefined}>
          <div data-metric-value>
            <MetricTile
              delta={metric.delta
            ? {
                hint: metric.delta.hint,
                label: metricDeltaLabel(metric.delta),
                positive: metric.delta.pct >= 0,
              }
            : null}
              {...(metric.hint ? { hint: metric.hint } : {})}
              label={metric.label}
              value={metric.value}
            />
          </div>
        </div>
      </div>
    {/each}

    {#if comparisonMessage}
      <p class={notice} data-metric-comparison-state={comparisonState}>{comparisonMessage}</p>
    {/if}
  </div>
</section>
