import type {
  FocusedOverviewResult,
  FocusedReportSummary,
  FocusedTimelineGap,
} from '@ai-usage/report-core/focused-report-query';
import { originProvenanceFor } from '@ai-usage/report-core/provenance';
import type { Metric, MetricDelta } from '../../../../dashboard-metric-model';
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
import {
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
} from '../../../foundation/presentation/report-value';

export interface TokenAnatomyRow {
  readonly key: 'cache-read' | 'cache-write' | 'input' | 'output';
  readonly label: string;
  readonly percentage: string;
  readonly value: string;
}

const comparisonDelta = (current: number, previous: number, format: (value: number) => string): MetricDelta | null => {
  if (previous <= 0) {
    return null;
  }
  return {
    hint: `Previous period of equal length: ${format(previous)}`,
    pct: ((current - previous) / previous) * 100,
  };
};

export const buildOverviewMetrics = (
  summary: FocusedReportSummary,
  previous: FocusedReportSummary | null,
): Metric[] => {
  const apiValue = aggregateApiValuePresentation(summary.priceMeasurement);
  const apiValueProvenance = aggregateApiPriceProvenance(summary.priceMeasurement);
  const metrics: Metric[] = [
    {
      kind: 'sessions',
      label: 'Sessions',
      value: fmtNum(summary.sessionCount),
      hint: 'Sessions in the current filter',
      delta: previous ? comparisonDelta(summary.sessionCount, previous.sessionCount, fmtNum) : null,
    },
    {
      kind: 'api-value',
      label: apiValueProvenance ? `API value · ${apiValueProvenance.label}` : 'API value',
      value: apiValue.label,
      hint: [
        `Estimated API-equivalent value at standard prices for ${fmtNum(summary.pricedSessions)} of ${fmtNum(summary.sessionCount)} fully priced sessions, including usage covered by subscriptions`,
        apiValueProvenance?.description,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
      delta: previous ? comparisonDelta(summary.totalCost, previous.totalCost, fmtMoney) : null,
    },
    {
      kind: 'actual-cost',
      label: 'Actual cost',
      value: fmtMoney(summary.actualCost),
      hint: `Out-of-pocket spend reported by harnesses; subscription usage counts as $0${
        summary.unknownActual ? ` (${fmtNum(summary.unknownActual)} sessions unknown)` : ''
      }`,
      delta: previous ? comparisonDelta(summary.actualCost, previous.actualCost, fmtMoney) : null,
    },
    {
      kind: 'subscription-value',
      label: 'Sub value',
      value: fmtMoney(summary.costQuota),
      hint: 'Cursor export value covered by the subscription quota',
      delta: previous ? comparisonDelta(summary.costQuota, previous.costQuota, fmtMoney) : null,
    },
    {
      kind: 'mean-cost',
      label: 'Mean / sess',
      value: fmtMoney(summary.meanCost),
      hint: 'Mean API value per priced session',
    },
    {
      kind: 'fresh-tokens',
      label: 'Fresh tokens',
      value: fmtCompact(summary.fresh),
      hint: `Tokens processed without cache: ${fmtNum(summary.fresh)}`,
      delta: previous ? comparisonDelta(summary.fresh, previous.fresh, fmtCompact) : null,
    },
  ];

  if (summary.rtkSaved) {
    metrics.push({
      kind: 'rtk-savings',
      label: 'RTK savings',
      value: fmtPct(summary.rtkInput ? (summary.rtkSaved / summary.rtkInput) * 100 : 0),
      hint: [
        `${fmtNum(summary.rtkSaved)} tokens saved in matched sessions`,
        `${fmtNum(summary.rtkInput)} RTK input tokens before filtering`,
        `${fmtNum(summary.rtkOutput)} RTK output tokens after filtering`,
      ].join('\n'),
    });
  }

  metrics.push(
    {
      kind: 'turns',
      label: 'Turns',
      value: fmtNum(summary.turns),
      hint: 'Assistant turns across the filtered sessions',
      delta: previous ? comparisonDelta(summary.turns, previous.turns, fmtNum) : null,
    },
    {
      kind: 'tool-calls',
      label: 'Tool calls',
      value: fmtNum(summary.tools),
      hint: 'Tool invocations across the filtered sessions',
      delta: previous ? comparisonDelta(summary.tools, previous.tools, fmtNum) : null,
    },
  );

  return metrics;
};

export const fmtDeltaPct = (percentage: number): string => {
  if (percentage >= 400) {
    const factor = percentage / 100 + 1;
    return `×${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}`;
  }
  return fmtPct(Math.abs(percentage));
};

export const metricDeltaLabel = (delta: MetricDelta): string => `${fmtDeltaPct(delta.pct)} vs previous period`;

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
