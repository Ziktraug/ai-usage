<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { HarnessBadge, SegmentedControl } from '@ai-usage/design-system/svelte';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import { analyticsBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import { PARTIALLY_MEASURED_LABEL } from '@ai-usage/report-core/provenance';
  import type { BreakdownSort, FieldFilterKey } from '../../../../dashboard-search';
  import { fmtCompact, fmtNum, fmtPct } from '../../../foundation/presentation/format';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import { analyticsExportRows, breakdownRows } from './model';
  import {
    barFill,
    barTrack,
    field,
    identityButton,
    item,
    list,
    metric,
    muted,
    panel,
    panelHeader,
    partialBarTrack,
    row,
    title,
  } from './styles';

  let {
    countLabel,
    dimension,
    generatedAt,
    groups,
    onFilter,
    onHarnessFilter,
    onSortChange,
    selectedHarnesses = [],
    sort,
    title: panelTitle,
  }: {
    countLabel: string;
    dimension: 'harnesses' | 'models' | 'providers';
    generatedAt: string;
    groups: readonly AnalyticsGroup[];
    onFilter?: (key: FieldFilterKey, value: string) => void;
    onHarnessFilter?: (value: string) => void;
    onSortChange: (sort: BreakdownSort) => void;
    selectedHarnesses?: readonly string[];
    sort: BreakdownSort;
    title: string;
  } = $props();

  let query = $state('');
  const sortLabels: Record<BreakdownSort, string> = { sessions: 'Sessions', tokens: 'Tokens', value: 'Value' };
  const sortItems = ['value', 'tokens', 'sessions'].map((value) => ({
    label: sortLabels[value as BreakdownSort],
    value,
  }));
  const changeSort = (value: string): void => {
    if (value === 'value' || value === 'tokens' || value === 'sessions') {
      onSortChange(value);
    }
  };
  const visibleRows = $derived(breakdownRows(groups, query, sort, dimension));
  const filterKey = $derived(dimension === 'models' ? 'model' : 'provider');
  const createExport = async (): Promise<{ csv: string; filename: string }> => ({
    csv: analyticsBreakdownCsv(analyticsExportRows(visibleRows)),
    filename: reportCsvFilename(dimension === 'models' ? 'models' : 'harnesses', generatedAt),
  });
</script>

<section class={panel} data-breakdown-panel={dimension}>
  <header class={panelHeader}>
    <h2 class={title}>{panelTitle}</h2>
    <span class={muted}>{fmtNum(visibleRows.length)} {countLabel}</span>
  </header>
  <div class={row}>
    <input aria-label="Search this breakdown" class={field} placeholder="Search this breakdown" bind:value={query}>
    <SegmentedControl
      ariaLabel="Sort breakdown"
      defaultValue="value"
      items={sortItems}
      onValueChange={changeSort}
      value={sort}
    />
    <ReportSharingActions {createExport} />
  </div>
  {#if visibleRows.length === 0}
    <p class={muted}>{query.trim() ? 'No matching groups' : `No ${countLabel}`}</p>
  {:else}
    <div class={list}>
      {#each visibleRows as view (view.group.key)}
        <article class={item} data-price-state={view.priceState}>
          <div>
            {#if dimension === 'harnesses' && onHarnessFilter}
              <HarnessBadge
                active={selectedHarnesses.includes(view.group.key)}
                name={view.label}
                onClick={() => onHarnessFilter?.(view.group.key)}
                title={`Filter by ${view.label}`}
              />
            {:else}
              <button class={identityButton} onclick={() => onFilter?.(filterKey, view.group.key)} type="button">
                {view.label}
              </button>
            {/if}
            <p class={muted}>
              {fmtNum(view.group.sessions)} {view.group.sessions === 1 ? 'session' : 'sessions'} ·
              {fmtCompact(view.group.fresh)}
              fresh
              {#if view.priceState === 'partially measured'}
                · {PARTIALLY_MEASURED_LABEL} ({fmtNum(view.group.priced)}/{fmtNum(view.group.sessions)}
                fully priced)
              {/if}
            </p>
            {#if view.widthPercent !== null}
              <div
                aria-label={view.ariaLabel}
                class={cx(barTrack, view.priceState === 'partially measured' ? partialBarTrack : undefined)}
                data-width-percent={String(view.widthPercent)}
                role="img"
              >
                <div class={barFill} style:width={`${view.widthPercent}%`}></div>
              </div>
            {/if}
          </div>
          <div class={metric}>
            <strong>{view.priceState === 'unavailable' ? '—' : `$${view.group.costSum.toFixed(2)}`}</strong>
            <div class={muted}>{fmtPct(view.group.costPercent)}</div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>
