import type { SessionPageItem, SessionQueryRange } from '@ai-usage/report-core/session-query';

export interface CampaignTimelineAxis {
  endMs: number;
  startMs: number;
  ticks: readonly { atMs: number; label: string }[];
}

export interface CampaignTimelineBar {
  clippedEnd: boolean;
  clippedStart: boolean;
  leftPercent: number;
  point: boolean;
  widthPercent: number;
}

export interface CampaignTimelineCampaign {
  bar: CampaignTimelineBar | null;
  item: SessionPageItem;
  outsideRange: boolean;
  timing: 'complete' | 'partial' | 'unavailable';
}

export interface CampaignTimelineProject {
  /** Union of observed spans; merged bands retain the weakest timing quality. */
  bars: readonly CampaignTimelineProjectBar[];
  campaigns: readonly CampaignTimelineCampaign[];
  projectKey: string;
  projectLabel: string;
}

export interface CampaignTimelineProjectBar extends CampaignTimelineBar {
  timing: 'complete' | 'partial';
}

export interface CampaignTimeline {
  axis: CampaignTimelineAxis | null;
  groups: readonly CampaignTimelineProject[];
  loadedCampaignCount: number;
}

const timestamp = (value: string | null): number | null => {
  const result = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(result) ? result : null;
};

const compareKeys = (left: string, right: string): number => (left < right ? -1 : Number(left > right));

/** A one-sided timestamp is a point, never an invented interval. */
export const barForInterval = (
  startMs: number | null,
  endMs: number | null,
  axis: CampaignTimelineAxis | null,
): CampaignTimelineBar | null => {
  const start = startMs ?? endMs;
  const end = endMs ?? startMs;
  if (
    !axis ||
    start === null ||
    end === null ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    end < axis.startMs ||
    start > axis.endMs
  ) {
    return null;
  }
  const clippedStart = Math.max(start, axis.startMs);
  const clippedEnd = Math.min(end, axis.endMs);
  const span = Math.max(1, axis.endMs - axis.startMs);
  return {
    leftPercent: ((clippedStart - axis.startMs) / span) * 100,
    widthPercent: ((clippedEnd - clippedStart) / span) * 100,
    clippedStart: start < axis.startMs,
    clippedEnd: end > axis.endMs,
    point: clippedStart === clippedEnd,
  };
};

const axisFor = (items: readonly SessionPageItem[], range: SessionQueryRange): CampaignTimelineAxis | null => {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const { chronology } of items) {
    for (const anchor of [chronology.observedFrom, chronology.observedTo]) {
      const instant = timestamp(anchor);
      if (instant !== null) {
        earliest = Math.min(earliest, instant);
        latest = Math.max(latest, instant);
      }
    }
  }
  const from = timestamp(range.from);
  const to = timestamp(range.to);
  // A finite discovery period owns its scale, independently of loaded pages.
  const finiteRange = from !== null && to !== null;
  const startMs = finiteRange ? from : Math.max(earliest, from ?? Number.NEGATIVE_INFINITY);
  const endMs = finiteRange ? to : Math.min(latest, to ?? Number.POSITIVE_INFINITY);
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs)) || endMs < startMs) {
    return null;
  }
  const crossesDay = new Date(startMs).toISOString().slice(0, 10) !== new Date(endMs).toISOString().slice(0, 10);
  const instants = startMs === endMs ? [startMs] : [startMs, startMs + (endMs - startMs) / 2, endMs];
  return {
    startMs,
    endMs,
    ticks: instants.map((atMs) => ({
      atMs,
      label: new Date(atMs)
        .toISOString()
        .slice(crossesDay ? 5 : 11, 16)
        .replace('T', ' '),
    })),
  };
};

const projectBands = (
  campaigns: readonly CampaignTimelineCampaign[],
  axis: CampaignTimelineAxis | null,
): CampaignTimelineProjectBar[] => {
  interface Interval {
    end: number;
    start: number;
    timing: CampaignTimelineProjectBar['timing'];
  }
  const intervals: Interval[] = [];
  for (const { item, timing } of campaigns) {
    const from = timestamp(item.chronology.observedFrom);
    const to = timestamp(item.chronology.observedTo);
    const start = from ?? to;
    const end = to ?? from;
    if (start !== null && end !== null && end >= start && timing !== 'unavailable') {
      intervals.push({ start, end, timing });
    }
  }
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
      if (interval.timing === 'partial') {
        previous.timing = 'partial';
      }
    } else {
      merged.push({ ...interval });
    }
  }
  return merged.flatMap(({ start, end, timing }) => {
    const bar = barForInterval(start, end, axis);
    return bar ? [{ ...bar, timing }] : [];
  });
};

/** Only the bounded loaded page participates; this never asks for campaign members. */
export const buildCampaignTimeline = (
  items: readonly SessionPageItem[],
  range: SessionQueryRange,
  retainedAxis?: CampaignTimelineAxis | null,
): CampaignTimeline => {
  const axis = retainedAxis ?? axisFor(items, range);
  const grouped = new Map<string, { label: string; campaigns: CampaignTimelineCampaign[]; latest: number }>();
  for (const item of items) {
    const { chronology, row } = item;
    const start = timestamp(chronology.observedFrom);
    const end = timestamp(chronology.observedTo);
    const group = grouped.get(row.projectKey) ?? {
      label: row.projectLabel,
      campaigns: [],
      latest: Number.NEGATIVE_INFINITY,
    };
    const bar = barForInterval(start, end, axis);
    const known = start !== null || end !== null;
    let timing: CampaignTimelineCampaign['timing'] = 'unavailable';
    if (known) {
      timing = chronology.timedSessionCount === chronology.sessionCount ? 'complete' : 'partial';
    }
    group.latest = Math.max(group.latest, end ?? start ?? Number.NEGATIVE_INFINITY);
    group.campaigns.push({
      item,
      bar,
      timing,
      outsideRange: known && bar === null,
    });
    grouped.set(row.projectKey, group);
  }
  const projects = [...grouped].sort(
    ([leftKey, left], [rightKey, right]) =>
      (left.latest === right.latest ? 0 : right.latest - left.latest) || compareKeys(leftKey, rightKey),
  );
  return {
    axis,
    loadedCampaignCount: items.length,
    groups: projects.map(([projectKey, group]) => {
      group.campaigns.sort((left, right) => {
        const a = timestamp(left.item.chronology.observedFrom) ?? Number.POSITIVE_INFINITY;
        const b = timestamp(right.item.chronology.observedFrom) ?? Number.POSITIVE_INFINITY;
        return (a === b ? 0 : a - b) || compareKeys(left.item.campaignKey, right.item.campaignKey);
      });
      return {
        projectKey,
        projectLabel: group.label,
        campaigns: group.campaigns,
        bars: projectBands(group.campaigns, axis),
      };
    }),
  };
};
