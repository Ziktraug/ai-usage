<script lang="ts">
  import type { FocusedOverviewSessionItem, FocusedTimelineSeries } from '@ai-usage/report-core/focused-report-query';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
  import type { LocalTimeCell, SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import type { QueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';
  import {
    campaignLabelFor,
    indexCampaignLabelOverrides,
    presentCampaignTimelineSeries,
    presentFocusedOverviewSessionItem,
    presentServedCampaignDisplayRow,
  } from '../../../../campaign-label-overrides';
  import {
    type DashboardSearch,
    primaryDashboardTabFor,
    serializeDashboardTimeCell,
  } from '../../../../dashboard-search';
  import {
    machineFreshnessSnapshotFromFocused,
    machineFreshnessStatusLabel,
    machineLabelPresentationForSnapshot,
  } from '../../../../machine-freshness-presentation';
  import type { MigrationGranularity, TimelineDimension, TimelineValue } from '../../../../overview-model';
  import { buildProjectGroupReferenceCommand } from '../../../../project-group-control';
  import { buildProviderStatusViews } from '../../../../provider-status-model';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import { sessionAnalysisTargetForSession } from '../../../../session-analysis-target';
  import type { WebReportPayloadWithoutRows } from '../../../../web-report-payload';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import { reportBreakdownQueryOptions } from '../../../query/options/report';
  import type { ReportClient } from '../../../rpc/report-client';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import { createSessionDetailController, type SessionSelectionInput } from '../../sessions/detail/controller';
  import { createSessionDetailQueryOwner } from '../../sessions/detail/query-owner';
  import SessionDetailSlot from '../../sessions/detail/session-detail-slot.svelte';
  import CampaignLabelEditor from '../actions/campaign-label-editor.svelte';
  import CampaignSessionControls from '../actions/campaign-session-controls.svelte';
  import {
    type CampaignSessionControlsBinding,
    campaignFilterMatchesBinding,
    campaignSessionSelectionFor,
  } from '../actions/campaign-session-controls-binding';
  import { projectGroupsAfterWarningCleanup, saveProjectGroupsAtRevision } from '../actions/project';
  import QuotaHistoryOwner from '../actions/quota-history-owner.svelte';
  import ActiveFilters from '../breakdown/active-filters.svelte';
  import DashboardBreakdown from '../breakdown/dashboard-breakdown.svelte';
  import FilterBar from '../breakdown/filter-bar.svelte';
  import { createBreakdownNavigation } from '../breakdown/navigation';
  import ReportWarnings from '../core/report-warnings.svelte';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import ReportLifecycleOwner from '../lifecycle/report-lifecycle-owner.svelte';
  import OverviewPage from '../overview/overview-page.svelte';
  import { activeTimelineSeriesKeys } from './active-timeline-series';
  import { createCampaignLabelOwner } from './campaign-label-owner.svelte';
  import FocusedDestinationRefresh from './focused-destination-refresh.svelte';
  import {
    createFocusedReportDescriptorSource,
    createFocusedReportSession,
    type FocusedReportCommit,
    initialFocusedReportDescriptor,
    requireFocusedBreakdown,
  } from './report-destination';
  import { queryForDescriptor, reportDestinationForSearch } from './report-search';
  import SessionsDestination from './sessions-destination.svelte';

  let {
    bootstrapResult,
    navigate,
    queryClient,
    reportClient,
    runtimeMode,
    search,
    sessionClient,
    omittedSupportItemCount,
    warnings,
  }: {
    bootstrapResult: Extract<ReportRevisionBootstrapResult, { readonly ok: true }>;
    navigate: SearchNavigationIntent<DashboardSearch>;
    queryClient: QueryClient;
    reportClient: ReportClient;
    runtimeMode: RuntimeMode;
    search: DashboardSearch;
    sessionClient: SessionClientAdapter;
    omittedSupportItemCount: number;
    warnings: readonly UsageReportWarning[];
  } = $props();

  let dimension = $state<TimelineDimension>('harness');
  let granularity = $state<MigrationGranularity>('day');
  let timelineValue = $state<TimelineValue>('cost');
  let commit = $state<FocusedReportCommit>();
  let detailRows = $state<readonly SessionPresentationRow[]>([]);
  let selectedRowId = $state<string | null>(null);
  let selection = $state<SessionSelectionInput | null>(null);
  let quotaHistoryOpen = $state(false);
  let servedSessionCount = $state<number>();
  let cleaningProjectWarningGroupId = $state<string>();
  let projectWarningCleanupError = $state<string>();
  let campaignSessionControls = $state<CampaignSessionControlsBinding | null>(null);
  const initialDescriptor = untrack(() => initialFocusedReportDescriptor(bootstrapResult));
  const descriptorSource = untrack(() =>
    createFocusedReportDescriptorSource({ client: reportClient, initial: initialDescriptor, queryClient }),
  );
  const focusedSession = untrack(() =>
    createFocusedReportSession({
      acquire: descriptorSource.acquire,
      client: reportClient,
      onCommit: (nextCommit) => {
        commit = nextCommit;
      },
      queryClient,
    }),
  );
  const campaignLabels = untrack(() => createCampaignLabelOwner(reportClient));
  const detailQuery = untrack(() => createSessionDetailQueryOwner({ client: sessionClient, queryClient }));
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
  const navigation = untrack(() => createBreakdownNavigation(navigate));
  const timeline = $derived({ dimension, granularity });
  const destination = $derived(
    reportDestinationForSearch(search, bootstrapResult.bootstrap.support.generatedAt, timeline),
  );
  const primary = $derived(primaryDashboardTabFor(search.tab));
  const bootstrap = $derived(commit?.descriptor.bootstrap ?? initialDescriptor.bootstrap);
  const machineSnapshot = $derived(machineFreshnessSnapshotFromFocused(bootstrap.machineFreshness));
  const machinePresentations = $derived(
    new Map(
      bootstrap.filterOptions.machine.map(({ label, value }) => [
        value,
        machineLabelPresentationForSnapshot({ id: value, label }, machineSnapshot),
      ]),
    ),
  );
  const campaignIndex = $derived(indexCampaignLabelOverrides(campaignLabels.snapshot.overrides));
  const providers = $derived(
    buildProviderStatusViews(bootstrap.support, bootstrap.providerRows, bootstrap.support.generatedAt),
  );
  const totalSessions = $derived(bootstrap.support.analytics.sessionCount);
  const visibleSessions = $derived(
    primary === 'sessions'
      ? (servedSessionCount ?? totalSessions)
      : (commit?.overview.summary.sessionCount ?? totalSessions),
  );
  const activeSeriesKeys = $derived(activeTimelineSeriesKeys(search, dimension));
  const selectedCampaignEditor = $derived.by(() => {
    const row = selection?.row;
    return row?.campaignKey ? campaignLabels.editorFor(row.campaignKey, row.sessionLabel) : undefined;
  });
  const projectPayload = $derived<Pick<WebReportPayloadWithoutRows, 'projectGroupConfigs' | 'projectGroups'>>({
    ...(commit?.breakdown?.context.projectGroupConfigs
      ? { projectGroupConfigs: commit.breakdown.context.projectGroupConfigs }
      : {}),
    ...(commit?.breakdown?.context.projectGroups ? { projectGroups: commit.breakdown.context.projectGroups } : {}),
  });

  const presentMachineLabel = (value: string): string =>
    machinePresentations.get(value)?.label ??
    bootstrap.filterOptions.machine.find((option) => option.value === value)?.label ??
    value;
  const presentMachineSeries = (key: string, label: string) =>
    machineLabelPresentationForSnapshot({ id: key, label }, machineSnapshot);
  const presentCampaignSeries = (series: FocusedTimelineSeries): FocusedTimelineSeries =>
    presentCampaignTimelineSeries(series, campaignIndex);
  const presentSessionItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem =>
    presentFocusedOverviewSessionItem(item, (campaignKey, derivedLabel) =>
      campaignLabelFor(campaignIndex, campaignKey, derivedLabel),
    );
  const presentSessionRow = (row: SessionPresentationRow): SessionPresentationRow =>
    presentServedCampaignDisplayRow(row, campaignIndex);
  const selectOverviewSession = (item: FocusedOverviewSessionItem): void => {
    const presented = presentSessionItem(item);
    detailRows = commit?.overview.view.topSessions.map((candidate) => presentSessionItem(candidate).row) ?? [
      presented.row,
    ];
    selection = {
      ...(commit?.overview.revision === undefined ? {} : { revision: commit.overview.revision }),
      row: presented.row,
    };
    selectedRowId = presented.row.rowId;
  };
  const selectCampaignSession = (row: SessionPresentationRow): void => {
    const controls = campaignSessionControls;
    if (controls === null) {
      return;
    }
    const selected = campaignSessionSelectionFor(controls, row);
    detailRows = controls.collection.items;
    selection = {
      ...selected,
      target: sessionAnalysisTargetForSession(row),
    };
    selectedRowId = row.rowId;
  };
  const selectDay = (date: string): void =>
    navigate((current) => ({ ...current, range: { from: date, mode: 'custom', to: date }, tab: 'sessions' }));
  const selectTimeCell = (cell: LocalTimeCell): void =>
    navigate((current) => ({ ...current, tab: 'sessions', timeCell: serializeDashboardTimeCell(cell) }));
  const updateOverviewOptions = (options: {
    dimension: TimelineDimension;
    granularity: MigrationGranularity;
    value: TimelineValue;
  }): void => {
    dimension = options.dimension;
    granularity = options.granularity;
    timelineValue = options.value;
  };
  const persistProjectGroups = async (
    groups: readonly ProjectGroupConfig[],
    revision = descriptorSource.current().revision,
  ): Promise<void> => {
    if (runtimeMode !== 'live') {
      throw new Error('Project groups can only be saved from a live report.');
    }
    await saveProjectGroupsAtRevision(
      groups,
      revision,
      () => descriptorSource.current().revision,
      async (next, current) => {
        const command = await buildProjectGroupReferenceCommand(next, current);
        await reportClient.saveProjectGroups(command);
      },
    );
  };
  const loadProjectGroupConfigs = async (): Promise<{
    readonly groups: readonly ProjectGroupConfig[];
    readonly revision: string;
  }> => {
    const committed = commit?.breakdown?.context.projectGroupConfigs;
    if (committed !== undefined && commit?.breakdown !== undefined) {
      return { groups: committed, revision: commit.breakdown.revision };
    }
    const revision = descriptorSource.current().revision;
    const request = {
      query: queryForDescriptor({ filters: destination.sessions.filters, range: destination.sessions.range }, revision),
    };
    const result = await queryClient.fetchQuery(reportBreakdownQueryOptions(reportClient, request, { browser: true }));
    return {
      groups: requireFocusedBreakdown(result, request).context.projectGroupConfigs ?? [],
      revision,
    };
  };
  const cleanupProjectWarning = (warning: UsageReportWarning, refresh: () => Promise<void>): void => {
    const groupId = warning.groupId;
    if (!groupId || cleaningProjectWarningGroupId !== undefined) {
      return;
    }
    cleaningProjectWarningGroupId = groupId;
    projectWarningCleanupError = undefined;
    const run = async (): Promise<void> => {
      const loaded = await loadProjectGroupConfigs();
      await persistProjectGroups(projectGroupsAfterWarningCleanup(loaded.groups, warning), loaded.revision);
      await refresh();
    };
    run()
      .catch((error: unknown) => {
        projectWarningCleanupError = error instanceof Error ? error.message : 'Failed to clean up the project group.';
      })
      .finally(() => {
        cleaningProjectWarningGroupId = undefined;
      });
  };

  onMount(() => {
    campaignLabels.load().catch(() => undefined);
  });
</script>

{#snippet campaignSlot()}
  {#if selectedCampaignEditor}
    <CampaignLabelEditor editor={selectedCampaignEditor} />
  {/if}
  {#if campaignSessionControls}
    <CampaignSessionControls
      campaign={campaignSessionControls.campaign}
      collection={campaignSessionControls.collection}
      onClearCampaignFilter={(campaignKey) => {
        if (campaignFilterMatchesBinding(search.filters.campaign, campaignKey)) {
          navigation.clearFieldFilter('campaign');
        }
      }}
      onLoadMoreCampaignSessions={() => campaignSessionControls?.loadMore()}
      onSelectSession={selectCampaignSession}
      query={campaignSessionControls.query}
      visibleRows={campaignSessionControls.visibleRows}
    />
  {/if}
{/snippet}

<ReportLifecycleOwner session={focusedSession}>
  {#snippet children(_owner)}
    <FocusedDestinationRefresh destination={destination.focused} owner={_owner} />
    <ReportWarnings
      cleanupDisabled={runtimeMode !== 'live'}
      {omittedSupportItemCount}
      {...(cleaningProjectWarningGroupId === undefined ? {} : { cleaningProjectWarningGroupId })}
      onCleanupProjectWarning={(warning) => cleanupProjectWarning(warning, async () => {
        if (destination.focused !== null) {
          await _owner.refresh(destination.focused);
        }
      })}
      {warnings}
    />
    {#if projectWarningCleanupError}
      <p aria-live="polite" role="status">{projectWarningCleanupError}</p>
    {/if}
    <FilterBar
      freshnessStatus={machineFreshnessStatusLabel(machineSnapshot)}
      freshnessUnavailable={machineSnapshot.kind === 'unavailable'}
      harnessOptions={bootstrap.filterOptions.harness}
      isDemo={false}
      machineAttention={machineSnapshot.kind === 'unavailable'}
      machineOptions={bootstrap.filterOptions.machine.map(({ value }) => value)}
      {navigation}
      {presentMachineLabel}
      {search}
    />
    <ActiveFilters
      hidden={Math.max(0, totalSessions - visibleSessions)}
      {navigation}
      pending={_owner.snapshot.pending}
      {presentMachineLabel}
      {search}
      total={totalSessions}
      visible={visibleSessions}
    />
    <ReportWorkspace
      hasOutput={primary === 'sessions' || commit !== undefined}
      pending={primary === 'sessions' ? false : _owner.snapshot.pending}
      refreshError={_owner.snapshot.refreshError}
    >
      {#snippet children()}
        {#if primary === 'overview' && commit?.destination.kind === 'overview'}
          <OverviewPage
            {activeSeriesKeys}
            {dimension}
            freshness={bootstrap.machineFreshness}
            {granularity}
            machineFreshnessStatus={machineFreshnessStatusLabel(machineSnapshot)}
            {navigate}
            onDimensionFilter={navigation.setTimelineDimensionFilter}
            onOpenQuotaHistory={() => (quotaHistoryOpen = true)}
            onOptionsChange={updateOverviewOptions}
            onRangeChange={navigation.setDateRange}
            onSelectDay={selectDay}
            onSelectSession={selectOverviewSession}
            onSelectTimeCell={selectTimeCell}
            {presentCampaignSeries}
            {presentMachineSeries}
            {presentSessionItem}
            {providers}
            range={search.range}
            result={commit.overview}
            value={timelineValue}
          />
        {:else if primary === 'breakdown' && commit?.breakdown}
          <DashboardBreakdown
            data={{
              cursorRows: commit.breakdown.context.cursorCommitAttribution,
              generatedAt: bootstrap.support.generatedAt,
              harnesses: commit.breakdown.groups.harnesses,
              harnessProviders: commit.breakdown.groups.harnessProviders,
              models: commit.breakdown.groups.models,
              projects: commit.breakdown.groups.projects,
            }}
            navigation={{
              onSortChange: navigation.setBreakdownSort,
              onTabChange: (tab) => navigation.setBreakdownTab(tab as Parameters<typeof navigation.setBreakdownTab>[0]),
              sort: search.breakdownSort,
              tab: search.tab,
            }}
            onFieldFilter={navigation.setFieldFilter}
            onHarnessFilter={(value) => navigation.setHarness(search.harness.includes(value) ? search.harness.filter((item) => item !== value) : [...search.harness, value])}
            projectEditor={{
              disabled: runtimeMode !== 'live',
              onSave: async (groups) => {
                await persistProjectGroups(groups);
                const focusedDestination = destination.focused;
                if (focusedDestination === null) {
                  throw new Error('Project groups require a focused report destination.');
                }
                await _owner.refresh(focusedDestination);
              },
              payload: projectPayload,
            }}
          />
        {:else if primary === 'sessions'}
          <SessionsDestination
            acquire={descriptorSource.acquire}
            client={sessionClient}
            destinationScope={destination.sessions}
            {navigate}
            onCampaignControlsChange={(binding) => (campaignSessionControls = binding)}
            onRowsChange={(rows) => (detailRows = rows)}
            onSelectionChange={(nextSelection) => {
              selection = nextSelection;
              selectedRowId = nextSelection?.row.rowId ?? null;
            }}
            onSessionCountChange={(sessionCount) => (servedSessionCount = sessionCount)}
            presentRow={presentSessionRow}
            {queryClient}
            {search}
            selectedCampaignKey={selection?.row.campaignKey}
            {selectedRowId}
          />
        {/if}
      {/snippet}
    </ReportWorkspace>
    <SessionDetailSlot
      {campaignSlot}
      controller={detailController}
      onFieldFilter={(key, value) => navigation.setFieldFilter(key, value)}
      rows={detailRows}
      {selection}
    />
    <QuotaHistoryOwner
      client={reportClient}
      generation={commit?.descriptor.revision ?? initialDescriptor.revision}
      onClose={() => (quotaHistoryOpen = false)}
      open={quotaHistoryOpen}
      {runtimeMode}
    />
  {/snippet}
</ReportLifecycleOwner>
