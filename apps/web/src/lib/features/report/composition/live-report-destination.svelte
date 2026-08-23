<script lang="ts">
  import type { FocusedOverviewSessionItem, FocusedTimelineSeries } from '@ai-usage/report-core/focused-report-query';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
  import type { LocalTimeCell, SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
  import { createMutation, createQuery, type QueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
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
  import { buildProviderStatusViews, providerHistoryAvailable } from '../../../../provider-status-model';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import { sessionAnalysisTargetForSession } from '../../../../session-analysis-target';
  import type { WebReportPayloadWithoutRows } from '../../../../web-report-payload';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import {
    campaignLabelOverridesQueryOptions,
    fetchReportBreakdown,
    saveProjectGroupsMutationOptions,
    setCampaignLabelOverrideMutationOptions,
  } from '../../../query/options/report';
  import { refreshReportDestination, reportDestinationQueryOptions } from '../../../query/options/report-destination';
  import {
    increaseSessionWindowDepth,
    initialSessionWindowIntent,
    type SessionWindowIntent,
    sessionWindowIntentFingerprint,
    sessionWindowSatisfiesIntent,
  } from '../../../query/options/session-window';
  import type { ReportClient } from '../../../rpc/report-client';
  import type { SessionClientAdapter } from '../../../rpc/session-client';
  import SessionDetailQuerySlot from '../../sessions/detail/session-detail-query-slot.svelte';
  import type { SessionSelectionInput } from '../../sessions/detail/types';
  import { useSessionWindowAnchorOwner } from '../../shell/session-window-anchor-context';
  import { useSourceControl } from '../../sources/context.svelte';
  import { campaignRenameMutation, campaignResetMutation } from '../actions/campaign';
  import CampaignLabelEditor from '../actions/campaign-label-editor.svelte';
  import type { CampaignLabelEditorState } from '../actions/campaign-label-editor-state';
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
  import { createBreakdownNavigation } from '../breakdown/navigation';
  import ReportWarnings from '../core/report-warnings.svelte';
  import { activeTimelineSeriesKeys } from './active-timeline-series';
  import { importReportLazyModule } from './lazy-module-e2e-fixture';
  import { createLazyModuleLoader } from './lazy-module-loader';
  import {
    destinationFingerprint,
    type FocusedReportDestination,
    INITIAL_REPORT_TIMELINE,
    initialFocusedReportDescriptor,
    requireFocusedBreakdown,
  } from './report-destination';
  import ReportDestinationPresentation from './report-destination-presentation.svelte';
  import { queryForDescriptor, reportDestinationForSearch } from './report-search';

  type DashboardBreakdownModule = typeof import('../breakdown/dashboard-breakdown.svelte');
  type SessionsDestinationModule = typeof import('./sessions-destination.svelte');

  let {
    bootstrapResult,
    modelsHref,
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
    modelsHref: string;
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
  const initialDescriptor = untrack(() => initialFocusedReportDescriptor(bootstrapResult));
  const initialDestination = untrack(() =>
    reportDestinationForSearch(search, bootstrapResult.bootstrap.support.generatedAt, INITIAL_REPORT_TIMELINE),
  );
  let detailRows = $state<readonly SessionPresentationRow[]>([]);
  let selectedRowId = $state<string | null>(null);
  let selection = $state<SessionSelectionInput | null>(null);
  let sessionDrawerClosing = false;
  let quotaHistoryOpen = $state(false);
  let servedSessionCount = $state<number>();
  let cleaningProjectWarningGroupId = $state<string>();
  let projectWarningCleanupError = $state<string>();
  let campaignSessionControls = $state<CampaignSessionControlsBinding | null>(null);
  let dashboardBreakdownModule = $state<DashboardBreakdownModule>();
  let dashboardBreakdownLoadFailed = $state(false);
  let sessionsDestinationModule = $state<SessionsDestinationModule>();
  let sessionsDestinationLoadFailed = $state(false);
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
  const sessionsDestinationLoader = createLazyModuleLoader({
    importModule: () =>
      importReportLazyModule({
        enabled: runtimeMode === 'e2e',
        importModule: () => import('./sessions-destination.svelte'),
        target: 'sessions',
      }),
    onFailureChange: (failed) => (sessionsDestinationLoadFailed = failed),
    onLoaded: (module) => (sessionsDestinationModule = module),
  });
  const sourceControl = useSourceControl();
  const defaultSessionWindowIntent = initialSessionWindowIntent();
  let sessionWindowState = $state.raw<{
    readonly destinationFingerprint: string;
    readonly intent: SessionWindowIntent;
  }>({
    destinationFingerprint:
      initialDestination.focused?.kind === 'sessions' ? destinationFingerprint(initialDestination.focused) : '',
    intent: defaultSessionWindowIntent,
  });
  const campaignLabelsQuery = createQuery(() =>
    campaignLabelOverridesQueryOptions(reportClient, { browser: typeof globalThis.location !== 'undefined' }),
  );
  const campaignLabelMutation = createMutation(() =>
    setCampaignLabelOverrideMutationOptions(reportClient, queryClient),
  );
  const projectGroupsMutation = createMutation(() => saveProjectGroupsMutationOptions(reportClient, queryClient));
  const navigation = createBreakdownNavigation((update, options) => navigate(update, options));
  const timeline = $derived({ dimension, granularity });
  const destination = $derived(
    reportDestinationForSearch(search, bootstrapResult.bootstrap.support.generatedAt, timeline),
  );
  const focusedDestination = $derived.by(() => {
    if (destination.focused === null) {
      throw new Error('The live report requires one focused destination.');
    }
    return destination.focused;
  });
  const activeSessionWindowIntent = $derived.by(() => {
    if (focusedDestination.kind !== 'sessions') {
      return defaultSessionWindowIntent;
    }
    return sessionWindowState.destinationFingerprint === destinationFingerprint(focusedDestination)
      ? sessionWindowState.intent
      : defaultSessionWindowIntent;
  });
  const destinationDependencies = untrack(() => ({ queryClient, reportClient, sessionClient }));
  const destinationQuery = createQuery(() =>
    reportDestinationQueryOptions(
      destinationDependencies,
      focusedDestination,
      { browser: typeof globalThis.location !== 'undefined' },
      activeSessionWindowIntent,
    ),
  );
  const commit = $derived(destinationQuery.data);
  const increaseSessionDepth = (
    family: 'campaign-children' | 'campaign-sessions' | 'top-level',
    campaignKey?: string,
  ): void => {
    if (focusedDestination.kind !== 'sessions') {
      return;
    }
    sessionWindowState = {
      destinationFingerprint: destinationFingerprint(focusedDestination),
      intent: increaseSessionWindowDepth(activeSessionWindowIntent, family, campaignKey),
    };
  };
  const refreshIdentityFor = (
    focused: FocusedReportDestination,
    publicationRevision: string | undefined,
    sessionIntent: SessionWindowIntent,
  ): string =>
    JSON.stringify({
      destination: destinationFingerprint(focused),
      publicationRevision,
      sessionWindow: focused.kind === 'sessions' ? sessionWindowIntentFingerprint(sessionIntent) : undefined,
    });
  let requestedRefreshIdentity = untrack(() => {
    if (initialDestination.focused === null) {
      return '';
    }
    return refreshIdentityFor(
      initialDestination.focused,
      sourceControl.state().publication?.revision,
      activeSessionWindowIntent,
    );
  });
  let visibleCommitIdentity = '';
  $effect(() => {
    const publicationRevision = sourceControl.state().publication?.revision;
    const refreshIdentity = refreshIdentityFor(focusedDestination, publicationRevision, activeSessionWindowIntent);
    if (refreshIdentity === requestedRefreshIdentity) {
      return;
    }
    requestedRefreshIdentity = refreshIdentity;
    const visible = destinationQuery.data;
    const sessionWindowIsCurrent =
      focusedDestination.kind !== 'sessions' ||
      (visible?.sessions !== undefined && sessionWindowSatisfiesIntent(visible.sessions, activeSessionWindowIntent));
    if (
      visible !== undefined &&
      publicationRevision === visible.descriptor.revision &&
      destinationFingerprint(focusedDestination) === destinationFingerprint(visible.destination) &&
      sessionWindowIsCurrent
    ) {
      return;
    }
    refreshReportDestination(destinationDependencies, focusedDestination, activeSessionWindowIntent).catch(
      () => undefined,
    );
  });
  $effect(() => {
    const nextCommit = commit;
    if (nextCommit === undefined) {
      return;
    }
    const identity = `${nextCommit.descriptor.revision}:${destinationFingerprint(nextCommit.destination)}`;
    if (identity === visibleCommitIdentity) {
      return;
    }
    visibleCommitIdentity = identity;
    draggedWindowApiValue = null;
  });
  const primary = $derived(primaryDashboardTabFor(search.tab));
  // The URL changes immediately, while the newly requested exact-revision data commits atomically.
  // Keep rendering the last complete destination during that gap instead of replacing it with a
  // page-sized loading message. The navigation still reflects the user's requested destination.
  const visiblePrimary = $derived(commit?.destination.kind ?? primary);
  // A refetch of the destination the reader is already looking at — a newer engine revision
  // published while the range and filters are unchanged — revalidates in place: the visible
  // figures still answer the request, so they keep full strength until the fresh commit lands.
  // Only a request the visible commit does not answer (range or filter change) marks it stale.
  const commitAnswersRequest = $derived(
    commit !== undefined && destinationFingerprint(focusedDestination) === destinationFingerprint(commit.destination),
  );
  const staleForRequest = $derived(destinationQuery.isFetching && !commitAnswersRequest);
  const workspacePending = (): boolean => {
    if (visiblePrimary === 'sessions') {
      return false;
    }
    if (commit === undefined) {
      return destinationQuery.isFetching || destinationQuery.error === null;
    }
    return staleForRequest;
  };
  $effect(() => {
    if (primary === 'breakdown' && !dashboardBreakdownModule) {
      dashboardBreakdownLoader.start();
    } else if (primary === 'sessions' && !sessionsDestinationModule) {
      sessionsDestinationLoader.start();
    }
  });
  const retryReportDestination = async (): Promise<void> => {
    if (primary === 'breakdown' && dashboardBreakdownLoadFailed) {
      await dashboardBreakdownLoader.retry();
      return;
    }
    if (primary === 'sessions' && sessionsDestinationLoadFailed) {
      await sessionsDestinationLoader.retry();
      return;
    }
    await destinationQuery.refetch();
  };
  const activeDestinationLoadFailed = $derived(
    (visiblePrimary === 'breakdown' && dashboardBreakdownLoadFailed) ||
      (visiblePrimary === 'sessions' && sessionsDestinationLoadFailed),
  );
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
  const campaignIndex = $derived(indexCampaignLabelOverrides(campaignLabelsQuery.data ?? []));
  const providers = $derived(
    buildProviderStatusViews(bootstrap.support, bootstrap.providerRows, bootstrap.support.generatedAt),
  );
  // Only offer the history drawer when a provider can plausibly have stored observations behind it;
  // a live or local-history source is what the quota store writes from.
  const quotaHistoryAvailable = $derived(
    providerHistoryAvailable(
      undefined,
      providers.some(({ provider }) => provider.source === 'live-api' || provider.source === 'local-history'),
    ),
  );
  const totalSessions = $derived(bootstrap.support.analytics.sessionCount);
  const visibleSessions = $derived(
    visiblePrimary === 'sessions'
      ? (servedSessionCount ?? totalSessions)
      : (commit?.overview.summary.sessionCount ?? totalSessions),
  );
  const activeSeriesKeys = $derived(activeTimelineSeriesKeys(search, dimension));
  const mutationsEnabled = $derived(reportMutationsEnabled(runtimeMode, sourceControl.state().connection));
  const mutateCampaignLabel = async (
    campaignKey: string,
    derivedLabel: string,
    label: string | null,
  ): Promise<string | null> => {
    if (campaignLabelMutation.isPending) {
      return null;
    }
    try {
      const overrides = await campaignLabelMutation.mutateAsync(
        label === null ? campaignResetMutation(campaignKey) : campaignRenameMutation(campaignKey, label),
      );
      return campaignLabelFor(indexCampaignLabelOverrides(overrides), campaignKey, label ?? derivedLabel);
    } catch {
      return null;
    }
  };
  const campaignLabelLoadStatus = (): CampaignLabelEditorState['loadStatus'] => {
    if (campaignLabelsQuery.data) {
      return 'ready';
    }
    return campaignLabelsQuery.isError ? 'error' : 'loading';
  };
  const campaignLabelMutationStatus = (): CampaignLabelEditorState['mutationStatus'] => {
    if (campaignLabelMutation.isPending) {
      return 'saving';
    }
    return campaignLabelMutation.isError ? 'error' : 'idle';
  };
  const selectedCampaignEditor = $derived.by(() => {
    const row = selection?.row;
    if (!row?.campaignKey) {
      return;
    }
    const index = campaignIndex;
    const campaignKey = row.campaignKey;
    return {
      campaignKey,
      effectiveLabel: campaignLabelFor(index, campaignKey, row.sessionLabel),
      hasOverride: index.has(campaignKey),
      loadError: campaignLabelsQuery.error?.message ?? null,
      loadStatus: campaignLabelLoadStatus(),
      mutationError: campaignLabelMutation.error?.message ?? null,
      mutationStatus: campaignLabelMutationStatus(),
      onRename: async (label: string) => await mutateCampaignLabel(campaignKey, row.sessionLabel, label),
      onReset: async () => await mutateCampaignLabel(campaignKey, row.sessionLabel, null),
      onRetry: async () => (await campaignLabelsQuery.refetch()).isSuccess,
    } satisfies CampaignLabelEditorState;
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
    if (sessionDrawerClosing) {
      return;
    }
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
    if (sessionDrawerClosing) {
      return;
    }
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
  const currentRevision = (): string => commit?.descriptor.revision ?? initialDescriptor.revision;
  const persistProjectGroups = async (
    groups: readonly ProjectGroupConfig[],
    revision = currentRevision(),
  ): Promise<void> => {
    if (!mutationsEnabled) {
      throw new Error('Project groups can only be saved while source control is live.');
    }
    await saveProjectGroupsAtRevision(
      groups,
      revision,
      () => currentRevision(),
      async (next, current) => {
        const command = await buildProjectGroupReferenceCommand(next, current);
        await projectGroupsMutation.mutateAsync(command);
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
    const revision = currentRevision();
    const request = {
      query: queryForDescriptor({ filters: destination.sessions.filters, range: destination.sessions.range }, revision),
    };
    const result = await fetchReportBreakdown(queryClient, reportClient, request);
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

<ReportWarnings
  cleanupDisabled={!mutationsEnabled}
  {omittedSupportItemCount}
  {...(cleaningProjectWarningGroupId === undefined ? {} : { cleaningProjectWarningGroupId })}
  onCleanupProjectWarning={(warning) =>
    cleanupProjectWarning(warning, async () => {
      await destinationQuery.refetch();
    })}
  {warnings}
/>
{#if projectWarningCleanupError}
  <p aria-live="polite" role="status">{projectWarningCleanupError}</p>
{/if}
{#snippet summary()}
  {@render activeFilterSummary(staleForRequest)}
{/snippet}
{#snippet sessions()}
  {#if sessionsDestinationModule}
    {@const SessionsDestination = sessionsDestinationModule.default}
    <SessionsDestination
      destinationScope={commit?.destination.kind === 'sessions' ? commit.destination.sessions : destination.sessions}
      initialSessionWindowAnchor={sessionWindowAnchorOwner.available()}
      {navigate}
      onCampaignControlsChange={(binding) => (campaignSessionControls = binding)}
      onIncreaseQueryDepth={increaseSessionDepth}
      onInitialSessionWindowAnchor={sessionWindowAnchorOwner.consume}
      onRowsChange={(rows) => (detailRows = rows)}
      onSelectionChange={(nextSelection) => {
        if (sessionDrawerClosing) {
          return;
        }
        selection = nextSelection;
        selectedRowId = nextSelection?.row.rowId ?? null;
      }}
      onSessionCountChange={(sessionCount) => (servedSessionCount = sessionCount)}
      pending={destinationQuery.isFetching}
      presentRow={presentSessionRow}
      queryData={commit?.sessions}
      queryIntent={activeSessionWindowIntent}
      {search}
      selectedCampaignKey={selection?.row.campaignKey}
      {selectedRowId}
    />
  {/if}
{/snippet}
{#snippet breakdownDestination()}
  {#if commit?.breakdown && dashboardBreakdownModule}
    {@const DashboardBreakdown = dashboardBreakdownModule.default}
    <DashboardBreakdown
      data={{
        cursorRows: commit.breakdown.context.cursorCommitAttribution,
        generatedAt: bootstrap.support.generatedAt,
        harnesses: commit.breakdown.groups.harnesses,
        harnessProviders: commit.breakdown.groups.harnessProviders,
        models: commit.breakdown.groups.models,
        projects: commit.breakdown.groups.projects,
        range: commit.destination.query.range,
      }}
      navigation={{
        onSortChange: navigation.setBreakdownSort,
        onTabChange: navigation.setBreakdownTab,
        sort: search.breakdownSort,
        tab: search.tab,
      }}
      onFieldFilter={navigation.setFieldFilter}
      onHarnessFilter={(value) =>
        navigation.setHarness(
          search.harness.includes(value)
            ? search.harness.filter((item) => item !== value)
            : [...search.harness, value],
        )}
      projectEditor={{
        disabled: !mutationsEnabled,
        onSave: async (groups) => {
          await persistProjectGroups(groups);
          await destinationQuery.refetch();
        },
        payload: projectPayload,
      }}
    />
  {/if}
{/snippet}
<ReportDestinationPresentation
  activeView={visiblePrimary}
  breakdown={breakdownDestination}
  breakdownReady={commit?.breakdown !== undefined && dashboardBreakdownModule !== undefined}
  filters={{
    freshnessStatus: machineFreshnessStatusLabel(machineSnapshot),
    freshnessUnavailable: machineSnapshot.kind === 'unavailable',
    harnessOptions: bootstrap.filterOptions.harness,
    isDemo: false,
    machineAttention: machineSnapshot.kind === 'unavailable',
    machineOptions: bootstrap.filterOptions.machine.map(({ value }) => value),
    navigation,
    presentMachineLabel,
    search,
  }}
  hasOutput={visiblePrimary === 'sessions' || commit !== undefined}
  loadFailed={activeDestinationLoadFailed}
  onRetry={retryReportDestination}
  overview={visiblePrimary === 'overview' && commit?.destination.kind === 'overview'
    ? {
        activity: {
          activeSeriesKeys,
          dateDomain: commit.overview.dateDomain,
          dimension,
          generatedAt: bootstrap.support.generatedAt,
          granularity,
          machineFreshnessStatus: machineFreshnessStatusLabel(machineSnapshot),
          navigate,
          onDimensionFilter: navigation.setTimelineDimensionFilter,
          onOptionsChange: updateOverviewOptions,
          onRangeChange: navigation.setDateRange,
          onWindowPreview: (apiValue) => (draggedWindowApiValue = apiValue),
          presentCampaignSeries,
          presentMachineSeries,
          range: search.range,
          revision: commit.overview.revision,
          timeline: commit.overview.timeline,
          value: timelineValue,
        },
        draggedWindowApiValue,
        modelsHref,
        onClearFilters: navigation.clearAllFilters,
        onOpenModels: () => navigation.setBreakdownTab('models'),
        ...(quotaHistoryAvailable ? { onOpenQuotaHistory: () => (quotaHistoryOpen = true) } : {}),
        onSelectDay: selectDay,
        onSelectSession: selectOverviewSession,
        onSelectTimeCell: selectTimeCell,
        presentSessionItem,
        providers,
        range: search.range,
        result: commit.overview,
        totalSessionCount: totalSessions,
      }
    : null}
  pending={workspacePending()}
  range={commit?.overview
    ? {
        hidden: false,
        props: {
          dateDomain: commit.overview.dateDomain,
          generatedAt: bootstrap.support.generatedAt,
          navigate,
          onRangeChange: navigation.setDateRange,
          range: search.range,
        },
      }
    : null}
  refreshError={destinationQuery.error?.message ?? null}
  {sessions}
  sessionsReady={sessionsDestinationModule !== undefined}
  {summary}
/>
<SessionDetailQuerySlot
  {campaignSlot}
  client={sessionClient}
  onClosingChange={(closing) => (sessionDrawerClosing = closing)}
  onFieldFilter={(key, value) => navigation.setFieldFilter(key, value)}
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
<QuotaHistoryOwner
  client={reportClient}
  generation={commit?.descriptor.revision ?? initialDescriptor.revision}
  onClose={() => (quotaHistoryOpen = false)}
  open={quotaHistoryOpen}
  {runtimeMode}
/>
