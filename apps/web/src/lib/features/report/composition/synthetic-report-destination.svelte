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
  import { onDestroy, untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { buildCampaignTableRows } from '../../../../dashboard-model';
  import {
    type DashboardSearch,
    primaryDashboardTabFor,
    serializeDashboardTimeCell,
  } from '../../../../dashboard-search';
  import { createFocusedReportE2EFixture } from '../../../../focused-report-e2e-fixture';
  import { buildProviderStatusViews } from '../../../../provider-status-model';
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
  import QuotaHistoryOwner from '../actions/quota-history-owner.svelte';
  import ActiveFilters from '../breakdown/active-filters.svelte';
  import FilterBar from '../breakdown/filter-bar.svelte';
  import { createBreakdownNavigation } from '../breakdown/navigation';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import OverviewPage from '../overview/overview-page.svelte';
  import ReportRangeControl from '../range/report-range-control.svelte';
  import { activeTimelineSeriesKeys } from './active-timeline-series';
  import { reportDestinationForSearch } from './report-search';

  type DashboardBreakdownModule = typeof import('../breakdown/dashboard-breakdown.svelte');
  type SessionTableModule = typeof import('../../sessions/table/session-table.svelte');

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
  const responseFixture = untrack(() => (browser && mode === 'e2e' ? createFocusedReportE2EFixture() : undefined));
  let renderedSearch = $state<DashboardSearch>(untrack(() => search));
  let renderedSearchKey = JSON.stringify(untrack(() => search));
  let pending = $state(false);
  let dashboardBreakdownModule = $state<DashboardBreakdownModule>();
  let dashboardBreakdownLoadFailed = $state(false);
  let dashboardBreakdownLoad: Promise<void> | undefined;
  let sessionTableModule = $state<SessionTableModule>();
  let sessionTableLoadFailed = $state(false);
  let sessionTableLoad: Promise<void> | undefined;
  let responseGeneration = 0;
  $effect(() => {
    const requestedSearch = search;
    const requestedKey = JSON.stringify(requestedSearch);
    if (!responseFixture) {
      renderedSearch = requestedSearch;
      renderedSearchKey = requestedKey;
      return;
    }
    if (requestedKey === renderedSearchKey) {
      return;
    }
    const generation = ++responseGeneration;
    pending = true;
    responseFixture.waitForResponse().then(() => {
      if (generation !== responseGeneration) {
        return;
      }
      renderedSearch = requestedSearch;
      renderedSearchKey = requestedKey;
      pending = false;
    });
  });
  onDestroy(() => {
    responseGeneration += 1;
  });
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
  const providers = buildProviderStatusViews(reportSupport, allRows, reportSupport.generatedAt);
  let dimension = $state<'campaign' | 'harness' | 'machine' | 'model' | 'origin' | 'provider' | 'project'>('harness');
  let granularity = $state<'day' | 'month' | 'week'>('day');
  let timelineValue = $state<'cost' | 'sessions' | 'share'>('cost');
  let detailRows = $state<readonly SessionPresentationRow[]>([]);
  let selectedRowId = $state<string | null>(null);
  let selection = $state<SessionSelectionInput | null>(null);
  let quotaHistoryOpen = $state(false);
  const navigation = createBreakdownNavigation((update, options) => navigate(update, options));
  const destination = $derived(
    reportDestinationForSearch(renderedSearch, reportSupport.generatedAt, { dimension, granularity }),
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
  const primary = $derived(primaryDashboardTabFor(renderedSearch.tab));
  $effect(() => {
    if (primary === 'breakdown' && !dashboardBreakdownModule) {
      dashboardBreakdownLoad ??= import('../breakdown/dashboard-breakdown.svelte')
        .then((module) => {
          dashboardBreakdownModule = module;
        })
        .catch(() => {
          dashboardBreakdownLoadFailed = true;
        });
    } else if (primary === 'sessions' && !sessionTableModule) {
      sessionTableLoad ??= import('../../sessions/table/session-table.svelte')
        .then((module) => {
          sessionTableModule = module;
        })
        .catch(() => {
          sessionTableLoadFailed = true;
        });
    }
  });
  const visibleRows = $derived(
    allRows.filter((row) => matchesFocusedReportQuery(row, focusedQuery, reportSupport.timeZone)),
  );
  const columnVisibility = $derived(columnVisibilityFromDiff(renderedSearch.cols, renderedSearch.colsBase));
  const sorting = $derived([{ ...renderedSearch.sort }]);
  const tableRows = $derived(buildCampaignTableRows(allRows, visibleRows, sorting));
  const sessionResetKey = $derived(
    JSON.stringify({
      filters: destination.sessions.filters,
      range: destination.sessions.range,
    }),
  );
  const activeSeriesKeys = $derived(activeTimelineSeriesKeys(renderedSearch, dimension));
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
    detailRows = visibleRows;
    selection = { row: item.row };
    selectedRowId = item.row.rowId;
  };
  const selectSessionRow = (row: SessionPresentationRow): void => {
    detailRows = tableRows;
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
  {pending}
  presentMachineLabel={(value) => machineOptions.find((option) => option.value === value)?.label ?? value}
  {search}
  total={support.support.analytics.sessionCount}
  visible={overview.summary.sessionCount}
/>
{#if primary !== 'overview'}
  <ReportRangeControl
    {activeSeriesKeys}
    dateDomain={overview.dateDomain}
    {dimension}
    generatedAt={reportSupport.generatedAt}
    {granularity}
    {navigate}
    onDimensionFilter={navigation.setTimelineDimensionFilter}
    onOptionsChange={(options) => {
      dimension = options.dimension;
      granularity = options.granularity;
      timelineValue = options.value;
    }}
    onRangeChange={navigation.setDateRange}
    range={renderedSearch.range}
    timeline={overview.timeline}
    value={timelineValue}
  />
{/if}
<ReportWorkspace hasOutput={!pending} {pending}>
  {#snippet children()}
    {#if primary === 'overview'}
      <OverviewPage
        {activeSeriesKeys}
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
        {...(mode === 'e2e' ? { onOpenQuotaHistory: () => (quotaHistoryOpen = true) } : {})}
        providers={mode === 'e2e' ? providers : []}
        range={renderedSearch.range}
        result={overview}
        value={timelineValue}
      />
    {:else if primary === 'breakdown' && dashboardBreakdownModule}
      {@const DashboardBreakdown = dashboardBreakdownModule.default}
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
          sort: renderedSearch.breakdownSort,
          tab: renderedSearch.tab,
        }}
        onFieldFilter={navigation.setFieldFilter}
        onHarnessFilter={(value) => navigation.setHarness(renderedSearch.harness.includes(value) ? renderedSearch.harness.filter((item) => item !== value) : [...renderedSearch.harness, value])}
        projectEditor={{
          disabled: true,
          onSave: () => Promise.reject(new Error('Synthetic project groups are read-only.')),
          payload: reportSupport,
        }}
      />
    {:else if primary === 'sessions' && sessionTableModule}
      {@const SessionTable = sessionTableModule.default}
      <SessionTable
        {columnVisibility}
        onClearFilters={navigation.clearAllFilters}
        onColumnVisibilityChange={(updater) => {
          const next = applyStateUpdate(updater, columnVisibility);
          navigate((current) => ({ ...current, ...columnVisibilitySearchForVisibility(next) }), { replace: true });
        }}
        onFieldFilter={navigation.setFieldFilter}
        onHarnessFilter={(value) => navigation.setHarness(renderedSearch.harness.includes(value) ? renderedSearch.harness.filter((item) => item !== value) : [...renderedSearch.harness, value])}
        onSelect={selectSessionRow}
        onSortingChange={(updater) => {
          const next = applyStateUpdate(updater, sorting);
          navigate((current) => ({ ...current, sort: sortFromSortingState(next, current.sort) }));
        }}
        queryResetKey={sessionResetKey}
        rows={tableRows}
        searchQuery={renderedSearch.q}
        {selectedRowId}
        {sorting}
        totalRows={visibleRows.length}
      />
    {:else if dashboardBreakdownLoadFailed || sessionTableLoadFailed}
      <p role="status">Report view is temporarily unavailable.</p>
    {:else}
      <p aria-live="polite" role="status">Loading report…</p>
    {/if}
  {/snippet}
</ReportWorkspace>
<SessionDetailSlot
  controller={detailController}
  onFieldFilter={navigation.setFieldFilter}
  rows={detailRows}
  {selection}
/>
{#if mode === 'e2e'}
  <QuotaHistoryOwner
    generation={revision}
    onClose={() => (quotaHistoryOpen = false)}
    open={quotaHistoryOpen}
    runtimeMode={mode}
  />
{/if}
