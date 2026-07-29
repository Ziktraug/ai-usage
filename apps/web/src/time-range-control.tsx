import { SegmentedControl, Tooltip } from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  chartLegendList,
  chartLegendPct,
  chartLegendSwatch,
  chartUnclassifiedSwatch,
  dimensionSwatch,
  migrationCrosshair,
  migrationLegendButton,
  migrationReadout,
  migrationReadoutDate,
  migrationReadoutHint,
  migrationReadoutItem,
  migrationReadoutItemActive,
  migrationReadoutSwatch,
  migrationReadoutTotal,
  migrationReadoutValue,
  migrationTotal,
  migrationTrend,
  migrationTrendDown,
  migrationTrendUp,
  monthGridline,
  presetButton,
  timeAxis,
  timeAxisTick,
  timeBucket,
  timeBucketSegment,
  timeBucketUnclassifiedBand,
  timeBucketUnclassifiedEmpty,
  timeChartOptions,
  timeChartOptionsCurrent,
  timeChartOptionsSummary,
  timeChartOptionsTitle,
  timeChartZoomSummary,
  timelineHoverLayer,
  timeRangeAdjustments,
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
  timeSliderBrushRow,
  timeSliderBrushTrack,
  timeSliderControl,
  timeSliderDateChip,
  timeSliderDateInputs,
  timeSliderDimLeft,
  timeSliderDimRight,
  timeSliderFrame,
  timeSliderQuickRanges,
  timeSliderRange,
  timeSliderRangeDrag,
  timeSliderRoot,
  timeSliderThumb,
  timeSliderTrack,
  timeSliderUnclassifiedBands,
} from '@ai-usage/design-system/report';
import type {
  FocusedTimelineData,
  FocusedTimelineDimension,
  FocusedTimelineGranularity,
} from '@ai-usage/report-core/focused-report-query';
import {
  type ApiPriceMeasurement,
  apiPriceMeasurement,
  combineApiPriceMeasurements,
  originProvenanceFor,
} from '@ai-usage/report-core/provenance';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import type { FieldFilterKey } from './dashboard-search';
import { clampNumber, dateFromIndex, dateRangePresets, parseLocalDate, type TimeRangePreset } from './date-range';
import type { DateRangeController } from './date-range-controller';
import {
  buildTimelineData,
  type MigrationGranularity,
  type TimelineBucket,
  type TimelineData,
  type TimelineDimension,
  type TimelineGap,
  type TimelineSeries,
  type TimelineValue,
} from './overview-model';
import {
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
  type DashboardRow,
  fmtDateOnly,
  fmtMoney,
  fmtNum,
  fmtPct,
} from './shared';
import {
  createTimeRangeControlState,
  type TimeRangeControlCommand,
  type TimeRangeControlContext,
  type TimeRangeControlEvent,
  type TimeRangeIndexRange,
  transitionTimeRangeControl,
} from './time-range-control-state';

const READOUT_LIMIT = 8;
const MAX_DELTA_PCT = 1000;
export const defaultTimelineGranularity: MigrationGranularity = 'day';
const MAX_VISUAL_TICKS = 14;

type RangeDragPointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };

const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });
const monthYearFormatter = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });
const monthDayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' });

const dayCountLabel = (count: number) => `${fmtNum(count)} ${count === 1 ? 'day' : 'days'}`;

export const humanDateInputValue = (value: string): string => {
  const date = parseLocalDate(value);
  return date ? fmtDateOnly(date) : value;
};

export const reportRangeSummary = (
  from: Date,
  to: Date,
  elapsedDays: number,
): { duration: string; fromLabel: string; toLabel: string } => ({
  duration: dayCountLabel(Math.max(1, elapsedDays)),
  fromLabel: from.getFullYear() === to.getFullYear() ? monthDayFormatter.format(from) : fmtDateOnly(from),
  toLabel: fmtDateOnly(to),
});

const DIMENSION_ITEMS = [
  { label: 'Campaign', value: 'campaign' },
  { label: 'Harness', value: 'harness' },
  { label: 'Machine', value: 'machine' },
  { label: 'Model', value: 'model' },
  { label: 'Origin', value: 'origin' },
  { label: 'Provider', value: 'provider' },
  { label: 'Project', value: 'project' },
] as const;

const DIMENSION_LABELS = {
  campaign: 'Campaign',
  harness: 'Harness',
  machine: 'Machine',
  model: 'Model',
  origin: 'Origin',
  project: 'Project',
  provider: 'Provider',
} as const satisfies Record<TimelineDimension, string>;

const GRANULARITY_ITEMS = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
] as const;

const VALUE_ITEMS = [
  { label: 'Estimated API value', value: 'cost' },
  { label: 'Share', value: 'share' },
  { label: 'Sessions', value: 'sessions' },
] as const;

export const chartOptionsSummary = (
  dimension: TimelineDimension,
  granularity: MigrationGranularity,
  value: TimelineValue,
) => {
  const dimensionLabel = DIMENSION_LABELS[dimension];
  const granularityLabel = GRANULARITY_ITEMS.find((item) => item.value === granularity)?.label ?? 'Day';
  const valueLabel = VALUE_ITEMS.find((item) => item.value === value)?.label ?? 'Estimated API value';
  return `${dimensionLabel} · ${granularityLabel} · ${valueLabel}`;
};

const toTimelineDimension = (value: string): TimelineDimension => {
  if (
    value === 'campaign' ||
    value === 'harness' ||
    value === 'machine' ||
    value === 'model' ||
    value === 'origin' ||
    value === 'project' ||
    value === 'provider'
  ) {
    return value;
  }
  return 'harness';
};

const toGranularity = (value: string): MigrationGranularity => (value === 'week' || value === 'month' ? value : 'day');

const toTimelineValue = (value: string): TimelineValue => (value === 'share' || value === 'sessions' ? value : 'cost');
const TIMELINE_PLOT_INSET_PX = 8;
const SPACED_BUCKET_MIN_WIDTH_PX = 2;
const SPACED_BUCKET_GAP_PX = 2;

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

const visibleMonthTicksFor = (buckets: TimelineBucket[], range: TimeRangeIndexRange) => {
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

export interface TimelineLabelBox {
  id: string;
  left: number;
  right: number;
}

export const retainTimelineTickLabels = (
  ticks: readonly TimelineLabelBox[],
  boundaries: readonly TimelineLabelBox[],
): TimelineLabelBox[] =>
  ticks.filter((tick) => boundaries.every((boundary) => tick.right <= boundary.left || tick.left >= boundary.right));

const timelineTickIdFor = (tick: { label: string; pct: number }): string => `${tick.pct}:${tick.label}`;

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

export const chartRangeForSelection = (
  chart: Pick<TimelineData, 'buckets'> & { minDay: Date },
  selectionIndexes: readonly [number, number],
): TimeRangeIndexRange => {
  const fromDate = dateFromIndex(chart.minDay, selectionIndexes[0]);
  const toDate = dateFromIndex(chart.minDay, selectionIndexes[1]);
  return {
    from: bucketIndexAtOrBefore(chart.buckets, fromDate),
    to: bucketIndexAtOrBefore(chart.buckets, toDate),
  };
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
  range: TimeRangeIndexRange,
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
    let unclassifiedValue = 0;
    if (bucket.unclassified) {
      unclassifiedValue = useSessions ? bucket.unclassified.sessions : bucket.unclassified.total;
    }
    return {
      bucket,
      segments,
      total: (useSessions ? bucket.sessions : bucket.total) - unclassifiedValue,
    };
  });
};

const mergeTimelineGaps = (current: TimelineGap | null, gap: TimelineGap | null): TimelineGap | null => {
  if (!gap) {
    return current;
  }
  const causes = current ? current.causes.map((cause) => ({ ...cause })) : [];
  for (const cause of gap.causes) {
    const existing = causes.find((candidate) => candidate.kind === cause.kind);
    if (existing) {
      existing.sessions += cause.sessions;
    } else {
      causes.push({ ...cause });
    }
  }
  return {
    causes,
    priceMeasurement: combineApiPriceMeasurements([
      current?.priceMeasurement ?? apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 0 }),
      gap.priceMeasurement,
    ]),
    sessions: (current?.sessions ?? 0) + gap.sessions,
    total: (current?.total ?? 0) + gap.total,
  };
};

export const originGapDescription = (gap: TimelineGap): string => {
  const breakdown = gap.causes
    .map((cause) => {
      const provenance = originProvenanceFor(cause.kind);
      return `${provenance.label}: ${fmtNum(cause.sessions)}${cause.sessions === 1 ? ' session' : ' sessions'}`;
    })
    .join(' · ');
  const total = `Not classified: ${fmtNum(gap.sessions)}${gap.sessions === 1 ? ' session' : ' sessions'}`;
  return breakdown ? `${total} · ${breakdown}` : total;
};

const timelineSummaryFor = (chart: TimelineData, range: TimeRangeIndexRange, useSessions: boolean) => {
  const measurementsByKey = new Map<string, ApiPriceMeasurement>();
  const totalsByKey = new Map<string, number>();
  let total = 0;
  let priceMeasurement = apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 0 });
  let unclassified: TimelineGap | null = null;
  for (const bucket of chart.buckets.slice(range.from, range.to + 1)) {
    const bucketTotal = useSessions ? bucket.sessions : bucket.total;
    total += bucketTotal;
    priceMeasurement = combineApiPriceMeasurements([priceMeasurement, bucket.priceMeasurement]);
    unclassified = mergeTimelineGaps(unclassified, bucket.unclassified);
    for (const [key, entry] of bucket.byKey) {
      const value = useSessions ? entry.sessions : entry.cost;
      totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + value);
      measurementsByKey.set(
        key,
        combineApiPriceMeasurements([
          measurementsByKey.get(key) ?? apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 0 }),
          entry.priceMeasurement,
        ]),
      );
    }
  }
  const first = chart.buckets[range.from]?.date ?? chart.first;
  const last = chart.buckets[range.to]?.date ?? chart.last;
  return { first, last, measurementsByKey, priceMeasurement, total, totalsByKey, unclassified };
};

const focusedTimelineData = (timeline: FocusedTimelineData): TimelineData => ({
  ...timeline,
  buckets: timeline.buckets.map((bucket) => ({
    ...bucket,
    byKey: new Map(Object.entries(bucket.byKey)),
    date: new Date(bucket.date),
  })),
  first: new Date(timeline.first),
  last: new Date(timeline.last),
});

export const TimeRangeControl = (props: {
  activeFieldFilters: Partial<Record<FieldFilterKey, string>>;
  activeHarness: string[];
  activeMachine: string[];
  campaignRows: DashboardRow[];
  dateRange: DateRangeController;
  focusedTimeline: FocusedTimelineData | null | undefined;
  focusedTimelineError: string | null;
  focusedTimelineLoading: boolean;
  onDateRangeCommit: () => void;
  onDimensionFilter: (dimension: TimelineDimension, value: string) => void;
  onFocusedTimelineRequest?: (options: {
    dimension: FocusedTimelineDimension;
    granularity: FocusedTimelineGranularity;
  }) => void;
  presentCampaignSeries: (series: TimelineSeries) => TimelineSeries;
  presentMachineLabel: (value: string) => string;
  rows: DashboardRow[];
}) => {
  const initialDomain = props.dateRange.domain();
  const [chartDomain, setChartDomain] = createSignal(initialDomain);
  const [editingDateInput, setEditingDateInput] = createSignal<'from' | 'to' | null>(null);
  const [dateInputDrafts, setDateInputDrafts] = createSignal(props.dateRange.inputValues());
  const [controlState, setControlState] = createSignal(
    createTimeRangeControlState({
      context: {
        selectionMaxIndex: initialDomain?.maxIndex ?? 0,
      },
      options: { dimension: 'harness', granularity: defaultTimelineGranularity, value: 'cost' },
      selectionIndexes: props.dateRange.selectedIndexes(),
    }),
  );
  const dimension = createMemo(() => controlState().options.dimension);
  const granularity = createMemo(() => controlState().options.granularity);
  const valueMode = createMemo(() => controlState().options.value);
  const hoveredBucket = () => controlState().hover.bucketIndex;
  const hoveredKey = () => controlState().hover.key;
  const draggingSelection = () => controlState().interaction.type === 'selection-pan';
  const syncChartDomain = () => setChartDomain(props.dateRange.domain());

  const data = createMemo(() => {
    const domain = chartDomain();
    if (!domain) {
      return null;
    }
    const focused = props.focusedTimeline;
    let timeline: TimelineData | null;
    if (focused === undefined) {
      timeline = buildTimelineData(props.rows, {
        campaignRows: props.campaignRows,
        dimension: dimension(),
        domain,
        granularity: granularity(),
      });
    } else {
      timeline = focused ? focusedTimelineData(focused) : null;
    }
    if (!timeline) {
      return null;
    }
    let series = timeline.series;
    if (timeline.dimension === 'machine') {
      series = timeline.series.map((timelineSeries) => ({
        ...timelineSeries,
        label: timelineSeries.key ? props.presentMachineLabel(timelineSeries.key) : timelineSeries.label,
      }));
    } else if (timeline.dimension === 'campaign') {
      series = timeline.series.map(props.presentCampaignSeries);
    }
    return {
      ...timeline,
      series,
      minDay: domain.minDay,
      maxDay: domain.maxDay,
      maxIndex: domain.maxIndex,
    };
  });

  createEffect(() => {
    props.onFocusedTimelineRequest?.({ dimension: dimension(), granularity: granularity() });
  });

  createEffect(() => {
    const values = props.dateRange.inputValues();
    const editing = editingDateInput();
    setDateInputDrafts((current) => ({
      from: editing === 'from' ? current.from : values.from,
      to: editing === 'to' ? current.to : values.to,
    }));
  });

  const controlContext = (): TimeRangeControlContext => ({
    selectionMaxIndex: chartDomain()?.maxIndex ?? 0,
  });

  let applyingSelectionIndexes = false;
  const executeControlCommands = (commands: readonly TimeRangeControlCommand[]) => {
    for (const command of commands) {
      if (command.type === 'setSelectionIndexes') {
        applyingSelectionIndexes = true;
        try {
          props.dateRange.setIndexes(command.indexes[0], command.indexes[1]);
        } finally {
          applyingSelectionIndexes = false;
        }
        continue;
      }
      if (command.type === 'commitReportRange') {
        syncChartDomain();
        props.onDateRangeCommit();
      }
    }
  };
  const dispatchControl = (event: TimeRangeControlEvent, context = controlContext()) => {
    const result = transitionTimeRangeControl(controlState(), event, context);
    if (result.handled) {
      setControlState(result.state);
      executeControlCommands(result.commands);
    }
    return result.handled;
  };

  createEffect(() => {
    const domain = props.dateRange.domain();
    const selectionIndexesFromDates = props.dateRange.selectedIndexes();
    if (applyingSelectionIndexes) {
      return;
    }
    setChartDomain(domain);
    untrack(() => {
      dispatchControl({ type: 'domainChanged', selectionIndexesFromDates });
    });
  });

  createEffect(() => {
    const focused = props.focusedTimeline;
    if (
      props.focusedTimelineLoading ||
      !focused ||
      (focused.dimension === dimension() && focused.granularity === granularity())
    ) {
      return;
    }
    untrack(() => {
      dispatchControl({
        type: 'optionsSynchronized',
        dimension: focused.dimension,
        granularity: focused.granularity,
      });
    });
  });

  const renderedDimension = createMemo(() => data()?.dimension ?? dimension());
  const renderedGranularity = createMemo(() => data()?.granularity ?? granularity());
  const reportRangeStatus = (): string => {
    if (props.focusedTimelineLoading) {
      return 'Loading report range…';
    }
    if (props.focusedTimelineError) {
      return `Unable to load report range: ${props.focusedTimelineError}`;
    }
    return 'No dated sessions match the current filters';
  };
  const timelineStatus = (): string => {
    if (props.focusedTimelineLoading) {
      return 'Loading activity…';
    }
    if (props.focusedTimelineError) {
      return `Unable to load activity: ${props.focusedTimelineError}`;
    }
    return 'No dated sessions match the current filters';
  };

  const reportBucketRange = createMemo(() => {
    const chart = data();
    return chart ? chartRangeForSelection(chart, controlState().selectionIndexes) : { from: 0, to: 0 };
  });
  const visibleBucketRange = reportBucketRange;
  const visibleBucketCount = createMemo(() => {
    const range = visibleBucketRange();
    return Math.max(1, range.to - range.from + 1);
  });

  const visibleMonthTicks = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [];
    }
    return visibleMonthTicksFor(chart.buckets, visibleBucketRange());
  });

  let timelineTickRow: HTMLDivElement | undefined;
  let timelineBoundaryRow: HTMLDivElement | undefined;
  const [retainedTimelineTickIds, setRetainedTimelineTickIds] = createSignal<ReadonlySet<string> | null>(null);

  const measuredLabelBoxes = (root: HTMLDivElement | undefined, selector: string): TimelineLabelBox[] => {
    if (!root) {
      return [];
    }
    return [...root.querySelectorAll<HTMLElement>(selector)].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        id: element.dataset.timelineLabelId ?? '',
        left: box.left,
        right: box.right,
      };
    });
  };

  const measureTimelineLabelCollisions = () => {
    const tickBoxes = measuredLabelBoxes(timelineTickRow, '[data-timeline-tick]');
    const boundaryBoxes = measuredLabelBoxes(timelineBoundaryRow, '[data-timeline-boundary]');
    setRetainedTimelineTickIds(new Set(retainTimelineTickLabels(tickBoxes, boundaryBoxes).map((tick) => tick.id)));
  };

  createEffect(() => {
    visibleMonthTicks();
    const chart = data();
    const range = visibleBucketRange();
    chart?.buckets[range.from]?.date.getTime();
    chart?.buckets[range.to]?.date.getTime();
    setRetainedTimelineTickIds(null);
    queueMicrotask(measureTimelineLabelCollisions);
  });

  onMount(() => {
    const resizeObserver = new ResizeObserver(measureTimelineLabelCollisions);
    if (timelineTickRow) {
      resizeObserver.observe(timelineTickRow);
    }
    if (timelineBoundaryRow) {
      resizeObserver.observe(timelineBoundaryRow);
    }
    measureTimelineLabelCollisions();
    onCleanup(() => resizeObserver.disconnect());
  });

  const usesSessionShare = (chart: NonNullable<ReturnType<typeof data>>) =>
    valueMode() === 'share' && chart.grandTotal <= 0;

  const bucketValue = (bucket: TimelineBucket, chart: NonNullable<ReturnType<typeof data>>) =>
    valueMode() === 'sessions' || usesSessionShare(chart) ? bucket.sessions : bucket.total;

  const unclassifiedValue = (bucket: TimelineBucket, chart: NonNullable<ReturnType<typeof data>>) => {
    if (!bucket.unclassified) {
      return 0;
    }
    return valueMode() === 'sessions' || usesSessionShare(chart)
      ? bucket.unclassified.sessions
      : bucket.unclassified.total;
  };

  const classifiedBucketValue = (bucket: TimelineBucket, chart: NonNullable<ReturnType<typeof data>>) =>
    Math.max(0, bucketValue(bucket, chart) - unclassifiedValue(bucket, chart));

  const entryValue = (
    entry: { cost: number; sessions: number } | undefined,
    chart: NonNullable<ReturnType<typeof data>>,
  ) => (valueMode() === 'sessions' || usesSessionShare(chart) ? (entry?.sessions ?? 0) : (entry?.cost ?? 0));

  const maxBucketValue = (chart: NonNullable<ReturnType<typeof data>>) =>
    valueMode() === 'sessions' || usesSessionShare(chart) ? chart.maxBucketSessions : chart.maxBucketTotal;

  const formatValue = (value: number, useSessions = false, priceMeasurement?: ApiPriceMeasurement) => {
    if (valueMode() === 'sessions' || useSessions) {
      return `${fmtNum(value)} sessions`;
    }
    return priceMeasurement ? aggregateApiValuePresentation(priceMeasurement).label : fmtMoney(value);
  };

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

  const reportSummary = createMemo(() => {
    const chart = data();
    if (!chart) {
      return null;
    }
    return timelineSummaryFor(chart, reportBucketRange(), valueMode() === 'sessions' || usesSessionShare(chart));
  });

  const visibleMaximum = createMemo(() => {
    const chart = data();
    if (!chart) {
      return 0;
    }
    return Math.max(
      0,
      ...chart.buckets
        .slice(visibleBucketRange().from, visibleBucketRange().to + 1)
        .map((bucket) => bucketValue(bucket, chart)),
    );
  });

  const visibleBucketLayout = createMemo(() => timelineBucketLayout(visibleBucketCount()));

  const barHeight = (bucket: TimelineBucket, chart: NonNullable<ReturnType<typeof data>>) => {
    const total = classifiedBucketValue(bucket, chart);
    if (valueMode() === 'share') {
      return total > 0 ? 100 : 0;
    }
    const maxValue = visibleMaximum() || maxBucketValue(chart);
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
    const visibleCount = visibleBucketCount();
    const rows: {
      delta: number | null;
      key: string;
      label: string;
      priceMeasurement: ApiPriceMeasurement;
      rank: number;
      value: number;
    }[] = [];
    for (let rank = 0; rank < chart.series.length; rank++) {
      const series = chart.series[rank];
      if (!series) {
        continue;
      }
      const entry = bucket.byKey.get(series.key);
      const value = entryValue(entry, chart);
      if (value <= 0) {
        continue;
      }
      const prior = previous ? entryValue(previous.byKey.get(series.key), chart) : 0;
      const delta = prior > 1e-9 ? ((value - prior) / prior) * 100 : null;
      rows.push({
        delta,
        key: series.key,
        label: series.label,
        priceMeasurement: entry?.priceMeasurement ?? series.priceMeasurement,
        rank,
        value,
      });
    }
    rows.sort((a, b) => b.value - a.value);
    const visible = rows.slice(0, READOUT_LIMIT);
    return {
      bucket,
      hasPrevious: previous !== null,
      hidden: rows.length - visible.length,
      label: bucketLabel(bucket.date, renderedGranularity()),
      pct: ((index - range.from + 0.5) / visibleCount) * 100,
      priceMeasurement: bucket.priceMeasurement,
      rows: visible,
      total: bucketValue(bucket, chart),
      unclassified: bucket.unclassified,
      useSessions: valueMode() === 'sessions' || usesSessionShare(chart),
    };
  });

  const updateHover = (event: MouseEvent & { currentTarget: HTMLElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const chart = data();
    if (!chart || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const range = visibleBucketRange();
    const count = visibleBucketCount();
    const localIndex = Math.max(0, Math.min(count - 1, Math.floor(((event.clientX - rect.left) / rect.width) * count)));
    const index = range.from + localIndex;

    const bucket = chart.buckets[index];
    if (!bucket) {
      dispatchControl({ type: 'hoverChanged', bucketIndex: index, key: null });
      return;
    }
    const total = classifiedBucketValue(bucket, chart);
    const heightFraction = barHeight(bucket, chart) / 100;
    const fromBottom = (rect.bottom - event.clientY) / rect.height;
    if (total <= 0 || heightFraction <= 0 || fromBottom > heightFraction) {
      dispatchControl({ type: 'hoverChanged', bucketIndex: index, key: null });
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
    dispatchControl({ type: 'hoverChanged', bucketIndex: index, key: found });
  };

  const clearHover = () => dispatchControl({ type: 'clearHover' });

  const inspectTimelineWithKeyboard = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => {
    if (!data()) {
      return;
    }
    if (
      !dispatchControl({
        key: event.key,
        type: 'timelineKeyboardMove',
        visibleRange: visibleBucketRange(),
      })
    ) {
      return;
    }
    event.preventDefault();
  };

  const pointerFinishType = (event: PointerEvent): 'pointerCancel' | 'pointerCaptureLost' | 'pointerEnd' => {
    if (event.type === 'pointercancel') {
      return 'pointerCancel';
    }
    if (event.type === 'lostpointercapture') {
      return 'pointerCaptureLost';
    }
    return 'pointerEnd';
  };

  const finishPointerInteraction = (event: RangeDragPointerEvent, stopPropagation: boolean) => {
    const finishType = pointerFinishType(event);
    if (!dispatchControl({ type: finishType, pointerId: event.pointerId })) {
      return;
    }
    if (finishType !== 'pointerCaptureLost' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const swatch = (key: string) => dimensionSwatch(renderedDimension(), key);

  const isLegendActive = (key: string) => {
    const currentDimension = renderedDimension();
    // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future dimension fails compilation.
    switch (currentDimension) {
      case 'campaign':
      case 'origin':
        return false;
      case 'harness':
        return props.activeHarness.includes(key);
      case 'machine':
        return props.activeMachine.includes(key);
      case 'model':
      case 'project':
      case 'provider':
        return props.activeFieldFilters[currentDimension] === key;
    }
  };

  const isLegendFilterable = (key: string): boolean => {
    // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future dimension fails compilation.
    switch (renderedDimension()) {
      case 'campaign':
      case 'origin':
        return false;
      case 'machine':
        return key.length > 0;
      case 'harness':
      case 'model':
      case 'project':
      case 'provider':
        return true;
    }
  };

  const legendTitle = (series: TimelineSeries): string => {
    const aggregateCount = series.memberKeys?.length ?? 0;
    if (aggregateCount > 0) {
      return `Aggregates ${aggregateCount} smaller series`;
    }
    if (!isLegendFilterable(series.key)) {
      return series.label;
    }
    return isLegendActive(series.key) ? `Clear or replace ${series.label} filter` : `Filter by ${series.label}`;
  };

  const applyPreset = (mode: TimeRangePreset) => {
    props.dateRange.setPreset(mode);
    syncChartDomain();
    const selectionIndexes = props.dateRange.selectedIndexes();
    dispatchControl({ type: 'selectionSynchronized', selectionIndexes, source: 'preset' });
  };

  const applyFromInput = (from: string) => {
    props.dateRange.setFromInput(from);
    syncChartDomain();
    const selectionIndexes = props.dateRange.selectedIndexes();
    dispatchControl({ type: 'selectionSynchronized', selectionIndexes, source: 'input' });
  };

  const applyToInput = (to: string) => {
    props.dateRange.setToInput(to);
    syncChartDomain();
    const selectionIndexes = props.dateRange.selectedIndexes();
    dispatchControl({ type: 'selectionSynchronized', selectionIndexes, source: 'input' });
  };

  const beginDateInputEdit = (field: 'from' | 'to') => {
    const value = humanDateInputValue(props.dateRange.inputValues()[field]);
    setDateInputDrafts((current) => ({ ...current, [field]: value }));
    setEditingDateInput(field);
  };

  const applyDateInputDraft = (field: 'from' | 'to', value: string) => {
    setDateInputDrafts((current) => ({ ...current, [field]: value }));
    if (!parseLocalDate(value)) {
      return;
    }
    if (field === 'from') {
      applyFromInput(value);
    } else {
      applyToInput(value);
    }
  };

  const finishDateInputEdit = (field: 'from' | 'to') => {
    const value = dateInputDrafts()[field];
    if (parseLocalDate(value) && props.dateRange.inputValues()[field] !== value) {
      if (field === 'from') {
        applyFromInput(value);
      } else {
        applyToInput(value);
      }
    }
    setEditingDateInput(null);
  };

  const dateInputValue = (field: 'from' | 'to') =>
    editingDateInput() === field ? dateInputDrafts()[field] : humanDateInputValue(props.dateRange.inputValues()[field]);

  const startSelectionDrag = (event: RangeDragPointerEvent) => {
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    const handled = dispatchControl({
      type: 'pointerStart',
      interaction: 'selection-pan',
      button: event.button,
      clientX: event.clientX,
      pointerId: event.pointerId,
      trackWidth: trackRect?.width ?? 0,
    });
    if (!handled) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!dispatchControl({ type: 'pointerMove', clientX: event.clientX, pointerId: event.pointerId })) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const endSelectionDrag = (event: RangeDragPointerEvent) => finishPointerInteraction(event, true);

  const startHandleDrag = (event: RangeDragPointerEvent, handle: 'start' | 'end') => {
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    const handled = dispatchControl({
      type: 'pointerStart',
      interaction: 'selection-handle',
      button: event.button,
      clientX: event.clientX,
      handle,
      pointerId: event.pointerId,
      trackWidth: trackRect?.width ?? 0,
    });
    if (!handled) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveHandleDrag = (event: RangeDragPointerEvent) => {
    if (!dispatchControl({ type: 'pointerMove', clientX: event.clientX, pointerId: event.pointerId })) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const endHandleDrag = (event: RangeDragPointerEvent) => finishPointerInteraction(event, true);

  const handleSliderKeyDown = (
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
    handle: 'start' | 'end',
  ) => {
    if (
      !dispatchControl({
        type: 'keyboardMove',
        axis: 'selection',
        handle,
        key: event.key,
        shiftKey: event.shiftKey,
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const rangeVars = (chart: NonNullable<ReturnType<typeof data>>) => {
    const [from, to] = controlState().selectionIndexes;
    const max = Math.max(1, chart.maxIndex);
    const startPct = (from / max) * 100;
    const endPct = 100 - (to / max) * 100;
    return {
      '--slider-range-start': `${startPct}%`,
      '--slider-range-end': `${endPct}%`,
    };
  };

  const selectedRangeDetails = (chart: { minDay: Date }) => {
    const [from, to] = controlState().selectionIndexes;
    const startDate = dateFromIndex(chart.minDay, from);
    const endDate = dateFromIndex(chart.minDay, to);
    return reportRangeSummary(startDate, endDate, to - from);
  };

  return (
    <section aria-busy={props.focusedTimelineLoading} aria-label="Date range" class={timeRangePanel}>
      <Show
        fallback={
          <div>
            <div class={timeRangeTitle}>Report range</div>
            <div aria-live="polite" class={timeRangeMeta}>
              {reportRangeStatus()}
            </div>
          </div>
        }
        when={chartDomain()}
      >
        {(domain) => (
          <div class={timeRangeHeader} data-report-range-part="summary">
            <div class={timeRangeSummary}>
              <span class={timeRangeSummaryDates}>
                {selectedRangeDetails(domain()).fromLabel} <span class={timeRangeArrow}>→</span>{' '}
                {selectedRangeDetails(domain()).toLabel}
              </span>{' '}
              <span class={timeRangeDuration}>· {selectedRangeDetails(domain()).duration}</span>
            </div>
          </div>
        )}
      </Show>

      <Show
        fallback={
          <div aria-live="polite" class={timeRangeMeta}>
            {timelineStatus()}
          </div>
        }
        when={data()}
      >
        {(chart) => (
          <>
            <Show when={!props.focusedTimelineLoading && props.focusedTimelineError}>
              <div aria-live="polite" class={timeRangeMeta}>
                Unable to update activity: {props.focusedTimelineError}
              </div>
            </Show>

            <Show when={reportSummary()}>
              {(summary) => {
                const useSessions = valueMode() === 'sessions' || usesSessionShare(chart());
                return (
                  <div class={chartLegendList} data-report-range-part="total-legend">
                    <span class={migrationTotal} data-report-range-total>
                      {formatValue(summary().total, useSessions, summary().priceMeasurement)}
                    </span>
                    <Show when={!useSessions && aggregateApiPriceProvenance(summary().priceMeasurement)}>
                      {(fact) => (
                        <Tooltip content={fact().description}>
                          <span class={migrationReadoutHint}>{fact().label}</span>
                        </Tooltip>
                      )}
                    </Show>
                    <For
                      each={chart().series.filter(
                        (entry) => (summary().totalsByKey.get(entry.key) ?? 0) > 0 || isLegendActive(entry.key),
                      )}
                    >
                      {(entry) => {
                        const marker = swatch(entry.key);
                        const entryValueTotal = summary().totalsByKey.get(entry.key) ?? 0;
                        const aggregateCount = entry.memberKeys?.length ?? 0;
                        const isAggregate = aggregateCount > 0;
                        const filterable = isLegendFilterable(entry.key);
                        return (
                          <button
                            aria-label={isAggregate ? `Other: ${aggregateCount} smaller series` : undefined}
                            aria-pressed={isLegendActive(entry.key)}
                            class={cx(
                              migrationLegendButton,
                              isLegendActive(entry.key) ? migrationReadoutItemActive : '',
                            )}
                            data-active={isLegendActive(entry.key)}
                            disabled={isAggregate || !filterable}
                            onClick={() => {
                              if (!(isAggregate || !filterable)) {
                                props.onDimensionFilter(renderedDimension(), entry.key);
                              }
                            }}
                            onMouseEnter={() =>
                              dispatchControl({ type: 'hoverChanged', bucketIndex: hoveredBucket(), key: entry.key })
                            }
                            onMouseLeave={() =>
                              dispatchControl({ type: 'hoverChanged', bucketIndex: hoveredBucket(), key: null })
                            }
                            title={legendTitle(entry)}
                            type="button"
                          >
                            <span class={cx(chartLegendSwatch, marker.className)} style={marker.style} />
                            {entry.label}
                            <span class={chartLegendPct}>
                              {fmtPct((entryValueTotal / Math.max(1e-9, summary().total)) * 100)}
                            </span>
                          </button>
                        );
                      }}
                    </For>
                    <Show when={summary().unclassified}>
                      {(gap) => (
                        <Tooltip content={originGapDescription(gap())}>
                          <span
                            class={migrationReadoutItem}
                            data-origin-unclassified-legend
                            title={originGapDescription(gap())}
                          >
                            <span class={chartUnclassifiedSwatch} />
                            Not classified
                            <span class={chartLegendPct}>
                              {fmtPct(
                                ((useSessions ? gap().sessions : gap().total) / Math.max(1e-9, summary().total)) * 100,
                              )}
                            </span>
                          </span>
                        </Tooltip>
                      )}
                    </Show>
                  </div>
                );
              }}
            </Show>

            <div class={timeSliderRoot} data-report-range-part="chart">
              <div class={timeSliderFrame}>
                <div class={timeSliderControl}>
                  <div class={timeSliderTrack} style={rangeVars(chart())}>
                    <For each={visibleMonthTicks()}>
                      {(tick) => (
                        <div aria-hidden="true" class={monthGridline} style={{ left: timelinePlotLeft(tick.pct) }} />
                      )}
                    </For>
                    <div
                      aria-hidden="true"
                      class={timeSliderBars}
                      data-origin-series-stack={chart().dimension === 'origin' ? '' : undefined}
                      style={{
                        bottom: chart().unclassified ? '16px' : undefined,
                        gap: visibleBucketLayout().bucketGap,
                      }}
                    >
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
                                const marker = swatch(segment.key);
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
                    <Show when={chart().unclassified}>
                      <div
                        aria-hidden="true"
                        class={timeSliderUnclassifiedBands}
                        data-origin-unclassified-band
                        style={{ gap: visibleBucketLayout().bucketGap }}
                      >
                        <For each={visibleBars()}>
                          {(bar) => (
                            <div
                              class={bar.bucket.unclassified ? timeBucketUnclassifiedBand : timeBucketUnclassifiedEmpty}
                              data-origin-gap-sessions={bar.bucket.unclassified?.sessions}
                              style={{ 'min-width': visibleBucketLayout().bucketMinWidth }}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                    <button
                      aria-label="Inspect activity timeline. Use arrow keys to inspect days."
                      class={timelineHoverLayer}
                      onClick={updateHover}
                      onKeyDown={inspectTimelineWithKeyboard}
                      onMouseLeave={clearHover}
                      onMouseMove={updateHover}
                      title="Inspect activity in the selected report range"
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
                <div
                  class={timeAxis}
                  data-report-range-part="chart-axis"
                  data-timeline-tick-row
                  ref={(element) => {
                    timelineTickRow = element;
                  }}
                  style={{ 'min-height': '16px' }}
                >
                  <For each={visibleMonthTicks()}>
                    {(tick) => {
                      const tickId = timelineTickIdFor(tick);
                      return (
                        <span
                          class={timeAxisTick}
                          data-timeline-label-id={tickId}
                          data-timeline-tick
                          style={{
                            left: `${tick.pct}%`,
                            visibility: retainedTimelineTickIds()?.has(tickId) === false ? 'hidden' : undefined,
                          }}
                        >
                          {tick.label}
                        </span>
                      );
                    }}
                  </For>
                </div>
                <div
                  class={timeAxis}
                  data-timeline-boundary-row
                  ref={(element) => {
                    timelineBoundaryRow = element;
                  }}
                >
                  <span data-timeline-boundary data-timeline-label-id="from">
                    {fmtDateOnly(chart().buckets[visibleBucketRange().from]?.date ?? chart().first)}
                  </span>
                  <span data-timeline-boundary data-timeline-label-id="to">
                    {fmtDateOnly(chart().buckets[visibleBucketRange().to]?.date ?? chart().last)}
                  </span>
                </div>
                <Show when={readout()}>
                  {(tip) => (
                    <div aria-live="polite" class={migrationReadout} role="status">
                      <span class={migrationReadoutDate}>{tip().label}</span>
                      <span class={migrationReadoutTotal}>
                        {formatValue(tip().total, tip().useSessions, tip().priceMeasurement)}
                      </span>
                      <Show when={!tip().useSessions && aggregateApiPriceProvenance(tip().priceMeasurement)}>
                        {(fact) => (
                          <Tooltip content={fact().description}>
                            <span class={migrationReadoutHint}>{fact().label}</span>
                          </Tooltip>
                        )}
                      </Show>
                      <For each={tip().rows}>
                        {(row) => {
                          const marker = swatch(row.key);
                          return (
                            <span
                              class={cx(
                                migrationReadoutItem,
                                row.key === hoveredKey() ? migrationReadoutItemActive : undefined,
                              )}
                            >
                              <span class={cx(migrationReadoutSwatch, marker.className)} style={marker.style} />
                              {row.label}
                              <span class={migrationReadoutValue}>
                                {formatValue(row.value, tip().useSessions, row.priceMeasurement)} ·{' '}
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
                      <Show when={tip().unclassified}>
                        {(gap) => (
                          <Tooltip content={originGapDescription(gap())}>
                            <span
                              class={migrationReadoutItem}
                              data-origin-unclassified-readout
                              title={originGapDescription(gap())}
                            >
                              <span class={chartUnclassifiedSwatch} />
                              Not classified
                              <span class={migrationReadoutValue}>
                                {formatValue(
                                  tip().useSessions ? gap().sessions : gap().total,
                                  tip().useSessions,
                                  gap().priceMeasurement,
                                )}
                              </span>
                            </span>
                          </Tooltip>
                        )}
                      </Show>
                      <Show when={tip().hidden > 0}>
                        <span class={migrationReadoutHint}>+{tip().hidden} more</span>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </div>

            <div class={timeRangeAdjustments} data-report-range-part="adjustments">
              <div class={timeSliderBrushRow}>
                <div class={timeSliderQuickRanges}>
                  <For each={dateRangePresets}>
                    {(preset) => (
                      <button
                        aria-pressed={props.dateRange.mode() === preset.mode}
                        class={presetButton}
                        data-active={props.dateRange.mode() === preset.mode}
                        onClick={() => applyPreset(preset.mode)}
                        title={`Set report range to ${preset.label}`}
                        type="button"
                      >
                        {preset.label}
                      </button>
                    )}
                  </For>
                </div>
                <div class={timeSliderDateInputs}>
                  <label style={{ display: 'grid', gap: '4px' }}>
                    <span class={timeChartZoomSummary}>From</span>
                    <input
                      aria-label="Start date"
                      autocomplete="off"
                      class={timeSliderDateChip}
                      inputmode="numeric"
                      onBlur={() => finishDateInputEdit('from')}
                      onFocus={(event) => {
                        beginDateInputEdit('from');
                        event.currentTarget.select();
                      }}
                      onInput={(event) => applyDateInputDraft('from', event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          finishDateInputEdit('from');
                          event.currentTarget.blur();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setDateInputDrafts((current) => ({
                            ...current,
                            from: props.dateRange.inputValues().from,
                          }));
                          setEditingDateInput(null);
                          event.currentTarget.blur();
                        }
                      }}
                      placeholder="YYYY-MM-DD"
                      title="Edit as YYYY-MM-DD"
                      type="text"
                      value={dateInputValue('from')}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: '4px' }}>
                    <span class={timeChartZoomSummary}>To</span>
                    <input
                      aria-label="End date"
                      autocomplete="off"
                      class={timeSliderDateChip}
                      inputmode="numeric"
                      onBlur={() => finishDateInputEdit('to')}
                      onFocus={(event) => {
                        beginDateInputEdit('to');
                        event.currentTarget.select();
                      }}
                      onInput={(event) => applyDateInputDraft('to', event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          finishDateInputEdit('to');
                          event.currentTarget.blur();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setDateInputDrafts((current) => ({
                            ...current,
                            to: props.dateRange.inputValues().to,
                          }));
                          setEditingDateInput(null);
                          event.currentTarget.blur();
                        }
                      }}
                      placeholder="YYYY-MM-DD"
                      title="Edit as YYYY-MM-DD"
                      type="text"
                      value={dateInputValue('to')}
                    />
                  </label>
                </div>
              </div>
              <div class={timeSliderBrushColumn} data-report-range-part="brush">
                <div class={timeSliderBrushHeader}>
                  <span>Follows report range</span>
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
                    onPointerDown={startSelectionDrag}
                    onPointerMove={moveSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    tabIndex={-1}
                    title="Drag selected range"
                    type="button"
                  />
                  <button
                    aria-label="Start date"
                    aria-valuemax={controlContext().selectionMaxIndex}
                    aria-valuemin={0}
                    aria-valuenow={controlState().selectionIndexes[0]}
                    aria-valuetext={fmtDateOnly(dateFromIndex(chart().minDay, controlState().selectionIndexes[0]))}
                    class={timeSliderThumb}
                    onKeyDown={(event) => handleSliderKeyDown(event, 'start')}
                    onLostPointerCapture={endHandleDrag}
                    onPointerCancel={endHandleDrag}
                    onPointerDown={(event) => startHandleDrag(event, 'start')}
                    onPointerMove={moveHandleDrag}
                    onPointerUp={endHandleDrag}
                    role="slider"
                    style={{ left: 'var(--slider-range-start)' }}
                    type="button"
                  />
                  <button
                    aria-label="End date"
                    aria-valuemax={controlContext().selectionMaxIndex}
                    aria-valuemin={0}
                    aria-valuenow={controlState().selectionIndexes[1]}
                    aria-valuetext={fmtDateOnly(dateFromIndex(chart().minDay, controlState().selectionIndexes[1]))}
                    class={timeSliderThumb}
                    onKeyDown={(event) => handleSliderKeyDown(event, 'end')}
                    onLostPointerCapture={endHandleDrag}
                    onPointerCancel={endHandleDrag}
                    onPointerDown={(event) => startHandleDrag(event, 'end')}
                    onPointerMove={moveHandleDrag}
                    onPointerUp={endHandleDrag}
                    role="slider"
                    style={{ left: 'calc(100% - var(--slider-range-end))' }}
                    type="button"
                  />
                </div>
              </div>
            </div>

            <details aria-label="Chart options" class={timeChartOptions} data-report-range-part="chart-options">
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
                  label="Group by"
                  onValueChange={(value) => {
                    dispatchControl({
                      type: 'optionChanged',
                      option: 'dimension',
                      value: toTimelineDimension(value),
                    });
                  }}
                  value={dimension()}
                />
                <SegmentedControl
                  ariaLabel="Timeline granularity"
                  items={GRANULARITY_ITEMS}
                  label="Interval"
                  onValueChange={(value) => {
                    const nextGranularity = toGranularity(value);
                    const domain = chartDomain();
                    dispatchControl(
                      {
                        type: 'optionChanged',
                        option: 'granularity',
                        selectionIndexesFromDates: props.dateRange.selectedIndexes(),
                        value: nextGranularity,
                      },
                      {
                        selectionMaxIndex: domain?.maxIndex ?? 0,
                      },
                    );
                  }}
                  value={granularity()}
                />
                <SegmentedControl
                  ariaLabel="Timeline value"
                  items={VALUE_ITEMS}
                  label="Metric"
                  onValueChange={(value) => {
                    dispatchControl({
                      type: 'optionChanged',
                      option: 'value',
                      value: toTimelineValue(value),
                    });
                  }}
                  value={valueMode()}
                />
              </div>
              <Show when={dimension() === 'model' && (valueMode() === 'sessions' || usesSessionShare(chart()))}>
                <div class={timeRangeMeta}>Multi-model sessions are counted once under their primary model.</div>
              </Show>
            </details>
          </>
        )}
      </Show>
    </section>
  );
};
