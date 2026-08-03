import type {
  FocusedOverviewResult,
  FocusedReportSummary,
  FocusedTimelineGap,
} from '@ai-usage/report-core/focused-report-query';
import { originProvenanceFor } from '@ai-usage/report-core/provenance';
import type { Metric, MetricDelta } from '../../../../dashboard-metric-model';
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
import { aggregateApiValuePresentation } from '../../../foundation/presentation/report-value';

export interface TokenAnatomyRow {
  readonly key: 'cache-read' | 'cache-write' | 'input' | 'output';
  readonly label: string;
  readonly percentage: string;
  readonly value: string;
}

const comparisonDelta = (current: number, previous: number, format: (value: number) => string): MetricDelta | null => {
  if (previous === 0) {
    return null;
  }
  return {
    hint: `Previous period of equal length: ${format(previous)}`,
    pct: ((current - previous) / Math.abs(previous)) * 100,
  };
};

const metric = (
  kind: Metric['kind'],
  label: string,
  value: string,
  hint: string | undefined,
  delta: MetricDelta | null,
): Metric => ({ kind, label, value, ...(hint ? { hint } : {}), ...(delta ? { delta } : {}) });

export const buildOverviewMetrics = (
  summary: FocusedReportSummary,
  previous: FocusedReportSummary | null,
): Metric[] => {
  const apiValue = aggregateApiValuePresentation(summary.priceMeasurement);
  const fullyPricedHint = `${apiValue.title} for ${fmtNum(summary.pricedSessions)} of ${fmtNum(summary.sessionCount)} fully priced sessions`;
  return [
    metric(
      'api-value',
      summary.priceMeasurement.state === 'partially measured' ? 'API value · partially measured' : 'API value',
      apiValue.label,
      fullyPricedHint,
      previous ? comparisonDelta(summary.totalCost, previous.totalCost, fmtMoney) : null,
    ),
    metric(
      'actual-cost',
      'Actual cost',
      summary.unknownActual === summary.sessionCount ? '—' : fmtMoney(summary.actualCost),
      `${fmtNum(Math.max(0, summary.sessionCount - summary.unknownActual))} of ${fmtNum(summary.sessionCount)} sessions report actual spend`,
      previous ? comparisonDelta(summary.actualCost, previous.actualCost, fmtMoney) : null,
    ),
    metric(
      'subscription-value',
      'Subscription value',
      fmtMoney(summary.costQuota),
      'Value covered by subscription quota',
      previous ? comparisonDelta(summary.costQuota, previous.costQuota, fmtMoney) : null,
    ),
    metric(
      'sessions',
      'Sessions',
      fmtNum(summary.sessionCount),
      undefined,
      previous ? comparisonDelta(summary.sessionCount, previous.sessionCount, fmtNum) : null,
    ),
    metric(
      'fresh-tokens',
      'Fresh tokens',
      fmtCompact(summary.fresh),
      'Input and output tokens excluding cache reads and writes',
      previous ? comparisonDelta(summary.fresh, previous.fresh, fmtCompact) : null,
    ),
    metric(
      'mean-cost',
      'Mean session value',
      fmtMoney(summary.meanCost),
      'Mean API-equivalent value across fully priced sessions',
      previous ? comparisonDelta(summary.meanCost, previous.meanCost, fmtMoney) : null,
    ),
    metric(
      'tool-calls',
      'Tool calls',
      fmtNum(summary.tools),
      undefined,
      previous ? comparisonDelta(summary.tools, previous.tools, fmtNum) : null,
    ),
    metric(
      'turns',
      'Turns',
      fmtNum(summary.turns),
      undefined,
      previous ? comparisonDelta(summary.turns, previous.turns, fmtNum) : null,
    ),
    metric(
      'rtk-savings',
      'RTK savings',
      fmtCompact(summary.rtkSaved),
      `${fmtNum(summary.rtkSessions)} sessions include RTK accounting`,
      previous ? comparisonDelta(summary.rtkSaved, previous.rtkSaved, fmtCompact) : null,
    ),
  ];
};

export const metricDeltaLabel = (delta: MetricDelta): string => `${fmtPct(Math.abs(delta.pct))} vs previous period`;

export const tokenAnatomyRows = (summary: FocusedReportSummary): TokenAnatomyRow[] => {
  const values = [summary.cacheRead, summary.cacheWrite, summary.tokIn, summary.tokOut] as const;
  const total = values.reduce((sum, value) => sum + value, 0);
  const row = (key: TokenAnatomyRow['key'], label: string, value: number): TokenAnatomyRow => ({
    key,
    label,
    percentage: fmtPct(total > 0 ? (value / total) * 100 : 0),
    value: fmtCompact(value),
  });
  return [
    row('cache-read', 'Cache read', summary.cacheRead),
    row('cache-write', 'Cache write', summary.cacheWrite),
    row('input', 'Input', summary.tokIn),
    row('output', 'Output', summary.tokOut),
  ];
};

export const originGapDescription = (gap: FocusedTimelineGap): string => {
  const causes = gap.causes
    .map(({ kind, sessions }) => {
      const provenance = originProvenanceFor(kind);
      return `${provenance.label}: ${fmtNum(sessions)} ${sessions === 1 ? 'session' : 'sessions'}`;
    })
    .join(' · ');
  const total = `Not classified: ${fmtNum(gap.sessions)} ${gap.sessions === 1 ? 'session' : 'sessions'}`;
  return causes.length > 0 ? `${total} · ${causes}` : total;
};

export const overviewHasContent = (result: FocusedOverviewResult): boolean => result.summary.sessionCount > 0;
