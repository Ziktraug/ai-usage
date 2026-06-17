import type { AnalyticsGroup } from '@ai-usage/core/analytics';
import type { UsageReportPayload } from '@ai-usage/core/report-data';
import {
  activeFilters,
  barFill,
  barTrack,
  chartLegend,
  commandButton,
  dateEditRow,
  dateFieldGroup,
  dateInput,
  demoBadge,
  empty,
  eyebrow,
  eyebrowRow,
  filterSummary,
  ghostButton,
  groupCount,
  groupHeader,
  groupKeyButton,
  groupPanel,
  groupPct,
  groupRow,
  groupRows,
  groupSub,
  groupTitle,
  groupValue,
  header,
  headerTop,
  inlineFieldLabel,
  meta,
  metricGrid,
  monthGridline,
  numCell,
  page,
  presetButton,
  presetGroup,
  projectTable,
  refreshButton,
  refreshIconButton,
  refreshRing,
  refreshRingDelayed,
  refreshRingError,
  refreshRingIdle,
  refreshRingPaused,
  refreshRingRefreshing,
  refreshRingStatic,
  refreshRingSuccess,
  refreshStatus,
  refreshStatusError,
  right,
  searchInput,
  section,
  selectInput,
  shell,
  strongCell,
  summaryPill,
  table,
  tableWrap,
  tabsList,
  tabsRoot,
  tabTrigger,
  timeAxis,
  timeAxisTick,
  timeBucket,
  timeBucketSegment,
  timeRangeHeader,
  timeRangeMeta,
  timeRangePanel,
  timeRangeTitle,
  timeSliderBars,
  timeSliderControl,
  timeSliderDimLeft,
  timeSliderDimRight,
  timeSliderRange,
  timeSliderRangeDrag,
  timeSliderRoot,
  timeSliderThumb,
  timeSliderTrack,
  title,
  titleBlock,
  toolbar,
  tooltipContent,
  unavailablePanel,
  unavailableText,
  unavailableTitle,
} from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import { Slider } from '@ark-ui/solid/slider';
import { Tabs } from '@ark-ui/solid/tabs';
import { Tooltip } from '@ark-ui/solid/tooltip';
import { useNavigate, useSearch } from '@tanstack/solid-router';
import type { OnChangeFn, SortingState, Updater, VisibilityState } from '@tanstack/solid-table';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { buildAnalyticsGroups, buildProjectGroups, type ProjectGroup } from './dashboard-analytics';
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
  clampNumber,
  DAY_MS,
  type DateBounds,
  dateFromIndex,
  dateIndexFrom,
  dateRangePresets,
  endOfDay,
  normalizeDateIndexRange,
  rowMatchesDateBounds,
  rowTime,
  shiftCalendarDays,
  startOfDay,
  type TimeRangePreset,
  toDateInputValue,
} from './date-range';
import { createDateRangeController, type DateRangeController } from './date-range-controller';
import { Overview } from './Overview';
import {
  type CursorCommitAttributionFacet,
  cursorCommitAttributionFacet,
  fetchReportPayload,
  isDemoReportPayload,
  readReportPayload,
} from './report-data';
import { columnDiffFromVisibility, columnVisibilityFromDiff, sortFromSortingState } from './session-columns';
import { SessionDrawer } from './session-drawer';
import { SessionTable } from './session-table';
import {
  accentFill,
  buildReportSummary,
  type DashboardRow,
  enrichReportRow,
  fmtCompact,
  fmtDate,
  fmtDateOnly,
  fmtMoney,
  fmtNum,
  fmtPct,
  HarnessBadge,
  harnessFillFor,
  rowKey,
  UNKNOWN_PRICE_HINT,
  USAGE_UNAVAILABLE_HINT,
  UsageUnavailableCell,
} from './shared';
import { applyTableUpdate } from './table-utils';

const initialPayload = readReportPayload();
const REFRESH_INTERVAL_MS = 60_000;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(initialPayload.filters.sort);

type RangeDragPointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };

const analyticsGroupUnavailableOnly = (group: AnalyticsGroup) => group.usageUnavailable === group.sessions;
const groupFreshLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? 'n/a fresh' : `${fmtCompact(group.fresh)} fresh`;
const groupFreshTitle = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? USAGE_UNAVAILABLE_HINT : `${fmtNum(group.fresh)} fresh tokens`;
const groupCacheLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? 'n/a cache' : `${fmtPct(group.cacheHitPct)} cache`;

const GroupPanel = (props: {
  title: string;
  groups: AnalyticsGroup[];
  countLabel: string;
  harnessTones?: boolean;
  onFilter?: (value: string) => void;
}) => {
  const maxCost = createMemo(() => Math.max(1, ...props.groups.map((group) => group.costSum)));
  return (
    <div class={groupPanel}>
      <div class={groupHeader}>
        <div class={groupTitle}>{props.title}</div>
        <div class={groupCount} title={`${props.groups.length} ${props.countLabel}`}>
          {props.groups.length} {props.countLabel}
        </div>
      </div>
      <div class={groupRows}>
        <For each={props.groups}>
          {(group) => (
            <div class={groupRow}>
              <div>
                <Show when={props.onFilter} fallback={<div class={strongCell}>{group.key}</div>}>
                  <button class={groupKeyButton} type="button" onClick={() => props.onFilter?.(group.key)}>
                    {group.key}
                  </button>
                </Show>
                <div class={groupSub} title={groupFreshTitle(group)}>
                  {group.sessions} sess · {groupFreshLabel(group)} · {groupCacheLabel(group)}
                </div>
                <div class={barTrack}>
                  <div
                    class={cx(barFill, (props.harnessTones ? harnessFillFor(group.harness) : undefined) ?? accentFill)}
                    style={{
                      width: analyticsGroupUnavailableOnly(group)
                        ? '0%'
                        : `${Math.max(3, (group.costSum / maxCost()) * 100)}%`,
                    }}
                  />
                </div>
              </div>
              <div class={right}>
                <div class={groupValue}>
                  <Show when={!analyticsGroupUnavailableOnly(group)} fallback={<UsageUnavailableCell />}>
                    <Show when={group.priced} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                      {fmtMoney(group.costSum)}
                    </Show>
                  </Show>
                </div>
                <div class={groupPct}>{fmtPct(group.costPercent)}</div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

type TimelinePart = { harness: string; cost: number };
type TimelineBucket = { date: Date; endDate: Date; total: number; sessions: number; parts: TimelinePart[] };

const timelineBucketTitle = (bucket: TimelineBucket, weekly: boolean, valueMode: 'cost' | 'sessions') =>
  [
    `${weekly ? 'Week of ' : ''}${fmtDateOnly(bucket.date)} — ${
      valueMode === 'cost' ? fmtMoney(bucket.total) : `${fmtNum(bucket.sessions)} sessions`
    }`,
    ...bucket.parts.map((part) => `${part.harness} ${fmtMoney(part.cost)}`),
  ].join('\n');

const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });

// Month boundaries anchor the brush; the two endpoint labels only give the
// extremes, which is not enough to aim a selection on a long domain.
const monthTicksFor = (chart: { minDay: Date; maxDay: Date; maxIndex: number }) => {
  if (chart.maxIndex < 28) return [];
  const monthStep = chart.maxIndex > 430 ? 3 : 1;
  const ticks: { pct: number; label: string }[] = [];
  const cursor = new Date(chart.minDay.getFullYear(), chart.minDay.getMonth() + 1, 1);
  while (cursor <= chart.maxDay) {
    if (cursor.getMonth() % monthStep === 0) {
      const pct = (dateIndexFrom(cursor, chart.minDay) / chart.maxIndex) * 100;
      if (pct >= 2 && pct <= 98) {
        const label =
          cursor.getMonth() === 0
            ? `${monthTickFormatter.format(cursor)} ’${String(cursor.getFullYear()).slice(-2)}`
            : monthTickFormatter.format(cursor);
        ticks.push({ pct, label });
      }
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return ticks;
};

const TimeRangeControl = (props: {
  rows: DashboardRow[];
  dateRange: DateRangeController;
  activeHarness: string;
  onHarnessFilter: (value: string) => void;
  onDateRangeCommit: () => void;
}) => {
  const [chartDomain, setChartDomain] = createSignal(props.dateRange.domain());
  const syncChartDomain = () => setChartDomain(props.dateRange.domain());
  createEffect(() => {
    props.rows;
    setChartDomain(untrack(() => props.dateRange.domain()));
  });

  const data = createMemo(() => {
    const domain = chartDomain();
    if (!domain) return null;
    const dated = props.rows
      .map((row) => ({ row, time: rowTime(row) }))
      .filter((item): item is { row: DashboardRow; time: number } => item.time != null);
    const dayCount = domain.maxIndex + 1;
    // Weekly buckets past ~4 months keep the bars readable (and the DOM small).
    const weekly = dayCount > 120;
    const bucketStart = (date: Date) => {
      const day = startOfDay(date);
      return weekly ? shiftCalendarDays(day, -((day.getDay() + 6) % 7)) : day;
    };

    const buckets = new Map<string, TimelineBucket & { byHarness: Map<string, number> }>();
    for (
      let cursor = bucketStart(domain.minDay);
      cursor <= domain.maxDay;
      cursor = shiftCalendarDays(cursor, weekly ? 7 : 1)
    ) {
      buckets.set(toDateInputValue(cursor), {
        date: cursor,
        endDate: weekly ? shiftCalendarDays(cursor, 6) : cursor,
        total: 0,
        sessions: 0,
        parts: [],
        byHarness: new Map(),
      });
    }
    const harnessTotals = new Map<string, number>();
    for (const { row, time } of dated) {
      const bucket = buckets.get(toDateInputValue(bucketStart(new Date(time))));
      if (!bucket) continue;
      bucket.sessions++;
      if (row.costKnown) {
        bucket.total += row.costApprox;
        bucket.byHarness.set(row.harness, (bucket.byHarness.get(row.harness) ?? 0) + row.costApprox);
        harnessTotals.set(row.harness, (harnessTotals.get(row.harness) ?? 0) + row.costApprox);
      }
    }
    const harnesses = [...harnessTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const list = [...buckets.values()].map((bucket) => ({
      date: bucket.date,
      endDate: bucket.endDate > domain.maxDay ? domain.maxDay : bucket.endDate,
      total: bucket.total,
      sessions: bucket.sessions,
      parts: harnesses
        .map((name) => ({ harness: name, cost: bucket.byHarness.get(name) ?? 0 }))
        .filter((part) => part.cost > 0),
    }));
    const maxTotal = Math.max(...list.map((bucket) => bucket.total));
    const maxSessions = Math.max(...list.map((bucket) => bucket.sessions));
    const valueMode: 'cost' | 'sessions' = maxTotal > 0 ? 'cost' : 'sessions';
    const maxValue = valueMode === 'cost' ? maxTotal : maxSessions;
    if (maxValue <= 0) return null;
    return {
      list,
      maxValue,
      valueMode,
      weekly,
      harnesses,
      minDay: domain.minDay,
      maxDay: domain.maxDay,
      maxIndex: domain.maxIndex,
    };
  });

  const [draggingSelection, setDraggingSelection] = createSignal(false);
  let selectionDrag: {
    pointerId: number;
    startX: number;
    startFrom: number;
    startTo: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;

  const indexesForValue = (value: number[]): [number, number] | null => {
    const chart = data();
    if (!chart) return null;
    return normalizeDateIndexRange(value, chart.maxIndex);
  };

  const previewSliderValue = (value: number[]) => {
    const nextIndexes = indexesForValue(value);
    if (!nextIndexes) return;
    props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
  };

  const commitIndexes = (value?: number[]) => {
    if (value) {
      const nextIndexes = indexesForValue(value);
      if (nextIndexes) props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
    }
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyPreset = (mode: TimeRangePreset) => {
    props.dateRange.setPreset(mode);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyFromInput = (from: string) => {
    props.dateRange.setFromInput(from);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyToInput = (to: string) => {
    props.dateRange.setToInput(to);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const startSelectionDrag = (event: RangeDragPointerEvent, chart: NonNullable<ReturnType<typeof data>>) => {
    if (event.button !== 0) return;
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width || chart.maxIndex <= 0) return;
    const [startFrom, startTo] = props.dateRange.selectedIndexes();
    selectionDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startFrom,
      startTo,
      trackWidth: trackRect.width,
      maxIndex: chart.maxIndex,
    };
    setDraggingSelection(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    const span = selectionDrag.startTo - selectionDrag.startFrom;
    const delta = Math.round(
      ((event.clientX - selectionDrag.startX) / selectionDrag.trackWidth) * selectionDrag.maxIndex,
    );
    const from = clampNumber(selectionDrag.startFrom + delta, 0, Math.max(0, selectionDrag.maxIndex - span));
    props.dateRange.setIndexes(from, from + span);
    event.preventDefault();
    event.stopPropagation();
  };

  const endSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    selectionDrag = null;
    commitIndexes();
    setDraggingSelection(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Show
      when={data()}
      fallback={
        <section class={timeRangePanel} aria-label="Date range">
          <div>
            <div class={timeRangeTitle}>Time range</div>
            <div class={timeRangeMeta}>No dated sessions match the current filters</div>
          </div>
        </section>
      }
    >
      {(chart) => (
        <section class={timeRangePanel} aria-label="Date range">
          <div class={timeRangeHeader}>
            <div>
              <div class={timeRangeTitle}>Time range</div>
              <div class={timeRangeMeta}>{props.dateRange.label()}</div>
            </div>
            <fieldset class={presetGroup} aria-label="Date presets">
              <For each={dateRangePresets}>
                {(preset) => (
                  <button
                    class={presetButton}
                    type="button"
                    data-active={String(props.dateRange.mode() === preset.mode)}
                    onClick={() => applyPreset(preset.mode)}
                  >
                    {preset.label}
                  </button>
                )}
              </For>
            </fieldset>
          </div>

          <div class={dateEditRow}>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>From</span>
              <input
                class={dateInput}
                type="date"
                value={props.dateRange.inputValues().from}
                min={toDateInputValue(chart().minDay)}
                max={toDateInputValue(chart().maxDay)}
                onInput={(event) => applyFromInput(event.currentTarget.value)}
              />
            </label>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>To</span>
              <input
                class={dateInput}
                type="date"
                value={props.dateRange.inputValues().to}
                min={toDateInputValue(chart().minDay)}
                max={toDateInputValue(chart().maxDay)}
                onInput={(event) => applyToInput(event.currentTarget.value)}
              />
            </label>
            <div class={chartLegend}>
              <For each={chart().harnesses}>
                {(name) => (
                  <HarnessBadge
                    name={name}
                    active={props.activeHarness === name}
                    title={props.activeHarness === name ? `Clear ${name} filter` : `Filter by ${name}`}
                    onClick={() => props.onHarnessFilter(name)}
                  />
                )}
              </For>
            </div>
          </div>

          <Slider.Root
            class={timeSliderRoot}
            min={0}
            max={chart().maxIndex}
            step={1}
            value={props.dateRange.selectedIndexes()}
            thumbSize={{ width: 32, height: 64 }}
            aria-label={['Start date', 'End date']}
            getAriaValueText={(details) => fmtDateOnly(dateFromIndex(chart().minDay, details.value))}
            onValueChange={(details) => previewSliderValue(details.value)}
            onValueChangeEnd={(details) => commitIndexes(details.value)}
          >
            <Slider.Control class={timeSliderControl}>
              <Slider.Track class={timeSliderTrack}>
                <For each={monthTicksFor(chart())}>
                  {(tick) => <div class={monthGridline} style={{ left: `${tick.pct}%` }} aria-hidden="true" />}
                </For>
                <Slider.Range class={timeSliderRange} />
                <div class={timeSliderBars} aria-hidden="true">
                  <For each={chart().list}>
                    {(bucket) => (
                      <div class={timeBucket} title={timelineBucketTitle(bucket, chart().weekly, chart().valueMode)}>
                        <Show
                          when={chart().valueMode === 'cost'}
                          fallback={
                            <div
                              class={cx(timeBucketSegment, accentFill)}
                              style={{ height: `${Math.max(2, (bucket.sessions / chart().maxValue) * 100)}%` }}
                            />
                          }
                        >
                          <For each={bucket.parts}>
                            {(part) => (
                              <div
                                class={cx(timeBucketSegment, harnessFillFor(part.harness) ?? accentFill)}
                                style={{ height: `${Math.max(2, (part.cost / chart().maxValue) * 100)}%` }}
                              />
                            )}
                          </For>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <div class={timeSliderDimLeft} aria-hidden="true" />
                <div class={timeSliderDimRight} aria-hidden="true" />
                <button
                  class={timeSliderRangeDrag}
                  type="button"
                  tabIndex={-1}
                  aria-label="Drag selected date range"
                  title="Drag selected range"
                  data-dragging={String(draggingSelection())}
                  onPointerDown={(event) => startSelectionDrag(event, chart())}
                  onPointerMove={moveSelectionDrag}
                  onPointerUp={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                  onLostPointerCapture={endSelectionDrag}
                />
              </Slider.Track>
              <Slider.Thumb index={0} class={timeSliderThumb}>
                <Slider.HiddenInput />
              </Slider.Thumb>
              <Slider.Thumb index={1} class={timeSliderThumb}>
                <Slider.HiddenInput />
              </Slider.Thumb>
            </Slider.Control>
            <div class={timeAxis}>
              <span>{fmtDateOnly(chart().minDay)}</span>
              <For each={monthTicksFor(chart()).filter((tick) => tick.pct >= 7 && tick.pct <= 93)}>
                {(tick) => (
                  <span class={timeAxisTick} style={{ left: `${tick.pct}%` }}>
                    {tick.label}
                  </span>
                )}
              </For>
              <span>{fmtDateOnly(chart().maxDay)}</span>
            </div>
          </Slider.Root>
        </section>
      )}
    </Show>
  );
};

const ProjectSummary = (props: { groups: ProjectGroup[]; onProjectFilter: (value: string) => void }) => (
  <Show when={props.groups.length} fallback={<div class={empty}>No projects</div>}>
    <div class={tableWrap}>
      <table class={cx(table, projectTable)}>
        <thead>
          <tr>
            <th>Project</th>
            <th style={{ width: '88px' }} class={right}>
              Sessions
            </th>
            <th style={{ width: '110px' }} class={right}>
              Fresh
            </th>
            <th style={{ width: '110px' }} class={right}>
              Cache
            </th>
            <th style={{ width: '96px' }} class={right}>
              $API
            </th>
            <th style={{ width: '110px' }} class={right}>
              Lines
            </th>
            <th style={{ width: '96px' }} class={right}>
              Turns
            </th>
            <th style={{ width: '96px' }} class={right}>
              Tools
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.groups}>
            {(project) => (
              <tr>
                <td
                  class={strongCell}
                  title={project.key === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
                >
                  <button class={groupKeyButton} type="button" onClick={() => props.onProjectFilter(project.key)}>
                    {project.key}
                  </button>
                </td>
                <td class={numCell}>{fmtNum(project.sessions)}</td>
                <td class={numCell} title={fmtNum(project.fresh)}>
                  {fmtCompact(project.fresh)}
                </td>
                <td class={numCell} title={fmtNum(project.cache)}>
                  {fmtCompact(project.cache)}
                </td>
                <td class={numCell}>
                  <Show when={project.priced} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                    {fmtMoney(project.cost)}
                  </Show>
                </td>
                <td class={numCell}>
                  +{fmtNum(project.linesAdded)}/-{fmtNum(project.linesDeleted)}
                </td>
                <td class={numCell}>{fmtNum(project.turns)}</td>
                <td class={numCell}>{fmtNum(project.tools)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </Show>
);

const cursorAiLineTotal = (row: CursorCommitAttributionFacet) =>
  row.composerLinesAdded + row.composerLinesDeleted + row.tabLinesAdded + row.tabLinesDeleted;

const uniqueCursorCommits = (rows: CursorCommitAttributionFacet[]) => new Set(rows.map((row) => row.commitHash)).size;

const CursorAttributionPanel = (props: { rows: CursorCommitAttributionFacet[] }) => {
  const totals = createMemo(() =>
    props.rows.reduce(
      (acc, row) => ({
        aiLines: acc.aiLines + cursorAiLineTotal(row),
        blankLines: acc.blankLines + row.blankLinesAdded + row.blankLinesDeleted,
        humanLines: acc.humanLines + row.humanLinesAdded + row.humanLinesDeleted,
        totalLines: acc.totalLines + row.linesAdded + row.linesDeleted,
      }),
      { aiLines: 0, blankLines: 0, humanLines: 0, totalLines: 0 },
    ),
  );
  const aiPct = () => (totals().totalLines ? (totals().aiLines / totals().totalLines) * 100 : 0);

  return (
    <Show
      when={props.rows.length}
      fallback={<div class={empty}>No Cursor commit attribution data in this payload</div>}
    >
      <div class={metricGrid}>
        <MetricTile
          label="Scored commits"
          value={fmtNum(uniqueCursorCommits(props.rows))}
          hint="Unique commit hashes scored by Cursor"
        />
        <MetricTile
          label="Branch rows"
          value={fmtNum(props.rows.length)}
          hint="Cursor stores attribution per branch, so commits can repeat"
        />
        <MetricTile
          label="AI line share"
          value={fmtPct(aiPct())}
          hint="Composer + Tab lines over scored added/deleted lines"
        />
        <MetricTile
          label="Human lines"
          value={fmtNum(totals().humanLines)}
          hint="Lines Cursor classified as human-authored"
        />
      </div>

      <div class={tableWrap}>
        <table class={table} style={{ 'min-width': '1120px' }}>
          <thead>
            <tr>
              <th>Commit</th>
              <th style={{ width: '150px' }}>Branch</th>
              <th style={{ width: '110px' }} class={right}>
                AI %
              </th>
              <th style={{ width: '120px' }} class={right}>
                Composer
              </th>
              <th style={{ width: '100px' }} class={right}>
                Tab
              </th>
              <th style={{ width: '110px' }} class={right}>
                Human
              </th>
              <th style={{ width: '130px' }} class={right}>
                Total +/-
              </th>
              <th style={{ width: '150px' }}>Scored</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(row) => (
                <tr>
                  <td class={strongCell} title={row.commitHash}>
                    <div>{row.commitMessage || row.commitHash.slice(0, 10)}</div>
                    <div class={meta}>{row.commitHash.slice(0, 10)}</div>
                  </td>
                  <td>{row.branchName}</td>
                  <td class={numCell}>{row.v2AiPercentage == null ? '—' : fmtPct(row.v2AiPercentage)}</td>
                  <td class={numCell}>
                    +{fmtNum(row.composerLinesAdded)}/-{fmtNum(row.composerLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.tabLinesAdded)}/-{fmtNum(row.tabLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.humanLinesAdded)}/-{fmtNum(row.humanLinesDeleted)}
                  </td>
                  <td class={numCell}>
                    +{fmtNum(row.linesAdded)}/-{fmtNum(row.linesDeleted)}
                  </td>
                  <td>{fmtDate(row.scoredAt)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
};

const formatRefreshCountdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
};

const formatRefreshAge = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

type RefreshStatusKind = 'idle' | 'refreshing' | 'success' | 'delayed' | 'error' | 'paused' | 'static';

const refreshStatusLabels: Record<RefreshStatusKind, string> = {
  delayed: 'Delayed',
  error: 'Error',
  idle: 'Ready',
  paused: 'Paused',
  refreshing: 'Refreshing',
  static: 'Static',
  success: 'Live',
};

const refreshRingClass: Record<RefreshStatusKind, string> = {
  delayed: refreshRingDelayed,
  error: refreshRingError,
  idle: refreshRingIdle,
  paused: refreshRingPaused,
  refreshing: refreshRingRefreshing,
  static: refreshRingStatic,
  success: refreshRingSuccess,
};

const RefreshStatus = (props: {
  canRefresh: boolean;
  generatedAt: string;
  lastRefreshError: string | null;
  lastSuccessfulRefreshAt: number | null;
  nextRefreshAt: number | null;
  onTogglePause: () => void;
  refreshErrorCount: number;
  refreshIntervalMs: number;
  refreshPaused: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) => {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  const countdown = createMemo(() => {
    const next = props.nextRefreshAt;
    if (!next) return 'paused';
    return formatRefreshCountdown(next - now());
  });
  const remainingRatio = createMemo(() => {
    if (!props.canRefresh || props.refreshPaused || props.nextRefreshAt == null) return 0;
    if (props.refreshing) return 1;
    return Math.max(0, Math.min(1, (props.nextRefreshAt - now()) / props.refreshIntervalMs));
  });
  const status = createMemo<RefreshStatusKind>(() => {
    if (!props.canRefresh) return 'static';
    if (props.refreshPaused) return 'paused';
    if (props.refreshing) return 'refreshing';
    if (props.refreshErrorCount >= 2) return 'error';
    if (props.refreshErrorCount === 1) return 'delayed';
    return props.lastSuccessfulRefreshAt == null ? 'idle' : 'success';
  });
  const statusLabel = () => refreshStatusLabels[status()];
  const primaryLabel = createMemo(() => {
    const currentStatus = status();
    if (currentStatus === 'static') return 'Static';
    if (currentStatus === 'paused') return 'Paused';
    if (currentStatus === 'refreshing') return 'Refreshing';
    if (currentStatus === 'delayed' || currentStatus === 'error') return `${statusLabel()} · retry ${countdown()}`;
    return `Next ${countdown()}`;
  });
  const tooltipLines = createMemo(() => {
    const lines = [`Status: ${statusLabel()}`, `Generated: ${fmtDate(props.generatedAt)}`];
    if (props.canRefresh) lines.push(`Interval: ${formatRefreshCountdown(props.refreshIntervalMs)}`);
    else lines.push('Auto-refresh unavailable for static snapshots');
    if (props.canRefresh && !props.refreshPaused) lines.push(`Next refresh: ${countdown()}`);
    if (props.refreshPaused) lines.push('Auto-refresh is paused');
    if (props.lastSuccessfulRefreshAt != null) {
      lines.push(`Last successful refresh: ${formatRefreshAge(now() - props.lastSuccessfulRefreshAt)}`);
    }
    if (props.lastRefreshError) lines.push(`Last error: ${props.lastRefreshError}`);
    return lines;
  });

  return (
    <Tooltip.Root openDelay={400} positioning={{ placement: 'bottom' }}>
      <Tooltip.Trigger
        class={cx(refreshStatus, status() === 'delayed' || status() === 'error' ? refreshStatusError : undefined)}
      >
        <span
          class={cx(refreshRing, refreshRingClass[status()])}
          role="status"
          aria-live="polite"
          aria-label={`Data refresh status: ${primaryLabel()}`}
          style={{ '--refresh-progress': String(remainingRatio()) }}
        />
        <button
          class={refreshButton}
          type="button"
          disabled={!props.canRefresh || props.refreshing}
          onClick={props.onRefresh}
        >
          Refresh
        </button>
        <button
          class={refreshIconButton}
          type="button"
          disabled={!props.canRefresh}
          aria-label={props.refreshPaused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
          onClick={props.onTogglePause}
        >
          {props.refreshPaused ? '>' : '||'}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Positioner>
        <Tooltip.Content class={tooltipContent}>
          <For each={tooltipLines()}>{(line) => <div>{line}</div>}</For>
        </Tooltip.Content>
      </Tooltip.Positioner>
    </Tooltip.Root>
  );
};

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
