<script lang="ts">
  import SegmentedControl from '@ai-usage/design-system/svelte/segmented-control';
  import {
    actionRow,
    groupCount,
    groupHeader,
    groupPanel,
    groupRow,
    groupRows,
    groupTitle,
    searchInput,
    unavailableText,
  } from '@ai-usage/design-system/svelte/passive';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import { analyticsBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { BreakdownSort, FieldFilterKey } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import BreakdownRow from './breakdown-row.svelte';
  import { analyticsExportRows, breakdownRows } from './model';

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

<section class={groupPanel} data-breakdown-panel={dimension}>
  <header class={groupHeader}>
    <h2 class={groupTitle}>{panelTitle}</h2>
    <span class={groupCount} title={`${fmtNum(visibleRows.length)} ${countLabel}`}
      >{fmtNum(visibleRows.length)} {countLabel}</span
    >
    <div class={actionRow} style:grid-column="1 / -1">
      <input
        aria-label="Search this breakdown"
        class={searchInput}
        placeholder="Search this breakdown"
        type="search"
        bind:value={query}
      >
      <SegmentedControl
        ariaLabel="Sort breakdown"
        defaultValue="value"
        items={sortItems}
        onValueChange={changeSort}
        value={sort}
      />
      <ReportSharingActions {createExport} />
    </div>
  </header>
  <div class={groupRows}>
    {#if visibleRows.length === 0}
      <div class={groupRow} role="status">
        <div class={unavailableText}>{query.trim() ? 'No matching groups' : `No ${countLabel}`}</div>
      </div>
    {:else}
      {#each visibleRows as view (view.group.key)}
        <BreakdownRow onFilter={() => onFilter?.(filterKey, view.group.key)} {view} />
      {/each}
    {/if}
  </div>
</section>
