<script lang="ts" module>
  import {
    heroLabel,
    heroLegend,
    heroLegendValue,
    heroMultiple,
    heroPanel,
    heroSide,
    heroText,
    heroValue,
  } from '@ai-usage/design-system/report';
</script>

<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { Tooltip } from '@ai-usage/design-system/svelte';
  import type { FocusedReportSummary } from '@ai-usage/report-core/focused-report-query';
  import type { DashboardDateRangeSearch } from '../../../../dashboard-search';
  import { parseLocalDate } from '../../../../date-range';
  import { fmtDateOnly, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import {
    aggregateApiPriceProvenance,
    aggregateApiValuePresentation,
  } from '../../../foundation/presentation/report-value';

  let {
    draggedWindowApiValue = null,
    range,
    summary,
  }: {
    draggedWindowApiValue?: number | null;
    range: DashboardDateRangeSearch;
    summary: FocusedReportSummary;
  } = $props();
  // While the brush is dragged the value is summed from the buckets already on screen, so the
  // headline tracks the handle. Only the amount is knowable locally: how much of it is priced, the
  // session counts and the reported spend all come from the server and stay on the last commit —
  // hence the busy marking on that block rather than a silently mismatched set of figures.
  const previewing = $derived(draggedWindowApiValue !== null);
  const provenanceTrigger = css({
    appearance: 'none',
    border: 0,
    bg: 'transparent',
    cursor: 'help',
    font: 'inherit',
    p: 0,
    textAlign: 'left',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const measurement = $derived(
    draggedWindowApiValue === null
      ? summary.priceMeasurement
      : { ...summary.priceMeasurement, knownCost: draggedWindowApiValue },
  );
  const apiValue = $derived(aggregateApiValuePresentation(measurement));
  const provenance = $derived(aggregateApiPriceProvenance(measurement));
  const provisional = css({ opacity: 0.45, transition: 'opacity 120ms ease' });
  const provisionalAttributes = $derived(
    previewing ? ({ 'aria-busy': 'true', 'data-hero-provisional': 'true' } as const) : {},
  );
  const actualKnownSessions = $derived(Math.max(0, summary.sessionCount - summary.unknownActual));
  const formattedRangeDate = (value: string | undefined, fallback: string): string => {
    const date = value ? parseLocalDate(value) : null;
    return date ? fmtDateOnly(date) : fallback;
  };
  const rangeLabel = $derived.by((): string => {
    if (range.mode === 'all') {
      return 'all dates';
    }
    if (range.mode === 'today') {
      return 'today';
    }
    if (range.mode === '7d') {
      return 'last 7 days';
    }
    if (range.mode === '30d') {
      return 'last 30 days';
    }
    return `${formattedRangeDate(range.from, 'start')} – ${formattedRangeDate(range.to, 'end')}`;
  });
</script>

<section aria-label="Estimated API-equivalent value" class={heroPanel}>
  <div>
    <p class={heroLabel}>Estimated API-equivalent value</p>
    <p class={heroValue}>{apiValue.label}</p>
    {#if provenance}
      <Tooltip content={provenance.description}>
        {#snippet trigger(_triggerProps)}
          <button
            {...provisionalAttributes}
            {..._triggerProps}
            class={cx(heroText, provenanceTrigger, previewing && provisional)}
            type="button"
          >
            {provenance.label}
          </button>
        {/snippet}
      </Tooltip>
    {/if}
    <p {...provisionalAttributes} class={cx(heroText, previewing && provisional)}>
      Standard API-price estimate for {fmtNum(summary.pricedSessions)} of {fmtNum(summary.sessionCount)} sessions ({rangeLabel}).
      This is a comparison value, not savings or ROI.
    </p>
  </div>
  <div {...provisionalAttributes} class={cx(heroSide, previewing && provisional)}>
    <span class={heroMultiple} data-reported-actual-spend>
      Reported actual spend · {fmtMoney(summary.actualCost)}
    </span>
    <div class={heroLegend} data-spend-coverage-legend>
      <span>
        Spend coverage<span class={heroLegendValue}
          >{fmtNum(actualKnownSessions)}/{fmtNum(summary.sessionCount)}
          sessions</span
        >
      </span>
      {#if summary.costQuota > 0}
        <span>
          Quota-covered value reported
          <span class={heroLegendValue}>{fmtMoney(summary.costQuota)}</span>
        </span>
      {/if}
    </div>
  </div>
</section>
