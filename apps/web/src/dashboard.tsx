import {
  activeFilters,
  commandButton,
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
  selectInput,
  shell,
  summaryPill,
  tabsList,
  tabsRoot,
  tabTrigger,
  title,
  titleBlock,
  toolbar,
  unavailablePanel,
  unavailableText,
  unavailableTitle,
} from '@ai-usage/design-system/report';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { Link, useNavigate, useSearch } from '@tanstack/solid-router';
import type { OnChangeFn, SortingState, Updater, VisibilityState } from '@tanstack/solid-table';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import {
  createClientPerfTrace,
  logClientPerf,
  logNavigationPerf,
  measureClientPerf,
  payloadStats,
  resolveClientPerfEnabled,
} from './client-perf';
import { CursorAttributionPanel } from './cursor-attribution-panel';
import { downloadCSV, downloadHTML } from './dashboard-export';
import { FilterPill, fieldFilterLabels } from './dashboard-filters';
import { MetricTile } from './dashboard-metrics';
import {
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
  type DashboardSearch,
  type DashboardTab,
  dashboardSearchDefaultsFor,
  type FieldFilterKey,
  type FieldFilters,
  isDashboardTab,
  sortingStateFromSearch,
} from './dashboard-search';
import { ThemeToggle } from './dashboard-theme';
import { type DateBounds, shiftCalendarDays, startOfDay, toDateInputValue } from './date-range';
import { createDateRangeController } from './date-range-controller';
import { GroupPanel } from './group-panel';
import { Overview } from './overview';
import { ProjectSummary } from './project-summary';
import { RefreshStatus } from './refresh-status';
import { cursorCommitAttributionFacet } from './report-data';
import { fetchReportPayload, isDemoReportPayload, readReportPayload } from './report-runtime';
import { ReportWarnings } from './report-warnings';
import { SessionDrawer } from './session-drawer';
import { SessionTable } from './session-table';
import { columnDiffFromVisibility, columnVisibilityFromDiff, sortFromSortingState } from './session-table-schema';
import { type DashboardRow, enrichReportRow, fmtDate, fmtDateOnly, fmtNum, rowKey } from './shared';
import { applyTableUpdate } from './table-utils';
import { TimeRangeControl } from './time-range-control';

const REFRESH_INTERVAL_MS = 60_000;
const FORM_CONTROL_TAG_PATTERN = /^(INPUT|SELECT|TEXTAREA)$/;

const dashboardTabs: { label: string; value: DashboardTab }[] = [
  { label: 'Overview', value: 'overview' },
  { label: 'Sessions', value: 'sessions' },
  { label: 'Models', value: 'models' },
  { label: 'Providers', value: 'providers' },
  { label: 'Harnesses', value: 'harnesses' },
  { label: 'Projects', value: 'projects' },
  { label: 'Cursor AI', value: 'cursor-ai' },
];

export const Dashboard = (props: {
  fetchPayload?: (options?: { force?: boolean }) => Promise<UsageReportPayload>;
  initialPayload?: UsageReportPayload;
}) => {
  const initialPayload = props.initialPayload ?? readReportPayload();
  const dashboardSearchDefaults = dashboardSearchDefaultsFor(initialPayload.filters.sort);
  const [payload, setPayload] = createSignal<UsageReportPayload>(initialPayload);
  const isDemo = !props.initialPayload && isDemoReportPayload();
  const canRefresh =
    !!props.fetchPayload &&
    !isDemo &&
    typeof window !== 'undefined' &&
    ['http:', 'https:'].includes(window.location.protocol);
  const [refreshing, setRefreshing] = createSignal(false);
  const [lastRefreshError, setLastRefreshError] = createSignal<string | null>(null);
  const [lastSuccessfulRefreshAt, setLastSuccessfulRefreshAt] = createSignal<number | null>(null);
  const [refreshErrorCount, setRefreshErrorCount] = createSignal(0);
  const [refreshPaused, setRefreshPaused] = createSignal(false);
  const [nextRefreshAt, setNextRefreshAt] = createSignal<number | null>(
    canRefresh ? Date.now() + REFRESH_INTERVAL_MS : null,
  );
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const updateSearch = (updater: (current: DashboardSearch) => DashboardSearch, options?: { replace?: boolean }) => {
    navigate({
      search: updater(search()),
      ...(options?.replace == null ? {} : { replace: options.replace }),
    }).catch((error: unknown) => {
      console.error(error);
    });
  };
  const query = () => search().q;
  const harness = () => search().harness;
  const fieldFilters = () => search().filters;
  const sorting = createMemo(() => sortingStateFromSearch(search().sort));
  const columnVisibility = createMemo(() => columnVisibilityFromDiff(search().cols));
  const generatedAt = createMemo(() => new Date(payload().generatedAt));
  const reportRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.reportRows',
      () => payload().rows.map(enrichReportRow),
      (rows) => ({
        rows: rows.length,
      }),
    ),
  );
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  let searchInputEl: HTMLInputElement | undefined;
  const cursorCommitRows = createMemo(() => cursorCommitAttributionFacet(payload()));
  const harnesses = createMemo(() => ['all', ...new Set(reportRows().map((row) => row.harness))]);
  const filterSnapshot = createMemo(() => createFilterSnapshot(query(), harness(), fieldFilters()));
  const timelineRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.timelineRows',
      () => filterTimelineRows(reportRows(), filterSnapshot()),
      (rows) => ({ rows: rows.length }),
    ),
  );
  const initialRange = search().range;
  const dateRange = createDateRangeController({
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
  // Rows in the table's current sort order — shared by CSV export and the
  // drawer's previous/next navigation so both walk the list the user sees.
  const sortedRows = createMemo(() =>
    measureClientPerf(
      'aiUsage.web.client.compute.sortedRows',
      () => buildSortedDashboardRows(tableFilteredRows(), sorting()),
      (rows) => ({ rows: rows.length }),
    ),
  );
  // The drawer closes by itself when its row leaves the filtered set.
  const selectedRow = createMemo(() => tableFilteredRows().find((row) => rowKey(row) === selectedKey()) ?? null);
  const navigateSelected = (delta: number) => {
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
        logNavigationPerf(payload());
        requestAnimationFrame(() => {
          logClientPerf('aiUsage.web.client.initialFrame', payloadStats(payload()));
        });
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  });
  const visibleSummary = createMemo(() =>
    measureClientPerf('aiUsage.web.client.compute.visibleSummary', () =>
      buildVisibleSummary(timelineRows(), dateRange.bounds()),
    ),
  );
  const modelGroups = createMemo(() => {
    if (search().tab !== 'models') {
      return [];
    }
    return buildModelGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost);
  });
  const providerGroups = createMemo(() => {
    if (search().tab !== 'providers') {
      return [];
    }
    return buildProviderGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost);
  });
  const harnessGroups = createMemo(() => {
    if (search().tab !== 'harnesses') {
      return [];
    }
    return buildHarnessGroups(timelineRows(), dateRange.bounds(), visibleSummary().totalCost);
  });
  const projectGroupRows = createMemo(() => {
    if (search().tab !== 'projects') {
      return [];
    }
    return buildProjectGroupRows(timelineRows(), dateRange.bounds());
  });
  const hiddenCount = createMemo(() => hiddenSessionCount(reportRows().length, visibleSummary().sessionCount));
  const previousSummary = createMemo(() =>
    buildPreviousPeriodSummary(timelineRows(), dateRange.bounds(), generatedAt()),
  );
  const exportRows = () => sortedRows();
  const refreshPayload = async (force = false) => {
    if (!props.fetchPayload || refreshing()) {
      return;
    }
    const perfTrace = createClientPerfTrace('aiUsage.web.client.refresh', { force });
    setRefreshing(true);
    perfTrace?.mark('started');
    try {
      const nextPayload = await props.fetchPayload!({ force });
      perfTrace?.mark('payloadReceived', payloadStats(nextPayload));
      setPayload(nextPayload);
      perfTrace?.mark('stateUpdated');
      requestAnimationFrame(() => {
        perfTrace?.end('frame', payloadStats(payload()));
      });
      setLastRefreshError(null);
      setLastSuccessfulRefreshAt(Date.now());
      setRefreshErrorCount(0);
      setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
    } catch (error) {
      perfTrace?.end('failed', { error: error instanceof Error ? error.message : String(error) });
      setLastRefreshError(error instanceof Error ? error.message : 'Failed to refresh report payload');
      setRefreshErrorCount((count) => count + 1);
      setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
    } finally {
      setRefreshing(false);
    }
  };
  const toggleRefreshPause = () => {
    setRefreshPaused((paused) => {
      if (paused) {
        setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
      }
      return !paused;
    });
  };
  createEffect(() => {
    if (!canRefresh || refreshPaused() || refreshing()) {
      return;
    }
    const next = nextRefreshAt();
    if (next == null) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        refreshPayload(true).catch((error: unknown) => {
          console.error(error);
        });
      },
      Math.max(0, next - Date.now()),
    );
    onCleanup(() => window.clearTimeout(timer));
  });
  onMount(() => {
    if (props.initialPayload) {
      return;
    }
    if (!isDemoReportPayload()) {
      return;
    }
    if (props.fetchPayload) {
      refreshPayload(true).catch((error: unknown) => {
        console.error(error);
      });
    } else if (import.meta.env.DEV) {
      fetchReportPayload({ force: true })
        .then(setPayload)
        .catch((error: unknown) => {
          setLastRefreshError(error instanceof Error ? error.message : 'Failed to refresh report payload');
          setRefreshErrorCount((count) => count + 1);
        });
    }
  });
  const toggleSelected = (row: DashboardRow) =>
    setSelectedKey((current) => (current === rowKey(row) ? null : rowKey(row)));
  let activeQueryEdit = false;
  const commitQueryEdit = () => {
    activeQueryEdit = false;
  };
  const setQuery = (q: string) => {
    const replace = activeQueryEdit;
    activeQueryEdit = true;
    updateSearch((current) => ({ ...current, q }), { replace });
  };
  const setHarness = (nextHarness: string) => updateSearch((current) => ({ ...current, harness: nextHarness }));
  const toggleHarness = (name: string) => setHarness(harness() === name ? 'all' : name);
  const focusDay = (day: Date) => {
    const value = toDateInputValue(day);
    dateRange.setCustom(value, value);
    commitTableDateRange();
  };
  const setFieldFilters = (updater: Updater<FieldFilters>) =>
    updateSearch((current) => ({ ...current, filters: applyTableUpdate(updater, current.filters) }));
  const setFieldFilter = (key: FieldFilterKey, value: string) =>
    setFieldFilters((current) => ({ ...current, [key]: value }));
  const clearFieldFilter = (key: FieldFilterKey) =>
    setFieldFilters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const clearFilters = () => {
    dateRange.clear();
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({ ...current, filters: {}, harness: 'all', q: '', range: { mode: 'all' } }));
  };
  const handleSortingChange: OnChangeFn<SortingState> = (updater) =>
    updateSearch((current) => ({
      ...current,
      sort: sortFromSortingState(
        applyTableUpdate(updater, sortingStateFromSearch(current.sort)),
        dashboardSearchDefaults.sort,
      ),
    }));
  const handleColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) =>
    updateSearch((current) => {
      const nextVisibility = applyTableUpdate(updater, columnVisibilityFromDiff(current.cols));
      return { ...current, cols: columnDiffFromVisibility(nextVisibility) };
    });
  const setTab = (tab: string) => {
    if (!isDashboardTab(tab)) {
      return;
    }
    updateSearch((current) => ({ ...current, tab }));
  };
  const metrics = createMemo(() =>
    measureClientPerf('aiUsage.web.client.compute.metrics', () =>
      buildDashboardMetrics(visibleSummary(), previousSummary()),
    ),
  );

  return (
    <main class={page}>
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
                  Generated {fmtDate(payload().generatedAt)}
                </Show>
              </div>
            </div>
            <div class={headerActions}>
              <Link class={navButton} to="/sync">
                Sync
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
            <select class={selectInput} onChange={(event) => setHarness(event.currentTarget.value)} value={harness()}>
              <For each={harnesses()}>
                {(item) => <option value={item}>{item === 'all' ? 'All harnesses' : item}</option>}
              </For>
            </select>
            <RefreshStatus
              canRefresh={canRefresh}
              generatedAt={payload().generatedAt}
              lastRefreshError={lastRefreshError()}
              lastSuccessfulRefreshAt={lastSuccessfulRefreshAt()}
              nextRefreshAt={nextRefreshAt()}
              onRefresh={() => {
                refreshPayload(true).catch((error: unknown) => {
                  console.error(error);
                });
              }}
              onTogglePause={toggleRefreshPause}
              refreshErrorCount={refreshErrorCount()}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
              refreshing={refreshing()}
              refreshPaused={refreshPaused()}
            />
            <button
              class={commandButton}
              onClick={() => downloadCSV(exportRows(), payload().generatedAt)}
              type="button"
            >
              Export CSV
            </button>
            <Show when={!import.meta.env.DEV}>
              <button
                class={ghostButton}
                onClick={() => {
                  downloadHTML(payload()).catch((error: unknown) => {
                    console.error(error);
                  });
                }}
                type="button"
              >
                Export HTML
              </button>
            </Show>
          </div>
        </Show>

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
            activeHarness={harness()}
            dateRange={dateRange}
            onDateRangeCommit={commitTableDateRange}
            onHarnessFilter={toggleHarness}
            rows={timelineRows()}
          />

          <div class={filterSummary}>
            <span aria-live="polite" class={summaryPill}>
              {fmtNum(visibleSummary().sessionCount)} / {fmtNum(reportRows().length)} sessions
            </span>
            <Show when={hiddenCount() > 0}>
              <span>{fmtNum(hiddenCount())} hidden by filters</span>
            </Show>
            <div class={activeFilters}>
              <Show when={harness() !== 'all'}>
                <FilterPill label="Harness" onClear={() => setHarness('all')} value={harness()} />
              </Show>
              <For each={Object.entries(fieldFilters()) as [FieldFilterKey, string][]}>
                {([key, value]) => (
                  <FilterPill label={fieldFilterLabels[key]} onClear={() => clearFieldFilter(key)} value={value} />
                )}
              </For>
            </div>
          </div>

          <ReportWarnings warnings={payload().warnings} />

          <div class={metricGrid}>
            <For each={metrics()}>{(metric) => <MetricTile {...metric} />}</For>
          </div>

          <div class={tabsRoot}>
            <div class={tabsList} role="tablist">
              <For each={dashboardTabs}>
                {(tab) => {
                  const selected = () => search().tab === tab.value;
                  return (
                    <button
                      aria-selected={selected()}
                      class={tabTrigger}
                      data-selected={selected() ? '' : undefined}
                      onClick={() => setTab(tab.value)}
                      role="tab"
                      type="button"
                    >
                      {tab.label}
                    </button>
                  );
                }}
              </For>
            </div>
            <Show when={search().tab === 'overview'}>
              <section class={section} role="tabpanel">
                <Overview
                  onSelectDay={focusDay}
                  onSelectSession={(row) => setSelectedKey(rowKey(row))}
                  rangeLabel={dateRange.label()}
                  rows={tableRows()}
                  summary={visibleSummary()}
                  timelineRows={timelineRows()}
                />
              </section>
            </Show>
            <Show when={search().tab === 'sessions'}>
              <section class={section} role="tabpanel">
                <SessionTable
                  columnVisibility={columnVisibility()}
                  onClearFilters={clearFilters}
                  onColumnVisibilityChange={handleColumnVisibilityChange}
                  onFieldFilter={setFieldFilter}
                  onHarnessFilter={setHarness}
                  onSelect={toggleSelected}
                  onSortingChange={handleSortingChange}
                  rows={tableRows()}
                  searchQuery={query()}
                  selectedKey={selectedKey()}
                  sorting={sorting()}
                />
              </section>
            </Show>
            <Show when={search().tab === 'models'}>
              <section class={section} role="tabpanel">
                <GroupPanel
                  countLabel="models"
                  groups={modelGroups()}
                  harnessTones
                  onFilter={(value) => setFieldFilter('model', value)}
                  title="By model"
                />
              </section>
            </Show>
            <Show when={search().tab === 'providers'}>
              <section class={section} role="tabpanel">
                <GroupPanel
                  countLabel="providers"
                  groups={providerGroups()}
                  harnessTones
                  onFilter={(value) => setFieldFilter('provider', value)}
                  title="By provider"
                />
              </section>
            </Show>
            <Show when={search().tab === 'harnesses'}>
              <section class={section} role="tabpanel">
                <GroupPanel
                  countLabel="harnesses"
                  groups={harnessGroups()}
                  harnessTones
                  onFilter={setHarness}
                  title="By harness"
                />
              </section>
            </Show>
            <Show when={search().tab === 'projects'}>
              <section class={section} role="tabpanel">
                <ProjectSummary
                  groups={projectGroupRows()}
                  onProjectFilter={(value) => setFieldFilter('project', value)}
                />
              </section>
            </Show>
            <Show when={search().tab === 'cursor-ai'}>
              <section class={section} role="tabpanel">
                <CursorAttributionPanel rows={cursorCommitRows()} />
              </section>
            </Show>
          </div>

          <Show when={selectedRow()}>
            {(row) => (
              <SessionDrawer
                onClose={() => setSelectedKey(null)}
                onFieldFilter={setFieldFilter}
                onNavigate={navigateSelected}
                row={row()}
                rows={sortedRows()}
              />
            )}
          </Show>
        </Show>
      </div>
    </main>
  );
};
