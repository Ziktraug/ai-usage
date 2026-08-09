import type { FocusedTimelineBucket, FocusedTimelineData } from '@ai-usage/report-core/focused-report-query';
import { clampNumber, dateFromIndex } from '../../../../date-range';
import type { TimeRangeIndexRange, TimeRangeSelectionIndexes } from '../../../../time-range-control-state';

/**
 * The Activity chart renders the selected report window, not the whole domain
 * the brush can address. These are the pure projections that decide which
 * buckets are visible and how they are scaled, restored from the retired Solid
 * control so the chart keeps following the report range.
 */

const MONTH_TICK_MINIMUM_BUCKETS = 8;
const MAX_VISUAL_TICKS = 14;
const SPACED_BUCKET_MIN_WIDTH_PX = 2;
const SPACED_BUCKET_GAP_PX = 2;
const TIMELINE_PLOT_INSET_PX = 8;
const PLOT_OFFSET_EPSILON = 0.0001;

const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });

export interface TimelineBucketLayout {
  bucketGap: string;
  bucketMinWidth: string;
}

export interface TimelineMonthTick {
  label: string;
  pct: number;
}

export interface VisibleTimelineSegment {
  key: string;
  rank: number;
  value: number;
}

export interface VisibleTimelineBar {
  bucket: FocusedTimelineBucket;
  index: number;
  segments: VisibleTimelineSegment[];
  total: number;
}

const bucketDate = (bucket: FocusedTimelineBucket): Date => new Date(bucket.date);

const bucketIndexAtOrBefore = (buckets: readonly FocusedTimelineBucket[], date: Date): number => {
  const time = date.getTime();
  let matchedIndex = 0;
  for (const [index, bucket] of buckets.entries()) {
    if (bucketDate(bucket).getTime() > time) {
      break;
    }
    matchedIndex = index;
  }
  return matchedIndex;
};

/** Maps the brush selection onto the bucket indexes it covers. */
export const timelineRangeForSelection = (
  buckets: readonly FocusedTimelineBucket[],
  domainFirst: Date,
  selectionIndexes: TimeRangeSelectionIndexes,
): TimeRangeIndexRange => ({
  from: bucketIndexAtOrBefore(buckets, dateFromIndex(domainFirst, selectionIndexes[0])),
  to: bucketIndexAtOrBefore(buckets, dateFromIndex(domainFirst, selectionIndexes[1])),
});

/** The classified value of one bucket, excluding its unclassified gap. */
export const classifiedBucketValue = (bucket: FocusedTimelineBucket, useSessions: boolean): number => {
  const gap = bucket.unclassified;
  const bucketValue = useSessions ? bucket.sessions : bucket.total;
  if (!gap) {
    return bucketValue;
  }
  return bucketValue - (useSessions ? gap.sessions : gap.total);
};

/**
 * Projects the visible buckets in series order, keeping only entries that
 * actually carry value so an unpriced series does not draw a zero-height sliver.
 */
export const visibleTimelineBars = (
  timeline: FocusedTimelineData,
  range: TimeRangeIndexRange,
  useSessions: boolean,
): VisibleTimelineBar[] => {
  const rankByKey = new Map(timeline.series.map((series, rank) => [series.key, rank]));
  return timeline.buckets.slice(range.from, range.to + 1).map((bucket, offset) => {
    const segments: VisibleTimelineSegment[] = [];
    for (const [key, entry] of Object.entries(bucket.byKey)) {
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
    return { bucket, index: range.from + offset, segments, total: classifiedBucketValue(bucket, useSessions) };
  });
};

/**
 * Bars are scaled against the tallest bucket inside the window, so narrowing the
 * range rescales the chart instead of flattening it against a domain-wide peak.
 */
export const visibleTimelineMaximum = (
  timeline: FocusedTimelineData,
  range: TimeRangeIndexRange,
  useSessions: boolean,
): number =>
  timeline.buckets
    .slice(range.from, range.to + 1)
    .reduce((maximum, bucket) => Math.max(maximum, classifiedBucketValue(bucket, useSessions)), 0);

/** Keeps dense day buckets inside the plot instead of overflowing horizontally. */
export const timelineBucketLayout = (bucketCount: number): TimelineBucketLayout => {
  const count = Math.max(1, Math.round(bucketCount));
  return {
    bucketGap:
      count > 1
        ? `clamp(0px, calc((100% - ${count * SPACED_BUCKET_MIN_WIDTH_PX}px) / ${count - 1}), ${SPACED_BUCKET_GAP_PX}px)`
        : '0px',
    bucketMinWidth: `min(${SPACED_BUCKET_MIN_WIDTH_PX}px, calc(100% / ${count}))`,
  };
};

/** Month boundaries inside the window; short windows carry no interior tick. */
export const visibleTimelineMonthTicks = (
  timeline: FocusedTimelineData,
  range: TimeRangeIndexRange,
): TimelineMonthTick[] => {
  const visible = timeline.buckets.slice(range.from, range.to + 1);
  if (visible.length < MONTH_TICK_MINIMUM_BUCKETS) {
    return [];
  }
  const monthKeyOf = (date: Date): string => `${date.getFullYear()}-${date.getMonth()}`;
  const firstDate = visible[0] ? bucketDate(visible[0]) : new Date(0);
  let previousMonthKey = monthKeyOf(firstDate);
  const ticks: TimelineMonthTick[] = [];
  for (const [index, bucket] of visible.entries()) {
    if (index === 0) {
      continue;
    }
    const date = bucketDate(bucket);
    const monthKey = monthKeyOf(date);
    if (monthKey === previousMonthKey) {
      continue;
    }
    previousMonthKey = monthKey;
    const label =
      date.getMonth() === 0
        ? `${monthTickFormatter.format(date)} ’${String(date.getFullYear()).slice(-2)}`
        : monthTickFormatter.format(date);
    ticks.push({ label, pct: (index / visible.length) * 100 });
  }
  if (ticks.length <= MAX_VISUAL_TICKS) {
    return ticks;
  }
  const step = Math.ceil(ticks.length / MAX_VISUAL_TICKS);
  return ticks.filter((_, index) => index % step === 0);
};

export interface VisibleTimelineSummary {
  gap: number;
  total: number;
  totalsByKey: ReadonlyMap<string, number>;
}

/**
 * Totals for the selected window only. Legend shares and the range total both
 * read these, so a series carrying nothing inside the range reports zero instead
 * of borrowing its domain-wide figure.
 */
export const visibleTimelineSummary = (
  timeline: FocusedTimelineData,
  range: TimeRangeIndexRange,
  useSessions: boolean,
): VisibleTimelineSummary => {
  const totalsByKey = new Map<string, number>();
  let total = 0;
  let gap = 0;
  for (const bucket of timeline.buckets.slice(range.from, range.to + 1)) {
    total += useSessions ? bucket.sessions : bucket.total;
    if (bucket.unclassified) {
      gap += useSessions ? bucket.unclassified.sessions : bucket.unclassified.total;
    }
    for (const [key, entry] of Object.entries(bucket.byKey)) {
      totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + (useSessions ? entry.sessions : entry.cost));
    }
  }
  return { gap, total, totalsByKey };
};

/** The dates the window actually starts and ends on. */
export const visibleTimelineBounds = (
  timeline: FocusedTimelineData,
  range: TimeRangeIndexRange,
): { first: string; last: string } => ({
  first: timeline.buckets[range.from]?.date ?? timeline.first,
  last: timeline.buckets[range.to]?.date ?? timeline.last,
});

export const timelineMonthTickId = (tick: TimelineMonthTick): string => `${tick.pct}:${tick.label}`;

/** Horizontal centre of one visible bucket, as a percentage of the window. */
export const timelineBucketCenterPercent = (offsetInWindow: number, visibleCount: number): number =>
  visibleCount > 0 ? ((offsetInWindow + 0.5) / visibleCount) * 100 : 50;

const cssNumber = (value: number): string => Number(value.toFixed(4)).toString();

/**
 * Bars and hover hit-testing live inside the plot's 8px inset while the
 * crosshair is positioned against the outer container, so a day-wide bucket
 * would otherwise appear to highlight its neighbour. Correct by the equivalent
 * pixel offset, which is largest at the edges and zero at the centre.
 */
export const timelinePlotLeft = (pct: number): string => {
  const clampedPct = clampNumber(pct, 0, 100);
  const plotRatio = clampedPct / 100;
  const offsetPx = TIMELINE_PLOT_INSET_PX - 2 * TIMELINE_PLOT_INSET_PX * plotRatio;
  if (Math.abs(offsetPx) < PLOT_OFFSET_EPSILON) {
    return `${cssNumber(clampedPct)}%`;
  }
  const sign = offsetPx < 0 ? '-' : '+';
  return `calc(${cssNumber(clampedPct)}% ${sign} ${cssNumber(Math.abs(offsetPx))}px)`;
};
