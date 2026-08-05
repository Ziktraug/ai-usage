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
  import { Tooltip } from '@ai-usage/design-system/svelte';
  import type { FocusedReportSummary } from '@ai-usage/report-core/focused-report-query';
  import type { DashboardDateRangeSearch } from '../../../../dashboard-search';
  import { parseLocalDate } from '../../../../date-range';
  import { fmtDateOnly, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import {
    aggregateApiPriceProvenance,
    aggregateApiValuePresentation,
  } from '../../../foundation/presentation/report-value';

  let { range, summary }: { range: DashboardDateRangeSearch; summary: FocusedReportSummary } = $props();
  const apiValue = $derived(aggregateApiValuePresentation(summary.priceMeasurement));
  const provenance = $derived(aggregateApiPriceProvenance(summary.priceMeasurement));
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
        <span class={heroText}>{provenance.label}</span>
      </Tooltip>
    {/if}
    <p class={heroText}>
      Standard API-price estimate for {fmtNum(summary.pricedSessions)} of {fmtNum(summary.sessionCount)} sessions ({rangeLabel}).
      This is a comparison value, not savings or ROI.
    </p>
  </div>
  <div class={heroSide}>
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
