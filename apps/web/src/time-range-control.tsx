import { SegmentedControl } from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  chartLegendList,
  chartLegendPct,
  chartLegendSwatch,
  dateEditRow,
  dateFieldGroup,
  dateInput,
  dimensionSwatch,
  inlineFieldLabel,
  migrationCrosshair,
  migrationLegendButton,
  migrationLegendMore,
  migrationReadout,
  migrationReadoutDate,
  migrationReadoutHint,
  migrationReadoutItem,
  migrationReadoutItemActive,
  migrationReadoutSwatch,
  migrationReadoutTotal,
  migrationReadoutValue,
  migrationTrend,
  migrationTrendDown,
  migrationTrendUp,
  monthGridline,
  timeAxis,
  timeAxisTick,
  timeBucket,
  timeBucketSegment,
  timelineHoverLayer,
  timeRangeHeader,
  timeRangeHeaderControls,
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
} from '@ai-usage/design-system/report';
import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import {
  clampNumber,
  dateFromIndex,
  dateIndexFrom,
  dateRangePresets,
  normalizeDateIndexRange,
  type TimeRangePreset,
  toDateInputValue,
} from './date-range';
import type { DateRangeController } from './date-range-controller';
import {
  buildTimelineData,
  type MigrationGranularity,
  type TimelineBucket,
  type TimelineDimension,
  type TimelineValue,
} from './overview-model';
import { type DashboardRow, fmtDateOnly, fmtMoney, fmtNum, fmtPct } from './shared';

const track = (..._values: unknown[]) => _values.length;
const LEGEND_LIMIT = 12;
const READOUT_LIMIT = 8;
const MAX_DELTA_PCT = 1000;

type RangeDragPointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };
type RangeHandle = 'start' | 'end';
type TimelineScale = 'compact' | 'linear';

const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });
const monthYearFormatter = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });

const DIMENSION_ITEMS = [
  { label: 'Harness', value: 'harness' },
  { label: 'Model', value: 'model' },
  { label: 'Provider', value: 'provider' },
  { label: 'Project', value: 'project' },
] as const;

const GRANULARITY_ITEMS = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
] as const;

const VALUE_ITEMS = [
  { label: 'Value', value: 'cost' },
  { label: 'Share', value: 'share' },
  { label: 'Sessions', value: 'sessions' },
] as const;

const SCALE_ITEMS = [
  { label: 'Linear', value: 'linear' },
  { label: 'Compact', value: 'compact' },
] as const;

const toTimelineDimension = (value: string): TimelineDimension =>
  value === 'model' || value === 'provider' || value === 'project' ? value : 'harness';

const toGranularity = (value: string): MigrationGranularity => (value === 'week' || value === 'month' ? value : 'day');

const toTimelineValue = (value: string): TimelineValue => (value === 'share' || value === 'sessions' ? value : 'cost');
const toTimelineScale = (value: string): TimelineScale => (value === 'linear' ? 'linear' : 'compact');

const bucketLabel = (date: Date, granularity: MigrationGranularity) => {
  if (granularity === 'month') {
    return monthYearFormatter.format(date);
  }
  if (granularity === 'week') {
    return `Week of ${fmtDateOnly(date)}`;
  }
  return fmtDateOnly(date);
};

// Month boundaries anchor the brush; the two endpoint labels only give the
// extremes, which is not enough to aim a selection on a long domain.
const monthTicksFor = (chart: { minDay: Date; maxDay: Date; maxIndex: number }) => {
  if (chart.maxIndex < 28) {
    return [];
  }
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

export const TimeRangeControl = (props: {
  rows: DashboardRow[];
  dateRange: DateRangeController;
  activeHarness: string[];
  activeFieldFilters: Partial<Record<Exclude<TimelineDimension, 'harness'>, string>>;
  onDateRangeCommit: () => void;
  onDimensionFilter: (dimension: TimelineDimension, value: string) => void;
}) => {
  const [chartDomain, setChartDomain] = createSignal(props.dateRange.domain());
  const [dimension, setDimension] = createSignal<TimelineDimension>('harness');
  const [granularity, setGranularity] = createSignal<MigrationGranularity>(
    (props.dateRange.domain()?.maxIndex ?? 0) > 120 ? 'week' : 'day',
  );
  const [valueMode, setValueMode] = createSignal<TimelineValue>('cost');
  const [scaleMode, setScaleMode] = createSignal<TimelineScale>('compact');
  const [hoveredBucket, setHoveredBucket] = createSignal<number | null>(null);
  const [hoveredKey, setHoveredKey] = createSignal<string | null>(null);
  const [showAll, setShowAll] = createSignal(false);
  const syncChartDomain = () => setChartDomain(props.dateRange.domain());
  createEffect(() => {
    track(props.rows);
    setChartDomain(untrack(() => props.dateRange.domain()));
  });

  const data = createMemo(() => {
    const domain = chartDomain();
    if (!domain) {
      return null;
    }
    const timeline = buildTimelineData(props.rows, {
      dimension: dimension(),
      domain,
      granularity: granularity(),
    });
    if (!timeline) {
      return null;
    }
    return {
      ...timeline,
      minDay: domain.minDay,
      maxDay: domain.maxDay,
      maxIndex: domain.maxIndex,
    };
  });

  const visibleSeries = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [];
    }
    return showAll() ? chart.series : chart.series.slice(0, LEGEND_LIMIT);
  });

  const usesSessionShare = (chart: NonNullable<ReturnType<typeof data>>) =>
    valueMode() === 'share' && chart.grandTotal <= 0;

  const bucketValue = (bucket: TimelineBucket, chart: NonNullable<ReturnType<typeof data>>) =>
    valueMode() === 'sessions' || usesSessionShare(chart) ? bucket.sessions : bucket.total;

  const entryValue = (
    entry: { cost: number; sessions: number } | undefined,
    chart: NonNullable<ReturnType<typeof data>>,
  ) => (valueMode() === 'sessions' || usesSessionShare(chart) ? (entry?.sessions ?? 0) : (entry?.cost ?? 0));

  const maxBucketValue = (chart: NonNullable<ReturnType<typeof data>>) =>
    valueMode() === 'sessions' || usesSessionShare(chart) ? chart.maxBucketSessions : chart.maxBucketTotal;

  const formatValue = (value: number, useSessions = false) =>
    valueMode() === 'sessions' || useSessions ? `${fmtNum(value)} sessions` : fmtMoney(value);

  const bars = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [];
    }
    return chart.buckets.map((bucket) => {
      const total = bucketValue(bucket, chart);
      const segments: { key: string; rank: number; value: number }[] = [];
      for (let rank = 0; rank < chart.series.length; rank++) {
        const series = chart.series[rank];
        if (!series) {
          continue;
        }
        const value = entryValue(bucket.byKey.get(series.key), chart);
        if (value > 0) {
          segments.push({ key: series.key, rank, value });
        }
      }
      return { bucket, segments, total };
    });
  });

  const barHeight = (bucket: TimelineBucket, chart: NonNullable<ReturnType<typeof data>>) => {
    const total = bucketValue(bucket, chart);
    if (valueMode() === 'share') {
      return total > 0 ? 100 : 0;
    }
    const maxValue = maxBucketValue(chart);
    if (maxValue <= 0) {
      return 0;
    }
    const ratio = total / maxValue;
    return (scaleMode() === 'compact' ? Math.sqrt(ratio) : ratio) * 100;
  };

  const segmentHeight = (segmentValue: number, bucketTotal: number) =>
    bucketTotal > 0 ? (segmentValue / bucketTotal) * 100 : 0;

  const segmentOpacity = (key: string) => {
    const active = hoveredKey();
    if (active === null) {
      return 0.92;
    }
    return active === key ? 1 : 0.26;
  };

  const renderedSegments = (segments: { key: string; rank: number; value: number }[]) => [...segments].reverse();

  const readout = createMemo(() => {
    const chart = data();
    const index = hoveredBucket();
    if (!chart || index === null) {
      return null;
    }
    const bucket = chart.buckets[index];
    if (!bucket) {
      return null;
    }
    const previous = index > 0 ? chart.buckets[index - 1] : null;
    const rows: { delta: number | null; key: string; rank: number; value: number }[] = [];
    for (let rank = 0; rank < chart.series.length; rank++) {
      const series = chart.series[rank];
      if (!series) {
        continue;
      }
      const value = entryValue(bucket.byKey.get(series.key), chart);
      if (value <= 0) {
        continue;
      }
      const prior = previous ? entryValue(previous.byKey.get(series.key), chart) : 0;
      const delta = prior > 1e-9 ? ((value - prior) / prior) * 100 : null;
      rows.push({ delta, key: series.key, rank, value });
    }
    rows.sort((a, b) => b.value - a.value);
    const visible = rows.slice(0, READOUT_LIMIT);
    return {
      bucket,
      hasPrevious: previous !== null,
      hidden: rows.length - visible.length,
      label: bucketLabel(bucket.date, granularity()),
      pct: ((index + 0.5) / chart.buckets.length) * 100,
      rows: visible,
      total: bucketValue(bucket, chart),
      useSessions: valueMode() === 'sessions' || usesSessionShare(chart),
    };
  });

  const globalReadout = createMemo(() => {
    const chart = data();
    if (!chart) {
      return null;
    }
    const useSessions = valueMode() === 'sessions' || usesSessionShare(chart);
    const rows = chart.series
      .map((series, rank) => ({
        delta: null,
        key: series.key,
        rank,
        value: useSessions ? series.sessions : series.total,
      }))
      .filter((row) => row.value > 0);
    const visible = rows.slice(0, READOUT_LIMIT);
    return {
      hasPrevious: false,
      hidden: rows.length - visible.length,
      label: `${fmtDateOnly(chart.first)} – ${fmtDateOnly(chart.last)}`,
      rows: visible,
      total: useSessions ? chart.grandSessions : chart.grandTotal,
      useSessions,
    };
  });

  const activeReadout = createMemo(() => readout() ?? globalReadout());

  const updateHover = (event: MouseEvent & { currentTarget: HTMLElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const chart = data();
    if (!chart || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const count = chart.buckets.length;
    const index = Math.max(0, Math.min(count - 1, Math.floor(((event.clientX - rect.left) / rect.width) * count)));
    setHoveredBucket(index);

    const bucket = chart.buckets[index];
    if (!bucket) {
      setHoveredKey(null);
      return;
    }
    const total = bucketValue(bucket, chart);
    const heightFraction = barHeight(bucket, chart) / 100;
    const fromBottom = (rect.bottom - event.clientY) / rect.height;
    if (total <= 0 || heightFraction <= 0 || fromBottom > heightFraction) {
      setHoveredKey(null);
      return;
    }
    const within = fromBottom / heightFraction;
    let cumulative = 0;
    let found: string | null = null;
    for (const series of chart.series) {
      const value = entryValue(bucket.byKey.get(series.key), chart);
      const share = total > 0 ? value / total : 0;
      if (share <= 0) {
        continue;
      }
      if (within <= cumulative + share) {
        found = series.key;
        break;
      }
      cumulative += share;
    }
    setHoveredKey(found);
  };

  const clearHover = () => {
    setHoveredBucket(null);
    setHoveredKey(null);
  };

  const swatch = (key: string, rank: number) => dimensionSwatch(dimension(), key, rank);

  const isLegendActive = (key: string) => {
    const currentDimension = dimension();
    if (currentDimension === 'harness') {
      return props.activeHarness.includes(key);
    }
    return props.activeFieldFilters[currentDimension] === key;
  };

  const [draggingSelection, setDraggingSelection] = createSignal(false);
  let selectionDrag: {
    pointerId: number;
    startX: number;
    startFrom: number;
    startTo: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;
  let handleDrag: {
    handle: RangeHandle;
    pointerId: number;
    startIndex: number;
    startX: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;

  const indexesForValue = (value: number[]): [number, number] | null => {
    const chart = data();
    if (!chart) {
      return null;
    }
    return normalizeDateIndexRange(value, chart.maxIndex);
  };

  const commitIndexes = (value?: number[]) => {
    if (value) {
      const nextIndexes = indexesForValue(value);
      if (nextIndexes) {
        props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
      }
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
    if (event.button !== 0) {
      return;
    }
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width || chart.maxIndex <= 0) {
      return;
    }
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
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) {
      return;
    }
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
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) {
      return;
    }
    selectionDrag = null;
    commitIndexes();
    setDraggingSelection(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const setHandleIndex = (handle: RangeHandle, index: number) => {
    const [from, to] = props.dateRange.selectedIndexes();
    if (handle === 'start') {
      props.dateRange.setIndexes(Math.min(index, to), to);
    } else {
      props.dateRange.setIndexes(from, Math.max(index, from));
    }
  };

  const startHandleDrag = (
    event: RangeDragPointerEvent,
    handle: RangeHandle,
    chart: NonNullable<ReturnType<typeof data>>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width || chart.maxIndex <= 0) {
      return;
    }
    const [from, to] = props.dateRange.selectedIndexes();
    handleDrag = {
      handle,
      pointerId: event.pointerId,
      startIndex: handle === 'start' ? from : to,
      startX: event.clientX,
      trackWidth: trackRect.width,
      maxIndex: chart.maxIndex,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveHandleDrag = (event: RangeDragPointerEvent) => {
    if (!handleDrag || handleDrag.pointerId !== event.pointerId) {
      return;
    }
    const delta = Math.round(((event.clientX - handleDrag.startX) / handleDrag.trackWidth) * handleDrag.maxIndex);
    setHandleIndex(handleDrag.handle, handleDrag.startIndex + delta);
    event.preventDefault();
    event.stopPropagation();
  };

  const endHandleDrag = (event: RangeDragPointerEvent) => {
    if (!handleDrag || handleDrag.pointerId !== event.pointerId) {
      return;
    }
    handleDrag = null;
    commitIndexes();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const handleSliderKeyDown = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }, handle: RangeHandle) => {
    const chart = data();
    if (!chart) {
      return;
    }
    const [from, to] = props.dateRange.selectedIndexes();
    const current = handle === 'start' ? from : to;
    const step = event.shiftKey ? 7 : 1;
    const next = (() => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        return current - step;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        return current + step;
      }
      if (event.key === 'PageDown') {
        return current - 30;
      }
      if (event.key === 'PageUp') {
        return current + 30;
      }
      if (event.key === 'Home') {
        return 0;
      }
      if (event.key === 'End') {
        return chart.maxIndex;
      }
      return null;
    })();
    if (next == null) {
      return;
    }
    setHandleIndex(handle, clampNumber(next, 0, chart.maxIndex));
    commitIndexes();
    event.preventDefault();
    event.stopPropagation();
  };

  const rangeVars = (chart: NonNullable<ReturnType<typeof data>>) => {
    const [from, to] = props.dateRange.selectedIndexes();
    const max = Math.max(1, chart.maxIndex);
    const startPct = (from / max) * 100;
    const endPct = 100 - (to / max) * 100;
    return {
      '--slider-range-start': `${startPct}%`,
      '--slider-range-end': `${endPct}%`,
    };
  };

  return (
    <Show
      fallback={
        <section aria-label="Date range" class={timeRangePanel}>
          <div>
            <div class={timeRangeTitle}>Time range</div>
            <div class={timeRangeMeta}>No dated sessions match the current filters</div>
          </div>
        </section>
      }
      when={data()}
    >
      {(chart) => (
        <section aria-label="Date range" class={timeRangePanel}>
          <div class={timeRangeHeader}>
            <div>
              <div class={timeRangeTitle}>Time range</div>
              <div class={timeRangeMeta}>{props.dateRange.label()}</div>
            </div>
            <div class={timeRangeHeaderControls}>
              <SegmentedControl
                ariaLabel="Date presets"
                items={dateRangePresets.map((preset) => ({ label: preset.label, value: preset.mode }))}
                label="Range"
                onValueChange={(value) => {
                  const preset = dateRangePresets.find((item) => item.mode === value);
                  if (preset) {
                    applyPreset(preset.mode);
                  }
                }}
                value={props.dateRange.mode()}
              />
              <SegmentedControl
                ariaLabel="Timeline dimension"
                items={DIMENSION_ITEMS}
                label="Group"
                onValueChange={(value) => {
                  setDimension(toTimelineDimension(value));
                  setShowAll(false);
                  clearHover();
                }}
                value={dimension()}
              />
              <SegmentedControl
                ariaLabel="Timeline granularity"
                items={GRANULARITY_ITEMS}
                label="Bucket"
                onValueChange={(value) => {
                  setGranularity(toGranularity(value));
                  clearHover();
                }}
                value={granularity()}
              />
              <SegmentedControl
                ariaLabel="Timeline value"
                items={VALUE_ITEMS}
                label="Metric"
                onValueChange={(value) => {
                  setValueMode(toTimelineValue(value));
                  clearHover();
                }}
                value={valueMode()}
              />
              <SegmentedControl
                ariaLabel="Timeline scale"
                items={SCALE_ITEMS}
                label="Scale"
                onValueChange={(value) => {
                  setScaleMode(toTimelineScale(value));
                  clearHover();
                }}
                value={scaleMode()}
              />
            </div>
          </div>

          <div class={dateEditRow}>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>From</span>
              <input
                class={dateInput}
                max={toDateInputValue(chart().maxDay)}
                min={toDateInputValue(chart().minDay)}
                onInput={(event) => applyFromInput(event.currentTarget.value)}
                type="date"
                value={props.dateRange.inputValues().from}
              />
            </label>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>To</span>
              <input
                class={dateInput}
                max={toDateInputValue(chart().maxDay)}
                min={toDateInputValue(chart().minDay)}
                onInput={(event) => applyToInput(event.currentTarget.value)}
                type="date"
                value={props.dateRange.inputValues().to}
              />
            </label>
            <div class={chartLegendList}>
              <For each={visibleSeries()}>
                {(entry) => {
                  const rank = chart().series.findIndex((series) => series.key === entry.key);
                  const marker = swatch(entry.key, rank);
                  const useSessions = valueMode() === 'sessions' || usesSessionShare(chart());
                  const value = useSessions ? entry.sessions : entry.total;
                  const total = useSessions ? chart().grandSessions : chart().grandTotal;
                  return (
                    <button
                      class={cx(migrationLegendButton, isLegendActive(entry.key) ? migrationReadoutItemActive : '')}
                      onClick={() => props.onDimensionFilter(dimension(), entry.key)}
                      onMouseEnter={() => setHoveredKey(entry.key)}
                      onMouseLeave={() => setHoveredKey(null)}
                      title={
                        isLegendActive(entry.key) ? `Clear or replace ${entry.key} filter` : `Filter by ${entry.key}`
                      }
                      type="button"
                    >
                      <span class={cx(chartLegendSwatch, marker.className)} style={marker.style} />
                      {entry.key}
                      <span class={chartLegendPct}>{fmtPct((value / Math.max(1e-9, total)) * 100)}</span>
                    </button>
                  );
                }}
              </For>
              <Show when={chart().series.length > LEGEND_LIMIT}>
                <button class={migrationLegendMore} onClick={() => setShowAll((value) => !value)} type="button">
                  {showAll() ? 'Show less' : `Show all (${chart().series.length})`}
                </button>
              </Show>
            </div>
          </div>

          <div class={timeSliderRoot}>
            <div class={timeSliderControl}>
              <div class={timeSliderTrack} style={rangeVars(chart())}>
                <For each={monthTicksFor(chart())}>
                  {(tick) => <div aria-hidden="true" class={monthGridline} style={{ left: `${tick.pct}%` }} />}
                </For>
                <div
                  aria-hidden="true"
                  class={timeSliderRange}
                  style={{ left: 'var(--slider-range-start)', right: 'var(--slider-range-end)' }}
                />
                <div aria-hidden="true" class={timeSliderBars}>
                  <For each={bars()}>
                    {(bar) => (
                      <div class={timeBucket} style={{ height: `${barHeight(bar.bucket, chart())}%` }}>
                        <For each={renderedSegments(bar.segments)}>
                          {(segment) => {
                            const marker = swatch(segment.key, segment.rank);
                            return (
                              <div
                                class={cx(timeBucketSegment, marker.className ?? accentFill)}
                                style={{
                                  height: `${Math.max(1, segmentHeight(segment.value, bar.total))}%`,
                                  opacity: segmentOpacity(segment.key),
                                  ...marker.style,
                                }}
                              />
                            );
                          }}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
                <button
                  aria-label="Inspect timeline bucket"
                  class={timelineHoverLayer}
                  onMouseLeave={clearHover}
                  onMouseMove={updateHover}
                  tabIndex={-1}
                  type="button"
                />
                <Show when={readout()}>
                  {(tip) => <div aria-hidden="true" class={migrationCrosshair} style={{ left: `${tip().pct}%` }} />}
                </Show>
                <div aria-hidden="true" class={timeSliderDimLeft} />
                <div aria-hidden="true" class={timeSliderDimRight} />
                <button
                  aria-label="Drag selected date range"
                  class={timeSliderRangeDrag}
                  data-dragging={String(draggingSelection())}
                  onLostPointerCapture={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                  onPointerDown={(event) => startSelectionDrag(event, chart())}
                  onPointerMove={moveSelectionDrag}
                  onPointerUp={endSelectionDrag}
                  tabIndex={-1}
                  title="Drag selected range"
                  type="button"
                />
                <button
                  aria-label="Start date"
                  aria-valuemax={chart().maxIndex}
                  aria-valuemin={0}
                  aria-valuenow={props.dateRange.selectedIndexes()[0]}
                  aria-valuetext={fmtDateOnly(dateFromIndex(chart().minDay, props.dateRange.selectedIndexes()[0]))}
                  class={timeSliderThumb}
                  onKeyDown={(event) => handleSliderKeyDown(event, 'start')}
                  onLostPointerCapture={endHandleDrag}
                  onPointerCancel={endHandleDrag}
                  onPointerDown={(event) => startHandleDrag(event, 'start', chart())}
                  onPointerMove={moveHandleDrag}
                  onPointerUp={endHandleDrag}
                  role="slider"
                  style={{ left: 'var(--slider-range-start)' }}
                  type="button"
                />
                <button
                  aria-label="End date"
                  aria-valuemax={chart().maxIndex}
                  aria-valuemin={0}
                  aria-valuenow={props.dateRange.selectedIndexes()[1]}
                  aria-valuetext={fmtDateOnly(dateFromIndex(chart().minDay, props.dateRange.selectedIndexes()[1]))}
                  class={timeSliderThumb}
                  onKeyDown={(event) => handleSliderKeyDown(event, 'end')}
                  onLostPointerCapture={endHandleDrag}
                  onPointerCancel={endHandleDrag}
                  onPointerDown={(event) => startHandleDrag(event, 'end', chart())}
                  onPointerMove={moveHandleDrag}
                  onPointerUp={endHandleDrag}
                  role="slider"
                  style={{ left: 'calc(100% - var(--slider-range-end))' }}
                  type="button"
                />
              </div>
            </div>
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
            <div class={migrationReadout}>
              <Show when={activeReadout()}>
                {(tip) => (
                  <>
                    <span class={migrationReadoutDate}>{tip().label}</span>
                    <span class={migrationReadoutTotal}>{formatValue(tip().total, tip().useSessions)}</span>
                    <For each={tip().rows}>
                      {(row) => {
                        const marker = swatch(row.key, row.rank);
                        return (
                          <span
                            class={cx(
                              migrationReadoutItem,
                              row.key === hoveredKey() ? migrationReadoutItemActive : undefined,
                            )}
                          >
                            <span class={cx(migrationReadoutSwatch, marker.className)} style={marker.style} />
                            {row.key}
                            <span class={migrationReadoutValue}>
                              {formatValue(row.value, tip().useSessions)} ·{' '}
                              {fmtPct((row.value / Math.max(1e-9, tip().total)) * 100)}
                            </span>
                            <Show
                              when={
                                tip().hasPrevious &&
                                row.delta !== null &&
                                Math.abs(row.delta) >= 1 &&
                                Math.abs(row.delta) < MAX_DELTA_PCT
                              }
                            >
                              <span
                                class={cx(
                                  migrationTrend,
                                  (row.delta ?? 0) >= 0 ? migrationTrendUp : migrationTrendDown,
                                )}
                              >
                                {(row.delta ?? 0) >= 0 ? '▲' : '▼'} {fmtPct(Math.abs(row.delta ?? 0))}
                              </span>
                            </Show>
                          </span>
                        );
                      }}
                    </For>
                    <Show when={tip().hidden > 0}>
                      <span class={migrationReadoutHint}>+{tip().hidden} more</span>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        </section>
      )}
    </Show>
  );
};
