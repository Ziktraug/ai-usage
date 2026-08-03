<script lang="ts">
  import { SegmentedControl } from '@ai-usage/design-system/svelte';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import { analyticsBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { BreakdownSort, FieldFilterKey } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import BreakdownRow from './breakdown-row.svelte';
  import { analyticsExportRows, breakdownRows } from './model';
  import { field, item, list, muted, panel, panelHeader, row, title } from './styles';

  let {
    countLabel,
    dimension,
    generatedAt,
    groups,
    onFilter,
    onSortChange,
    sort,
    title: panelTitle,
  }: {
    countLabel: string;
    dimension: 'harnesses' | 'models' | 'providers';
    generatedAt: string;
    groups: readonly AnalyticsGroup[];
    onFilter?: (key: FieldFilterKey, value: string) => void;
    onSortChange: (sort: BreakdownSort) => void;
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
        <article class={item}>
          <BreakdownRow onFilter={() => onFilter?.(filterKey, view.group.key)} {view} />
        </article>
      {/each}
    </div>
  {/if}
</section>
