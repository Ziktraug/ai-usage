import { SegmentedControl } from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  chartLegendList,
  chartLegendPct,
  chartLegendSwatch,
  dimensionSwatch,
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
  presetButton,
  timeAxis,
  timeAxisTick,
  timeBucket,
  timeBucketSegment,
  timeChartOptions,
  timeChartOptionsCurrent,
  timeChartOptionsSummary,
  timeChartOptionsTitle,
  timeChartToolbar,
  timeChartZoomButton,
  timeChartZoomControls,
  timeChartZoomSummary,
  timelineHoverLayer,
  timeRangeArrow,
  timeRangeDuration,
  timeRangeHeader,
  timeRangeMeta,
  timeRangePanel,
  timeRangeSummary,
  timeRangeSummaryDates,
  timeRangeTitle,
  timeRangeViewControls,
  timeSliderBars,
  timeSliderBrushColumn,
  timeSliderBrushHeader,
  timeSliderBrushTrack,
  timeSliderControl,
  timeSliderDateChip,
  timeSliderDimLeft,
  timeSliderDimRight,
  timeSliderFrame,
  timeSliderHandleLabelEnd,
  timeSliderHandleLabelStart,
  timeSliderHandleLabels,
  timeSliderQuickRanges,
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
  shiftCalendarDays,
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
const CHART_ZOOM_FACTOR = 1.5;
const MIN_VISIBLE_BUCKETS = 1;
const MAX_VISUAL_TICKS = 14;
const VISUAL_VIEW_PRESETS = [
  { days: 2, label: '2d' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
] as const;

type RangeDragPointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };
type TimelinePointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };
type RangeHandle = 'start' | 'end';
type VisualRangeHandle = 'start' | 'end';

interface VisualZoomRange {
  from: number;
  to: number;
}

const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });
const monthYearFormatter = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });

const dayCountLabel = (count: number) => `${fmtNum(count)} ${count === 1 ? 'day' : 'days'}`;

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
  { label: 'API value', value: 'cost' },
  { label: 'Share', value: 'share' },
  { label: 'Sessions', value: 'sessions' },
] as const;

export const chartOptionsSummary = (
  dimension: TimelineDimension,
  granularity: MigrationGranularity,
  value: TimelineValue,
) => {
  const dimensionLabel = DIMENSION_ITEMS.find((item) => item.value === dimension)?.label ?? 'Harness';
  const granularityLabel = GRANULARITY_ITEMS.find((item) => item.value === granularity)?.label ?? 'Day';
  const valueLabel = VALUE_ITEMS.find((item) => item.value === value)?.label ?? 'API value';
  return `${dimensionLabel} · ${granularityLabel} · ${valueLabel}`;
};

const toTimelineDimension = (value: string): TimelineDimension =>
  value === 'model' || value === 'provider' || value === 'project' ? value : 'harness';

const toGranularity = (value: string): MigrationGranularity => (value === 'week' || value === 'month' ? value : 'day');

const toTimelineValue = (value: string): TimelineValue => (value === 'share' || value === 'sessions' ? value : 'cost');
const TIMELINE_PLOT_INSET_PX = 8;
const SPACED_BUCKET_MIN_WIDTH_PX = 2;
const SPACED_BUCKET_GAP_PX = 2;

const sliderIndexForKey = (key: string, current: number, max: number, step: number): number | null => {
  if (key === 'ArrowLeft' || key === 'ArrowDown') {
    return current - step;
  }
  if (key === 'ArrowRight' || key === 'ArrowUp') {
    return current + step;
  }
  if (key === 'PageDown') {
    return current - 30;
  }
  if (key === 'PageUp') {
    return current + 30;
  }
  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return max;
  }
  return null;
};

const cssNumber = (value: number) => Number(value.toFixed(4)).toString();

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

const normalizeVisualZoomRange = (range: VisualZoomRange | null, bucketCount: number): VisualZoomRange => {
  const lastIndex = Math.max(0, bucketCount - 1);
  if (!range || bucketCount <= 0) {
    return { from: 0, to: lastIndex };
  }
  const from = clampNumber(Math.round(range.from), 0, lastIndex);
  const to = clampNumber(Math.round(range.to), 0, lastIndex);
  return from <= to ? { from, to } : { from: to, to: from };
};

const bucketRangeSize = (range: VisualZoomRange) => range.to - range.from + 1;

const visibleMonthTicksFor = (buckets: TimelineBucket[], range: VisualZoomRange) => {
  const visibleBuckets = buckets.slice(range.from, range.to + 1);
  if (visibleBuckets.length < 8) {
    return [];
  }

  const ticks: { pct: number; label: string }[] = [];
  let previousMonthKey = `${visibleBuckets[0]?.date.getFullYear() ?? 0}-${visibleBuckets[0]?.date.getMonth() ?? 0}`;
  for (let index = 1; index < visibleBuckets.length; index++) {
    const bucket = visibleBuckets[index];
    if (!bucket) {
      continue;
    }
    const monthKey = `${bucket.date.getFullYear()}-${bucket.date.getMonth()}`;
    if (monthKey === previousMonthKey) {
      continue;
    }
    previousMonthKey = monthKey;
    const label =
      bucket.date.getMonth() === 0
        ? `${monthTickFormatter.format(bucket.date)} ’${String(bucket.date.getFullYear()).slice(-2)}`
        : monthTickFormatter.format(bucket.date);
    ticks.push({ label, pct: (index / visibleBuckets.length) * 100 });
  }

  if (ticks.length <= MAX_VISUAL_TICKS) {
    return ticks;
  }

  const step = Math.ceil(ticks.length / MAX_VISUAL_TICKS);
  return ticks.filter((_, index) => index % step === 0);
};

const bucketIndexAtOrBefore = (buckets: TimelineBucket[], date: Date) => {
  const time = date.getTime();
  let matchedIndex = 0;
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index];
    if (!bucket || bucket.date.getTime() > time) {
      break;
    }
    matchedIndex = index;
  }
  return matchedIndex;
};

export const timelinePlotLeft = (pct: number) => {
  const clampedPct = clampNumber(pct, 0, 100);
  // Bars and hover hit-testing live inside an 8px inset, while the crosshair is
  // positioned against the outer track. Add the equivalent pixel correction so
  // day-width buckets do not appear to highlight the adjacent harness segment.
  const plotRatio = clampedPct / 100;
  const offsetPx = TIMELINE_PLOT_INSET_PX - 2 * TIMELINE_PLOT_INSET_PX * plotRatio;
  if (Math.abs(offsetPx) < 0.0001) {
    return `${cssNumber(clampedPct)}%`;
  }
  const sign = offsetPx < 0 ? '-' : '+';
  return `calc(${cssNumber(clampedPct)}% ${sign} ${cssNumber(Math.abs(offsetPx))}px)`;
};

export const timelineBucketLayout = (bucketCount: number) => {
  const count = Math.max(1, Math.round(bucketCount));
  return {
    bucketGap:
      count > 1
        ? `clamp(0px, calc((100% - ${count * SPACED_BUCKET_MIN_WIDTH_PX}px) / ${count - 1}), ${SPACED_BUCKET_GAP_PX}px)`
        : '0px',
    bucketMinWidth: `min(${SPACED_BUCKET_MIN_WIDTH_PX}px, calc(100% / ${count}))`,
  };
};

export const buildVisibleTimelineBars = (
  buckets: TimelineBucket[],
  seriesKeys: string[],
  range: VisualZoomRange,
  useSessions: boolean,
) => {
  const rankByKey = new Map(seriesKeys.map((key, rank) => [key, rank]));
  return buckets.slice(range.from, range.to + 1).map((bucket) => {
    const segments: { key: string; rank: number; value: number }[] = [];
    for (const [key, entry] of bucket.byKey) {
      const rank = rankByKey.get(key);
      if (rank === undefined) {
        continue;
      }
      const value = useSessions ? entry.sessions : entry.cost;
      if (value > 0) {
        segments.push({ key, rank, value });
      }
    }
    segments.sort((left, right) => left.rank - right.rank);
    return {
      bucket,
      segments,
      total: useSessions ? bucket.sessions : bucket.total,
    };
  });
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
  const [hoveredBucket, setHoveredBucket] = createSignal<number | null>(null);
  const [hoveredKey, setHoveredKey] = createSignal<string | null>(null);
  const [showAll, setShowAll] = createSignal(false);
  const [visualZoom, setVisualZoom] = createSignal<VisualZoomRange | null>(null);
  const [showGraphViewControls, setShowGraphViewControls] = createSignal(false);
  const [draggingVisualZoom, setDraggingVisualZoom] = createSignal(false);
  let visualZoomDrag: {
    pointerId: number;
    startFrom: number;
    startTo: number;
    startX: number;
    scaleBuckets: number;
    trackWidth: number;
  } | null = null;
  let visualZoomHandleDrag: {
    handle: VisualRangeHandle;
    pointerId: number;
    startIndex: number;
    startX: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;
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

  const visibleBucketRange = createMemo(() => {
    const chart = data();
    if (!chart) {
      return { from: 0, to: 0 };
    }
    return normalizeVisualZoomRange(visualZoom(), chart.buckets.length);
  });

  const isVisuallyZoomed = createMemo(() => {
    const chart = data();
    if (!chart) {
      return false;
    }
    return bucketRangeSize(visibleBucketRange()) < chart.buckets.length;
  });

  const canMoveVisualZoomLater = createMemo(() => {
    const chart = data();
    if (!chart) {
      return false;
    }
    return isVisuallyZoomed() && visibleBucketRange().to < chart.buckets.length - 1;
  });

  const visibleMonthTicks = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [];
    }
    return visibleMonthTicksFor(chart.buckets, visibleBucketRange());
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

  const visibleBars = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [];
    }
    return buildVisibleTimelineBars(
      chart.buckets,
      chart.series.map((series) => series.key),
      visibleBucketRange(),
      valueMode() === 'sessions' || usesSessionShare(chart),
    );
  });

  const visibleBucketLayout = createMemo(() => timelineBucketLayout(bucketRangeSize(visibleBucketRange())));

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
    return ratio * 100;
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
    const range = visibleBucketRange();
    const visibleCount = Math.max(1, bucketRangeSize(range));
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
      pct: ((index - range.from + 0.5) / visibleCount) * 100,
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
    if (draggingVisualZoom()) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const chart = data();
    if (!chart || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const range = visibleBucketRange();
    const count = bucketRangeSize(range);
    const localIndex = Math.max(0, Math.min(count - 1, Math.floor(((event.clientX - rect.left) / rect.width) * count)));
    const index = range.from + localIndex;
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

  const setVisualZoomRange = (chart: NonNullable<ReturnType<typeof data>>, range: VisualZoomRange) => {
    const normalized = normalizeVisualZoomRange(range, chart.buckets.length);
    if (bucketRangeSize(normalized) >= chart.buckets.length) {
      setVisualZoom(null);
      return;
    }
    setVisualZoom(normalized);
  };

  const updateVisualZoom = (
    chart: NonNullable<ReturnType<typeof data>>,
    visibleBucketCount: number,
    anchorRatio = 0.5,
  ) => {
    const totalBuckets = chart.buckets.length;
    if (totalBuckets <= MIN_VISIBLE_BUCKETS) {
      setVisualZoom(null);
      return;
    }

    const nextCount = clampNumber(
      Math.round(visibleBucketCount),
      MIN_VISIBLE_BUCKETS,
      Math.max(MIN_VISIBLE_BUCKETS, totalBuckets),
    );
    if (nextCount >= totalBuckets) {
      setVisualZoom(null);
      return;
    }

    const currentRange = visibleBucketRange();
    const boundedAnchor = clampNumber(anchorRatio, 0, 1);
    const anchor = currentRange.from + (bucketRangeSize(currentRange) - 1) * boundedAnchor;
    const from = clampNumber(Math.round(anchor - (nextCount - 1) * boundedAnchor), 0, totalBuckets - nextCount);
    setVisualZoomRange(chart, { from, to: from + nextCount - 1 });
  };

  const zoomChartBy = (chart: NonNullable<ReturnType<typeof data>>, factor: number, anchorRatio = 0.5) => {
    const currentCount = bucketRangeSize(visibleBucketRange());
    updateVisualZoom(chart, currentCount * factor, anchorRatio);
    clearHover();
  };

  const zoomChartToSelection = (chart: NonNullable<ReturnType<typeof data>>) => {
    const [fromIndex, toIndex] = props.dateRange.selectedIndexes();
    const fromDate = dateFromIndex(chart.minDay, fromIndex);
    const toDate = dateFromIndex(chart.minDay, toIndex);
    const from = bucketIndexAtOrBefore(chart.buckets, fromDate);
    const to = bucketIndexAtOrBefore(chart.buckets, toDate);
    setVisualZoomRange(chart, { from, to });
    clearHover();
  };

  const zoomChartToLastDays = (chart: NonNullable<ReturnType<typeof data>>, days: number) => {
    const lastIndex = chart.buckets.length - 1;
    const lastBucket = chart.buckets[lastIndex];
    if (!lastBucket) {
      return;
    }
    const firstDate = shiftCalendarDays(lastBucket.date, -(days - 1));
    const from = bucketIndexAtOrBefore(chart.buckets, firstDate);
    setVisualZoomRange(chart, { from, to: lastIndex });
    clearHover();
  };

  const resetVisualZoom = () => {
    setVisualZoom(null);
    clearHover();
  };

  const visualRangeVars = (chart: NonNullable<ReturnType<typeof data>>) => {
    const range = visibleBucketRange();
    const max = Math.max(1, chart.buckets.length - 1);
    const startPct = (range.from / max) * 100;
    const endPct = 100 - (range.to / max) * 100;
    return {
      '--slider-range-start': `${startPct}%`,
      '--slider-range-end': `${endPct}%`,
    };
  };

  const moveVisualZoomTo = (chart: NonNullable<ReturnType<typeof data>>, from: number) => {
    if (!isVisuallyZoomed()) {
      return;
    }
    const range = visibleBucketRange();
    const visibleCount = bucketRangeSize(range);
    const clampedFrom = clampNumber(Math.round(from), 0, chart.buckets.length - visibleCount);
    setVisualZoomRange(chart, { from: clampedFrom, to: clampedFrom + visibleCount - 1 });
    clearHover();
  };

  const moveVisualZoomToLatest = (chart: NonNullable<ReturnType<typeof data>>) => {
    const visibleCount = bucketRangeSize(visibleBucketRange());
    moveVisualZoomTo(chart, chart.buckets.length - visibleCount);
  };

  const startVisualZoomDrag = (event: TimelinePointerEvent, scaleBuckets: number) => {
    if (event.button !== 0 || !isVisuallyZoomed()) {
      return;
    }
    const trackRect = event.currentTarget.getBoundingClientRect();
    if (trackRect.width <= 0) {
      return;
    }
    const range = visibleBucketRange();
    visualZoomDrag = {
      pointerId: event.pointerId,
      startFrom: range.from,
      startTo: range.to,
      startX: event.clientX,
      scaleBuckets,
      trackWidth: trackRect.width,
    };
    setDraggingVisualZoom(true);
    clearHover();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveVisualZoomDrag = (event: TimelinePointerEvent, chart: NonNullable<ReturnType<typeof data>>) => {
    if (!visualZoomDrag || visualZoomDrag.pointerId !== event.pointerId) {
      return;
    }
    const visibleCount = visualZoomDrag.startTo - visualZoomDrag.startFrom + 1;
    const delta = Math.round(
      ((event.clientX - visualZoomDrag.startX) / visualZoomDrag.trackWidth) * visualZoomDrag.scaleBuckets,
    );
    const from = clampNumber(visualZoomDrag.startFrom + delta, 0, chart.buckets.length - visibleCount);
    setVisualZoomRange(chart, { from, to: from + visibleCount - 1 });
    event.preventDefault();
  };

  const endVisualZoomDrag = (event: TimelinePointerEvent) => {
    if (!visualZoomDrag || visualZoomDrag.pointerId !== event.pointerId) {
      return;
    }
    visualZoomDrag = null;
    setDraggingVisualZoom(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const setVisualZoomHandleIndex = (
    chart: NonNullable<ReturnType<typeof data>>,
    handle: VisualRangeHandle,
    index: number,
  ) => {
    const range = visibleBucketRange();
    const nextIndex = clampNumber(index, 0, chart.buckets.length - 1);
    if (handle === 'start') {
      setVisualZoomRange(chart, { from: Math.min(nextIndex, range.to), to: range.to });
      return;
    }
    setVisualZoomRange(chart, { from: range.from, to: Math.max(nextIndex, range.from) });
  };

  const startVisualZoomHandleDrag = (
    event: TimelinePointerEvent,
    handle: VisualRangeHandle,
    chart: NonNullable<ReturnType<typeof data>>,
  ) => {
    if (event.button !== 0 || chart.buckets.length <= MIN_VISIBLE_BUCKETS) {
      return;
    }
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width) {
      return;
    }
    const range = visibleBucketRange();
    visualZoomHandleDrag = {
      handle,
      pointerId: event.pointerId,
      startIndex: handle === 'start' ? range.from : range.to,
      startX: event.clientX,
      trackWidth: trackRect.width,
      maxIndex: chart.buckets.length - 1,
    };
    setDraggingVisualZoom(true);
    clearHover();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveVisualZoomHandleDrag = (event: TimelinePointerEvent, chart: NonNullable<ReturnType<typeof data>>) => {
    if (!visualZoomHandleDrag || visualZoomHandleDrag.pointerId !== event.pointerId) {
      return;
    }
    const delta = Math.round(
      ((event.clientX - visualZoomHandleDrag.startX) / visualZoomHandleDrag.trackWidth) * visualZoomHandleDrag.maxIndex,
    );
    setVisualZoomHandleIndex(chart, visualZoomHandleDrag.handle, visualZoomHandleDrag.startIndex + delta);
    event.preventDefault();
    event.stopPropagation();
  };

  const endVisualZoomHandleDrag = (event: TimelinePointerEvent) => {
    if (!visualZoomHandleDrag || visualZoomHandleDrag.pointerId !== event.pointerId) {
      return;
    }
    visualZoomHandleDrag = null;
    setDraggingVisualZoom(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const handleChartWheel = (
    event: WheelEvent & { currentTarget: HTMLElement },
    chart: NonNullable<ReturnType<typeof data>>,
  ) => {
    if (chart.buckets.length <= MIN_VISIBLE_BUCKETS) {
      return;
    }
    if (event.deltaY >= 0 && !isVisuallyZoomed()) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const anchorRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1);
    const factor = event.deltaY < 0 ? 1 / CHART_ZOOM_FACTOR : CHART_ZOOM_FACTOR;
    zoomChartBy(chart, factor, anchorRatio);
    event.preventDefault();
  };

  const visualZoomLabel = (chart: NonNullable<ReturnType<typeof data>>) => {
    if (!isVisuallyZoomed()) {
      return 'Chart view: full history';
    }
    const range = visibleBucketRange();
    const firstBucket = chart.buckets[range.from];
    const lastBucket = chart.buckets[range.to];
    if (!(firstBucket && lastBucket)) {
      return 'Chart view: full history';
    }
    return `Chart view: ${bucketLabel(firstBucket.date, granularity())} – ${bucketLabel(lastBucket.date, granularity())}`;
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
    const next = sliderIndexForKey(event.key, current, chart.maxIndex, step);
    if (next == null) {
      return;
    }
    setHandleIndex(handle, clampNumber(next, 0, chart.maxIndex));
    commitIndexes();
    event.preventDefault();
    event.stopPropagation();
  };

  const handleVisualZoomKeyDown = (
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
    handle: VisualRangeHandle,
    chart: NonNullable<ReturnType<typeof data>>,
  ) => {
    const range = visibleBucketRange();
    const current = handle === 'start' ? range.from : range.to;
    const maxIndex = chart.buckets.length - 1;
    const next = sliderIndexForKey(event.key, current, maxIndex, event.shiftKey ? 7 : 1);
    if (next == null) {
      return;
    }
    setVisualZoomHandleIndex(chart, handle, clampNumber(next, 0, maxIndex));
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

  const selectedRangeDetails = (chart: NonNullable<ReturnType<typeof data>>) => {
    const [from, to] = props.dateRange.selectedIndexes();
    const startDate = dateFromIndex(chart.minDay, from);
    const endDate = dateFromIndex(chart.minDay, to);
    return {
      duration: dayCountLabel(to - from + 1),
      fromLabel: fmtDateOnly(startDate),
      toLabel: fmtDateOnly(endDate),
    };
  };

  return (
    <Show
      fallback={
        <section aria-label="Date range" class={timeRangePanel}>
          <div>
            <div class={timeRangeTitle}>Report range</div>
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
              <div class={timeRangeTitle}>Report range</div>
              <div class={timeRangeSummary}>
                <span class={timeRangeSummaryDates}>
                  <span>{selectedRangeDetails(chart()).fromLabel}</span>
                  <span class={timeRangeArrow}>→</span>
                  <span>{selectedRangeDetails(chart()).toLabel}</span>
                </span>
                <span class={timeRangeDuration}>{selectedRangeDetails(chart()).duration}</span>
              </div>
            </div>
            <div class={timeSliderQuickRanges}>
              <For each={dateRangePresets}>
                {(preset) => (
                  <button
                    class={presetButton}
                    onClick={() => applyPreset(preset.mode)}
                    title={`Set report range to ${preset.label}`}
                    type="button"
                  >
                    {preset.label}
                  </button>
                )}
              </For>
            </div>
          </div>

          <details aria-label="Chart options" class={timeChartOptions}>
            <summary class={timeChartOptionsSummary}>
              <span class={timeChartOptionsTitle}>Chart options</span>
              <span class={timeChartOptionsCurrent}>
                {chartOptionsSummary(dimension(), granularity(), valueMode())}
              </span>
            </summary>
            <div class={timeRangeViewControls}>
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
                  setVisualZoom(null);
                  setShowGraphViewControls(false);
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
            </div>
          </details>

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

          <div class={timeSliderRoot}>
            <div class={timeChartToolbar}>
              <span class={timeChartZoomSummary}>{visualZoomLabel(chart())}</span>
              <div class={timeChartZoomControls}>
                <button
                  class={timeChartZoomButton}
                  onClick={() => setShowGraphViewControls((value) => !value)}
                  title="Open graph view controls"
                  type="button"
                >
                  {showGraphViewControls() ? 'Hide view controls' : 'Adjust view'}
                </button>
              </div>
            </div>
            <Show when={showGraphViewControls()}>
              <div class={timeChartToolbar}>
                <span class={timeChartZoomSummary}>
                  Only changes graph readability. The selected range below still filters the app.
                </span>
                <div class={timeChartZoomControls}>
                  <For each={VISUAL_VIEW_PRESETS}>
                    {(preset) => (
                      <button
                        class={timeChartZoomButton}
                        onClick={() => zoomChartToLastDays(chart(), preset.days)}
                        title={`Show the latest ${preset.days} days in the graph only`}
                        type="button"
                      >
                        {preset.label}
                      </button>
                    )}
                  </For>
                  <button
                    class={timeChartZoomButton}
                    disabled={bucketRangeSize(visibleBucketRange()) <= MIN_VISIBLE_BUCKETS}
                    onClick={() => zoomChartBy(chart(), 1 / CHART_ZOOM_FACTOR)}
                    title="Zoom into the graph without changing the selected range"
                    type="button"
                  >
                    Zoom +
                  </button>
                  <button
                    class={timeChartZoomButton}
                    disabled={!isVisuallyZoomed()}
                    onClick={() => zoomChartBy(chart(), CHART_ZOOM_FACTOR)}
                    title="Zoom out without changing the selected range"
                    type="button"
                  >
                    Zoom −
                  </button>
                  <button
                    class={timeChartZoomButton}
                    disabled={!canMoveVisualZoomLater()}
                    onClick={() => moveVisualZoomToLatest(chart())}
                    title="Move the graph view to the latest data"
                    type="button"
                  >
                    Latest data
                  </button>
                  <button
                    class={timeChartZoomButton}
                    onClick={() => zoomChartToSelection(chart())}
                    title="Fit the graph to the selected range only visually"
                    type="button"
                  >
                    Fit selected range
                  </button>
                  <button
                    class={timeChartZoomButton}
                    disabled={!isVisuallyZoomed()}
                    onClick={resetVisualZoom}
                    title="Show the full history in the graph"
                    type="button"
                  >
                    Full history
                  </button>
                  <button class={timeChartZoomButton} onClick={() => setShowGraphViewControls(false)} type="button">
                    Done
                  </button>
                </div>
              </div>
            </Show>
            <div class={timeSliderFrame}>
              <div class={timeSliderControl}>
                <div class={timeSliderTrack} style={rangeVars(chart())}>
                  <For each={visibleMonthTicks()}>
                    {(tick) => (
                      <div aria-hidden="true" class={monthGridline} style={{ left: timelinePlotLeft(tick.pct) }} />
                    )}
                  </For>
                  <div aria-hidden="true" class={timeSliderBars} style={{ gap: visibleBucketLayout().bucketGap }}>
                    <For each={visibleBars()}>
                      {(bar) => (
                        <div
                          class={timeBucket}
                          style={{
                            height: `${barHeight(bar.bucket, chart())}%`,
                            'min-width': visibleBucketLayout().bucketMinWidth,
                          }}
                        >
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
                    data-dragging={String(draggingVisualZoom())}
                    data-zoomed={String(isVisuallyZoomed())}
                    onLostPointerCapture={endVisualZoomDrag}
                    onMouseLeave={clearHover}
                    onMouseMove={updateHover}
                    onPointerCancel={endVisualZoomDrag}
                    onPointerDown={(event) => startVisualZoomDrag(event, bucketRangeSize(visibleBucketRange()))}
                    onPointerMove={(event) => moveVisualZoomDrag(event, chart())}
                    onPointerUp={endVisualZoomDrag}
                    onWheel={(event) => handleChartWheel(event, chart())}
                    tabIndex={-1}
                    title="Scroll to zoom, then drag to move the visual window"
                    type="button"
                  />
                  <Show when={readout()}>
                    {(tip) => (
                      <div
                        aria-hidden="true"
                        class={migrationCrosshair}
                        style={{ left: timelinePlotLeft(tip().pct) }}
                      />
                    )}
                  </Show>
                </div>
              </div>
              <Show when={showGraphViewControls()}>
                <div class={timeSliderBrushColumn}>
                  <div class={timeSliderBrushHeader}>
                    <span>Graph view</span>
                    <span>Optional reading aid: drag to pan, resize handles to adjust detail</span>
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
                  <div class={timeSliderBrushTrack} style={visualRangeVars(chart())}>
                    <div
                      aria-hidden="true"
                      class={timeSliderRange}
                      style={{ left: 'var(--slider-range-start)', right: 'var(--slider-range-end)' }}
                    />
                    <div aria-hidden="true" class={timeSliderDimLeft} />
                    <div aria-hidden="true" class={timeSliderDimRight} />
                    <button
                      aria-label="Drag graph view"
                      class={timeSliderRangeDrag}
                      data-dragging={String(draggingVisualZoom())}
                      disabled={!isVisuallyZoomed()}
                      onLostPointerCapture={endVisualZoomDrag}
                      onPointerCancel={endVisualZoomDrag}
                      onPointerDown={(event) => startVisualZoomDrag(event, chart().buckets.length)}
                      onPointerMove={(event) => moveVisualZoomDrag(event, chart())}
                      onPointerUp={endVisualZoomDrag}
                      tabIndex={-1}
                      title="Drag graph view"
                      type="button"
                    />
                    <button
                      aria-label="Graph view start"
                      aria-valuemax={chart().buckets.length - 1}
                      aria-valuemin={0}
                      aria-valuenow={visibleBucketRange().from}
                      aria-valuetext={fmtDateOnly(chart().buckets[visibleBucketRange().from]?.date ?? chart().minDay)}
                      class={timeSliderThumb}
                      onKeyDown={(event) => handleVisualZoomKeyDown(event, 'start', chart())}
                      onLostPointerCapture={endVisualZoomHandleDrag}
                      onPointerCancel={endVisualZoomHandleDrag}
                      onPointerDown={(event) => startVisualZoomHandleDrag(event, 'start', chart())}
                      onPointerMove={(event) => moveVisualZoomHandleDrag(event, chart())}
                      onPointerUp={endVisualZoomHandleDrag}
                      role="slider"
                      style={{ left: 'var(--slider-range-start)' }}
                      type="button"
                    />
                    <button
                      aria-label="Graph view end"
                      aria-valuemax={chart().buckets.length - 1}
                      aria-valuemin={0}
                      aria-valuenow={visibleBucketRange().to}
                      aria-valuetext={fmtDateOnly(chart().buckets[visibleBucketRange().to]?.date ?? chart().maxDay)}
                      class={timeSliderThumb}
                      onKeyDown={(event) => handleVisualZoomKeyDown(event, 'end', chart())}
                      onLostPointerCapture={endVisualZoomHandleDrag}
                      onPointerCancel={endVisualZoomHandleDrag}
                      onPointerDown={(event) => startVisualZoomHandleDrag(event, 'end', chart())}
                      onPointerMove={(event) => moveVisualZoomHandleDrag(event, chart())}
                      onPointerUp={endVisualZoomHandleDrag}
                      role="slider"
                      style={{ left: 'calc(100% - var(--slider-range-end))' }}
                      type="button"
                    />
                  </div>
                </div>
              </Show>
              <div class={timeSliderBrushColumn}>
                <div class={timeSliderBrushHeader}>
                  <span>Adjust report range</span>
                  <span>Filters the entire report</span>
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
                <div class={timeSliderBrushTrack} style={rangeVars(chart())}>
                  <div
                    aria-hidden="true"
                    class={timeSliderRange}
                    style={{ left: 'var(--slider-range-start)', right: 'var(--slider-range-end)' }}
                  />
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
                <div class={timeSliderHandleLabels} style={rangeVars(chart())}>
                  <label class={timeSliderHandleLabelStart}>
                    <input
                      aria-label="Start date"
                      class={timeSliderDateChip}
                      max={toDateInputValue(chart().maxDay)}
                      min={toDateInputValue(chart().minDay)}
                      onInput={(event) => applyFromInput(event.currentTarget.value)}
                      title="Start date"
                      type="date"
                      value={props.dateRange.inputValues().from}
                    />
                  </label>
                  <label class={timeSliderHandleLabelEnd}>
                    <input
                      aria-label="End date"
                      class={timeSliderDateChip}
                      max={toDateInputValue(chart().maxDay)}
                      min={toDateInputValue(chart().minDay)}
                      onInput={(event) => applyToInput(event.currentTarget.value)}
                      title="End date"
                      type="date"
                      value={props.dateRange.inputValues().to}
                    />
                  </label>
                </div>
              </div>
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
