<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type { FocusedOverviewSessionItem, FocusedTimelineSeries } from '@ai-usage/report-core/focused-report-query';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
  import type { LocalTimeCell, SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import type { QueryClient } from '@tanstack/svelte-query';
  import { onDestroy, onMount, untrack } from 'svelte';
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
  import {
    createSessionTableQueryOwner,
    type SessionTableQueryState,
    seedSessionTableQueryState,
  } from '../../sessions/table/session-table-query-owner';
  import { useSessionWindowAnchorOwner } from '../../shell/session-window-anchor-context';
  import { useSourceControl } from '../../sources/context.svelte';
  import CampaignLabelEditor from '../actions/campaign-label-editor.svelte';
  import CampaignSessionControls from '../actions/campaign-session-controls.svelte';
  import {
    type CampaignSessionControlsBinding,
    campaignFilterMatchesBinding,
    campaignSessionSelectionFor,
  } from '../actions/campaign-session-controls-binding';
  import { projectGroupsAfterWarningCleanup, saveProjectGroupsAtRevision } from '../actions/project';
  import QuotaHistoryOwner from '../actions/quota-history-owner.svelte';
  import { reportMutationsEnabled } from '../actions/report-mutation-availability';
  import ActiveFilters from '../breakdown/active-filters.svelte';
  import FilterBar from '../breakdown/filter-bar.svelte';
  import { createBreakdownNavigation } from '../breakdown/navigation';
  import ReportWarnings from '../core/report-warnings.svelte';
  import ReportWorkspace from '../core/report-workspace.svelte';
  import ReportLifecycleOwner from '../lifecycle/report-lifecycle-owner.svelte';
  import type { ServedReportOwnerSnapshot } from '../lifecycle/served-report-session-owner.svelte';
  import OverviewPage from '../overview/overview-page.svelte';
  import OverviewStatus from '../overview/overview-status.svelte';
  import ReportRangeControl from '../range/report-range-control.svelte';
  import { activeTimelineSeriesKeys } from './active-timeline-series';
  import { createCampaignLabelOwner } from './campaign-label-owner.svelte';
  import FocusedDestinationRefresh from './focused-destination-refresh.svelte';
  import {
    createFocusedReportDescriptorSource,
    createFocusedReportSession,
    type FocusedReportCommit,
    type FocusedReportDescriptor,
    INITIAL_REPORT_TIMELINE,
    initialFocusedReportDescriptor,
    requireFocusedBreakdown,
    seedFocusedReportCommit,
  } from './report-destination';
  import { queryForDescriptor, reportDestinationForSearch, reportFilterFingerprint } from './report-search';
  import SessionDestinationRefresh from './session-destination-refresh.svelte';

  const rangePlacement = css({ mt: '14px' });

  type DashboardBreakdownModule = typeof import('../breakdown/dashboard-breakdown.svelte');
  type SessionsDestinationModule = typeof import('./sessions-destination.svelte');

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

  const sessionWindowAnchorOwner = useSessionWindowAnchorOwner();
  let dimension = $state<TimelineDimension>(INITIAL_REPORT_TIMELINE.dimension);
  let granularity = $state<MigrationGranularity>(INITIAL_REPORT_TIMELINE.granularity);
  let timelineValue = $state<TimelineValue>('cost');
  // Headline value of the window currently under the pointer, so the hero tracks the brush instead
  // of waiting for the release-triggered round trip. Null whenever the brush is not being dragged.
  let draggedWindowApiValue = $state<number | null>(null);
  // The route load hands us warm exact data for the landing destination. Reading it synchronously
  // lets Overview paint during SSR and lets destination chunks mount without a data waterfall.
  // The session below still owns every later commit; this seed is discarded as soon as it commits.
  const initialDescriptor = untrack(() => initialFocusedReportDescriptor(bootstrapResult));
  const initialDestination = untrack(() =>
    reportDestinationForSearch(search, bootstrapResult.bootstrap.support.generatedAt, INITIAL_REPORT_TIMELINE),
  );
  let commit = $state<FocusedReportCommit | undefined>(
    untrack(() =>
      seedFocusedReportCommit({
        descriptor: initialDescriptor,
        destination: initialDestination.focused,
        queryClient,
      }),
    ),
  );
  let detailRows = $state<readonly SessionPresentationRow[]>([]);
  let selectedRowId = $state<string | null>(null);
  let selection = $state<SessionSelectionInput | null>(null);
  let quotaHistoryOpen = $state(false);
  let servedSessionCount = $state<number>();
  let cleaningProjectWarningGroupId = $state<string>();
  let projectWarningCleanupError = $state<string>();
  let campaignSessionControls = $state<CampaignSessionControlsBinding | null>(null);
  let dashboardBreakdownModule = $state<DashboardBreakdownModule>();
  let dashboardBreakdownLoadFailed = $state(false);
  let dashboardBreakdownLoad: Promise<void> | undefined;
  let sessionsDestinationModule = $state<SessionsDestinationModule>();
  let sessionsDestinationLoadFailed = $state(false);
  let sessionsDestinationLoad: Promise<void> | undefined;
  let deferredModuleCommit: FocusedReportCommit | undefined;
  let sessionQueryState = $state.raw<SessionTableQueryState | undefined>(
    untrack(() =>
      initialDestination.focused?.kind === 'sessions'
        ? seedSessionTableQueryState({
            queryClient,
            revision: initialDescriptor.revision,
            scope: initialDestination.focused.sessions,
          })
        : undefined,
    ),
  );
  const sourceControl = useSourceControl();
  const descriptorSource = untrack(() =>
    createFocusedReportDescriptorSource({ client: reportClient, initial: initialDescriptor, queryClient }),
  );
  const showCommit = (nextCommit: FocusedReportCommit): void => {
    deferredModuleCommit = undefined;
    commit = nextCommit;
    // The committed figures now describe the dragged window, so the local preview retires here
    // rather than on release — otherwise the headline briefly shows the range just left behind.
    draggedWindowApiValue = null;
  };
  const acceptCommit = (nextCommit: FocusedReportCommit): void => {
    const modulePending =
      (nextCommit.destination.kind === 'breakdown' && !dashboardBreakdownModule) ||
      (nextCommit.destination.kind === 'sessions' && !sessionsDestinationModule);
    if (modulePending) {
      deferredModuleCommit = nextCommit;
      return;
    }
    showCommit(nextCommit);
  };
  const sessionQuery = untrack(() =>
    createSessionTableQueryOwner({
      client: sessionClient,
      onStateChange: (state) => {
        sessionQueryState = state;
      },
      queryClient,
    }),
  );
  const focusedSession = untrack(() =>
    createFocusedReportSession({
      acquire: descriptorSource.acquire,
      client: reportClient,
      onCommit: acceptCommit,
      queryClient,
      sessionOwner: sessionQuery,
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
  const navigation = createBreakdownNavigation((update, options) => navigate(update, options));
  const timeline = $derived({ dimension, granularity });
  const destination = $derived(
    reportDestinationForSearch(search, bootstrapResult.bootstrap.support.generatedAt, timeline),
  );
  const requestedFilterFingerprint = $derived(
    destination.focused === null ? undefined : reportFilterFingerprint(destination.focused.query.filters),
  );
  const committedFilterFingerprint = $derived(
    commit === undefined ? undefined : reportFilterFingerprint(commit.destination.query.filters),
  );
  const focusedTimelineFiltersChanged = $derived(requestedFilterFingerprint !== committedFilterFingerprint);
  const primary = $derived(primaryDashboardTabFor(search.tab));
  // The URL changes immediately, while the newly requested exact-revision data commits atomically.
  // Keep rendering the last complete destination during that gap instead of replacing it with a
  // page-sized loading message. The navigation still reflects the user's requested destination.
  const visiblePrimary = $derived(commit?.destination.kind ?? primary);
  /**
   * Before the first commit there is no data and no error yet — the honest state is "loading".
   * Without this the workspace falls through to "Report payload unavailable", which reads as a
   * failure; the effect that would raise `pending` never runs during the server render.
   */
  const workspacePending = (snapshot: ServedReportOwnerSnapshot<FocusedReportDescriptor>): boolean => {
    if (visiblePrimary === 'sessions') {
      return false;
    }
    if (commit === undefined) {
      return snapshot.refreshError === null;
    }
    return snapshot.pending;
  };
  $effect(() => {
    if (primary === 'breakdown' && !dashboardBreakdownModule) {
      dashboardBreakdownLoad ??= import('../breakdown/dashboard-breakdown.svelte')
        .then((module) => {
          dashboardBreakdownModule = module;
          if (deferredModuleCommit?.destination.kind === 'breakdown' && primary === 'breakdown') {
            showCommit(deferredModuleCommit);
          }
        })
        .catch(() => {
          dashboardBreakdownLoadFailed = true;
        });
    } else if (primary === 'sessions' && !sessionsDestinationModule) {
      sessionsDestinationLoad ??= import('./sessions-destination.svelte')
        .then((module) => {
          sessionsDestinationModule = module;
          if (deferredModuleCommit?.destination.kind === 'sessions' && primary === 'sessions') {
            showCommit(deferredModuleCommit);
          }
        })
        .catch(() => {
          sessionsDestinationLoadFailed = true;
        });
    }
  });
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
    visiblePrimary === 'sessions'
      ? (servedSessionCount ?? totalSessions)
      : (commit?.overview.summary.sessionCount ?? totalSessions),
  );
  const activeSeriesKeys = $derived(activeTimelineSeriesKeys(search, dimension));
  const mutationsEnabled = $derived(reportMutationsEnabled(runtimeMode, sourceControl.state().connection));
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
    navigate((current) => ({ ...current, timeCell: serializeDashboardTimeCell(cell) }));
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
    if (!mutationsEnabled) {
      throw new Error('Project groups can only be saved while source control is live.');
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

  onDestroy(() => sessionQuery.close());
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
{#snippet activeFilterSummary(_filterPending: boolean)}
  <ActiveFilters
    hidden={Math.max(0, totalSessions - visibleSessions)}
    {navigation}
    pending={_filterPending}
    {presentMachineLabel}
    {search}
    total={totalSessions}
    visible={visibleSessions}
  />
{/snippet}

<ReportLifecycleOwner session={focusedSession}>
  {#snippet children(_owner)}
    <FocusedDestinationRefresh
      destination={destination.focused}
      owner={_owner}
      publicationRevision={sourceControl.state().publication?.revision}
    />
    <SessionDestinationRefresh destination={destination.focused} owner={_owner} queryOwner={sessionQuery} />
    <ReportWarnings
      cleanupDisabled={!mutationsEnabled}
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
    {#if commit?.overview}
      <div class={rangePlacement} hidden={_owner.snapshot.pending && focusedTimelineFiltersChanged}>
        <ReportRangeControl
          {activeSeriesKeys}
          dateDomain={commit.overview.dateDomain}
          {dimension}
          generatedAt={bootstrap.support.generatedAt}
          {granularity}
          machineFreshnessStatus={machineFreshnessStatusLabel(machineSnapshot)}
          {navigate}
          onDimensionFilter={navigation.setTimelineDimensionFilter}
          onOptionsChange={updateOverviewOptions}
          onRangeChange={navigation.setDateRange}
          onWindowPreview={(apiValue) => (draggedWindowApiValue = apiValue)}
          {presentCampaignSeries}
          {presentMachineSeries}
          range={search.range}
          timeline={commit.overview.timeline}
          value={timelineValue}
        />
      </div>
    {/if}
    {@render activeFilterSummary(_owner.snapshot.pending)}
    <ReportWorkspace
      hasOutput={visiblePrimary === 'sessions' || commit !== undefined}
      pending={workspacePending(_owner.snapshot)}
      refreshError={_owner.snapshot.refreshError}
    >
      {#snippet status()}
        {#if visiblePrimary === 'overview' && commit?.destination.kind === 'overview' && !_owner.snapshot.pending}
          <OverviewStatus
            onOpenQuotaHistory={() => (quotaHistoryOpen = true)}
            {providers}
            range={search.range}
            result={commit.overview}
          />
        {/if}
      {/snippet}
      {#snippet children()}
        {#if visiblePrimary === 'overview' && commit?.destination.kind === 'overview'}
          <OverviewPage
            {activeSeriesKeys}
            {dimension}
            {draggedWindowApiValue}
            freshness={bootstrap.machineFreshness}
            {granularity}
            machineFreshnessStatus={machineFreshnessStatusLabel(machineSnapshot)}
            {navigate}
            onDimensionFilter={navigation.setTimelineDimensionFilter}
            onOptionsChange={updateOverviewOptions}
            onRangeChange={navigation.setDateRange}
            onSelectDay={selectDay}
            onSelectSession={selectOverviewSession}
            onSelectTimeCell={selectTimeCell}
            {presentCampaignSeries}
            {presentMachineSeries}
            {presentSessionItem}
            range={search.range}
            result={commit.overview}
            value={timelineValue}
          />
        {:else if visiblePrimary === 'breakdown' && commit?.breakdown && dashboardBreakdownModule}
          {@const DashboardBreakdown = dashboardBreakdownModule.default}
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
              disabled: !mutationsEnabled,
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
        {:else if visiblePrimary === 'sessions' && sessionsDestinationModule}
          {@const SessionsDestination = sessionsDestinationModule.default}
          <SessionsDestination
            destinationScope={commit?.destination.kind === 'sessions' ? commit.destination.sessions : destination.sessions}
            initialSessionWindowAnchor={sessionWindowAnchorOwner.available()}
            {navigate}
            onCampaignControlsChange={(binding) => (campaignSessionControls = binding)}
            onInitialSessionWindowAnchor={sessionWindowAnchorOwner.consume}
            onRowsChange={(rows) => (detailRows = rows)}
            onSelectionChange={(nextSelection) => {
              selection = nextSelection;
              selectedRowId = nextSelection?.row.rowId ?? null;
            }}
            onSessionCountChange={(sessionCount) => (servedSessionCount = sessionCount)}
            pending={_owner.snapshot.pending}
            presentRow={presentSessionRow}
            queryOwner={sessionQuery}
            queryState={sessionQueryState}
            {search}
            selectedCampaignKey={selection?.row.campaignKey}
            {selectedRowId}
          />
        {:else if dashboardBreakdownLoadFailed || sessionsDestinationLoadFailed}
          <p role="status">Report view is temporarily unavailable.</p>
        {:else}
          <p aria-live="polite" role="status">Loading report…</p>
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
