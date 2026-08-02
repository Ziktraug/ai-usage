import { cx } from '@ai-usage/design-system/css';
import {
  banner,
  bannerError,
  page,
  shell,
  unavailablePanel,
  unavailableText,
  unavailableTitle,
} from '@ai-usage/design-system/report';
import type { FocusedReportQueryScope, FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { activeTimeMatchesLocalTimeCell, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js';
import type { CampaignLabelApi } from './campaign-label-controller';
import {
  indexCampaignLabelOverrides,
  presentCampaignTimelineSeries,
  presentServedCampaignDisplayRow,
} from './campaign-label-overrides';
import { createCampaignLabelRuntime } from './campaign-label-runtime';
import {
  logClientPerf,
  logNavigationPerf,
  measureClientPerf,
  payloadStats,
  resolveClientPerfEnabled,
} from './client-perf';
import { DashboardActiveFilters } from './dashboard-active-filters';
import { DashboardFilterBar } from './dashboard-filter-bar';
import { DashboardHeader } from './dashboard-header';
import { metricComparisonStateFor } from './dashboard-metric-model';
import {
  buildCampaignTableRows,
  buildCampaignViews,
  buildDashboardMetrics,
  buildHarnessGroups,
  buildHarnessProviderGroups,
  buildModelGroups,
  buildPreviousPeriodSummary,
  buildProjectGroupRows,
  buildSortedDashboardRows,
  buildVisibleSummary,
  createFilterSnapshot,
  filterRowsByDateBounds,
  filterTimelineRows,
  hiddenSessionCount,
  machineFilterOptionsForRows,
} from './dashboard-model';
import { createDashboardNavigationController } from './dashboard-navigation-controller';
import { createProjectWarningCleanup } from './dashboard-project-warning-cleanup';
import { buildDashboardReportDestinationScope } from './dashboard-report-destination';
import { createDashboardReportLifecycle, type DashboardReportDestinationScope } from './dashboard-report-lifecycle';
import { DashboardReportWorkspace } from './dashboard-report-workspace';
import {
  breakdownTabFor,
  type DashboardSearch,
  dashboardSearchDefaultsFor,
  defaultDashboardDateRangeMode,
  defaultDashboardOrigins,
  withoutDashboardTimeCell,
} from './dashboard-search';
import { createDashboardServedReportSession } from './dashboard-served-report-session';
import { createDashboardSessionSelection } from './dashboard-session-selection';
import { type DateBounds, shiftCalendarDays, startOfDay, toDateInputValue } from './date-range';
import { createDateRangeController } from './date-range-controller';
import {
  createFocusedReportStore,
  createServedFocusedReportSource,
  type FocusedReportBootstrapDescriptor,
} from './focused-report-client';
import { createFocusedReportE2EFixture } from './focused-report-e2e-fixture';
import {
  type MachineFreshnessSnapshot,
  type MachineLabelPresentation,
  machineFreshnessSnapshotFromFocused,
  machineFreshnessStatusLabel,
  machineLabelPresentationForSnapshot,
} from './manual-transfer-model';
import type { ProviderQuotaSource } from './provider-quota-client';
import { cursorCommitAttributionFacet, demoReportPayload } from './report-data';
import { ReportWarnings } from './report-warnings';
import type { RuntimeMode } from './runtime-mode';
import { sessionAnalysisTargetForSession } from './session-analysis-target';
import {
  buildDashboardSessionQueryScope,
  createServedSessionQuerySource,
  createSessionQueryCoordinator,
  type SessionQueryState,
  sessionRowsForState,
} from './session-query-client';
import { enrichReportRow, fmtDateOnly } from './shared';
import { useSourceControl } from './source-control-context';
import { TimeRangeControl } from './time-range-control';
import { toWebReportPayload, type WebReportPayload, type WebReportPayloadWithoutRows } from './web-report-payload';

const FORM_CONTROL_TAG_PATTERN = /^(INPUT|SELECT|TEXTAREA)$/;
const payloadForFocusedBootstrap = (bootstrap: FocusedSupportResult): WebReportPayload =>
  toWebReportPayload({ ...bootstrap.support, rows: [], tableRows: [] });

const supportForFocusedBootstrap = (bootstrap: FocusedSupportResult): WebReportPayloadWithoutRows => {
  const { rows: _rows, ...support } = payloadForFocusedBootstrap(bootstrap);
  return support;
};

export const Dashboard = (props: {
  campaignLabelApi?: CampaignLabelApi;
  initialPayload?: WebReportPayload;
  machineFreshness: MachineFreshnessSnapshot;
  quotaHistoryFixture?: ProviderQuotaHistoryResult;
  quotaSource?: ProviderQuotaSource;
  runtimeMode?: RuntimeMode;
  servedBootstrap?: FocusedSupportResult;
  servedBootstrapDescriptor?: FocusedReportBootstrapDescriptor;
}) => {
  const sourceControl = useSourceControl();
  const runtimeMode = props.runtimeMode ?? 'live';
  const focusedFixture = runtimeMode === 'e2e' ? createFocusedReportE2EFixture() : undefined;
  const servedBootstrap =
    props.servedBootstrapDescriptor?.bootstrap ?? props.servedBootstrap ?? focusedFixture?.bootstrap;
  const initialPayload =
    props.initialPayload ??
    (servedBootstrap ? payloadForFocusedBootstrap(servedBootstrap) : toWebReportPayload(demoReportPayload));
  const dashboardSearchDefaults = dashboardSearchDefaultsFor(initialPayload.filters.sort);
  const { rows: _initialRows, ...initialSupport } = initialPayload;
  const focusedStore = servedBootstrap ? createFocusedReportStore(servedBootstrap) : undefined;
  const focusedSource = focusedStore ? (focusedFixture?.source ?? createServedFocusedReportSource()) : undefined;
  let restartServedDestination = (): Promise<void> => Promise.resolve();
  const activeMachineFreshness = createMemo(() =>
    focusedStore ? machineFreshnessSnapshotFromFocused(focusedStore.machineFreshness()) : props.machineFreshness,
  );
  const reportSupport = createMemo(() =>
    focusedStore
      ? supportForFocusedBootstrap({
          dateDomain: focusedStore.dateDomain(),
          filterOptions: focusedStore.filterOptions(),
          machineFreshness: focusedStore.machineFreshness(),
          providerRows: focusedStore.providerRows(),
          requestFingerprint: '',
          revision: focusedStore.revision(),
          support: focusedStore.support(),
          truncation: focusedStore.truncation(),
        })
      : initialSupport,
  );
  const supportOmissionCount = createMemo(() => {
    const truncation = focusedStore?.truncation();
    return truncation ? Object.values(truncation).reduce((total, omitted) => total + omitted, 0) : 0;
  });
  const isDemo = runtimeMode === 'demo';
  const campaignLabels = createCampaignLabelRuntime(runtimeMode, props.campaignLabelApi);
  const campaignLabelIndex = createMemo(() => indexCampaignLabelOverrides(campaignLabels.overrides()));
  const hasReportData = Boolean(props.initialPayload || servedBootstrap || runtimeMode !== 'live');
  const servedSessionQueries = Boolean(focusedStore);
  const [servedSessionState, setServedSessionState] = createSignal<SessionQueryState>();
  const servedSessionFingerprint = () => {
    const state = servedSessionState();
    return state ? sessionQueryFingerprint(state.query) : undefined;
  };
  const sessionQueryCoordinator = servedSessionQueries
    ? createSessionQueryCoordinator({
        onStateChange: setServedSessionState,
        ...(focusedStore
          ? {
              onRevisionExpired: () => restartServedDestination(),
              revision: focusedStore.revision,
            }
          : {}),
        source: createServedSessionQuerySource(),
      })
    : undefined;
  const [clientReady, setClientReady] = createSignal(false);
  const [operationError, setOperationError] = createSignal<string | null>(null);
  const navigation = createDashboardNavigationController(dashboardSearchDefaults);
  const {
    clearFieldFilter,
    clearLocalTimeCell,
    columnVisibility,
    commitQueryEdit,
    fieldFilters,
    handleColumnVisibilityChange,
    handleSortingChange,
    harness,
    localTimeCell,
    machine,
    origin,
    query,
    removeHarness,
    removeMachine,
    search,
    setBreakdownSort,
    setFieldFilter,
    setHarness,
    setLocalTimeCell,
    setMachine,
    setOrigin,
    setQuery,
    setTab,
    setTimelineDimensionFilter,
    sorting,
    toggleHarness,
    updateSearch,
  } = navigation;
  const servedSessionViewActive = () => servedSessionQueries && search().tab === 'sessions';
  const localTimeCellQueryInput = createMemo(() => {
    const cell = localTimeCell();
    return cell === undefined ? {} : { localTimeCell: cell };
  });
  const generatedAt = createMemo(() => new Date(reportSupport().generatedAt));
  const reportRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.reportRows',
      () => initialPayload.rows.map(enrichReportRow),
      (rows) => ({
        rows: rows.length,
      }),
    ),
  );
  let searchInputEl: HTMLInputElement | undefined;
  const cursorCommitRows = createMemo(() =>
    focusedStore
      ? (focusedStore.breakdown()?.context.cursorCommitAttribution ?? [])
      : cursorCommitAttributionFacet(reportSupport()),
  );
  const harnessOptions = createMemo(() =>
    focusedStore ? focusedStore.filterOptions().harness : [...new Set(reportRows().map((row) => row.harness))],
  );
  const machineOptions = createMemo(() =>
    focusedStore ? focusedStore.filterOptions().machine : machineFilterOptionsForRows(reportRows()),
  );
  const machineOptionLabels = createMemo(
    () => new Map(machineOptions().map(({ label, value }) => [value, label] as const)),
  );
  const machinePresentations = createMemo(() => {
    const presentations = new Map<string, MachineLabelPresentation>();
    for (const { label, value } of machineOptions()) {
      presentations.set(value, machineLabelPresentationForSnapshot({ id: value, label }, activeMachineFreshness()));
    }
    return presentations;
  });
  const machineFreshnessStatus = createMemo(() => machineFreshnessStatusLabel(activeMachineFreshness()));
  const presentMachineLabel = (value: string): string =>
    machinePresentations().get(value)?.label ?? machineOptionLabels().get(value) ?? value;
  const machineOptionValues = createMemo(() => machineOptions().map(({ value }) => value));
  const hasMachineFreshnessAttention = createMemo(() =>
    machineOptions().some(({ value }) => machinePresentations().get(value)?.freshness !== 'fresh'),
  );
  const filterSnapshot = createMemo(() =>
    createFilterSnapshot(query(), harness(), machine(), fieldFilters(), origin()),
  );
  const timelineRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.timelineRows',
      () =>
        filterTimelineRows(reportRows(), filterSnapshot()).filter((row) =>
          activeTimeMatchesLocalTimeCell(row.activeTime, localTimeCell(), reportSupport().timeZone),
        ),
      (rows) => ({ rows: rows.length }),
    ),
  );
  const focusedDateDomain = createMemo(() => {
    if (!focusedStore) {
      return null;
    }
    const overview = focusedStore.overview();
    const domain = overview ? overview.dateDomain : focusedStore.dateDomain();
    return domain ? { maxDay: new Date(domain.last), minDay: new Date(domain.first) } : null;
  });
  const initialRange = search().range;
  const dateRange = createDateRangeController({
    ...(focusedStore ? { domain: focusedDateDomain } : {}),
    generatedAt,
    rows: timelineRows,
    defaultFrom: toDateInputValue(startOfDay(shiftCalendarDays(generatedAt(), -6))),
    defaultTo: toDateInputValue(generatedAt()),
    formatDate: fmtDateOnly,
    initialMode: initialRange.mode,
    ...(initialRange.from ? { initialFrom: initialRange.from } : {}),
    ...(initialRange.to ? { initialTo: initialRange.to } : {}),
  });
  const [tableDateBounds, setTableDateBounds] = createSignal<DateBounds>(dateRange.bounds());
  const focusedQueryScopeForRevision = (revision: string): FocusedReportQueryScope => {
    if (!focusedStore) {
      throw new Error('Focused report queries require a served report store');
    }
    const sessionScope = buildDashboardSessionQueryScope({
      fields: fieldFilters(),
      harness: harness(),
      ...localTimeCellQueryInput(),
      machine: machine(),
      origin: origin(),
      query: query(),
      range: tableDateBounds(),
      sorting: sorting(),
    });
    return {
      filters: sessionScope.filters,
      range: sessionScope.range,
      revision,
    };
  };
  const focusedQueryScope = (): FocusedReportQueryScope => {
    if (!focusedStore) {
      throw new Error('Focused report queries require a served report store');
    }
    return focusedQueryScopeForRevision(focusedStore.revision());
  };
  const focusedOverviewForDisplay = createMemo(() => focusedStore?.overviewForDisplay());
  const activeSessionQueryScope = () =>
    buildDashboardSessionQueryScope({
      fields: fieldFilters(),
      harness: harness(),
      ...localTimeCellQueryInput(),
      machine: machine(),
      origin: origin(),
      query: query(),
      range: tableDateBounds(),
      sorting: sorting(),
    });
  const sessionTableQueryResetKey = createMemo(() => {
    const revision = focusedStore?.revision() ?? 'local-report';
    return `${revision}:${sessionQueryFingerprint({
      ...activeSessionQueryScope(),
      cursor: null,
      revision,
    })}`;
  });
  const searchRangeFromDateRange = (): DashboardSearch['range'] => {
    const mode = dateRange.mode();
    if (mode !== 'custom') {
      return { mode };
    }
    const values = dateRange.inputValues();
    return {
      mode,
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
    };
  };
  const commitTableDateRange = () => {
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({ ...current, range: searchRangeFromDateRange() }));
  };
  createEffect(() => {
    const range = search().range;
    untrack(() => {
      const values = dateRange.inputValues();
      const matchesRange =
        dateRange.mode() === range.mode &&
        (range.mode !== 'custom' || (values.from === (range.from ?? '') && values.to === (range.to ?? '')));
      if (!matchesRange) {
        dateRange.setRange(range.mode, range.from, range.to);
      }
      setTableDateBounds(dateRange.bounds());
    });
  });
  const tableFilteredRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.tableFilteredRows',
      () => filterRowsByDateBounds(timelineRows(), tableDateBounds()),
      (rows) => ({ rows: rows.length }),
    ),
  );
  const tableRows = tableFilteredRows;
  // Rows in the table's current sort order drive drawer previous/next navigation.
  const sortedRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.sortedRows',
      () => buildSortedDashboardRows(tableFilteredRows(), sorting()),
      (rows) => ({ rows: rows.length }),
    ),
  );
  const campaignViews = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.campaignViews',
      () => buildCampaignViews(reportRows(), tableFilteredRows(), campaignLabels.labelFor),
      (campaigns) => ({ campaigns: campaigns.length }),
    ),
  );
  const sessionTableRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.sessionTableRows',
      () => buildCampaignTableRows(reportRows(), tableFilteredRows(), sorting(), campaignViews()),
      (rows) => ({ rows: rows.length }),
    ),
  );
  const visibleSessionTableRows = createMemo(() =>
    servedSessionQueries
      ? sessionRowsForState(servedSessionState()).map((row) =>
          presentServedCampaignDisplayRow(row, campaignLabelIndex()),
        )
      : sessionTableRows(),
  );
  const sessionSelection = createDashboardSessionSelection({
    local: { campaigns: campaignViews, reportRows, sortedRows },
    onError: setOperationError,
    overviewRevision: () => focusedStore?.revision() ?? null,
    ...(sessionQueryCoordinator
      ? {
          served: {
            active: servedSessionViewActive,
            coordinator: sessionQueryCoordinator,
            rows: visibleSessionTableRows,
            state: servedSessionState,
          },
        }
      : {}),
  });
  const drawerNavigationProps = createMemo(() => {
    const navigation = sessionSelection.drawerNavigation();
    return navigation ? { navigation } : {};
  });
  const selectedCampaignLabelEditor = createMemo(() => {
    if (isDemo) {
      return;
    }
    const context = sessionSelection.selectedCampaignLabelContext();
    if (!context) {
      return;
    }
    return {
      campaignKey: context.campaignKey,
      effectiveLabel: campaignLabels.labelFor(context.campaignKey, context.derivedLabel),
      hasOverride: campaignLabels.overrideFor(context.campaignKey) !== undefined,
      loadError: campaignLabels.loadError(),
      loadStatus: campaignLabels.loadStatus(),
      mutationError: campaignLabels.mutationError(),
      mutationStatus: campaignLabels.mutationStatus(),
      onRename: (label: string) => campaignLabels.rename(context.campaignKey, label),
      onReset: () => campaignLabels.reset(context.campaignKey, context.derivedLabel),
      onRetry: campaignLabels.retryLoad,
    };
  });
  const selectedCampaignLabelEditorProps = () => {
    const editor = selectedCampaignLabelEditor();
    return editor ? { campaignLabelEditor: editor } : {};
  };
  const servedReportSession =
    focusedSource && focusedStore && sessionQueryCoordinator
      ? createDashboardServedReportSession({
          focusedSource,
          focusedStore,
          ...(props.servedBootstrapDescriptor ? { initialDescriptor: props.servedBootstrapDescriptor } : {}),
          sessionCoordinator: sessionQueryCoordinator,
        })
      : undefined;
  const destinationScope = createMemo<DashboardReportDestinationScope | undefined>(() => {
    if (!(focusedStore && servedReportSession)) {
      return;
    }
    return buildDashboardReportDestinationScope(search().tab, focusedQueryScope(), activeSessionQueryScope());
  });
  const reportLifecycle = createDashboardReportLifecycle({
    currentOverviewRequestFingerprint: () => focusedStore?.overview()?.requestFingerprint,
    currentRevision: () => focusedStore?.revision() ?? 'unavailable',
    destinationScope,
    onError: setOperationError,
    publicationRevision: () => {
      const state = sourceControl.state();
      return state.publication?.revision ?? state.snapshot?.publication.revision;
    },
    ready: clientReady,
    sessionState: servedSessionState,
    ...(servedReportSession ? { servedReportSession } : {}),
    ...(sessionQueryCoordinator ? { sessionCoordinator: sessionQueryCoordinator } : {}),
  });
  const focusedFilterFingerprint = createMemo(() =>
    focusedStore ? JSON.stringify(focusedQueryScope().filters) : undefined,
  );
  const [committedOverviewFilterFingerprint, setCommittedOverviewFilterFingerprint] = createSignal<string>();
  let committedOverview = focusedStore?.overview();
  createEffect(() => {
    const overview = focusedStore?.overview();
    if (!overview || overview === committedOverview) {
      return;
    }
    committedOverview = overview;
    setCommittedOverviewFilterFingerprint(untrack(focusedFilterFingerprint));
  });
  const focusedTimelineFiltersAreStale = (): boolean => {
    const committedFingerprint = committedOverviewFilterFingerprint();
    const requestedFingerprint = focusedFilterFingerprint();
    return (
      reportLifecycle.destinationPending() &&
      committedFingerprint !== undefined &&
      requestedFingerprint !== committedFingerprint
    );
  };
  restartServedDestination = reportLifecycle.refresh;
  createEffect(() => {
    if (!sessionSelection.selectedRow()) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => sessionSelection.handleKeyDown(event);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });
  // "/" jumps to the filter input, mirroring the CLI feel of the report.
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (FORM_CONTROL_TAG_PATTERN.test(target.tagName) || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      searchInputEl?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });
  onMount(() => {
    if (runtimeMode !== 'live') {
      return;
    }
    resolveClientPerfEnabled()
      .then((enabled) => {
        if (!enabled) {
          return;
        }
        logNavigationPerf(initialPayload);
        requestAnimationFrame(() => {
          logClientPerf('aiUsage.web.client.initialFrame', payloadStats(initialPayload));
        });
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  });
  const visibleSummary = createMemo(
    () =>
      focusedStore?.overview()?.summary ??
      measureClientPerf('aiUsage.web.client.compute.visibleSummary', () =>
        buildVisibleSummary(timelineRows(), dateRange.bounds()),
      ),
  );
  const modelGroups = createMemo(() => {
    if (search().tab !== 'models') {
      return [];
    }
    return (
      focusedStore?.breakdown()?.groups.models ??
      buildModelGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost)
    );
  });
  const harnessGroups = createMemo(() => {
    if (breakdownTabFor(search().tab) !== 'harness-providers') {
      return [];
    }
    return (
      focusedStore?.breakdown()?.groups.harnesses ??
      buildHarnessGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost)
    );
  });
  const harnessProviderGroups = createMemo(() => {
    if (breakdownTabFor(search().tab) !== 'harness-providers') {
      return [];
    }
    return (
      focusedStore?.breakdown()?.groups.harnessProviders ??
      buildHarnessProviderGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost)
    );
  });
  const projectGroupRows = createMemo(() => {
    if (search().tab !== 'projects') {
      return [];
    }
    return focusedStore?.breakdown()?.groups.projects ?? buildProjectGroupRows(timelineRows(), dateRange.bounds());
  });
  const projectGroupPayload = createMemo(() => {
    if (!focusedStore) {
      return reportSupport();
    }
    const context = focusedStore.breakdown()?.context;
    return {
      ...(context?.projectGroupConfigs ? { projectGroupConfigs: context.projectGroupConfigs } : {}),
      ...(context?.projectGroups ? { projectGroups: context.projectGroups } : {}),
    };
  });
  const totalSessionCount = () => (focusedStore ? focusedStore.support().analytics.sessionCount : reportRows().length);
  const visibleSessionCount = () =>
    servedSessionViewActive() ? (servedSessionState()?.sessionCount ?? 0) : visibleSummary().sessionCount;
  const hiddenCount = createMemo(() => hiddenSessionCount(totalSessionCount(), visibleSessionCount()));
  const previousSummary = createMemo(() => {
    if (focusedStore) {
      return focusedStore.overview()?.view.previousSummary ?? null;
    }
    return buildPreviousPeriodSummary(timelineRows(), dateRange.bounds(), generatedAt());
  });
  const metricComparisonState = createMemo(() => metricComparisonStateFor(dateRange.mode(), previousSummary()));
  const saveProjectGroupConfigs = async (projectGroups: ProjectGroupConfig[]) => {
    if (!focusedStore) {
      throw new Error('Project groups require a served report revision.');
    }
    if (sourceControl.state().connection !== 'live') {
      throw new Error('Project group mutations require a live compatible usage engine.');
    }
    const [{ buildProjectGroupReferenceCommand }, { saveProjectGroups }] = await Promise.all([
      import('./project-group-control'),
      import('./server/report-payload'),
    ]);
    const command = await buildProjectGroupReferenceCommand(projectGroups, focusedStore.revision());
    await saveProjectGroups({ data: command });
  };
  const projectWarningCleanup = createProjectWarningCleanup({
    focusedQueryScope,
    ...(focusedSource ? { focusedSource } : {}),
    ...(focusedStore ? { focusedStore } : {}),
    onError: setOperationError,
    projectGroupConfigs: () => reportSupport().projectGroupConfigs ?? [],
    save: saveProjectGroupConfigs,
  });
  onMount(() => setClientReady(true));
  const focusDay = (day: Date) => {
    const value = toDateInputValue(day);
    dateRange.setCustom(value, value);
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({
      ...current,
      range: searchRangeFromDateRange(),
      tab: 'sessions',
    }));
  };
  const clearFilters = () => {
    dateRange.setRange(defaultDashboardDateRangeMode);
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({
      ...withoutDashboardTimeCell(current),
      filters: {},
      harness: [],
      origin: [...defaultDashboardOrigins],
      machine: [],
      q: '',
      range: { mode: defaultDashboardDateRangeMode },
    }));
  };
  const sessionDrawerProps = () => {
    const row = sessionSelection.selectedRow();
    if (!row) {
      return;
    }
    return {
      ...drawerNavigationProps(),
      ...selectedCampaignLabelEditorProps(),
      onClearFilters: clearFilters,
      onClose: sessionSelection.close,
      onFieldFilter: setFieldFilter,
      onNavigate: sessionSelection.navigate,
      onSelectSession: sessionSelection.selectDrawerSession,
      revision: sessionSelection.analysisRevision(),
      row,
      rows: sessionSelection.drawerRows(),
      selectedCampaign: sessionSelection.selectedCampaign(),
      target: sessionSelection.analysisTarget() ?? sessionAnalysisTargetForSession(row),
    };
  };
  const metrics = createMemo(() =>
    measureClientPerf('aiUsage.web.client.compute.metrics', () =>
      buildDashboardMetrics(visibleSummary(), previousSummary()),
    ),
  );

  return (
    <main
      class={page}
      data-hydrated={clientReady() ? 'true' : 'false'}
      data-report-revision={servedSessionState()?.query.revision}
      data-request-fingerprint={servedSessionFingerprint()}
    >
      <div class={shell}>
        <DashboardHeader generatedAt={reportSupport().generatedAt} hasReportData={hasReportData} isDemo={isDemo} />

        <Show when={hasReportData}>
          <DashboardFilterBar
            freshnessStatus={machineFreshnessStatus()}
            freshnessUnavailable={activeMachineFreshness().kind === 'unavailable'}
            harness={{ onChange: setHarness, options: harnessOptions(), value: harness() }}
            isDemo={isDemo}
            machine={{
              attention: hasMachineFreshnessAttention(),
              labelFor: presentMachineLabel,
              onChange: setMachine,
              options: machineOptionValues(),
              value: machine(),
            }}
            onOriginChange={setOrigin}
            origin={origin()}
            query={{
              inputRef: (element) => {
                searchInputEl = element;
              },
              onCommit: commitQueryEdit,
              onInput: setQuery,
              value: query(),
            }}
          />
        </Show>

        <Show when={operationError()}>{(message) => <div class={cx(banner, bannerError)}>{message()}</div>}</Show>

        <Show
          fallback={
            <section class={unavailablePanel}>
              <div class={unavailableTitle}>Real report data is not loaded</div>
              <div class={unavailableText}>
                The CLI payload was not injected into this page, so usage metrics are hidden instead of showing demo
                fixture data.
              </div>
            </section>
          }
          when={hasReportData}
        >
          <div hidden={focusedTimelineFiltersAreStale()}>
            <TimeRangeControl
              {...(reportLifecycle.available ? { onFocusedTimelineRequest: reportLifecycle.requestTimeline } : {})}
              activeFieldFilters={fieldFilters()}
              activeHarness={harness()}
              activeMachine={machine()}
              campaignRows={reportRows()}
              dateRange={dateRange}
              focusedTimeline={focusedStore ? (focusedStore.overview()?.timeline ?? null) : undefined}
              focusedTimelineError={reportLifecycle.focusedTimelineError()}
              focusedTimelineLoading={reportLifecycle.focusedTimelineLoading()}
              onDateRangeCommit={commitTableDateRange}
              onDimensionFilter={setTimelineDimensionFilter}
              presentCampaignSeries={(series) => presentCampaignTimelineSeries(series, campaignLabelIndex())}
              presentMachineLabel={presentMachineLabel}
              rows={timelineRows()}
            />
          </div>

          <DashboardActiveFilters
            actions={{
              clearAll: clearFilters,
              clearField: clearFieldFilter,
              clearHarness: removeHarness,
              clearMachine: removeMachine,
              clearTimeCell: clearLocalTimeCell,
              setQuery,
            }}
            counts={{
              hidden: hiddenCount(),
              pending: reportLifecycle.destinationPending(),
              total: totalSessionCount(),
              visible: visibleSessionCount(),
            }}
            presentMachineLabel={presentMachineLabel}
            search={search()}
          />

          <ReportWarnings
            cleaningProjectWarningGroupId={projectWarningCleanup.cleaningGroupId()}
            cleanupDisabled={sourceControl.state().connection !== 'live'}
            omittedSupportItemCount={supportOmissionCount()}
            onCleanupProjectWarning={projectWarningCleanup.cleanup}
            warnings={reportSupport().warnings}
          />

          <DashboardReportWorkspace
            breakdown={{
              data: {
                cursorRows: cursorCommitRows(),
                generatedAt: reportSupport().generatedAt,
                harnesses: harnessGroups(),
                harnessProviders: harnessProviderGroups(),
                models: modelGroups(),
                projects: projectGroupRows(),
              },
              navigation: {
                onSortChange: setBreakdownSort,
                onTabChange: setTab,
                sort: search().breakdownSort,
                tab: search().tab,
              },
              onFieldFilter: setFieldFilter,
              onHarnessFilter: toggleHarness,
              projectEditor: {
                disabled: !reportLifecycle.available || sourceControl.state().connection !== 'live',
                onSave: saveProjectGroupConfigs,
                payload: projectGroupPayload(),
              },
            }}
            drawer={sessionDrawerProps()}
            overview={{
              advancedAnalysisError: reportLifecycle.advancedAnalysisError(),
              advancedAnalysisLoading: reportLifecycle.advancedAnalysisLoading(),
              campaigns: campaignViews(),
              focused: focusedOverviewForDisplay(),
              labelFor: campaignLabels.labelFor,
              onSelectDay: focusDay,
              onSelectSession: sessionSelection.inspectOverview,
              onSelectTimeCell: setLocalTimeCell,
              rangeLabel: dateRange.label(),
              rows: tableRows(),
              summary: visibleSummary(),
              timelineRows: timelineRows(),
              timeZone: reportSupport().timeZone,
            }}
            pending={reportLifecycle.destinationPending}
            sessions={{
              ...(servedSessionState()
                ? {
                    campaignChildren: servedSessionState()!.campaignChildren,
                    loadingMoreRows: servedSessionState()!.loadingMore,
                    totalRows: servedSessionState()!.itemCount,
                  }
                : {}),
              ...(sessionQueryCoordinator
                ? {
                    onLoadCampaignChildren: (campaignKey: string) => {
                      sessionQueryCoordinator.loadCampaignChildren(campaignKey).catch((error: unknown) => {
                        setOperationError(error instanceof Error ? error.message : 'Failed to load campaign sessions');
                      });
                    },
                    onLoadMoreRows: () => {
                      sessionQueryCoordinator.loadMore().catch((error: unknown) => {
                        setOperationError(error instanceof Error ? error.message : 'Failed to load sessions');
                      });
                    },
                  }
                : {}),
              columnVisibility: columnVisibility(),
              hasMoreRows: Boolean(servedSessionState()?.nextCursor),
              loading: reportLifecycle.sessionQueryLoading(),
              onClearFilters: clearFilters,
              onColumnVisibilityChange: handleColumnVisibilityChange,
              onFieldFilter: setFieldFilter,
              onHarnessFilter: toggleHarness,
              onSelect: sessionSelection.toggleTableRow,
              onSortingChange: handleSortingChange,
              queryResetKey: sessionTableQueryResetKey(),
              rows: visibleSessionTableRows(),
              searchQuery: query(),
              selectedKey: sessionSelection.selectedKey(),
              sorting: sorting(),
            }}
            status={
              !reportLifecycle.destinationPending() && search().tab === 'overview'
                ? {
                    comparisonState: metricComparisonState(),
                    metrics: metrics(),
                    providerStatus: {
                      ...(props.quotaHistoryFixture === undefined
                        ? {}
                        : { quotaHistoryFixture: props.quotaHistoryFixture }),
                      ...(props.quotaSource === undefined ? {} : { quotaSource: props.quotaSource }),
                      report: reportSupport(),
                      rows: focusedStore ? focusedStore.providerRows() : reportRows(),
                      runtimeMode,
                      served: Boolean(focusedStore),
                    },
                  }
                : undefined
            }
            tab={search().tab}
          />
        </Show>
      </div>
    </main>
  );
};
