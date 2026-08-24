import type {
  FocusedTimelineBucket,
  FocusedTimelineBucketEntry,
  FocusedTimelineData,
  FocusedTimelineDimension,
  FocusedTimelineSeries,
} from '@ai-usage/report-core/focused-report-query';
import type { ApiPriceMeasurement } from '@ai-usage/report-core/provenance';
import type { ResolvedTimelineMetric, TimelineValue } from '../../../../overview-model';
import { fmtNum, fmtPct } from '../../../foundation/presentation/format';
import {
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
} from '../../../foundation/presentation/report-value';

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
  readonly metric: ResolvedTimelineMetric;
  readonly rows: readonly TimelineReadoutRow[];
  readonly total: number;
}

export interface TimelineValuePresentation {
  readonly label: string;
  readonly provenance: ReturnType<typeof aggregateApiPriceProvenance>;
  readonly title: string | null;
}

export type CampaignSeriesPresenter = (series: FocusedTimelineSeries) => FocusedTimelineSeries;
export type MachineSeriesPresenter = (key: string, label: string) => MachineTimelinePresentation;
export const resolveTimelineMetric = (
  timeline: Pick<FocusedTimelineData, 'grandTotal'> | null,
  value: TimelineValue,
): ResolvedTimelineMetric => {
  if (value !== 'share') {
    return value;
  }
  return timeline !== null && timeline.grandTotal <= 0 ? 'sessions' : 'cost';
};

export const timelineSharePercent = (amount: number, total: number): number => (total > 0 ? (amount / total) * 100 : 0);

export const timelineMetricLabel = (value: TimelineValue, metric: ResolvedTimelineMetric): string => {
  if (value === 'share') {
    return 'Share';
  }
  if (metric === 'tokens') {
    return 'Processed tokens';
  }
  return metric === 'sessions' ? 'Sessions' : 'API value';
};

export const presentTimelineValue = (
  amount: number,
  total: number,
  value: TimelineValue,
  metric: ResolvedTimelineMetric,
  priceMeasurement: ApiPriceMeasurement,
): TimelineValuePresentation => {
  if (value === 'share') {
    return { label: fmtPct(timelineSharePercent(amount, total)), provenance: null, title: null };
  }
  if (metric === 'tokens') {
    return { label: `${fmtNum(amount)} tokens`, provenance: null, title: null };
  }
  if (metric === 'sessions') {
    return { label: `${fmtNum(amount)} sessions`, provenance: null, title: null };
  }
  const amountMeasurement = { ...priceMeasurement, knownCost: amount };
  const presentation = aggregateApiValuePresentation(amountMeasurement);
  return {
    label: presentation.label,
    provenance: aggregateApiPriceProvenance(amountMeasurement),
    title: presentation.title,
  };
};

// Internal to the readout: bars read their own segment values from
// `timeline-window`, which already filtered the empty entries out.
const timelineEntryValue = (
  entry: Pick<FocusedTimelineBucketEntry, 'cost' | 'sessions' | 'tokens'> | null | undefined,
  metric: ResolvedTimelineMetric,
): number => {
  if (!entry) {
    return 0;
  }
  if (metric === 'sessions') {
    return entry.sessions;
  }
  return metric === 'tokens' ? entry.tokens : entry.cost;
};

// Internal to the readout: the chart itself reads classified bucket values from
// `timeline-window`, which excludes the unclassified gap.
const timelineBucketValue = (
  bucket: Pick<FocusedTimelineBucket, 'sessions' | 'tokens' | 'total'>,
  metric: ResolvedTimelineMetric,
): number => {
  if (metric === 'sessions') {
    return bucket.sessions;
  }
  return metric === 'tokens' ? bucket.tokens : bucket.total;
};

export const timelineSeriesValue = (
  series: Pick<FocusedTimelineSeries, 'sessions' | 'tokens' | 'total'>,
  metric: ResolvedTimelineMetric,
): number => {
  if (metric === 'sessions') {
    return series.sessions;
  }
  return metric === 'tokens' ? series.tokens : series.total;
};

export const timelineGapValue = (
  gap: { readonly sessions: number; readonly tokens: number; readonly total: number },
  metric: ResolvedTimelineMetric,
): number => {
  if (metric === 'sessions') {
    return gap.sessions;
  }
  return metric === 'tokens' ? gap.tokens : gap.total;
};

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

export interface TimelineOtherDisclosure {
  readonly items: readonly string[];
  readonly label: string;
}

/**
 * What an aggregated series contains, for reading only. The tail collapses into
 * a non-filterable `Other`, and the members it swallowed never reached the DOM;
 * this names a bounded, rank-ordered sample of them plus how many stayed
 * unnamed. It deliberately yields no filter target: `Other` is not an exact
 * dimension filter, and disclosing its members must not make it one.
 */
export const timelineOtherDisclosure = (
  series: Pick<FocusedTimelineSeries, 'memberKeys' | 'memberSummaries'>,
): TimelineOtherDisclosure | null => {
  const memberKeys = series.memberKeys ?? [];
  if (memberKeys.length === 0) {
    return null;
  }
  const items = (series.memberSummaries ?? []).map(
    ({ label, sessions }) => `${label} · ${fmtNum(sessions)} ${sessions === 1 ? 'session' : 'sessions'}`,
  );
  const unnamed = memberKeys.length - items.length;
  return {
    items: unnamed > 0 ? [...items, `and ${fmtNum(unnamed)} more`] : items,
    label: `${fmtNum(memberKeys.length)} grouped`,
  };
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
  const metric = resolveTimelineMetric(timeline, value);
  // The bucket before this one, when there is one, is what each series change is
  // measured against.
  const previous = index > 0 ? timeline.buckets[index - 1] : undefined;
  const rows = series
    .map((series) => {
      const entry = bucket.byKey[series.key];
      const current = timelineEntryValue(entry, metric);
      const prior = previous ? timelineEntryValue(previous.byKey[series.key], metric) : 0;
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
    metric,
    rows,
    total: timelineBucketValue(bucket, metric),
  };
};

export const retainTimelineTickLabels = (
  ticks: readonly TimelineLabelBox[],
  boundaries: readonly TimelineLabelBox[],
): readonly TimelineLabelBox[] =>
  ticks.filter((tick) => boundaries.every((boundary) => tick.right <= boundary.left || tick.left >= boundary.right));
