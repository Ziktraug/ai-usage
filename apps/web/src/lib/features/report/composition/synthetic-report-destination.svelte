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
  import {
    enrichSessionPresentationRow,
    type SessionPresentationRow,
    sessionQueryFingerprint,
  } from '@ai-usage/report-core/session-query';
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
  import { buildCampaignTableRows, buildCampaignViews } from '../../../../dashboard-model';
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
  import type { TimelineValue } from '../../../../overview-model';
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
  import SessionDetailQuerySlot from '../../sessions/detail/session-detail-query-slot.svelte';
  import type { SessionSelectionInput } from '../../sessions/detail/types';
  import { useSessionWindowAnchorOwner } from '../../shell/session-window-anchor-context';
  import CampaignLabelEditor from '../actions/campaign-label-editor.svelte';
  import type { CampaignLabelEditorState } from '../actions/campaign-label-editor-state';
  import CampaignSessionControls from '../actions/campaign-session-controls.svelte';
  import QuotaHistoryOwner from '../actions/quota-history-owner.svelte';
  import ActiveFilters from '../breakdown/active-filters.svelte';
  import { createBreakdownNavigation } from '../breakdown/navigation';
  import { activeTimelineSeriesKeys } from './active-timeline-series';
  import { importReportLazyModule } from './lazy-module-e2e-fixture';
  import { createLazyModuleLoader } from './lazy-module-loader';
  import ReportDestinationPresentation from './report-destination-presentation.svelte';
  import { reportDestinationForSearch } from './report-search';

  import SessionIdentityPublisher from './session-identity-publisher.svelte';

  type DashboardBreakdownModule = typeof import('../breakdown/dashboard-breakdown.svelte');
  type SessionTableModule = typeof import('../../sessions/table/session-table.svelte');

  let {
    mode,
    modelsHref,
    navigate,
    queryClient,
    search,
  }: {
    mode: Extract<RuntimeMode, 'demo' | 'e2e'>;
    modelsHref: string;
    navigate: SearchNavigationIntent<DashboardSearch>;
    queryClient: QueryClient;
    search: DashboardSearch;
  } = $props();

  const sessionWindowAnchorOwner = useSessionWindowAnchorOwner();
  const runtimeMode = untrack(() => mode);
  const revision = untrack(() => `synthetic-${runtimeMode}`);
  const responseFixture = untrack(() => (browser && mode === 'e2e' ? createFocusedReportE2EFixture() : undefined));
  let renderedSearch = $state<DashboardSearch>(untrack(() => search));
  let renderedSearchKey = JSON.stringify(untrack(() => search));
  let pending = $state(false);
  let dashboardBreakdownModule = $state<DashboardBreakdownModule>();
  let dashboardBreakdownLoadFailed = $state(false);
  let sessionTableModule = $state<SessionTableModule>();
  let sessionTableLoadFailed = $state(false);
  const dashboardBreakdownLoader = createLazyModuleLoader({
    importModule: () =>
      importReportLazyModule({
        enabled: runtimeMode === 'e2e',
        importModule: () => import('../breakdown/dashboard-breakdown.svelte'),
        target: 'breakdown',
      }),
    onFailureChange: (failed) => (dashboardBreakdownLoadFailed = failed),
    onLoaded: (module) => (dashboardBreakdownModule = module),
  });
  const sessionTableLoader = createLazyModuleLoader({
    importModule: () =>
      importReportLazyModule({
        enabled: runtimeMode === 'e2e',
        importModule: () => import('../../sessions/table/session-table.svelte'),
        target: 'sessions',
      }),
    onFailureChange: (failed) => (sessionTableLoadFailed = failed),
    onLoaded: (module) => (sessionTableModule = module),
  });
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
  // Once the rendered payload describes the committed range, the local preview has nothing left to
  // add, so it retires here rather than on pointerup — the same contract as the live destination.
  let previewRetiredForRangeKey = '';
  $effect(() => {
    const committedRangeKey = JSON.stringify(renderedSearch.range);
    if (committedRangeKey === previewRetiredForRangeKey) {
      return;
    }
    previewRetiredForRangeKey = committedRangeKey;
    draggedWindowApiValue = null;
  });
  onDestroy(() => {
    responseGeneration += 1;
  });
  const { rows: demoSerializedRows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;
  const serializedRows = responseFixture?.overviewRows ?? demoSerializedRows;
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
  const totalSessionCount =
    responseFixture?.bootstrap.support.analytics.sessionCount ?? support.support.analytics.sessionCount;
  const syntheticMachineFreshness = {
    kind: 'available',
    machines: [{ id: 'fixture-machine', label: 'Fixture Machine', lastSeenAt: reportSupport.generatedAt }],
    observedAt: '2026-07-12T12:00:00.000Z',
    omittedMachines: 0,
    skippedRows: 0,
  } as const;
  const focusedMachineFreshness = runtimeMode === 'e2e' ? syntheticMachineFreshness : support.machineFreshness;
  const machineSnapshot = machineFreshnessSnapshotFromFocused(focusedMachineFreshness);
  const supportMachineSnapshot = machineFreshnessSnapshotFromFocused(support.machineFreshness);
  const machineFreshnessStatus = runtimeMode === 'e2e' ? machineFreshnessStatusLabel(machineSnapshot) : null;
  const displayedFreshnessStatus = $derived.by(() => {
    if (runtimeMode === 'demo') {
      return 'Synthetic data';
    }
    return responseFixture ? machineFreshnessStatusLabel(supportMachineSnapshot) : machineFreshnessStatus;
  });
  const displayedFreshnessUnavailable = $derived(
    responseFixture ? supportMachineSnapshot.kind === 'unavailable' : machineSnapshot.kind === 'unavailable',
  );
  const machinePresentations = new Map(
    machineOptions.map(({ label, value }) => [
      value,
      machineLabelPresentationForSnapshot({ id: value, label }, machineSnapshot),
    ]),
  );
  const providers = buildProviderStatusViews(reportSupport, allRows, reportSupport.generatedAt);
  let dimension = $state<'campaign' | 'harness' | 'machine' | 'model' | 'origin' | 'provider' | 'project'>('harness');
  let granularity = $state<'day' | 'month' | 'week'>('day');
  let timelineValue = $state<TimelineValue>('cost');
  // Headline value of the window under the pointer, so the hero keeps tracking the brush now that a
  // gesture only commits on release. This payload recomputes in memory, so the committed range
  // itself is the signal to retire the preview.
  let draggedWindowApiValue = $state<number | null>(null);
  let detailRows = $state<readonly SessionPresentationRow[]>([]);
  let selectedRowId = $state<string | null>(null);
  let selection = $state<SessionSelectionInput | null>(null);
  let sessionDrawerClosing = false;
  let quotaHistoryOpen = $state(false);
  let campaignLabelOverrides = $state<readonly CampaignLabelOverride[]>([]);
  const navigation = createBreakdownNavigation((update, options) => navigate(update, options));
  const destination = $derived(
    reportDestinationForSearch(renderedSearch, reportSupport.generatedAt, { dimension, granularity }),
  );
  const syntheticSessionQuery = $derived({ ...destination.sessions, cursor: null, revision });
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
      dashboardBreakdownLoader.start();
    } else if (primary === 'sessions' && !sessionTableModule) {
      sessionTableLoader.start();
    }
  });
  const retryReportDestination = async (): Promise<void> => {
    if (primary === 'breakdown' && dashboardBreakdownLoadFailed) {
      await dashboardBreakdownLoader.retry();
      return;
    }
    if (primary === 'sessions' && sessionTableLoadFailed) {
      await sessionTableLoader.retry();
    }
  };
  const activeDestinationLoadFailed = $derived(
    (primary === 'breakdown' && dashboardBreakdownLoadFailed) || (primary === 'sessions' && sessionTableLoadFailed),
  );
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
  const selectedCampaignView = $derived.by(() => {
    const campaignKey = selection?.row.campaignKey;
    if (!campaignKey) {
      return;
    }
    return buildCampaignViews(allRows, visibleRows).find((campaign) => campaign.campaignKey === campaignKey);
  });
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
  const republishSelectedCampaign = (campaignKey: string, index: ReadonlyMap<string, string>): void => {
    if (sessionDrawerClosing) {
      return;
    }
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
  };

  const selectOverviewSession = (item: FocusedOverviewSessionItem): void => {
    if (sessionDrawerClosing) {
      return;
    }
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
    if (sessionDrawerClosing) {
      return;
    }
    detailRows = tableRows;
    selection = selectedRowId === row.rowId ? null : { row };
    selectedRowId = selection?.row.rowId ?? null;
  };
</script>
{#snippet campaignSlot()}
  {#if selectedCampaignEditor}
    <CampaignLabelEditor editor={selectedCampaignEditor} />
  {/if}
  {#if selectedCampaignView && selection?.row}
    <CampaignSessionControls
      campaign={selection.row}
      collection={{
        items: selectedCampaignView.allRows,
        loading: false,
        nextCursor: null,
        totalCount: selectedCampaignView.totalCount,
      }}
      onClearCampaignFilter={(campaignKey) => {
        if (renderedSearch.filters.campaign === campaignKey) {
          navigation.clearFieldFilter('campaign');
        }
      }}
      onLoadMoreCampaignSessions={() => undefined}
      onSelectSession={selectSessionRow}
      query={syntheticSessionQuery}
      visibleRows={selectedCampaignView.visibleRows}
    />
  {/if}
{/snippet}
{#snippet activeFilterSummary(_filterPending: boolean)}
  <ActiveFilters
    hidden={Math.max(0, totalSessionCount - overview.summary.sessionCount)}
    {navigation}
    pending={_filterPending}
    {presentMachineLabel}
    {search}
    total={totalSessionCount}
    visible={overview.summary.sessionCount}
  />
{/snippet}

{#snippet summary()}
  {@render activeFilterSummary(pending)}
{/snippet}
{#snippet sessions()}
  {#if sessionTableModule}
    {@const SessionTable = sessionTableModule.default}
    <SessionIdentityPublisher
      requestFingerprint={sessionQueryFingerprint(syntheticSessionQuery)}
      revision={syntheticSessionQuery.revision}
    />
    <SessionTable
      {columnVisibility}
      initialWindowAnchor={sessionWindowAnchorOwner.available()}
      onClearFilters={navigation.clearAllFilters}
      onColumnVisibilityChange={(updater) => {
        const next = applyStateUpdate(updater, columnVisibility);
        navigate((current) => ({ ...current, ...columnVisibilitySearchForVisibility(next) }), { replace: true });
      }}
      onFieldFilter={navigation.setFieldFilter}
      onHarnessFilter={(value) =>
        navigation.setHarness(
          renderedSearch.harness.includes(value)
            ? renderedSearch.harness.filter((item) => item !== value)
            : [...renderedSearch.harness, value],
        )}
      onInitialWindowAnchor={sessionWindowAnchorOwner.consume}
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
  {/if}
{/snippet}
{#snippet breakdownDestination()}
  {#if dashboardBreakdownModule}
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
        onTabChange: (tab) => navigate((current) => ({ ...current, tab })),
        sort: renderedSearch.breakdownSort,
        tab: renderedSearch.tab,
      }}
      onFieldFilter={navigation.setFieldFilter}
      onHarnessFilter={(value) =>
        navigation.setHarness(
          renderedSearch.harness.includes(value)
            ? renderedSearch.harness.filter((item) => item !== value)
            : [...renderedSearch.harness, value],
        )}
      projectEditor={{
        disabled: true,
        onSave: () => Promise.reject(new Error('Synthetic project groups are read-only.')),
        payload: reportSupport,
      }}
    />
  {/if}
{/snippet}
<ReportDestinationPresentation
  activeView={primary}
  breakdown={breakdownDestination}
  breakdownReady={dashboardBreakdownModule !== undefined}
  filters={{
    freshnessStatus: displayedFreshnessStatus,
    freshnessUnavailable: displayedFreshnessUnavailable,
    harnessOptions,
    isDemo: mode === 'demo',
    machineAttention:
      runtimeMode === 'e2e' &&
      machineOptions.some(({ value }) => machinePresentations.get(value)?.freshness !== 'fresh'),
    machineOptions: machineOptions.map(({ value }) => value),
    navigation,
    presentMachineLabel,
    search,
  }}
  hasOutput={true}
  loadFailed={activeDestinationLoadFailed}
  onRetry={retryReportDestination}
  overview={primary === 'overview'
    ? {
        activity: {
          activeSeriesKeys,
          dateDomain: overview.dateDomain,
          dimension,
          generatedAt: reportSupport.generatedAt,
          granularity,
          machineFreshnessStatus,
          navigate,
          onDimensionFilter: navigation.setTimelineDimensionFilter,
          onOptionsChange: (options) => {
            dimension = options.dimension;
            granularity = options.granularity;
            timelineValue = options.value;
          },
          onRangeChange: navigation.setDateRange,
          onWindowPreview: (apiValue) => (draggedWindowApiValue = apiValue),
          presentCampaignSeries,
          presentMachineSeries,
          range: renderedSearch.range,
          revision: overview.revision,
          timeline: overview.timeline,
          value: timelineValue,
        },
        draggedWindowApiValue,
        modelsHref,
        onClearFilters: navigation.clearAllFilters,
        onOpenModels: () => navigation.setBreakdownTab('models'),
        ...(mode === 'e2e' ? { onOpenQuotaHistory: () => (quotaHistoryOpen = true) } : {}),
        onSelectDay: (date) =>
          navigate((current) => ({
            ...current,
            range: { from: date, mode: 'custom', to: date },
            tab: 'sessions',
          })),
        onSelectSession: selectOverviewSession,
        onSelectTimeCell: (cell) =>
          navigate((current) => ({ ...current, timeCell: serializeDashboardTimeCell(cell) })),
        presentSessionItem,
        providers: mode === 'e2e' ? providers : [],
        range: renderedSearch.range,
        result: overview,
        totalSessionCount,
      }
    : null}
  {pending}
  range={{
    hidden: false,
    props: {
      dateDomain: overview.dateDomain,
      generatedAt: reportSupport.generatedAt,
      navigate,
      onRangeChange: navigation.setDateRange,
      range: renderedSearch.range,
    },
  }}
  {sessions}
  sessionsReady={sessionTableModule !== undefined}
  {summary}
/>
<SessionDetailQuerySlot
  {campaignSlot}
  client={syntheticClient}
  onClosingChange={(closing) => (sessionDrawerClosing = closing)}
  onFieldFilter={navigation.setFieldFilter}
  onSelectionChange={(nextSelection) => {
    if (sessionDrawerClosing && nextSelection !== null) {
      return;
    }
    selection = nextSelection;
    selectedRowId = nextSelection?.row.rowId ?? null;
  }}
  {queryClient}
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
