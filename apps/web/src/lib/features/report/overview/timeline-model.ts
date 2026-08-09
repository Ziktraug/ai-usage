import type {
  FocusedTimelineBucket,
  FocusedTimelineBucketEntry,
  FocusedTimelineData,
  FocusedTimelineDimension,
  FocusedTimelineSeries,
} from '@ai-usage/report-core/focused-report-query';
import type { ApiPriceMeasurement } from '@ai-usage/report-core/provenance';
import type { TimelineValue } from '../../../../overview-model';

export interface MachineTimelinePresentation {
  readonly freshness: 'fresh' | 'stale' | 'unavailable';
  readonly label: string;
}

export interface TimelineLabelBox {
  readonly id: string;
  readonly left: number;
  readonly right: number;
}

export interface TimelineReadoutRow {
  /** Percentage change against the previous bucket; null without a prior value. */
  readonly delta: number | null;
  readonly key: string;
  readonly label: string;
  readonly priceMeasurement: ApiPriceMeasurement;
  readonly value: number;
}

export interface TimelineReadout {
  readonly bucket: FocusedTimelineBucket;
  readonly hasPrevious: boolean;
  readonly rows: readonly TimelineReadoutRow[];
  readonly total: number;
  readonly useSessions: boolean;
}

export type CampaignSeriesPresenter = (series: FocusedTimelineSeries) => FocusedTimelineSeries;
export type MachineSeriesPresenter = (key: string, label: string) => MachineTimelinePresentation;

export const timelineUsesSessions = (timeline: FocusedTimelineData, value: TimelineValue): boolean =>
  value === 'sessions' || (value === 'share' && timeline.grandTotal <= 0);

// Internal to the readout: bars read their own segment values from
// `timeline-window`, which already filtered the empty entries out.
const timelineEntryValue = (
  entry: Pick<FocusedTimelineBucketEntry, 'cost' | 'sessions'> | null | undefined,
  useSessions: boolean,
): number => {
  if (!entry) {
    return 0;
  }
  return useSessions ? entry.sessions : entry.cost;
};

// Internal to the readout: the chart itself reads classified bucket values from
// `timeline-window`, which excludes the unclassified gap.
const timelineBucketValue = (
  bucket: Pick<FocusedTimelineBucket, 'sessions' | 'total'>,
  useSessions: boolean,
): number => (useSessions ? bucket.sessions : bucket.total);

export const timelineSeriesValue = (
  series: Pick<FocusedTimelineSeries, 'sessions' | 'total'>,
  useSessions: boolean,
): number => (useSessions ? series.sessions : series.total);

export const timelineGapValue = (
  gap: { readonly sessions: number; readonly total: number },
  useSessions: boolean,
): number => (useSessions ? gap.sessions : gap.total);

export const timelineSharePercent = (amount: number, total: number): number => (total > 0 ? (amount / total) * 100 : 0);

export const presentTimelineSeries = (
  timeline: FocusedTimelineData,
  presentCampaignSeries: CampaignSeriesPresenter,
  presentMachineSeries: MachineSeriesPresenter,
): readonly FocusedTimelineSeries[] => {
  if (timeline.dimension === 'campaign') {
    return timeline.series.map(presentCampaignSeries);
  }
  if (timeline.dimension === 'machine') {
    return timeline.series.map((series) => ({
      ...series,
      label: presentMachineSeries(series.key, series.label).label,
    }));
  }
  return timeline.series;
};

export const timelineSeriesIsFilterable = (
  dimension: FocusedTimelineDimension,
  series: Pick<FocusedTimelineSeries, 'key' | 'memberKeys'>,
): boolean => {
  if ((series.memberKeys?.length ?? 0) > 0 || dimension === 'campaign' || dimension === 'origin') {
    return false;
  }
  return dimension !== 'machine' || series.key.length > 0;
};

/** Below this the change is noise; at or above it the ratio stops being useful. */
const MINIMUM_TREND_PCT = 1;
const MAXIMUM_TREND_PCT = 1000;
const NEGLIGIBLE_PRIOR = 1e-9;

/** Whether a series change is worth showing next to its value. */
export const timelineTrendIsVisible = (delta: number | null): boolean =>
  delta !== null && Math.abs(delta) >= MINIMUM_TREND_PCT && Math.abs(delta) < MAXIMUM_TREND_PCT;

export const timelineReadoutFor = (
  timeline: FocusedTimelineData,
  value: TimelineValue,
  index: number,
  series: readonly FocusedTimelineSeries[] = timeline.series,
): TimelineReadout | null => {
  const bucket = timeline.buckets[index];
  if (!bucket) {
    return null;
  }
  const useSessions = timelineUsesSessions(timeline, value);
  // The bucket before this one, when there is one, is what each series change is
  // measured against.
  const previous = index > 0 ? timeline.buckets[index - 1] : undefined;
  const rows = series
    .map((series) => {
      const entry = bucket.byKey[series.key];
      const current = timelineEntryValue(entry, useSessions);
      const prior = previous ? timelineEntryValue(previous.byKey[series.key], useSessions) : 0;
      return {
        delta: prior > NEGLIGIBLE_PRIOR ? ((current - prior) / prior) * 100 : null,
        key: series.key,
        label: series.label,
        priceMeasurement: entry?.priceMeasurement ?? series.priceMeasurement,
        value: current,
      };
    })
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value);
  return {
    bucket,
    hasPrevious: previous !== undefined,
    rows,
    total: timelineBucketValue(bucket, useSessions),
    useSessions,
  };
};

export const retainTimelineTickLabels = (
  ticks: readonly TimelineLabelBox[],
  boundaries: readonly TimelineLabelBox[],
): readonly TimelineLabelBox[] =>
  ticks.filter((tick) => boundaries.every((boundary) => tick.right <= boundary.left || tick.left >= boundary.right));
