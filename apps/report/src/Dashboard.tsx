import type { UsageReportPayload } from '@ai-usage/core/report-data';
import {
  activeFilters,
  commandButton,
  demoBadge,
  eyebrow,
  eyebrowRow,
  filterSummary,
  ghostButton,
  header,
  headerTop,
  meta,
  metricGrid,
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
} from '@ai-usage/design-system';
import { Tabs } from '@ark-ui/solid/tabs';
import { useNavigate, useSearch } from '@tanstack/solid-router';
import type { OnChangeFn, SortingState, Updater, VisibilityState } from '@tanstack/solid-table';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { CursorAttributionPanel } from './cursor-attribution-panel';
import { buildAnalyticsGroups, buildProjectGroups } from './dashboard-analytics';
import { downloadCSV, downloadHTML } from './dashboard-export';
import { createFilterSnapshot, FilterPill, fieldFilterLabels, matchesFilterSnapshot } from './dashboard-filters';
import { type Metric, type MetricDelta, MetricTile } from './dashboard-metrics';
import {
  type DashboardSearch,
  dashboardSearchDefaultsFor,
  type FieldFilterKey,
  type FieldFilters,
  isDashboardTab,
  sortingStateFromSearch,
} from './dashboard-search';
import { compareRows } from './dashboard-sort';
import { ThemeToggle } from './dashboard-theme';
import {
  DAY_MS,
  type DateBounds,
  endOfDay,
  rowMatchesDateBounds,
  shiftCalendarDays,
  startOfDay,
  toDateInputValue,
} from './date-range';
import { createDateRangeController } from './date-range-controller';
import { GroupPanel } from './group-panel';
import { Overview } from './Overview';
import { ProjectSummary } from './project-summary';
import { RefreshStatus } from './refresh-status';
import {
  cursorCommitAttributionFacet,
  fetchReportPayload,
  isDemoReportPayload,
  readReportPayload,
} from './report-data';
import { columnDiffFromVisibility, columnVisibilityFromDiff, sortFromSortingState } from './session-columns';
import { SessionDrawer } from './session-drawer';
import { SessionTable } from './session-table';
import {
  buildReportSummary,
  type DashboardRow,
  enrichReportRow,
  fmtCompact,
  fmtDate,
  fmtDateOnly,
  fmtMoney,
  fmtNum,
  fmtPct,
  rowKey,
} from './shared';
import { applyTableUpdate } from './table-utils';
import { TimeRangeControl } from './time-range-control';

const initialPayload = readReportPayload();
const REFRESH_INTERVAL_MS = 60_000;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(initialPayload.filters.sort);

export const Dashboard = () => {
  const [payload, setPayload] = createSignal<UsageReportPayload>(initialPayload);
  const isDemo = isDemoReportPayload();
  const canRefresh = !isDemo && typeof window !== 'undefined' && ['http:', 'https:'].includes(window.location.protocol);
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
  const updateSearch = (updater: (current: DashboardSearch) => DashboardSearch, options?: { replace?: boolean }) =>
    void navigate({
      search: updater(search()),
      ...(options?.replace == null ? {} : { replace: options.replace }),
    });
  const query = () => search().q;
  const harness = () => search().harness;
  const fieldFilters = () => search().filters;
  const sorting = createMemo(() => sortingStateFromSearch(search().sort));
  const columnVisibility = createMemo(() => columnVisibilityFromDiff(search().cols));
  const generatedAt = createMemo(() => new Date(payload().generatedAt));
  const reportRows = createMemo(() => payload().rows.map(enrichReportRow));
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  let searchInputEl: HTMLInputElement | undefined;
  const cursorCommitRows = createMemo(() => cursorCommitAttributionFacet(payload()));
  const harnesses = createMemo(() => ['all', ...new Set(reportRows().map((row) => row.harness))]);
  const filterSnapshot = createMemo(() => createFilterSnapshot(query(), harness(), fieldFilters()));
  const timelineRows = createMemo(() => {
    const filters = filterSnapshot();
    return reportRows().filter((row) => matchesFilterSnapshot(row, filters));
  });
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
    if (mode !== 'custom') return { mode };
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
      if (!matchesRange) dateRange.setRange(range.mode, range.from, range.to);
      setTableDateBounds(dateRange.bounds());
    });
  });
  const tableFilteredRows = createMemo(() => {
    const bounds = tableDateBounds();
    return timelineRows().filter((row) => rowMatchesDateBounds(row, bounds));
  });
  const tableRows = tableFilteredRows;
  // Rows in the table's current sort order — shared by CSV export and the
  // drawer's previous/next navigation so both walk the list the user sees.
  const sortedRows = createMemo(() => [...tableFilteredRows()].sort(compareRows(sorting())));
  // The drawer closes by itself when its row leaves the filtered set.
  const selectedRow = createMemo(() => tableFilteredRows().find((row) => rowKey(row) === selectedKey()) ?? null);
  const navigateSelected = (delta: number) => {
    const rows = sortedRows();
    const key = selectedKey();
    const index = rows.findIndex((row) => rowKey(row) === key);
    if (index === -1) return;
    const next = rows[index + delta];
    if (next) setSelectedKey(rowKey(next));
  };
  createEffect(() => {
    if (!selectedRow()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
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
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
      event.preventDefault();
      searchInputEl?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });
  const visibleSummary = createMemo(() => {
    const bounds = dateRange.bounds();
    return buildReportSummary(timelineRows(), (row) => rowMatchesDateBounds(row, bounds));
  });
  const modelGroups = createMemo(() => {
    if (search().tab !== 'models') return [];
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      timelineRows(),
      (row) => rowMatchesDateBounds(row, bounds),
      (row) => row.modelKey,
      visibleSummary().totalCost,
    );
  });
  const providerGroups = createMemo(() => {
    if (search().tab !== 'providers') return [];
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      timelineRows(),
      (row) => rowMatchesDateBounds(row, bounds),
      (row) => row.providerDisplay,
      visibleSummary().totalCost,
    );
  });
  const harnessGroups = createMemo(() => {
    if (search().tab !== 'harnesses') return [];
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      timelineRows(),
      (row) => rowMatchesDateBounds(row, bounds),
      (row) => row.harness,
      visibleSummary().totalCost,
    );
  });
  const projectGroupRows = createMemo(() => {
    if (search().tab !== 'projects') return [];
    const bounds = dateRange.bounds();
    return buildProjectGroups(timelineRows(), (row) => rowMatchesDateBounds(row, bounds));
  });
  const hiddenCount = createMemo(() => reportRows().length - visibleSummary().sessionCount);
  // Usage in the equally-long window right before the selected one; null when
  // the range is open-ended ("All") or the previous window is empty.
  const previousSummary = createMemo(() => {
    const bounds = dateRange.bounds();
    if (!bounds.from) return null;
    const from = bounds.from.getTime();
    const to = (bounds.to ?? endOfDay(generatedAt())).getTime();
    const span = Math.max(DAY_MS, to - from);
    const previousBounds: DateBounds = { from: new Date(from - span), to: new Date(from - 1) };
    const summary = buildReportSummary(timelineRows(), (row) => rowMatchesDateBounds(row, previousBounds));
    return summary.sessionCount > 0 ? summary : null;
  });
  const exportRows = () => sortedRows();
  const refreshPayload = async (force = false) => {
    if (!canRefresh || refreshing()) return;
    setRefreshing(true);
    try {
      setPayload(await fetchReportPayload({ force }));
      setLastRefreshError(null);
      setLastSuccessfulRefreshAt(Date.now());
      setRefreshErrorCount(0);
      setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
    } catch (error) {
      setLastRefreshError(error instanceof Error ? error.message : 'Failed to refresh report payload');
      setRefreshErrorCount((count) => count + 1);
      setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
    } finally {
      setRefreshing(false);
    }
  };
  const toggleRefreshPause = () => {
    setRefreshPaused((paused) => {
      if (paused) setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
      return !paused;
    });
  };
  createEffect(() => {
    if (!canRefresh || refreshPaused() || refreshing()) return;
    const next = nextRefreshAt();
    if (next == null) return;
    const timer = window.setTimeout(() => void refreshPayload(), Math.max(0, next - Date.now()));
    onCleanup(() => window.clearTimeout(timer));
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
    if (!isDashboardTab(tab)) return;
    updateSearch((current) => ({ ...current, tab }));
  };
  const deltaVs = (current: number, previous: number | undefined, fmt: (n: number) => string): MetricDelta | null => {
    if (previous == null || previous <= 0) return null;
    return {
      pct: ((current - previous) / previous) * 100,
      hint: `Previous period of equal length: ${fmt(previous)}`,
    };
  };
  const metrics = createMemo<Metric[]>(() => {
    const a = visibleSummary();
    const prev = previousSummary() ?? undefined;
    return [
      {
        label: 'Sessions',
        value: fmtNum(a.sessionCount),
        hint: 'Sessions in the current filter',
        delta: deltaVs(a.sessionCount, prev?.sessionCount, fmtNum),
      },
      {
        label: 'API value',
        value: fmtMoney(a.totalCost),
        hint: 'Estimated cost at standard API prices, including usage covered by subscriptions',
        delta: deltaVs(a.totalCost, prev?.totalCost, fmtMoney),
      },
      {
        label: 'Actual cost',
        value: fmtMoney(a.actualCost),
        hint: `Out-of-pocket spend reported by harnesses; subscription usage counts as $0${
          a.unknownActual ? ` (${fmtNum(a.unknownActual)} sessions unknown)` : ''
        }`,
        delta: deltaVs(a.actualCost, prev?.actualCost, fmtMoney),
      },
      { label: 'Mean / sess', value: fmtMoney(a.meanCost), hint: 'Mean API value per priced session' },
      {
        label: 'Fresh tokens',
        value: fmtCompact(a.fresh),
        hint: `Tokens processed without cache: ${fmtNum(a.fresh)}`,
        delta: deltaVs(a.fresh, prev?.fresh, fmtCompact),
      },
      ...(a.rtkSaved
        ? [
            {
              label: 'RTK savings',
              value: fmtPct(a.rtkInput ? (a.rtkSaved / a.rtkInput) * 100 : 0),
              hint: [
                `${fmtNum(a.rtkSaved)} tokens saved in matched sessions`,
                `${fmtNum(a.rtkInput)} RTK input tokens before filtering`,
                `${fmtNum(a.rtkOutput)} RTK output tokens after filtering`,
              ].join('\n'),
            },
          ]
        : []),
      {
        label: 'Turns',
        value: fmtNum(a.turns),
        hint: 'Assistant turns across the filtered sessions',
        delta: deltaVs(a.turns, prev?.turns, fmtNum),
      },
      {
        label: 'Tool calls',
        value: fmtNum(a.tools),
        hint: 'Tool invocations across the filtered sessions',
        delta: deltaVs(a.tools, prev?.tools, fmtNum),
      },
    ];
  });

  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <div class={eyebrowRow}>
                <div class={eyebrow}>ai-usage</div>
                <Show when={isDemoReportPayload()}>
                  <span class={demoBadge}>Demo data</span>
                </Show>
              </div>
              <h1 class={title}>Usage report</h1>
              <div class={meta}>
                <Show when={!isDemo} fallback="Report payload unavailable">
                  Generated {fmtDate(payload().generatedAt)}
                </Show>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </header>

        <Show when={!isDemo}>
          <div class={toolbar}>
            <input
              ref={searchInputEl}
              class={searchInput}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onBlur={commitQueryEdit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitQueryEdit();
              }}
              placeholder="Filter by title, project, model…  ( / )"
              aria-label="Filter sessions by title, project, model, provider, or harness"
            />
            <select class={selectInput} value={harness()} onChange={(event) => setHarness(event.currentTarget.value)}>
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
              onTogglePause={toggleRefreshPause}
              refreshErrorCount={refreshErrorCount()}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
              refreshPaused={refreshPaused()}
              refreshing={refreshing()}
              onRefresh={() => void refreshPayload(true)}
            />
            <button
              class={commandButton}
              type="button"
              onClick={() => downloadCSV(exportRows(), payload().generatedAt)}
            >
              Export CSV
            </button>
            <Show when={!import.meta.env.DEV}>
              <button class={ghostButton} type="button" onClick={() => void downloadHTML(payload())}>
                Export HTML
              </button>
            </Show>
          </div>
        </Show>

        <Show
          when={!isDemo}
          fallback={
            <section class={unavailablePanel}>
              <div class={unavailableTitle}>Real report data is not loaded</div>
              <div class={unavailableText}>
                The CLI payload was not injected into this page, so usage metrics are hidden instead of showing demo
                fixture data.
              </div>
            </section>
          }
        >
          <TimeRangeControl
            rows={timelineRows()}
            dateRange={dateRange}
            activeHarness={harness()}
            onHarnessFilter={toggleHarness}
            onDateRangeCommit={commitTableDateRange}
          />

          <div class={filterSummary}>
            <span class={summaryPill} aria-live="polite">
              {fmtNum(visibleSummary().sessionCount)} / {fmtNum(reportRows().length)} sessions
            </span>
            <Show when={hiddenCount() > 0}>
              <span>{fmtNum(hiddenCount())} hidden by filters</span>
            </Show>
            <div class={activeFilters}>
              <Show when={harness() !== 'all'}>
                <FilterPill label="Harness" value={harness()} onClear={() => setHarness('all')} />
              </Show>
              <For each={Object.entries(fieldFilters()) as [FieldFilterKey, string][]}>
                {([key, value]) => (
                  <FilterPill label={fieldFilterLabels[key]} value={value} onClear={() => clearFieldFilter(key)} />
                )}
              </For>
            </div>
          </div>

          <div class={metricGrid}>
            <For each={metrics()}>{(metric) => <MetricTile {...metric} />}</For>
          </div>

          <Tabs.Root
            value={search().tab}
            class={tabsRoot}
            lazyMount
            unmountOnExit
            onValueChange={(details) => setTab(details.value)}
          >
            <Tabs.List class={tabsList}>
              <Tabs.Trigger value="overview" class={tabTrigger}>
                Overview
              </Tabs.Trigger>
              <Tabs.Trigger value="sessions" class={tabTrigger}>
                Sessions
              </Tabs.Trigger>
              <Tabs.Trigger value="models" class={tabTrigger}>
                Models
              </Tabs.Trigger>
              <Tabs.Trigger value="providers" class={tabTrigger}>
                Providers
              </Tabs.Trigger>
              <Tabs.Trigger value="harnesses" class={tabTrigger}>
                Harnesses
              </Tabs.Trigger>
              <Tabs.Trigger value="projects" class={tabTrigger}>
                Projects
              </Tabs.Trigger>
              <Tabs.Trigger value="cursor-ai" class={tabTrigger}>
                Cursor AI
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="overview" class={section}>
              <Overview
                rows={tableRows()}
                timelineRows={timelineRows()}
                summary={visibleSummary()}
                rangeLabel={dateRange.label()}
                onSelectSession={(row) => setSelectedKey(rowKey(row))}
                onSelectDay={focusDay}
              />
            </Tabs.Content>
            <Tabs.Content value="sessions" class={section}>
              <SessionTable
                rows={tableRows()}
                selectedKey={selectedKey()}
                searchQuery={query()}
                sorting={sorting()}
                columnVisibility={columnVisibility()}
                onSortingChange={handleSortingChange}
                onColumnVisibilityChange={handleColumnVisibilityChange}
                onSelect={toggleSelected}
                onHarnessFilter={setHarness}
                onFieldFilter={setFieldFilter}
                onClearFilters={clearFilters}
              />
            </Tabs.Content>
            <Tabs.Content value="models" class={section}>
              <GroupPanel
                title="By model"
                groups={modelGroups()}
                countLabel="models"
                harnessTones
                onFilter={(value) => setFieldFilter('model', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="providers" class={section}>
              <GroupPanel
                title="By provider"
                groups={providerGroups()}
                countLabel="providers"
                harnessTones
                onFilter={(value) => setFieldFilter('provider', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="harnesses" class={section}>
              <GroupPanel
                title="By harness"
                groups={harnessGroups()}
                countLabel="harnesses"
                harnessTones
                onFilter={setHarness}
              />
            </Tabs.Content>
            <Tabs.Content value="projects" class={section}>
              <ProjectSummary
                groups={projectGroupRows()}
                onProjectFilter={(value) => setFieldFilter('project', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="cursor-ai" class={section}>
              <CursorAttributionPanel rows={cursorCommitRows()} />
            </Tabs.Content>
          </Tabs.Root>

          <Show when={selectedRow()}>
            {(row) => (
              <SessionDrawer
                row={row()}
                rows={sortedRows()}
                onClose={() => setSelectedKey(null)}
                onNavigate={navigateSelected}
                onFieldFilter={setFieldFilter}
              />
            )}
          </Show>
        </Show>
      </div>
    </main>
  );
};
