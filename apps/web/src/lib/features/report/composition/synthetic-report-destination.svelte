<script lang="ts">
  import {
    type FocusedOverviewSessionItem,
    matchesFocusedReportQuery,
    projectFocusedBreakdown,
    projectFocusedOverview,
    projectFocusedSupport,
  } from '@ai-usage/report-core/focused-report-query';
  import { enrichSessionPresentationRow, type SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { QueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import {
    type DashboardSearch,
    primaryDashboardTabFor,
    serializeDashboardTimeCell,
  } from '../../../../dashboard-search';
  import { demoReportPayload } from '../../../../report-data';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import {
    columnVisibilityFromDiff,
    columnVisibilitySearchForVisibility,
    sortFromSortingState,
  } from '../../../../session-table-schema';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import { applyStateUpdate } from '../../../foundation/table/state';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import { createSessionDetailController, type SessionSelectionInput } from '../../sessions/detail/controller';
  import { createSessionDetailQueryOwner } from '../../sessions/detail/query-owner';
  import SessionDetailSlot from '../../sessions/detail/session-detail-slot.svelte';
  import SessionTable from '../../sessions/table/session-table.svelte';
  import ActiveFilters from '../breakdown/active-filters.svelte';
  import DashboardBreakdown from '../breakdown/dashboard-breakdown.svelte';
  import FilterBar from '../breakdown/filter-bar.svelte';
  import { createBreakdownNavigation } from '../breakdown/navigation';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import OverviewPage from '../overview/overview-page.svelte';
  import { reportDestinationForSearch } from './report-search';

  let {
    mode,
    navigate,
    queryClient,
    search,
  }: {
    mode: Extract<RuntimeMode, 'demo' | 'e2e'>;
    navigate: SearchNavigationIntent<DashboardSearch>;
    queryClient: QueryClient;
    search: DashboardSearch;
  } = $props();

  const revision = untrack(() => `synthetic-${mode}`);
  const { rows: serializedRows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;
  const allRows = serializedRows.map(enrichSessionPresentationRow);
  const harnessOptions = [...new Set(allRows.map(({ harness }) => harness))].sort();
  const machineOptions = [
    ...new Map(
      allRows.flatMap((row) =>
        row.source?.machineId
          ? [
              [
                row.source.machineId,
                { label: row.source.machineLabel ?? row.source.machineId, value: row.source.machineId },
              ],
            ]
          : [],
      ),
    ).values(),
  ];
  const support = projectFocusedSupport(
    reportSupport,
    { harness: harnessOptions, machine: machineOptions, truncated: false },
    { revision },
    { providerRows: allRows },
  );
  let dimension = $state<'campaign' | 'harness' | 'machine' | 'model' | 'origin' | 'provider' | 'project'>('harness');
  let granularity = $state<'day' | 'month' | 'week'>('day');
  let timelineValue = $state<'cost' | 'sessions' | 'share'>('cost');
  let detailRows = $state<readonly SessionPresentationRow[]>([]);
  let selectedRowId = $state<string | null>(null);
  let selection = $state<SessionSelectionInput | null>(null);
  const navigation = untrack(() => createBreakdownNavigation(navigate));
  const destination = $derived(
    reportDestinationForSearch(search, reportSupport.generatedAt, { dimension, granularity }),
  );
  const focusedQuery = $derived({
    filters: destination.sessions.filters,
    range: destination.sessions.range,
    revision,
  });
  const overview = $derived(
    projectFocusedOverview(serializedRows, reportSupport, {
      includeAdvanced: true,
      query: focusedQuery,
      timeline: { dimension, granularity },
    }),
  );
  const breakdown = $derived(projectFocusedBreakdown(serializedRows, reportSupport, { query: focusedQuery }));
  const primary = $derived(primaryDashboardTabFor(search.tab));
  const visibleRows = $derived(
    allRows.filter((row) => matchesFocusedReportQuery(row, focusedQuery, reportSupport.timeZone)),
  );
  const columnVisibility = $derived(columnVisibilityFromDiff(search.cols, search.colsBase));
  const sorting = $derived([{ ...search.sort }]);
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('Synthetic session detail transport is unavailable.'));
  const syntheticClient: SessionClientAdapter = {
    campaignChildren: unavailable,
    detail: unavailable,
    neighbors: unavailable,
    page: unavailable,
    vcs: unavailable,
  };
  const detailQuery = untrack(() => createSessionDetailQueryOwner({ client: syntheticClient, queryClient }));
  const detailController = untrack(() =>
    createSessionDetailController({
      onSelectedRowId: (rowId) => {
        selectedRowId = rowId;
        if (rowId === null) {
          selection = null;
        }
      },
      query: detailQuery,
      rows: () => detailRows,
    }),
  );

  const selectOverviewSession = (item: FocusedOverviewSessionItem): void => {
    detailRows = overview.view.topSessions.map((candidate) => candidate.row);
    selection = { row: item.row };
    selectedRowId = item.row.rowId;
  };
  const selectSessionRow = (row: SessionPresentationRow): void => {
    detailRows = visibleRows;
    selection = selectedRowId === row.rowId ? null : { row };
    selectedRowId = selection?.row.rowId ?? null;
  };
</script>

<FilterBar
  freshnessStatus="Synthetic data"
  freshnessUnavailable
  {harnessOptions}
  isDemo={mode === 'demo'}
  machineOptions={machineOptions.map(({ value }) => value)}
  {navigation}
  presentMachineLabel={(value) => machineOptions.find((option) => option.value === value)?.label ?? value}
  {search}
/>
<ActiveFilters
  hidden={Math.max(0, support.support.analytics.sessionCount - overview.summary.sessionCount)}
  {navigation}
  presentMachineLabel={(value) => machineOptions.find((option) => option.value === value)?.label ?? value}
  {search}
  total={support.support.analytics.sessionCount}
  visible={overview.summary.sessionCount}
/>
<ReportWorkspace hasOutput pending={false}>
  {#snippet children()}
    {#if primary === 'overview'}
      <OverviewPage
        {dimension}
        freshness={support.machineFreshness}
        {granularity}
        {navigate}
        onDimensionFilter={navigation.setTimelineDimensionFilter}
        onOptionsChange={(options) => {
          dimension = options.dimension;
          granularity = options.granularity;
          timelineValue = options.value;
        }}
        onRangeChange={navigation.setDateRange}
        onSelectDay={(date) => navigate((current) => ({ ...current, range: { from: date, mode: 'custom', to: date }, tab: 'sessions' }))}
        onSelectSession={selectOverviewSession}
        onSelectTimeCell={(cell) => navigate((current) => ({ ...current, tab: 'sessions', timeCell: serializeDashboardTimeCell(cell) }))}
        providers={[]}
        range={search.range}
        result={overview}
        value={timelineValue}
      />
    {:else if primary === 'breakdown'}
      <DashboardBreakdown
        data={{
          cursorRows: breakdown.context.cursorCommitAttribution,
          generatedAt: reportSupport.generatedAt,
          harnesses: breakdown.groups.harnesses,
          harnessProviders: breakdown.groups.harnessProviders,
          models: breakdown.groups.models,
          projects: breakdown.groups.projects,
        }}
        navigation={{
          onSortChange: navigation.setBreakdownSort,
          onTabChange: (tab) => navigate((current) => ({ ...current, tab: tab as DashboardSearch['tab'] })),
          sort: search.breakdownSort,
          tab: search.tab,
        }}
        onFieldFilter={navigation.setFieldFilter}
        onHarnessFilter={(value) => navigation.setHarness(search.harness.includes(value) ? search.harness.filter((item) => item !== value) : [...search.harness, value])}
        projectEditor={{
          disabled: true,
          onSave: () => Promise.reject(new Error('Synthetic project groups are read-only.')),
          payload: reportSupport,
        }}
      />
    {:else}
      <SessionTable
        {columnVisibility}
        onClearFilters={navigation.clearAllFilters}
        onColumnVisibilityChange={(updater) => {
          const next = applyStateUpdate(updater, columnVisibility);
          navigate((current) => ({ ...current, ...columnVisibilitySearchForVisibility(next) }), { replace: true });
        }}
        onFieldFilter={navigation.setFieldFilter}
        onHarnessFilter={(value) => navigation.setHarness(search.harness.includes(value) ? search.harness.filter((item) => item !== value) : [...search.harness, value])}
        onSelect={selectSessionRow}
        onSortingChange={(updater) => {
          const next = applyStateUpdate(updater, sorting);
          navigate((current) => ({ ...current, sort: sortFromSortingState(next, current.sort) }));
        }}
        queryResetKey={JSON.stringify(destination.sessions)}
        rows={visibleRows}
        searchQuery={search.q}
        {selectedRowId}
        {sorting}
        totalRows={visibleRows.length}
      />
    {/if}
  {/snippet}
</ReportWorkspace>
<SessionDetailSlot
  controller={detailController}
  onFieldFilter={navigation.setFieldFilter}
  rows={detailRows}
  {selection}
/>
