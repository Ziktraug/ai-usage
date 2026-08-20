import {
  PROVIDER_QUOTA_LIVE_GAP_MS,
  type ProviderQuotaHistoryPoint,
  segmentProviderQuotaHistoryPoints,
} from '@ai-usage/report-core/provider-quota';
import type { ProviderLimitWindow, ProviderStatus } from '@ai-usage/report-core/provider-status';
import type { QuotaHistoryRange } from './cli';
import { clr } from './render/colors';
import { fmtDate, pad, trunc } from './render/format';

export const renderQuota = (providers: readonly ProviderStatus[]): string => {
  if (providers.length === 0) {
    return 'No stored provider usage-limit observation is available.';
  }

  const bar = (pct: number) => {
    const n = Math.round(Math.min(100, pct) / 5);
    const style = quotaColor(pct);
    return style('█'.repeat(n)) + clr.grey('░'.repeat(20 - n));
  };
  const lines: string[] = [];
  // Every provider that stores an observation, not a nominated one: the command is "show my quota",
  // and answering with only the first stored provider hides the rest as they are wired up.
  for (const provider of providers) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(
      clr.bold(`═══ ${provider.label} subscription quota ═══`),
      `  plan: ${clr.cyan(provider.plan ?? 'unknown')}   ${clr.dim(`observed ${fmtDate(new Date(provider.generatedAt))}`)}`,
    );
    if (provider.windows.length === 0) {
      lines.push(clr.dim('  no quota window reported'));
      continue;
    }
    for (const window of provider.windows) {
      const usedPercent = window.usedPercent ?? (window.remainingPercent === null ? 0 : 100 - window.remainingPercent);
      const span = quotaWindowSpan(window);
      // The span is only worth its parentheses when it says something the label does not. A provider
      // that reports no window duration falls back to the label, and "5h (5h)" is noise.
      const heading = span === window.label ? window.label : `${window.label} (${span})`;
      lines.push(
        `  ${pad(heading, 18)} ${bar(usedPercent)} ${clr.bold(`${usedPercent.toFixed(0)}%`)}` +
          (window.resetsAt ? clr.dim(`  resets ${fmtDate(new Date(window.resetsAt))}`) : ''),
      );
    }
  }
  lines.push(clr.dim('\n  Percentages are consumed usage, from the newest durable observation of each provider.'));
  return lines.join('\n');
};

const quotaWindowSpan = (window: ProviderLimitWindow): string => {
  if (window.limitSeconds === null) {
    return window.label;
  }
  if (window.limitSeconds >= 86_400) {
    return `${Math.round(window.limitSeconds / 86_400)}d`;
  }
  return `${Math.round(window.limitSeconds / 3600)}h`;
};

const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
/** Terminal-compact by design: the full chart is the web drawer's job, not the CLI's. */
const SPARKLINE_COLUMN_WIDTH = 24;
// Real window labels carry model and scope qualifiers ("Fable · Weekly", "Weekly scoped"), so the
// column truncates rather than letting one long label shove every sparkline out of alignment.
const WINDOW_LABEL_WIDTH = 18;
const FULL_PERCENT = 100;

/** Mirrors the web model's series identity so the terminal groups exactly as the drawer does. */
const historySeriesKey = (point: ProviderQuotaHistoryPoint): string =>
  [point.providerKey, point.machineId, point.accountScope ?? '', point.windowId].join('|');

/**
 * Candidate ways two rows with the same provider and window label can differ, most meaningful first.
 * Printing a dimension the rows agree on ("nixos" beside both) names nothing, so the renderer picks
 * the first one that actually varies within the ambiguous group.
 */
const QUALIFIER_DIMENSIONS: readonly ((point: ProviderQuotaHistoryPoint) => string)[] = [
  (point) => point.accountScope ?? '',
  (point) => point.machineLabel ?? point.machineId,
  (point) => point.windowId,
  // Last resort: two machines can carry the same label, and an unlabelled row is worse than an id.
  (point) => point.machineId,
];

const distinguishingDimension = (
  group: readonly ProviderQuotaHistoryPoint[],
): ((point: ProviderQuotaHistoryPoint) => string) | null =>
  QUALIFIER_DIMENSIONS.find((dimension) => new Set(group.map(dimension)).size > 1) ?? null;

const sparkGlyph = (usedPercent: number | null): string => {
  if (usedPercent === null) {
    return ' ';
  }
  const clamped = Math.min(FULL_PERCENT, Math.max(0, usedPercent));
  const index = Math.round((clamped / FULL_PERCENT) * (SPARK_GLYPHS.length - 1));
  return SPARK_GLYPHS[index] ?? SPARK_GLYPHS[0];
};

/** Keeps the first and last observation and spreads the rest, so the trend endpoints never move. */
const sampleEvenly = <Item>(items: readonly Item[], budget: number): Item[] => {
  if (items.length <= budget) {
    return [...items];
  }
  if (budget <= 1) {
    const last = items.at(-1);
    return last === undefined ? [] : [last];
  }
  const sampled: Item[] = [];
  for (let index = 0; index < budget; index++) {
    const source = items[Math.round((index * (items.length - 1)) / (budget - 1))];
    if (source !== undefined) {
      sampled.push(source);
    }
  }
  return sampled;
};

const GAP_MARKER = ' ·gap· ';
/** Bounds the row: markers cost columns, so past this many the oldest runs merge instead of growing. */
const MAX_GAP_MARKERS = 2;

const CONFIDENCE_RANK: Record<ProviderQuotaHistoryPoint['source']['confidence'], number> = {
  authoritative: 3,
  derived: 2,
  historical: 1,
};

/**
 * Same rule as the web model: one point per observation timestamp, keeping the most trustworthy
 * source. A backfilled rollout point and a live app-server point can describe the same instant, and
 * letting the historical one win would make the endpoint percentages disagree with the drawer.
 */
const dedupeByConfidence = (points: readonly ProviderQuotaHistoryPoint[]): ProviderQuotaHistoryPoint[] => {
  const selected = new Map<string, ProviderQuotaHistoryPoint>();
  for (const point of points) {
    const key = `${historySeriesKey(point)}|${point.firstObservedAt}`;
    const current = selected.get(key);
    if (!current || CONFIDENCE_RANK[point.source.confidence] > CONFIDENCE_RANK[current.source.confidence]) {
      selected.set(key, point);
    }
  }
  return [...selected.values()].sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt));
};

// Only a collection gap gets a marker. The shared segmenter also breaks on a reset, but real windows
// roll their resetAt forward on nearly every observation, so marking those turns a one-line sparkline
// into a wall of separators. A reset is already legible as the percentage dropping, and the row's
// "resets" column names the next one. The elapsed time is re-checked here rather than trusting
// breakReason, because the segmenter reports 'reset' first and would otherwise hide a hiatus that
// happens to straddle one.
const gapSeparatedRuns = (points: readonly ProviderQuotaHistoryPoint[]): ProviderQuotaHistoryPoint[][] => {
  const runs: ProviderQuotaHistoryPoint[][] = [];
  for (const segment of segmentProviderQuotaHistoryPoints([...points], PROVIDER_QUOTA_LIVE_GAP_MS)) {
    const previousLast = runs.at(-1)?.at(-1);
    const segmentFirst = segment.points[0];
    const elapsedMs =
      previousLast && segmentFirst
        ? Date.parse(segmentFirst.firstObservedAt) - Date.parse(previousLast.lastObservedAt)
        : 0;
    const isGap = segment.breakReason === 'gap' || elapsedMs > PROVIDER_QUOTA_LIVE_GAP_MS;
    const previous = runs.at(-1);
    if (previous && !isGap) {
      previous.push(...segment.points);
    } else {
      runs.push([...segment.points]);
    }
  }
  // Oldest first: when history is too fragmented to draw honestly, the recent structure is the part
  // worth keeping distinct.
  while (runs.length > MAX_GAP_MARKERS + 1) {
    const [oldest, next, ...rest] = runs as [
      ProviderQuotaHistoryPoint[],
      ProviderQuotaHistoryPoint[],
      ...ProviderQuotaHistoryPoint[][],
    ];
    runs.length = 0;
    runs.push([...oldest, ...next], ...rest);
  }
  return runs;
};

const historySparkline = (points: readonly ProviderQuotaHistoryPoint[]): string => {
  const runs = gapSeparatedRuns(points);
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  const glyphBudget = Math.max(runs.length, SPARKLINE_COLUMN_WIDTH - (runs.length - 1) * GAP_MARKER.length);
  // Allocated against a running remainder so the glyphs total the budget exactly and the column stays
  // within SPARKLINE_COLUMN_WIDTH however many gaps the history has.
  let remaining = glyphBudget;
  const glyphRuns = runs.map((run, index) => {
    const runsAfter = runs.length - 1 - index;
    const share =
      runsAfter === 0
        ? remaining
        : Math.max(1, Math.min(remaining - runsAfter, Math.round((glyphBudget * run.length) / Math.max(1, total))));
    remaining -= share;
    return sampleEvenly(run, share)
      .map((point) => sparkGlyph(point.usedPercent))
      .join('');
  });
  const width = glyphRuns.reduce((sum, run) => sum + run.length, 0) + (glyphRuns.length - 1) * GAP_MARKER.length;
  const text = glyphRuns.join(clr.dim(GAP_MARKER));
  return text + ' '.repeat(Math.max(0, SPARKLINE_COLUMN_WIDTH - width));
};

const historyPercent = (usedPercent: number | null): string =>
  usedPercent === null ? clr.grey('—') : quotaColor(usedPercent)(`${usedPercent.toFixed(0)}%`);

export const renderQuotaHistory = (
  points: readonly ProviderQuotaHistoryPoint[],
  range: QuotaHistoryRange,
  options: { readonly partial?: boolean } = {},
): string => {
  if (points.length === 0) {
    return `No stored provider quota history in the last ${range}.`;
  }
  const groups = new Map<string, ProviderQuotaHistoryPoint[]>();
  for (const point of points) {
    const key = historySeriesKey(point);
    const existing = groups.get(key);
    if (existing) {
      existing.push(point);
    } else {
      groups.set(key, [point]);
    }
  }
  const series = [...groups.values()].map(dedupeByConfidence).sort((left, right) => {
    const first = left[0] as ProviderQuotaHistoryPoint;
    const second = right[0] as ProviderQuotaHistoryPoint;
    return (
      first.providerLabel.localeCompare(second.providerLabel) ||
      first.windowLabel.localeCompare(second.windowLabel) ||
      first.windowId.localeCompare(second.windowId)
    );
  });
  // The query is unfiltered by machine and account, so one provider can legitimately return several
  // rows with the same window label. Name the difference rather than printing twin rows.
  const sameLabelGroups = new Map<string, ProviderQuotaHistoryPoint[]>();
  for (const seriesPoints of series) {
    const first = seriesPoints[0] as ProviderQuotaHistoryPoint;
    const key = `${first.providerLabel}|${first.windowLabel}`;
    const group = sameLabelGroups.get(key);
    if (group) {
      group.push(first);
    } else {
      sameLabelGroups.set(key, [first]);
    }
  }
  const qualifiers = new Map<string, (point: ProviderQuotaHistoryPoint) => string>();
  for (const [key, group] of sameLabelGroups) {
    const dimension = group.length > 1 ? distinguishingDimension(group) : null;
    if (dimension) {
      qualifiers.set(key, dimension);
    }
  }

  const lines: string[] = [];
  let renderedProvider: string | null = null;
  for (const points of series) {
    const first = points[0] as ProviderQuotaHistoryPoint;
    const last = points.at(-1) as ProviderQuotaHistoryPoint;
    if (first.providerLabel !== renderedProvider) {
      if (renderedProvider !== null) {
        lines.push('');
      }
      lines.push(clr.bold(`═══ ${first.providerLabel} subscription quota — last ${range} ═══`));
      renderedProvider = first.providerLabel;
    }
    const qualifier = qualifiers.get(`${first.providerLabel}|${first.windowLabel}`)?.(first);
    lines.push(
      `  ${pad(trunc(first.windowLabel, WINDOW_LABEL_WIDTH), WINDOW_LABEL_WIDTH)} ${historySparkline(points)}  ` +
        `${historyPercent(first.usedPercent)} → ${historyPercent(last.usedPercent)}` +
        (last.resetAt ? clr.dim(`   resets ${fmtDate(new Date(last.resetAt))}`) : '') +
        (qualifier ? clr.dim(`   ${qualifier}`) : ''),
    );
  }
  // Say so rather than presenting a clipped trend as the whole picture; the drawer carries the same
  // caveat from the same two store signals.
  if (options.partial) {
    lines.push(clr.dim('\n  History is partial or contains skipped observations.'));
  }
  lines.push(clr.dim("\n  Read from stored observations only. Run 'ai-usage quota' for a fresh reading."));
  return lines.join('\n');
};

const quotaColor = (pct: number) => {
  if (pct >= 90) {
    return clr.redB;
  }
  if (pct >= 70) {
    return clr.yellow;
  }
  return clr.green;
};
