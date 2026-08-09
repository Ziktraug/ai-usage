import type {
  FocusedExecutiveGroup,
  FocusedExecutiveOverview,
  FocusedReportSummary,
} from '@ai-usage/report-core/focused-report-query';
import type { ApiPriceMeasurement } from '@ai-usage/report-core/provenance';
import {
  type MetricComparisonState,
  type MetricDelta,
  metricComparisonMessage,
  metricComparisonStateFor,
} from '../../../../dashboard-metric-model';
import type { DateRangeMode } from '../../../../date-range';
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
import {
  type ApiValuePresentation,
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
} from '../../../foundation/presentation/report-value';

export const EXECUTIVE_INSIGHT_MINIMUM_CHANGE_PERCENT = 20;
export const EXECUTIVE_INSIGHT_MINIMUM_CONCENTRATION_PERCENT = 40;

export interface ExecutiveInsightItem {
  readonly costApprox: number;
  readonly costKnown: boolean;
  readonly kind: 'campaign' | 'session';
}

export interface ExecutiveOverviewModelInput {
  readonly executive: FocusedExecutiveOverview;
  readonly previousSummary: FocusedReportSummary | null;
  readonly rangeMode: DateRangeMode;
  readonly summary: FocusedReportSummary;
  readonly topItems: readonly ExecutiveInsightItem[];
  readonly totalSessionCount: number;
}

export interface ExecutiveComparisonPresentation {
  readonly delta: MetricDelta | null;
  readonly explanation: string | null;
  readonly state: MetricComparisonState;
}

export interface ExecutivePrimaryPresentation {
  readonly comparison: ExecutiveComparisonPresentation;
  readonly periodScope: string;
  readonly provenance: ReturnType<typeof aggregateApiPriceProvenance>;
  readonly value: ApiValuePresentation;
}

export type ExecutiveSupportMetricKey = 'cache-volume' | 'output-tokens' | 'pricing-coverage' | 'processed-tokens';

export interface ExecutiveSupportMetric {
  readonly detail: string;
  readonly key: ExecutiveSupportMetricKey;
  readonly label: string;
  readonly qualification: string | null;
  readonly value: string;
}

export interface ExecutiveGroupPresentation {
  readonly group: FocusedExecutiveGroup;
  readonly processedTokensLabel: string;
  readonly sessionsLabel: string;
  readonly shareLabel: string;
  readonly sharePercent: number | null;
  readonly value: ApiValuePresentation;
  readonly valuePerMillion: ApiValuePresentation;
}

export interface ExecutivePeriodInsight {
  readonly sentences: readonly [string, string];
  readonly text: string;
}

export type ExecutiveEmptyState =
  | {
      readonly actionIntent: 'open-sources';
      readonly actionLabel: 'Open Sources';
      readonly description: string;
      readonly kind: 'no-local-data';
      readonly title: 'No local usage yet';
    }
  | {
      readonly actionIntent: 'clear-filters';
      readonly actionLabel: 'Clear filters';
      readonly description: string;
      readonly kind: 'filtered-zero';
      readonly title: 'No sessions match these filters';
    };

export interface ExecutiveOverviewModel {
  readonly emptyState: ExecutiveEmptyState | null;
  readonly harnesses: readonly ExecutiveGroupPresentation[];
  readonly insight: ExecutivePeriodInsight | null;
  readonly models: readonly ExecutiveGroupPresentation[];
  readonly primary: ExecutivePrimaryPresentation;
  readonly supportMetrics: readonly ExecutiveSupportMetric[];
}

const comparisonFor = (
  summary: FocusedReportSummary,
  previousSummary: FocusedReportSummary | null,
  rangeMode: DateRangeMode,
): ExecutiveComparisonPresentation => {
  const state = metricComparisonStateFor(rangeMode, previousSummary);
  const delta =
    previousSummary && previousSummary.totalCost > 0
      ? {
          hint: `Previous period of equal length: ${fmtMoney(previousSummary.totalCost)}`,
          pct: ((summary.totalCost - previousSummary.totalCost) / previousSummary.totalCost) * 100,
        }
      : null;
  return { delta, explanation: metricComparisonMessage(state), state };
};

const periodScopeFor = (rangeMode: DateRangeMode): string => {
  if (rangeMode === 'all') {
    return 'across all recorded dates';
  }
  if (rangeMode === 'today') {
    return 'today';
  }
  if (rangeMode === '7d') {
    return 'in the last 7 days';
  }
  if (rangeMode === '30d') {
    return 'in the last 30 days';
  }
  if (rangeMode === '90d') {
    return 'in the last 90 days';
  }
  return 'in the selected custom period';
};

const pricingQualification = (measurement: ApiPriceMeasurement): string | null =>
  aggregateApiPriceProvenance(measurement)?.description ?? null;

const buildSupportMetrics = (summary: FocusedReportSummary): readonly ExecutiveSupportMetric[] => {
  const processedTokens = summary.cacheRead + summary.cacheWrite + summary.tokIn + summary.tokOut;
  const cacheVolume = summary.cacheRead + summary.cacheWrite;
  const pricingPercentage = summary.sessionCount > 0 ? (summary.pricedSessions / summary.sessionCount) * 100 : 0;
  return [
    {
      detail: `${fmtNum(processedTokens)} processed tokens`,
      key: 'processed-tokens',
      label: 'Processed tokens',
      qualification: null,
      value: fmtCompact(processedTokens),
    },
    {
      detail: `${fmtNum(summary.cacheRead)} read · ${fmtNum(summary.cacheWrite)} write`,
      key: 'cache-volume',
      label: 'Cache volume',
      qualification: null,
      value: fmtCompact(cacheVolume),
    },
    {
      detail: `${fmtNum(summary.tokOut)} output tokens`,
      key: 'output-tokens',
      label: 'Output tokens',
      qualification: null,
      value: fmtCompact(summary.tokOut),
    },
    {
      detail: `${fmtPct(pricingPercentage)} fully priced`,
      key: 'pricing-coverage',
      label: 'Pricing coverage',
      qualification: pricingQualification(summary.priceMeasurement),
      value: `${fmtNum(summary.pricedSessions)} / ${fmtNum(summary.sessionCount)}`,
    },
  ];
};

const valuePerMillionPresentation = (group: FocusedExecutiveGroup): ApiValuePresentation => {
  const definition = 'Known API-equivalent value divided by processed tokens, multiplied by 1,000,000.';
  if (group.processedTokens === 0) {
    return {
      label: '—',
      status: 'unknown',
      title: 'API value per 1M processed tokens is unavailable because this group has zero processed tokens.',
    };
  }
  const value = (group.priceMeasurement.knownCost / group.processedTokens) * 1_000_000;
  if (group.priceMeasurement.state === 'partially measured') {
    return {
      label: `≥ ${fmtMoney(value)}`,
      status: 'lower-bound',
      title: `${pricingQualification(group.priceMeasurement) ?? 'Known API-value subtotal.'} ${definition}`,
    };
  }
  return { label: fmtMoney(value), status: 'exact', title: definition };
};

const groupPresentation = (group: FocusedExecutiveGroup, measuredTotal: number): ExecutiveGroupPresentation => {
  const sharePercent = measuredTotal > 0 ? (group.total / measuredTotal) * 100 : null;
  return {
    group,
    processedTokensLabel: fmtCompact(group.processedTokens),
    sessionsLabel: `${fmtNum(group.sessions)} ${group.sessions === 1 ? 'session' : 'sessions'}`,
    shareLabel: sharePercent === null ? '—' : fmtPct(sharePercent),
    sharePercent,
    value: aggregateApiValuePresentation(group.priceMeasurement),
    valuePerMillion: valuePerMillionPresentation(group),
  };
};

const leadingItemsNoun = (items: readonly [ExecutiveInsightItem, ExecutiveInsightItem]): string => {
  if (items[0].kind !== items[1].kind) {
    return 'items';
  }
  return items[0].kind === 'campaign' ? 'campaigns' : 'sessions';
};

const periodInsight = (
  summary: FocusedReportSummary,
  previousSummary: FocusedReportSummary | null,
  topItems: readonly ExecutiveInsightItem[],
): ExecutivePeriodInsight | null => {
  if (
    summary.priceMeasurement.state !== 'measured' ||
    previousSummary?.priceMeasurement.state !== 'measured' ||
    previousSummary.totalCost <= 0 ||
    summary.totalCost <= 0
  ) {
    return null;
  }
  const pricedItems = topItems.filter(({ costKnown }) => costKnown);
  const first = pricedItems[0];
  const second = pricedItems[1];
  if (!(first && second)) {
    return null;
  }
  const changePercent = ((summary.totalCost - previousSummary.totalCost) / previousSummary.totalCost) * 100;
  const concentrationPercent = ((first.costApprox + second.costApprox) / summary.totalCost) * 100;
  if (
    Math.abs(changePercent) < EXECUTIVE_INSIGHT_MINIMUM_CHANGE_PERCENT ||
    concentrationPercent < EXECUTIVE_INSIGHT_MINIMUM_CONCENTRATION_PERCENT
  ) {
    return null;
  }
  const direction = changePercent >= 0 ? 'higher' : 'lower';
  const items = [first, second] as const;
  const sentences = [
    `API-equivalent value is ${fmtPct(Math.abs(changePercent))} ${direction} than the previous equal-length period.`,
    `The two leading ${leadingItemsNoun(items)} represent ${fmtPct(concentrationPercent)} of this period's measured value.`,
  ] as const;
  return { sentences, text: sentences.join(' ') };
};

const emptyStateFor = (summary: FocusedReportSummary, totalSessionCount: number): ExecutiveEmptyState | null => {
  if (summary.sessionCount > 0) {
    return null;
  }
  if (totalSessionCount === 0) {
    return {
      actionIntent: 'open-sources',
      actionLabel: 'Open Sources',
      description: 'Connect or refresh a source to begin analyzing local usage.',
      kind: 'no-local-data',
      title: 'No local usage yet',
    };
  }
  return {
    actionIntent: 'clear-filters',
    actionLabel: 'Clear filters',
    description: 'Change or clear the active filters to restore matching sessions.',
    kind: 'filtered-zero',
    title: 'No sessions match these filters',
  };
};

export const buildExecutiveOverviewModel = ({
  executive,
  previousSummary,
  rangeMode,
  summary,
  topItems,
  totalSessionCount,
}: ExecutiveOverviewModelInput): ExecutiveOverviewModel => ({
  emptyState: emptyStateFor(summary, totalSessionCount),
  harnesses: executive.harnesses.map((group) => groupPresentation(group, summary.totalCost)),
  insight: periodInsight(summary, previousSummary, topItems),
  models: executive.models.map((group) => groupPresentation(group, summary.totalCost)),
  primary: {
    comparison: comparisonFor(summary, previousSummary, rangeMode),
    periodScope: periodScopeFor(rangeMode),
    provenance: aggregateApiPriceProvenance(summary.priceMeasurement),
    value: aggregateApiValuePresentation(summary.priceMeasurement),
  },
  supportMetrics: buildSupportMetrics(summary),
});
