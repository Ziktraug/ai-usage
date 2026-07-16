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
  headerActions,
  headerTop,
  meta,
  metricGrid,
  navButton,
  page,
  searchInput,
  section,
  shell,
  summaryPill,
  title,
  titleBlock,
  toolbar,
  unavailablePanel,
  unavailableText,
  unavailableTitle,
} from '@ai-usage/design-system/report';
import {
  type FocusedReportQueryScope,
  type FocusedSupportResult,
  type FocusedTimelineDimension,
  type FocusedTimelineGranularity,
  focusedAdvancedAnalysisFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import {
  type ProjectGroupConfig,
  type ProjectSourceSelector,
  projectSourceSelectorKey,
} from '@ai-usage/report-core/project-group';
import type { ProviderQuotaHistoryPoint, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { type SessionNeighborResult, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import type { ProviderQuotaRefreshResult } from '@ai-usage/report-data/provider-quota';
import { Link, useNavigate, useSearch } from '@tanstack/solid-router';
import type { OnChangeFn, SortingState, Updater, VisibilityState } from '@tanstack/solid-table';
import {
  batch,
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
import { MetricTile } from './dashboard-metrics';
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
} from './dashboard-model';
import {
  breakdownTabFor,
  type DashboardSearch,
  dashboardSearchDefaultsFor,
  defaultDashboardDateRangeMode,
  type FieldFilterKey,
  type FieldFilters,
  hasActiveDashboardFilters,
  isDashboardTab,
  primaryDashboardTabFor,
  sortingStateFromSearch,
  toggleExactFieldFilter,
} from './dashboard-search';
import {
  createDashboardServedReportSession,
  type DashboardServedDestination,
  dashboardDestinationTimelineMatches,
} from './dashboard-served-report-session';
import { ThemeToggle } from './dashboard-theme';
import { type DateBounds, shiftCalendarDays, startOfDay, toDateInputValue } from './date-range';
import { createDateRangeController } from './date-range-controller';
import {
  createFocusedReportStore,
  createServedFocusedReportSource,
  fetchFocusedBreakdown,
} from './focused-report-client';
import { GroupPanel } from './group-panel';
import { Overview } from './overview';
import type { TimelineDimension } from './overview-model';
import { ProjectGroupEditor } from './project-group-editor';
import { ProjectSummary } from './project-summary';
import {
  createProviderQuotaPoller,
  createServedProviderQuotaSource,
  type ProviderQuotaSource,
} from './provider-quota-client';
import { type ProviderQuotaHistoryRange, providerQuotaHistoryRequest } from './provider-quota-history-model';
import { ProviderQuotaHistoryPanel } from './provider-quota-history-panel';
import { createProviderStatusClock } from './provider-status-clock';
import { buildProviderStatusViews } from './provider-status-model';
import { ProviderStatusPanel } from './provider-status-panel';
import { cursorCommitAttributionFacet, demoReportPayload } from './report-data';
import { ReportWarnings } from './report-warnings';
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
import { type DashboardRow, enrichReportRow, fmtDate, fmtDateOnly, fmtNum, rowKey } from './shared';
import { applyTableUpdate } from './table-utils';
import { TimeRangeControl } from './time-range-control';
import { toWebReportPayload, type WebReportPayload, type WebReportPayloadWithoutRows } from './web-report-payload';

const FORM_CONTROL_TAG_PATTERN = /^(INPUT|SELECT|TEXTAREA)$/;
const SessionTable = lazy(async () => {
  const module = await import('./session-table');
  return { default: module.SessionTable };
});

const fixtureQuotaPoint = (input: {
  at: string;
  resetAt: string;
  usedPercent: number;
  window: '5h' | 'weekly';
}): ProviderQuotaHistoryPoint => ({
  accountScope: 'fixture-account',
  blocked: false,
  firstObservedAt: input.at,
  group: input.window,
  lastObservedAt: input.at,
  limitSeconds: input.window === '5h' ? 18_000 : 604_800,
  machineId: 'fixture-machine',
  machineLabel: 'Fixture Machine',
  providerKey: 'codex',
  providerLabel: 'Codex',
  resetAt: input.resetAt,
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  usedPercent: input.usedPercent,
  windowId: `codex:${input.window}`,
  windowLabel: input.window === '5h' ? '5h' : 'Weekly',
});

const e2eQuotaHistoryFixture: ProviderQuotaHistoryResult = {
  coverage: [],
  generatedAt: '2026-07-15T10:40:00.000Z',
  latest: [],
  points: [
    fixtureQuotaPoint({
      at: '2026-07-15T09:00:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 22,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:05:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 28,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:30:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 35,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:35:00.000Z',
      resetAt: '2026-07-15T17:00:00.000Z',
      usedPercent: 4,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:00:00.000Z',
      resetAt: '2026-07-21T00:00:00.000Z',
      usedPercent: 61,
      window: 'weekly',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:35:00.000Z',
      resetAt: '2026-07-21T00:00:00.000Z',
      usedPercent: 63,
      window: 'weekly',
    }),
  ],
  skipped: 0,
  truncated: false,
};

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
  quotaHistoryFixture?: ProviderQuotaHistoryResult;
  quotaSource?: ProviderQuotaSource;
  servedBootstrap?: FocusedSupportResult;
}) => {
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
  const providerStatusClock = createProviderStatusClock({ initialNow: initialPayload.generatedAt });
  onMount(providerStatusClock.start);
  const isDemo = !(props.initialPayload || props.servedBootstrap);
  const quotaFixture =
    props.quotaHistoryFixture ?? (import.meta.env?.VITE_AI_USAGE_E2E === '1' ? e2eQuotaHistoryFixture : undefined);
  const quotaSource = props.quotaSource ?? (props.servedBootstrap ? createServedProviderQuotaSource() : undefined);
  const [quotaHistory, setQuotaHistory] = createSignal<ProviderQuotaHistoryResult | null>(quotaFixture ?? null);
  const [quotaRefresh, setQuotaRefresh] = createSignal<ProviderQuotaRefreshResult | null>(null);
  const [quotaHistoryError, setQuotaHistoryError] = createSignal<string | null>(null);
  const [quotaHistoryLoading, setQuotaHistoryLoading] = createSignal(false);
  const [quotaHistoryOpen, setQuotaHistoryOpen] = createSignal(false);
  const [quotaHistoryRange, setQuotaHistoryRange] = createSignal<ProviderQuotaHistoryRange>('24h');
  const quotaRequest = () => providerQuotaHistoryRequest(quotaHistoryRange(), new Date(), { providerKey: 'codex' });
  const loadQuotaRange = async (range: ProviderQuotaHistoryRange): Promise<void> => {
    setQuotaHistoryRange(range);
    if (!(quotaSource && !quotaFixture)) {
      return;
    }
    setQuotaHistoryLoading(true);
    try {
      const result = await quotaSource.history(
        providerQuotaHistoryRequest(range, new Date(), { providerKey: 'codex' }),
      );
      setQuotaHistory(result);
      setQuotaHistoryError(null);
    } catch (error) {
      setQuotaHistoryError(error instanceof Error ? error.message : 'Quota history query failed');
    } finally {
      setQuotaHistoryLoading(false);
    }
  };
  onMount(() => {
    if (!(quotaSource && !quotaFixture && ['http:', 'https:'].includes(window.location.protocol))) {
      return;
    }
    const poller = createProviderQuotaPoller({
      document,
      onError: (error) => setQuotaHistoryError(error instanceof Error ? error.message : 'Quota refresh failed'),
      onResult: (result, refresh) => {
        setQuotaHistory(result);
        setQuotaRefresh(refresh);
        setQuotaHistoryError(null);
      },
      request: quotaRequest,
      source: quotaSource,
    });
    poller.start();
    onCleanup(poller.stop);
  });
  const servedSessionQueries = Boolean(focusedStore);
  const [servedSessionState, setServedSessionState] = createSignal<SessionQueryState>();
  const servedSessionFingerprint = () => {
    const state = servedSessionState();
    return state ? sessionQueryFingerprint(state.query) : undefined;
  };
  const [sessionQueryLoading, setSessionQueryLoading] = createSignal(false);
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
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [selectedNavigationRow, setSelectedNavigationRow] = createSignal<DashboardRow | null>(null);
  const [sessionNeighbors, setSessionNeighbors] = createSignal<SessionNeighborResult>();
  const [sessionNeighborsLoading, setSessionNeighborsLoading] = createSignal(false);
  let searchInputEl: HTMLInputElement | undefined;
  const cursorCommitRows = createMemo(() =>
    focusedStore
      ? (focusedStore.breakdown()?.context.cursorCommitAttribution ?? [])
      : cursorCommitAttributionFacet(reportSupport()),
  );
  const providerStatusViews = createMemo(() =>
    buildProviderStatusViews(
      reportSupport(),
      focusedStore ? focusedStore.providerRows() : reportRows(),
      providerStatusClock.now(),
    ),
  );
  const harnessOptions = createMemo(() =>
    focusedStore ? focusedStore.filterOptions().harness : [...new Set(reportRows().map((row) => row.harness))],
  );
  const machineOptions = createMemo(() =>
    focusedStore
      ? focusedStore.filterOptions().machine
      : [
          ...new Set(
            reportRows()
              .map((row) => row.source?.machineLabel ?? '')
              .filter((label) => label !== ''),
          ),
        ],
  );
  const groupCampaigns = () => search().campaigns !== 'off';
  const filterSnapshot = createMemo(() => createFilterSnapshot(query(), harness(), machine(), fieldFilters()));
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
  const [focusedTimelineOptions, setFocusedTimelineOptions] = createSignal<{
    dimension: FocusedTimelineDimension;
    granularity: FocusedTimelineGranularity;
  }>({ dimension: 'harness', granularity: 'day' });
  const [advancedAnalysisFailure, setAdvancedAnalysisFailure] = createSignal<{
    message: string;
    scopeFingerprint: string;
  }>();
  const [focusedTimelineError, setFocusedTimelineError] = createSignal<string | null>(null);
  const [focusedTimelineLoading, setFocusedTimelineLoading] = createSignal(Boolean(focusedStore));
  const [advancedAnalysisLoading, setAdvancedAnalysisLoading] = createSignal(false);
  const requestFocusedTimeline = (options: {
    dimension: FocusedTimelineDimension;
    granularity: FocusedTimelineGranularity;
  }): void => {
    batch(() => {
      setFocusedTimelineLoading(true);
      setFocusedTimelineOptions(options);
    });
  };
  const focusedQueryScopeForRevision = (revision: string): FocusedReportQueryScope => {
    if (!focusedStore) {
      throw new Error('Focused report queries require a served report store');
    }
    const sessionScope = buildDashboardSessionQueryScope({
      campaigns: groupCampaigns(),
      fields: fieldFilters(),
      harness: harness(),
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
  const advancedAnalysisError = createMemo(() => {
    if (!focusedStore) {
      return null;
    }
    const failure = advancedAnalysisFailure();
    return failure?.scopeFingerprint === focusedAdvancedAnalysisFingerprint(focusedQueryScope())
      ? failure.message
      : null;
  });
  const activeSessionQueryScope = () =>
    buildDashboardSessionQueryScope({
      campaigns: groupCampaigns(),
      fields: fieldFilters(),
      harness: harness(),
      machine: machine(),
      query: query(),
      range: tableDateBounds(),
      sorting: sorting(),
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
      () => buildCampaignTableRows(reportRows(), tableFilteredRows(), sorting(), groupCampaigns(), campaignViews()),
      (rows) => ({ rows: rows.length }),
    ),
  );
  const visibleSessionTableRows = createMemo(() =>
    servedSessionQueries ? sessionRowsForState(servedSessionState()) : sessionTableRows(),
  );
  const servedReportSession =
    focusedSource && focusedStore && sessionQueryCoordinator
      ? createDashboardServedReportSession({ focusedSource, focusedStore, sessionCoordinator: sessionQueryCoordinator })
      : undefined;
  const servedDestination = createMemo<DashboardServedDestination | undefined>(() => {
    if (!(focusedStore && servedReportSession)) {
      return;
    }
    const { revision: _revision, ...queryScope } = focusedQueryScope();
    const timeline = focusedTimelineOptions();
    const destination = primaryDashboardTabFor(search().tab);
    if (destination === 'overview') {
      const advancedFingerprint = focusedAdvancedAnalysisFingerprint(focusedQueryScope());
      return {
        includeAdvanced: advancedAnalysisFailure()?.scopeFingerprint !== advancedFingerprint,
        kind: 'overview',
        query: queryScope,
        timeline,
      };
    }
    if (destination === 'breakdown') {
      return { kind: 'breakdown', query: queryScope, timeline };
    }
    return { kind: 'sessions', query: queryScope, sessions: activeSessionQueryScope(), timeline };
  });
  const refreshServedDestination = async (refreshRevision = false): Promise<void> => {
    const destination = servedDestination();
    if (!(destination && servedReportSession)) {
      return;
    }
    const outcome = await servedReportSession.refresh(destination, { refreshRevision });
    if (outcome.status === 'superseded') {
      return;
    }
    if (outcome.status === 'failed-preserving-previous') {
      const message = outcome.error instanceof Error ? outcome.error.message : 'Failed to load report destination';
      setFocusedTimelineError(message);
      setOperationError(message);
      if (destination.kind === 'overview' && destination.includeAdvanced) {
        setAdvancedAnalysisFailure({
          message,
          scopeFingerprint: focusedAdvancedAnalysisFingerprint({
            ...destination.query,
            revision: focusedStore?.revision() ?? 'unavailable',
          }),
        });
      }
      return;
    }
    batch(() => {
      setFocusedTimelineError(null);
      setFocusedTimelineLoading(false);
      setAdvancedAnalysisLoading(false);
      setSessionQueryLoading(false);
      if (destination.kind === 'overview' && destination.includeAdvanced) {
        setAdvancedAnalysisFailure(undefined);
      }
    });
  };
  restartServedDestination = () => refreshServedDestination();
  createEffect(() => {
    const destination = servedDestination();
    if (!(clientReady() && destination && servedReportSession && focusedStore)) {
      return;
    }
    batch(() => {
      setFocusedTimelineLoading(
        !dashboardDestinationTimelineMatches(
          destination,
          focusedStore.revision(),
          focusedStore.overview()?.requestFingerprint,
        ),
      );
      setAdvancedAnalysisLoading(destination.kind === 'overview' && destination.includeAdvanced);
      setSessionQueryLoading(destination.kind === 'sessions' && !servedSessionState());
    });
    refreshServedDestination().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to coordinate report destination';
      setOperationError(message);
    });
  });
  onCleanup(() => servedReportSession?.abort());
  // Campaign context rows can select their atomic root even when the root is outside
  // the current table filter, so resolve selection against the payload rows.
  const selectedRow = createMemo(() => {
    const key = selectedKey();
    if (!key) {
      return null;
    }
    if (!servedSessionQueries) {
      return reportRows().find((row) => rowKey(row) === key) ?? null;
    }
    const servedRow = visibleSessionTableRows()
      .flatMap((row) => [row, ...(row.children ?? [])])
      .find((row) => rowKey(row) === key);
    const navigationRow = selectedNavigationRow();
    return (
      servedRow ??
      (navigationRow?.rowId === key ? navigationRow : null) ??
      reportRows().find((row) => rowKey(row) === key) ??
      null
    );
  });
  const selectedCampaign = createMemo(() => {
    if (servedSessionViewActive() && servedSessionState()) {
      return null;
    }
    const row = selectedRow();
    if (!row) {
      return null;
    }
    const key = rowKey(row);
    return (
      campaignViews().find((campaign) => campaign.allRows.some((campaignRow) => rowKey(campaignRow) === key)) ?? null
    );
  });
  const navigateSelected = (delta: number) => {
    if (servedSessionViewActive() && servedSessionState()) {
      const next = delta > 0 ? sessionNeighbors()?.next : sessionNeighbors()?.previous;
      if (next) {
        setSelectedNavigationRow(next);
        setSelectedKey(rowKey(next));
        sessionQueryCoordinator?.select(rowKey(next));
      }
      return;
    }
    const rows = sortedRows();
    const key = selectedKey();
    const index = rows.findIndex((row) => rowKey(row) === key);
    if (index === -1) {
      return;
    }
    const next = rows[index + delta];
    if (next) {
      setSelectedKey(rowKey(next));
    }
  };
  let neighborRequestSequence = 0;
  createEffect(() => {
    const row = selectedRow();
    if (!(servedSessionQueries && sessionQueryCoordinator && servedSessionState() && row)) {
      setSessionNeighbors();
      setSessionNeighborsLoading(false);
      return;
    }
    neighborRequestSequence += 1;
    const sequence = neighborRequestSequence;
    setSessionNeighbors();
    setSessionNeighborsLoading(true);
    sessionQueryCoordinator
      .loadNeighbors(row.rowId)
      .then((neighbors) => {
        if (sequence === neighborRequestSequence) {
          setSessionNeighbors(neighbors);
        }
      })
      .catch((error: unknown) => {
        if (sequence === neighborRequestSequence) {
          setOperationError(error instanceof Error ? error.message : 'Failed to load session neighbors');
        }
      })
      .finally(() => {
        if (sequence === neighborRequestSequence) {
          setSessionNeighborsLoading(false);
        }
      });
  });
  createEffect(() => {
    if (!selectedRow()) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (FORM_CONTROL_TAG_PATTERN.test(target.tagName) || target.isContentEditable)) {
        return;
      }
      if (event.key === 'Escape') {
        setSelectedKey(null);
      } else if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        navigateSelected(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        navigateSelected(-1);
      }
    };
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
    await refreshServedDestination(true);
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
  const toggleSelected = (row: DashboardRow) => {
    const next = selectedKey() === rowKey(row) ? null : rowKey(row);
    setSelectedNavigationRow(next ? row : null);
    setSelectedKey(next);
    sessionQueryCoordinator?.select(next);
  };
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
  const setMachine = (next: string[]) => updateSearch((current) => ({ ...current, machine: next }));
  const removeMachine = (name: string) => setMachine(machine().filter((value) => value !== name));
  const focusDay = (day: Date) => {
    const value = toDateInputValue(day);
    dateRange.setCustom(value, value);
    commitTableDateRange();
    setTab('sessions');
  };
  const inspectOverviewSession = (row: DashboardRow) => {
    setSelectedNavigationRow(row);
    setSelectedKey(rowKey(row));
    sessionQueryCoordinator?.select(rowKey(row));
  };
  const setFieldFilters = (updater: Updater<FieldFilters>) =>
    updateSearch((current) => ({ ...current, filters: applyTableUpdate(updater, current.filters) }));
  const setFieldFilter = (key: FieldFilterKey, value: string) =>
    setFieldFilters((current) => toggleExactFieldFilter(current, key, value));
  const setTimelineDimensionFilter = (dimension: TimelineDimension, value: string) => {
    if (dimension === 'harness') {
      toggleHarness(value);
      return;
    }
    setFieldFilter(dimension, value);
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
  const setCampaignGrouping = (enabled: boolean) =>
    updateSearch((current) => ({ ...current, campaigns: enabled ? 'on' : 'off' }));
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
                <Show fallback="Report payload unavailable" when={!isDemo}>
                  Generated {fmtDate(reportSupport().generatedAt)}
                </Show>
              </div>
            </div>
            <div class={headerActions}>
              <Link class={navButton} to="/skills">
                Skills
              </Link>
              <Link class={navButton} to="/sync">
                Sync
              </Link>
              <Link class={navButton} to="/sources">
                Sources
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <Show when={!isDemo}>
          <div class={toolbar}>
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
            <MultiSelect
              label="Filter by harness"
              noun="harnesses"
              onValueChange={setHarness}
              options={harnessOptions()}
              placeholder="All harnesses"
              value={harness()}
            />
            <Show when={machineOptions().length > 1}>
              <MultiSelect
                label="Filter by machine"
                noun="machines"
                onValueChange={setMachine}
                options={machineOptions()}
                placeholder="All machines"
                value={machine()}
              />
            </Show>
            <SourceControlSummary />
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
          when={!isDemo}
        >
          <TimeRangeControl
            {...(focusedStore ? { onFocusedTimelineRequest: requestFocusedTimeline } : {})}
            activeFieldFilters={fieldFilters()}
            activeHarness={harness()}
            dateRange={dateRange}
            focusedTimeline={focusedStore ? (focusedStore.overview()?.timeline ?? null) : undefined}
            focusedTimelineError={focusedTimelineError()}
            focusedTimelineLoading={focusedTimelineLoading()}
            onDateRangeCommit={commitTableDateRange}
            onDimensionFilter={setTimelineDimensionFilter}
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
                {(value) => <FilterPill label="Machine" onClear={() => removeMachine(value)} value={value} />}
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
                          advancedAnalysisError={advancedAnalysisError()}
                          advancedAnalysisLoading={advancedAnalysisLoading()}
                          campaigns={campaignViews()}
                          focused={focusedOverviewForDisplay()}
                          onSelectDay={focusDay}
                          onSelectSession={inspectOverviewSession}
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
                            groupCampaigns={groupCampaigns()}
                            hasMoreRows={Boolean(servedSessionState()?.nextCursor)}
                            loading={sessionQueryLoading()}
                            onClearFilters={clearFilters}
                            onColumnVisibilityChange={handleColumnVisibilityChange}
                            onFieldFilter={setFieldFilter}
                            onGroupCampaignsChange={setCampaignGrouping}
                            onHarnessFilter={toggleHarness}
                            onSelect={toggleSelected}
                            onSortingChange={handleSortingChange}
                            rows={visibleSessionTableRows()}
                            searchQuery={query()}
                            selectedKey={selectedKey()}
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
                                  disabled={!servedReportSession}
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
                  <div class={metricGrid}>
                    <For each={metrics()}>{(metric) => <MetricTile {...metric} />}</For>
                  </div>
                </div>
              </section>

              <Show when={!isDemo}>
                <ProviderStatusPanel
                  historyAvailable={(quotaHistory()?.points.length ?? 0) > 0}
                  onViewHistory={() => setQuotaHistoryOpen(true)}
                  providers={providerStatusViews()}
                />
              </Show>
            </div>
          </div>

          <Show when={selectedRow()}>
            {(row) => (
              <SessionDrawer
                {...(servedSessionViewActive() && servedSessionState()
                  ? {
                      navigation: {
                        loading: sessionNeighborsLoading(),
                        next: sessionNeighbors()?.next ?? null,
                        previous: sessionNeighbors()?.previous ?? null,
                        total: servedSessionState()?.sessionCount ?? 0,
                      },
                    }
                  : {})}
                onClearFilters={clearFilters}
                onClose={() => {
                  setSelectedNavigationRow(null);
                  setSelectedKey(null);
                  sessionQueryCoordinator?.select(null);
                }}
                onFieldFilter={setFieldFilter}
                onNavigate={navigateSelected}
                onSelectSession={(session) => {
                  setSelectedNavigationRow(session);
                  setSelectedKey(rowKey(session));
                  sessionQueryCoordinator?.select(rowKey(session));
                }}
                row={row()}
                rows={servedSessionViewActive() ? visibleSessionTableRows() : sortedRows()}
                selectedCampaign={selectedCampaign()}
              />
            )}
          </Show>
          <Show when={quotaHistoryOpen()}>
            <ProviderQuotaHistoryPanel
              error={quotaHistoryError()}
              loading={quotaHistoryLoading()}
              onClose={() => setQuotaHistoryOpen(false)}
              onRangeChange={(range) => {
                loadQuotaRange(range).catch((error: unknown) => {
                  setQuotaHistoryError(error instanceof Error ? error.message : 'Quota history query failed');
                });
              }}
              range={quotaHistoryRange()}
              refresh={quotaRefresh()}
              result={quotaHistory()}
            />
          </Show>
        </Show>
      </div>
    </main>
  );
};
