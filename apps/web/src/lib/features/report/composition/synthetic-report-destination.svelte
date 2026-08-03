<script lang="ts">
  import { applyCampaignLabelOverrideMutation, type CampaignLabelOverride } from '@ai-usage/report-core/campaign-label';
  import {
    type FocusedOverviewSessionItem,
    type FocusedTimelineSeries,
    matchesFocusedReportQuery,
    projectFocusedBreakdown,
    projectFocusedOverview,
    projectFocusedSupport,
  } from '@ai-usage/report-core/focused-report-query';
  import { enrichSessionPresentationRow, type SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { QueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';
  import { browser } from '$app/environment';
  import {
    campaignLabelFor,
    focusedCampaignLabelContext,
    indexCampaignLabelOverrides,
    presentCampaignTimelineSeries,
    presentFocusedOverviewSessionItem,
    presentServedCampaignDisplayRow,
  } from '../../../../campaign-label-overrides';
  import { buildCampaignTableRows } from '../../../../dashboard-model';
  import {
    type DashboardSearch,
    primaryDashboardTabFor,
    serializeDashboardTimeCell,
  } from '../../../../dashboard-search';
  import { createFocusedReportE2EFixture } from '../../../../focused-report-e2e-fixture';
  import {
    machineFreshnessSnapshotFromFocused,
    machineFreshnessStatusLabel,
    machineLabelPresentationForSnapshot,
  } from '../../../../machine-freshness-presentation';
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
  import CampaignLabelEditor from '../actions/campaign-label-editor.svelte';
  import type { CampaignLabelEditorState } from '../actions/campaign-label-editor-state';
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

  const runtimeMode = untrack(() => mode);
  const revision = untrack(() => `synthetic-${runtimeMode}`);
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
  const derivedCampaignLabels = new Map(
    buildCampaignTableRows(allRows, allRows, [{ desc: true, id: 'date' }]).flatMap((row) =>
      row.campaignKey ? ([[row.campaignKey, row.sessionLabel]] as const) : [],
    ),
  );
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
  const syntheticMachineFreshness = {
    kind: 'available',
    machines: [{ id: 'fixture-machine', label: 'Fixture Machine', lastSeenAt: reportSupport.generatedAt }],
    observedAt: '2026-07-12T12:00:00.000Z',
    omittedMachines: 0,
    skippedRows: 0,
  } as const;
  const focusedMachineFreshness = runtimeMode === 'e2e' ? syntheticMachineFreshness : support.machineFreshness;
  const machineSnapshot = machineFreshnessSnapshotFromFocused(focusedMachineFreshness);
  const machineFreshnessStatus = runtimeMode === 'e2e' ? machineFreshnessStatusLabel(machineSnapshot) : null;
  const machinePresentations = new Map(
    machineOptions.map(({ label, value }) => [
      value,
      machineLabelPresentationForSnapshot({ id: value, label }, machineSnapshot),
    ]),
  );
  const providers = buildProviderStatusViews(reportSupport, allRows, reportSupport.generatedAt);
  let dimension = $state<'campaign' | 'harness' | 'machine' | 'model' | 'origin' | 'provider' | 'project'>('harness');
  let granularity = $state<'day' | 'month' | 'week'>('day');
  let timelineValue = $state<'cost' | 'sessions' | 'share'>('cost');
  let detailRows = $state<readonly SessionPresentationRow[]>([]);
  let selectedRowId = $state<string | null>(null);
  let selection = $state<SessionSelectionInput | null>(null);
  let quotaHistoryOpen = $state(false);
  let campaignLabelOverrides = $state<readonly CampaignLabelOverride[]>([]);
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
  const presentCampaignRow = (
    row: SessionPresentationRow,
    index: ReadonlyMap<string, string>,
  ): SessionPresentationRow => {
    const campaignKey = row.campaignKey;
    if (!campaignKey) {
      return row;
    }
    const derivedLabel = derivedCampaignLabels.get(campaignKey) ?? row.sessionLabel;
    return presentServedCampaignDisplayRow({ ...row, sessionLabel: derivedLabel }, index);
  };
  const campaignIndex = $derived(indexCampaignLabelOverrides(campaignLabelOverrides));
  const columnVisibility = $derived(columnVisibilityFromDiff(renderedSearch.cols, renderedSearch.colsBase));
  const sorting = $derived([{ ...renderedSearch.sort }]);
  const tableRows = $derived(
    buildCampaignTableRows(allRows, visibleRows, sorting).map((row) => presentCampaignRow(row, campaignIndex)),
  );
  const sessionResetKey = $derived(
    JSON.stringify({
      filters: destination.sessions.filters,
      range: destination.sessions.range,
    }),
  );
  const activeSeriesKeys = $derived(activeTimelineSeriesKeys(renderedSearch, dimension));
  const selectedCampaignEditor = $derived.by((): CampaignLabelEditorState | undefined => {
    const row = selection?.row;
    const campaignKey = row?.campaignKey;
    if (!campaignKey) {
      return;
    }
    const derivedLabel = derivedCampaignLabels.get(campaignKey) ?? row.sessionLabel;
    const mutate = (label: string | null): Promise<string> => {
      const nextOverrides = applyCampaignLabelOverrideMutation(campaignLabelOverrides, { campaignKey, label });
      const nextIndex = indexCampaignLabelOverrides(nextOverrides);
      campaignLabelOverrides = nextOverrides;
      republishSelectedCampaign(campaignKey, nextIndex);
      return Promise.resolve(campaignLabelFor(nextIndex, campaignKey, derivedLabel));
    };
    return {
      campaignKey,
      effectiveLabel: campaignLabelFor(campaignIndex, campaignKey, derivedLabel),
      hasOverride: campaignIndex.has(campaignKey),
      loadError: null,
      loadStatus: 'ready',
      mutationError: null,
      mutationStatus: 'idle',
      onRename: async (label) => await mutate(label),
      onReset: async () => await mutate(null),
      onRetry: async () => true,
    };
  });
  const presentMachineLabel = (value: string): string =>
    (runtimeMode === 'e2e' ? machinePresentations.get(value)?.label : undefined) ??
    machineOptions.find((option) => option.value === value)?.label ??
    value;
  const presentMachineSeries = (key: string, label: string) =>
    runtimeMode === 'e2e'
      ? machineLabelPresentationForSnapshot({ id: key, label }, machineSnapshot)
      : { freshness: 'unavailable' as const, label };
  const presentCampaignSeries = (series: FocusedTimelineSeries): FocusedTimelineSeries =>
    presentCampaignTimelineSeries(series, campaignIndex);
  const presentSessionItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem =>
    presentFocusedOverviewSessionItem(item, (campaignKey, derivedLabel) =>
      campaignLabelFor(campaignIndex, campaignKey, derivedLabel),
    );
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
  const republishSelectedCampaign = (campaignKey: string, index: ReadonlyMap<string, string>): void => {
    const activeSelection = selection;
    if (!(activeSelection && activeSelection.row.campaignKey === campaignKey)) {
      return;
    }
    const row = presentCampaignRow(activeSelection.row, index);
    const nextSelection = { ...activeSelection, row };
    detailRows = detailRows.map((candidate) =>
      candidate.rowId === row.rowId ? row : presentCampaignRow(candidate, index),
    );
    selection = nextSelection;
    // SessionDetailSlot deduplicates equal identities, so use the
    // controller's safe same-identity presentation republish seam.
    detailController.select(nextSelection);
  };

  const selectOverviewSession = (item: FocusedOverviewSessionItem): void => {
    const presented = presentSessionItem(item);
    const campaignContext = focusedCampaignLabelContext(presented);
    const presentedRow = campaignContext
      ? { ...presented.row, campaignKey: campaignContext.campaignKey, sessionLabel: presented.label }
      : presented.row;
    detailRows = visibleRows;
    selection = { row: presentedRow };
    selectedRowId = presentedRow.rowId;
  };
  const selectSessionRow = (row: SessionPresentationRow): void => {
    detailRows = tableRows;
    selection = selectedRowId === row.rowId ? null : { row };
    selectedRowId = selection?.row.rowId ?? null;
  };
</script>
{#snippet campaignSlot()}
  {#if selectedCampaignEditor}
    <CampaignLabelEditor editor={selectedCampaignEditor} />
  {/if}
{/snippet}

<FilterBar
  freshnessStatus={runtimeMode === 'demo' ? 'Synthetic data' : machineFreshnessStatus}
  freshnessUnavailable={machineSnapshot.kind === 'unavailable'}
  {harnessOptions}
  isDemo={mode === 'demo'}
  machineAttention={runtimeMode === 'e2e' && machineOptions.some(({ value }) => machinePresentations.get(value)?.freshness !== 'fresh')}
  machineOptions={machineOptions.map(({ value }) => value)}
  {navigation}
  {presentMachineLabel}
  {search}
/>
<ActiveFilters
  hidden={Math.max(0, support.support.analytics.sessionCount - overview.summary.sessionCount)}
  {navigation}
  {pending}
  {presentMachineLabel}
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
    {machineFreshnessStatus}
    {navigate}
    onDimensionFilter={navigation.setTimelineDimensionFilter}
    onOptionsChange={(options) => {
      dimension = options.dimension;
      granularity = options.granularity;
      timelineValue = options.value;
    }}
    onRangeChange={navigation.setDateRange}
    {presentCampaignSeries}
    {presentMachineSeries}
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
        freshness={focusedMachineFreshness}
        {granularity}
        {machineFreshnessStatus}
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
        onSelectTimeCell={(cell) => navigate((current) => ({ ...current, timeCell: serializeDashboardTimeCell(cell) }))}
        {...(mode === 'e2e' ? { onOpenQuotaHistory: () => (quotaHistoryOpen = true) } : {})}
        {presentCampaignSeries}
        {presentMachineSeries}
        {presentSessionItem}
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
  {campaignSlot}
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
