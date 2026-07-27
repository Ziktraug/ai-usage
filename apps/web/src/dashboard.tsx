import { MultiSelect, Tabs } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import {
  activeFilters,
  banner,
  bannerError,
  demoBadge,
  eyebrow,
  eyebrowRow,
  filterSummary,
  ghostButton,
  header,
  headerTop,
  meta,
  page,
  searchInput,
  section,
  shell,
  summaryPill,
  title,
  titleBlock,
  unavailablePanel,
  unavailableText,
  unavailableTitle,
} from '@ai-usage/design-system/report';
import type { FocusedReportQueryScope, FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import {
  type ProjectGroupConfig,
  type ProjectSourceSelector,
  projectSourceSelectorKey,
} from '@ai-usage/report-core/project-group';
import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { isSessionOrigin, type SessionOrigin, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import { useNavigate, useSearch } from '@tanstack/solid-router';
import type { OnChangeFn, SortingState, Updater, VisibilityState } from '@tanstack/solid-table';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
  untrack,
} from 'solid-js';
import {
  logClientPerf,
  logNavigationPerf,
  measureClientPerf,
  payloadStats,
  resolveClientPerfEnabled,
} from './client-perf';
import { SourceControlSummary } from './components/source-control-summary';
import { CursorAttributionPanel } from './cursor-attribution-panel';
import { FilterPill, fieldFilterLabels } from './dashboard-filters';
import { dashboardMetricGrid, MetricTile } from './dashboard-metrics';
import {
  buildCampaignTableRows,
  buildCampaignViews,
  buildDashboardMetrics,
  buildHarnessGroups,
  buildModelGroups,
  buildPreviousPeriodSummary,
  buildProjectGroupRows,
  buildProviderGroups,
  buildSortedDashboardRows,
  buildVisibleSummary,
  createFilterSnapshot,
  filterRowsByDateBounds,
  filterTimelineRows,
  hiddenSessionCount,
  machineFilterOptionsForRows,
} from './dashboard-model';
import { DashboardProviderStatus } from './dashboard-provider-status';
import { createDashboardReportLifecycle, type DashboardReportDestinationScope } from './dashboard-report-lifecycle';
import {
  breakdownTabFor,
  type DashboardSearch,
  dashboardSearchDefaultsFor,
  defaultDashboardDateRangeMode,
  defaultDashboardOrigins,
  type FieldFilterKey,
  type FieldFilters,
  hasActiveDashboardFilters,
  isDashboardTab,
  primaryDashboardTabFor,
  sortingStateFromSearch,
  toggleExactFieldFilter,
} from './dashboard-search';
import { createDashboardServedReportSession } from './dashboard-served-report-session';
import { createDashboardSessionSelection } from './dashboard-session-selection';
import { type DateBounds, shiftCalendarDays, startOfDay, toDateInputValue } from './date-range';
import { createDateRangeController } from './date-range-controller';
import {
  createFocusedReportStore,
  createServedFocusedReportSource,
  fetchFocusedBreakdown,
} from './focused-report-client';
import { GroupPanel } from './group-panel';
import {
  type MachineFreshnessSnapshot,
  type MachineLabelPresentation,
  machineLabelPresentation,
} from './manual-transfer-model';
import { OriginFilter } from './origin-filter';
import { Overview } from './overview';
import type { TimelineDimension } from './overview-model';
import { ProjectGroupEditor } from './project-group-editor';
import { ProjectSummary } from './project-summary';
import type { ProviderQuotaSource } from './provider-quota-client';
import { cursorCommitAttributionFacet, demoReportPayload } from './report-data';
import { ReportWarnings } from './report-warnings';
import type { RuntimeMode } from './runtime-mode';
import { sessionAnalysisTargetForSession } from './session-analysis-target';
import { SessionDrawer } from './session-drawer';
import {
  buildDashboardSessionQueryScope,
  createServedSessionQuerySource,
  createSessionQueryCoordinator,
  type SessionQueryState,
  sessionRowsForState,
} from './session-query-client';
import {
  columnVisibilityFromDiff,
  columnVisibilitySearchForVisibility,
  sortFromSortingState,
} from './session-table-schema';
import { enrichReportRow, fmtDate, fmtDateOnly, fmtNum } from './shared';
import { useSourceControl } from './source-control-context';
import { applyTableUpdate } from './table-utils';
import { TimeRangeControl } from './time-range-control';
import { toWebReportPayload, type WebReportPayload, type WebReportPayloadWithoutRows } from './web-report-payload';

const FORM_CONTROL_TAG_PATTERN = /^(INPUT|SELECT|TEXTAREA)$/;
const SessionTable = lazy(async () => {
  const module = await import('./session-table');
  return { default: module.SessionTable };
});

const secondaryMetrics = css({
  my: '20px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

const secondaryMetricsHeader = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  p: '14px 16px',
  color: 'ink',
  fontWeight: 600,
  borderBottom: '1px solid token(colors.line)',
});

const secondaryMetricsTitle = css({
  m: 0,
  fontSize: 'inherit',
  fontWeight: 'inherit',
});

const secondaryMetricsGrid = css({
  display: 'block',
  px: '14px',
  pb: '14px',
  '& > div': { my: '14px' },
});

const dashboardFilterToolbar = css({
  position: { base: 'static', md: 'sticky' },
  top: '0',
  zIndex: 20,
  display: 'flex',
  flexDirection: { base: 'column', sm: 'row' },
  flexWrap: { base: 'nowrap', sm: 'wrap' },
  gap: { base: '8px', sm: '10px' },
  alignItems: 'center',
  py: { base: '8px', sm: '12px' },
  bg: 'canvas',
  borderBottom: '1px solid token(colors.line)',
  _print: { display: 'none' },
  '& > input': {
    flex: { base: 'none', sm: '1 1 240px' },
    minW: { base: 0, sm: '180px' },
    w: { base: 'full', sm: 'auto' },
  },
});

const dashboardFilterControls = css({
  display: { base: 'grid', sm: 'contents' },
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  w: { base: 'full', sm: 'auto' },
  gap: { base: '8px', sm: '0' },
  alignItems: 'center',
  '& > *': { minW: 0, w: { base: 'full', sm: 'auto' } },
  '& > :last-child:nth-child(odd)': { gridColumn: { base: '1 / -1', sm: 'auto' } },
});

const dashboardLayout = css({
  display: 'flex',
  flexDirection: 'column',
});

const dashboardView = css({
  order: 1,
});

const dashboardStatus = css({
  order: 2,
});

const removeSelectors = (sources: ProjectSourceSelector[], selectors: ProjectSourceSelector[]) => {
  const removed = new Set(selectors.map(projectSourceSelectorKey));
  return sources.filter((source) => !removed.has(projectSourceSelectorKey(source)));
};

const payloadForFocusedBootstrap = (bootstrap: FocusedSupportResult): WebReportPayload =>
  toWebReportPayload({ ...bootstrap.support, rows: [], tableRows: [] });

const supportForFocusedBootstrap = (bootstrap: FocusedSupportResult): WebReportPayloadWithoutRows => {
  const { rows: _rows, ...support } = payloadForFocusedBootstrap(bootstrap);
  return support;
};

export const Dashboard = (props: {
  initialPayload?: WebReportPayload;
  machineFreshness: MachineFreshnessSnapshot;
  quotaHistoryFixture?: ProviderQuotaHistoryResult;
  quotaSource?: ProviderQuotaSource;
  runtimeMode?: RuntimeMode;
  servedBootstrap?: FocusedSupportResult;
}) => {
  const sourceControl = useSourceControl();
  const initialPayload =
    props.initialPayload ??
    (props.servedBootstrap ? payloadForFocusedBootstrap(props.servedBootstrap) : toWebReportPayload(demoReportPayload));
  const dashboardSearchDefaults = dashboardSearchDefaultsFor(initialPayload.filters.sort);
  const { rows: _initialRows, ...initialSupport } = initialPayload;
  const focusedStore = props.servedBootstrap ? createFocusedReportStore(props.servedBootstrap) : undefined;
  const focusedSource = focusedStore ? createServedFocusedReportSource() : undefined;
  let restartServedDestination = (): Promise<void> => Promise.resolve();
  const reportSupport = createMemo(() =>
    focusedStore
      ? supportForFocusedBootstrap({
          dateDomain: focusedStore.dateDomain(),
          filterOptions: focusedStore.filterOptions(),
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
  const runtimeMode = props.runtimeMode ?? 'live';
  const isDemo = runtimeMode === 'demo';
  const hasReportData = Boolean(props.initialPayload || props.servedBootstrap || runtimeMode !== 'live');
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
  const search = useSearch({ from: '/' });
  const servedSessionViewActive = () => servedSessionQueries && search().tab === 'sessions';
  const navigate = useNavigate({ from: '/' });
  const updateSearch = (
    updater: (current: DashboardSearch) => DashboardSearch,
    options?: { replace?: boolean; resetScroll?: boolean },
  ) => {
    navigate({
      search: updater(search()),
      ...(options?.replace == null ? {} : { replace: options.replace }),
      resetScroll: options?.resetScroll ?? false,
    }).catch((error: unknown) => {
      console.error(error);
    });
  };
  const query = () => search().q;
  const harness = () => search().harness;
  const origin = () => search().origin;
  const machine = () => search().machine;
  const fieldFilters = () => search().filters;
  const sorting = createMemo(() => sortingStateFromSearch(search().sort));
  const [columnVisibility, setColumnVisibility] = createSignal(
    columnVisibilityFromDiff(search().cols, search().colsBase),
  );
  createEffect(() => {
    setColumnVisibility(columnVisibilityFromDiff(search().cols, search().colsBase));
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
    for (const machineFreshness of props.machineFreshness.machines) {
      const presentation = machineLabelPresentation(machineFreshness, props.machineFreshness.observedAt);
      const current = presentations.get(presentation.value);
      if (current?.stale === false && presentation.stale) {
        continue;
      }
      presentations.set(presentation.value, presentation);
    }
    return presentations;
  });
  const presentMachineLabel = (value: string): string =>
    machinePresentations().get(value)?.label ?? machineOptionLabels().get(value) ?? value;
  const machineOptionValues = createMemo(() => machineOptions().map(({ value }) => value));
  const hasStaleMachineOption = createMemo(() =>
    machineOptions().some(({ value }) => machinePresentations().get(value)?.stale === true),
  );
  const filterSnapshot = createMemo(() =>
    createFilterSnapshot(query(), harness(), machine(), fieldFilters(), origin()),
  );
  const timelineRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.timelineRows',
      () => filterTimelineRows(reportRows(), filterSnapshot()),
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
      origin: origin(),
      machine: machine(),
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
      origin: origin(),
      machine: machine(),
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
      () => buildCampaignViews(reportRows(), tableFilteredRows()),
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
    servedSessionQueries ? sessionRowsForState(servedSessionState()) : sessionTableRows(),
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
  const servedReportSession =
    focusedSource && focusedStore && sessionQueryCoordinator
      ? createDashboardServedReportSession({ focusedSource, focusedStore, sessionCoordinator: sessionQueryCoordinator })
      : undefined;
  const destinationScope = createMemo<DashboardReportDestinationScope | undefined>(() => {
    if (!(focusedStore && servedReportSession)) {
      return;
    }
    const { revision: _revision, ...queryScope } = focusedQueryScope();
    const destination = primaryDashboardTabFor(search().tab);
    if (destination === 'overview') {
      return { kind: 'overview', query: queryScope };
    }
    if (destination === 'breakdown') {
      return { kind: 'breakdown', query: queryScope };
    }
    return { kind: 'sessions', query: queryScope, sessions: activeSessionQueryScope() };
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
  const providerGroups = createMemo(() => {
    if (search().tab !== 'providers') {
      return [];
    }
    return (
      focusedStore?.breakdown()?.groups.providers ??
      buildProviderGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost)
    );
  });
  const harnessGroups = createMemo(() => {
    if (search().tab !== 'harnesses') {
      return [];
    }
    return (
      focusedStore?.breakdown()?.groups.harnesses ??
      buildHarnessGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost)
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
  const previousSummary = createMemo(
    () =>
      focusedStore?.overview()?.view.previousSummary ??
      buildPreviousPeriodSummary(timelineRows(), dateRange.bounds(), generatedAt()),
  );
  const saveProjectGroupConfigs = async (projectGroups: ProjectGroupConfig[]) => {
    const { saveProjectGroups } = await import('./server/report-payload');
    await saveProjectGroups({ data: { projectGroups } });
  };
  const [cleanupWarningGroupId, setCleanupWarningGroupId] = createSignal<string>();
  const cleanupProjectWarningForServer = async (
    warning: NonNullable<WebReportPayload['warnings']>[number],
  ): Promise<void> => {
    const groupId = warning.groupId;
    if (!groupId) {
      throw new Error('This project-group warning does not identify a group to clean up');
    }
    let configs = reportSupport().projectGroupConfigs ?? [];
    if (focusedStore && focusedSource) {
      let breakdown = focusedStore.breakdown();
      if (!breakdown?.context.projectGroupConfigs) {
        const request = { query: focusedQueryScope() };
        const result = await fetchFocusedBreakdown(focusedSource, request);
        const applied = focusedStore.applyBreakdown(request, result);
        if (!applied.applied) {
          throw new Error(`Project-group context rejected: ${applied.reason}`);
        }
        breakdown = result;
      }
      configs = breakdown.context.projectGroupConfigs ?? [];
    }
    const target = configs.find((group) => group.id === groupId);
    if (!target) {
      throw new Error(`Project group ${groupId} is no longer available to clean up`);
    }
    const nextGroups =
      warning.reason === 'unmatched-group'
        ? configs.filter((group) => group.id !== groupId)
        : configs.map((group) => {
            if (group.id !== groupId) {
              return group;
            }
            return { ...group, sources: removeSelectors(group.sources, warning.selectors ?? []) };
          });
    await saveProjectGroupConfigs(nextGroups.filter((group) => group.sources.length > 0));
  };
  const cleanupProjectWarning = (warning: NonNullable<WebReportPayload['warnings']>[number]) => {
    const groupId = warning.groupId;
    if (!groupId || cleanupWarningGroupId()) {
      return;
    }
    setCleanupWarningGroupId(groupId);
    cleanupProjectWarningForServer(warning)
      .catch((error: unknown) => {
        setOperationError(error instanceof Error ? error.message : 'Failed to clean up the project group');
      })
      .finally(() => setCleanupWarningGroupId());
  };
  onMount(() => setClientReady(true));
  let activeQueryEdit = false;
  const commitQueryEdit = () => {
    activeQueryEdit = false;
  };
  const setQuery = (q: string) => {
    const replace = activeQueryEdit;
    activeQueryEdit = true;
    updateSearch((current) => ({ ...current, q }), { replace });
  };
  const setHarness = (next: string[]) => updateSearch((current) => ({ ...current, harness: next }));
  const toggleHarness = (name: string) =>
    setHarness(harness().includes(name) ? harness().filter((value) => value !== name) : [...harness(), name]);
  const removeHarness = (name: string) => setHarness(harness().filter((value) => value !== name));
  const setOrigin = (next: SessionOrigin[]) => updateSearch((current) => ({ ...current, origin: next }));
  const toggleOrigin = (value: SessionOrigin) => {
    const current = origin();
    setOrigin(
      current.length === 0 || !current.includes(value)
        ? [value]
        : current.filter((originValue) => originValue !== value),
    );
  };
  const setMachine = (next: string[]) => updateSearch((current) => ({ ...current, machine: next }));
  const toggleMachine = (name: string) =>
    setMachine(machine().includes(name) ? machine().filter((value) => value !== name) : [...machine(), name]);
  const removeMachine = (name: string) => setMachine(machine().filter((value) => value !== name));
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
  const setFieldFilters = (updater: Updater<FieldFilters>) =>
    updateSearch((current) => ({ ...current, filters: applyTableUpdate(updater, current.filters) }));
  const setFieldFilter = (key: FieldFilterKey, value: string) =>
    setFieldFilters((current) => toggleExactFieldFilter(current, key, value));
  const setTimelineDimensionFilter = (dimension: TimelineDimension, value: string) => {
    // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future dimension fails compilation.
    switch (dimension) {
      case 'campaign': {
        const campaignKey = value.startsWith('campaign:') ? value.slice('campaign:'.length) : value;
        setFieldFilter('campaign', campaignKey);
        return;
      }
      case 'origin':
        if (isSessionOrigin(value)) {
          toggleOrigin(value);
        }
        return;
      case 'harness':
        toggleHarness(value);
        return;
      case 'machine':
        toggleMachine(value);
        return;
      case 'model':
      case 'project':
      case 'provider':
        setFieldFilter(dimension, value);
    }
  };
  const clearFieldFilter = (key: FieldFilterKey) =>
    setFieldFilters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const clearFilters = () => {
    dateRange.setRange(defaultDashboardDateRangeMode);
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({
      ...current,
      filters: {},
      harness: [],
      origin: [...defaultDashboardOrigins],
      machine: [],
      q: '',
      range: { mode: defaultDashboardDateRangeMode },
    }));
  };
  const handleSortingChange: OnChangeFn<SortingState> = (updater) =>
    updateSearch((current) => ({
      ...current,
      sort: sortFromSortingState(
        applyTableUpdate(updater, sortingStateFromSearch(current.sort)),
        dashboardSearchDefaults.sort,
      ),
    }));
  const handleColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) => {
    const nextVisibility = applyTableUpdate(updater, columnVisibility());
    setColumnVisibility(nextVisibility);
    updateSearch((current) => ({ ...current, ...columnVisibilitySearchForVisibility(nextVisibility) }), {
      replace: true,
    });
  };
  const setTab = (tab: string) => {
    if (!isDashboardTab(tab)) {
      return;
    }
    updateSearch((current) => ({ ...current, tab }));
  };
  const setPrimaryTab = (tab: string) => {
    setTab(tab === 'breakdown' ? 'models' : tab);
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
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <div class={eyebrowRow}>
                <div class={eyebrow}>ai-usage</div>
                <Show when={isDemo}>
                  <span class={demoBadge}>Demo data</span>
                </Show>
              </div>
              <h1 class={title}>Usage report</h1>
              <div class={meta}>
                <Show fallback="Report payload unavailable" when={hasReportData}>
                  Generated {fmtDate(reportSupport().generatedAt)}
                </Show>
              </div>
            </div>
          </div>
        </header>

        <Show when={hasReportData}>
          <div class={dashboardFilterToolbar} data-dashboard-filter-stack>
            <input
              aria-label="Filter sessions by title, project, model, provider, or harness"
              class={searchInput}
              onBlur={commitQueryEdit}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitQueryEdit();
                }
              }}
              placeholder="Filter by title, project, model…  ( / )"
              ref={(element) => {
                searchInputEl = element;
              }}
              value={query()}
            />
            <div class={dashboardFilterControls}>
              <MultiSelect
                label="Filter by harness"
                noun="harnesses"
                onValueChange={setHarness}
                options={harnessOptions()}
                placeholder="All harnesses"
                value={harness()}
              />
              <OriginFilter onValueChange={setOrigin} value={origin()} />
              <Show when={machineOptions().length > 1 || hasStaleMachineOption()}>
                <MultiSelect
                  label="Filter by machine"
                  noun="machines"
                  onValueChange={setMachine}
                  optionLabel={presentMachineLabel}
                  options={machineOptionValues()}
                  placeholder="All machines"
                  value={machine()}
                />
              </Show>
              <Show when={!isDemo}>
                <SourceControlSummary />
              </Show>
            </div>
          </div>
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
            presentMachineLabel={presentMachineLabel}
            rows={timelineRows()}
          />

          <div class={filterSummary}>
            <span aria-live="polite" class={summaryPill}>
              {fmtNum(visibleSessionCount())} / {fmtNum(totalSessionCount())} sessions
            </span>
            <Show when={hiddenCount() > 0}>
              <span>{fmtNum(hiddenCount())} hidden by filters</span>
            </Show>
            <div class={activeFilters}>
              <Show when={query()}>
                <FilterPill label="Query" onClear={() => setQuery('')} value={query()} />
              </Show>
              <For each={harness()}>
                {(value) => <FilterPill label="Harness" onClear={() => removeHarness(value)} value={value} />}
              </For>
              <For each={machine()}>
                {(value) => (
                  <FilterPill label="Machine" onClear={() => removeMachine(value)} value={presentMachineLabel(value)} />
                )}
              </For>
              <For each={Object.entries(fieldFilters()) as [FieldFilterKey, string][]}>
                {([key, value]) => (
                  <FilterPill label={fieldFilterLabels[key]} onClear={() => clearFieldFilter(key)} value={value} />
                )}
              </For>
            </div>
            <Show when={hasActiveDashboardFilters(search())}>
              <button class={ghostButton} onClick={clearFilters} type="button">
                Clear all
              </button>
            </Show>
          </div>

          <ReportWarnings
            cleaningProjectWarningGroupId={cleanupWarningGroupId()}
            omittedSupportItemCount={supportOmissionCount()}
            onCleanupProjectWarning={cleanupProjectWarning}
            warnings={reportSupport().warnings}
          />

          <div class={dashboardLayout}>
            <div class={dashboardView}>
              <Tabs
                ariaLabel="Dashboard sections"
                items={[
                  {
                    content: () => (
                      <section class={section}>
                        <Overview
                          advancedAnalysisError={reportLifecycle.advancedAnalysisError()}
                          advancedAnalysisLoading={reportLifecycle.advancedAnalysisLoading()}
                          campaigns={campaignViews()}
                          focused={focusedOverviewForDisplay()}
                          onSelectDay={focusDay}
                          onSelectSession={sessionSelection.inspectOverview}
                          rangeLabel={dateRange.label()}
                          rows={tableRows()}
                          summary={visibleSummary()}
                          timelineRows={timelineRows()}
                        />
                      </section>
                    ),
                    label: 'Overview',
                    value: 'overview',
                  },
                  {
                    content: () => (
                      <section class={section}>
                        <Suspense fallback={<div class={unavailableText}>Loading sessions…</div>}>
                          <SessionTable
                            {...(servedSessionState()
                              ? {
                                  campaignChildren: servedSessionState()!.campaignChildren,
                                  loadingMoreRows: servedSessionState()!.loadingMore,
                                  totalRows: servedSessionState()!.itemCount,
                                }
                              : {})}
                            {...(sessionQueryCoordinator
                              ? {
                                  onLoadCampaignChildren: (campaignKey: string) => {
                                    sessionQueryCoordinator
                                      .loadCampaignChildren(campaignKey)
                                      .catch((error: unknown) => {
                                        setOperationError(
                                          error instanceof Error ? error.message : 'Failed to load campaign sessions',
                                        );
                                      });
                                  },
                                  onLoadMoreRows: () => {
                                    sessionQueryCoordinator.loadMore().catch((error: unknown) => {
                                      setOperationError(
                                        error instanceof Error ? error.message : 'Failed to load sessions',
                                      );
                                    });
                                  },
                                }
                              : {})}
                            columnVisibility={columnVisibility()}
                            hasMoreRows={Boolean(servedSessionState()?.nextCursor)}
                            loading={reportLifecycle.sessionQueryLoading()}
                            onClearFilters={clearFilters}
                            onColumnVisibilityChange={handleColumnVisibilityChange}
                            onFieldFilter={setFieldFilter}
                            onHarnessFilter={toggleHarness}
                            onSelect={sessionSelection.toggleTableRow}
                            onSortingChange={handleSortingChange}
                            queryResetKey={sessionTableQueryResetKey()}
                            rows={visibleSessionTableRows()}
                            searchQuery={query()}
                            selectedKey={sessionSelection.selectedKey()}
                            sorting={sorting()}
                          />
                        </Suspense>
                      </section>
                    ),
                    label: 'Sessions',
                    value: 'sessions',
                  },
                  {
                    content: () => (
                      <Tabs
                        ariaLabel="Breakdown dimension"
                        items={[
                          {
                            content: () => (
                              <section class={section}>
                                <GroupPanel
                                  countLabel="models"
                                  groups={modelGroups()}
                                  harnessTones
                                  onFilter={(value) => setFieldFilter('model', value)}
                                  title="By model"
                                />
                              </section>
                            ),
                            label: 'Models',
                            value: 'models',
                          },
                          {
                            content: () => (
                              <section class={section}>
                                <GroupPanel
                                  countLabel="providers"
                                  groups={providerGroups()}
                                  harnessTones
                                  onFilter={(value) => setFieldFilter('provider', value)}
                                  title="By provider"
                                />
                              </section>
                            ),
                            label: 'Providers',
                            value: 'providers',
                          },
                          {
                            content: () => (
                              <section class={section}>
                                <GroupPanel
                                  countLabel="harnesses"
                                  groups={harnessGroups()}
                                  harnessTones
                                  onFilter={toggleHarness}
                                  title="By harness"
                                />
                              </section>
                            ),
                            label: 'Harnesses',
                            value: 'harnesses',
                          },
                          {
                            content: () => (
                              <section class={section}>
                                <ProjectGroupEditor
                                  disabled={!reportLifecycle.available}
                                  onSave={saveProjectGroupConfigs}
                                  payload={projectGroupPayload()}
                                />
                                <ProjectSummary
                                  groups={projectGroupRows()}
                                  onProjectFilter={(value) => setFieldFilter('project', value)}
                                />
                              </section>
                            ),
                            label: 'Projects',
                            value: 'projects',
                          },
                          {
                            content: () => (
                              <section class={section}>
                                <CursorAttributionPanel rows={cursorCommitRows()} />
                              </section>
                            ),
                            label: 'Cursor AI',
                            value: 'cursor-ai',
                          },
                        ]}
                        onValueChange={setTab}
                        value={breakdownTabFor(search().tab)}
                      />
                    ),
                    label: 'Breakdown',
                    value: 'breakdown',
                  },
                ]}
                onValueChange={setPrimaryTab}
                value={primaryDashboardTabFor(search().tab)}
              />
            </div>

            <div class={dashboardStatus}>
              <section aria-labelledby="additional-report-metrics-title" class={secondaryMetrics}>
                <header class={secondaryMetricsHeader}>
                  <h2 class={secondaryMetricsTitle} id="additional-report-metrics-title">
                    More report metrics
                  </h2>
                  <span class={meta}>{metrics().length}</span>
                </header>
                <div class={secondaryMetricsGrid} id="additional-report-metrics">
                  <div class={dashboardMetricGrid} data-metric-grid>
                    <For each={metrics()}>{(metric) => <MetricTile {...metric} />}</For>
                  </div>
                </div>
              </section>

              <DashboardProviderStatus
                {...(props.quotaHistoryFixture === undefined ? {} : { quotaHistoryFixture: props.quotaHistoryFixture })}
                {...(props.quotaSource === undefined ? {} : { quotaSource: props.quotaSource })}
                report={reportSupport()}
                rows={focusedStore ? focusedStore.providerRows() : reportRows()}
                runtimeMode={runtimeMode}
                served={Boolean(focusedStore)}
              />
            </div>
          </div>

          <Show when={sessionSelection.selectedRow()}>
            {(row) => (
              <SessionDrawer
                {...drawerNavigationProps()}
                onClearFilters={clearFilters}
                onClose={sessionSelection.close}
                onFieldFilter={setFieldFilter}
                onNavigate={sessionSelection.navigate}
                onSelectSession={sessionSelection.selectDrawerSession}
                revision={sessionSelection.analysisRevision()}
                row={row()}
                rows={sessionSelection.drawerRows()}
                selectedCampaign={sessionSelection.selectedCampaign()}
                target={sessionSelection.analysisTarget() ?? sessionAnalysisTargetForSession(row())}
              />
            )}
          </Show>
        </Show>
      </div>
    </main>
  );
};
