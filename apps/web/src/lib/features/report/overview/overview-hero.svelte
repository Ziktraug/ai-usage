<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const hero = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1.2fr) minmax(0, 1fr)' },
    gap: '18px 32px',
    alignItems: 'center',
    p: '20px 22px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'card',
  });
  const eyebrow = css({ textStyle: 'eyebrow', color: 'accent' });
  const value = css({
    textStyle: 'numeric',
    mt: '8px',
    fontSize: { base: '30px', md: '38px' },
    fontWeight: 650,
    lineHeight: '1.05',
  });
  const detail = css({ mt: '6px', color: 'muted', fontSize: '13px' });
  const side = css({ display: 'grid', gap: '10px' });
  const reportedSpend = css({
    textStyle: 'numeric',
    display: 'inline-flex',
    alignItems: 'center',
    h: '24px',
    justifySelf: 'start',
    px: '10px',
    borderRadius: 'full',
    bg: 'accentSoft',
    color: 'accent',
    fontSize: '12px',
    fontWeight: 650,
  });
  const legend = css({ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', color: 'muted', fontSize: '11px' });
  const legendValue = css({ textStyle: 'numeric', ml: '5px', color: 'ink' });
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

<section aria-label="Estimated API-equivalent value" class={hero}>
  <div>
    <p class={eyebrow}>Estimated API-equivalent value</p>
    <p class={value}>{apiValue.label}</p>
    {#if provenance}
      <Tooltip content={provenance.description}>
        <span class={detail}>{provenance.label}</span>
      </Tooltip>
    {/if}
    <p class={detail}>
      Standard API-price estimate for {fmtNum(summary.pricedSessions)} of {fmtNum(summary.sessionCount)} sessions ({rangeLabel}).
      This is a comparison value, not savings or ROI.
    </p>
  </div>
  <div class={side}>
    <span class={reportedSpend} data-reported-actual-spend>
      Reported actual spend · {fmtMoney(summary.actualCost)}
    </span>
    <div class={legend} data-spend-coverage-legend>
      <span>
        Spend coverage<span class={legendValue}
          >{fmtNum(actualKnownSessions)}/{fmtNum(summary.sessionCount)}
          sessions</span
        >
      </span>
      {#if summary.costQuota > 0}
        <span>
          Quota-covered value reported
          <span class={legendValue}>{fmtMoney(summary.costQuota)}</span>
        </span>
      {/if}
    </div>
  </div>
</section>
