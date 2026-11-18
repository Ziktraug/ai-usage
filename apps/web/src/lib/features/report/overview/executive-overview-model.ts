import type {
  FocusedExecutiveGroup,
  FocusedExecutiveOverview,
  FocusedReportSummary,
} from '@ai-usage/report-core/focused-report-query';
import type { ApiPriceMeasurement } from '@ai-usage/report-core/provenance';
import {
  comparePeriodMetric,
  type MetricPeriodComparison,
  type PeriodRecordedHistory,
  processedTokensReading,
  resolvePeriodBaseline,
  totalApiValueReading,
} from '../../../../dashboard-model';
import type { DateBounds, DateRangeMode } from '../../../../date-range';
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
import {
  type ApiValuePresentation,
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
} from '../../../foundation/presentation/report-value';
import {
  type PeriodComparisonMetricCopy,
  type PeriodComparisonPresentation,
  presentPeriodComparison,
} from './period-comparison-presentation';

export const EXECUTIVE_INSIGHT_MINIMUM_CHANGE_PERCENT = 20;
export const EXECUTIVE_INSIGHT_MINIMUM_CONCENTRATION_PERCENT = 40;

export interface ExecutiveInsightItem {
  readonly costApprox: number;
  readonly costKnown: boolean;
  readonly kind: 'campaign' | 'session';
}

/** The selected period as both summaries were queried, with the history that decides what was recorded. */
export interface ExecutiveComparisonPeriod {
  readonly bounds: DateBounds;
  readonly generatedAt: Date;
  /** The deciding history (`periodRecordedHistory`); null when nothing is recorded. */
  readonly recordedHistory: PeriodRecordedHistory | null;
}

export interface ExecutiveOverviewModelInput {
  readonly comparisonPeriod: ExecutiveComparisonPeriod;
  readonly executive: FocusedExecutiveOverview;
  readonly periodInProgress: boolean;
  readonly previousSummary: FocusedReportSummary | null;
  readonly rangeMode: DateRangeMode;
  readonly summary: FocusedReportSummary;
  readonly topItems: readonly ExecutiveInsightItem[];
  readonly totalSessionCount: number;
}

export interface ExecutivePrimaryPresentation {
  readonly comparison: PeriodComparisonPresentation;
  readonly periodScope: string;
  readonly provenance: ReturnType<typeof aggregateApiPriceProvenance>;
  readonly value: ApiValuePresentation;
}

export type ExecutiveSupportMetricKey = 'cache-volume' | 'output-tokens' | 'pricing-coverage' | 'processed-tokens';

export interface ExecutiveSupportMetric {
  /**
   * Set only where a change against the previous period informs a decision. Processed tokens are
   * the volume of work independent of pricing; cache and output volumes are parts of that total and
   * pricing coverage describes the data, so none of them repeats the comparison.
   */
  readonly comparison?: PeriodComparisonPresentation;
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

const API_VALUE_COMPARISON_COPY: PeriodComparisonMetricCopy = {
  format: fmtMoney,
  noun: 'API-equivalent value',
  partly: 'priced',
};
const PROCESSED_TOKENS_COMPARISON_COPY: PeriodComparisonMetricCopy = {
  format: fmtCompact,
  noun: 'processed tokens',
  partly: 'counted',
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

const buildSupportMetrics = (
  summary: FocusedReportSummary,
  processedTokensComparison: MetricPeriodComparison,
): readonly ExecutiveSupportMetric[] => {
  const processedTokens = processedTokensReading(summary).value;
  const cacheVolume = summary.cacheRead + summary.cacheWrite;
  const pricingPercentage = summary.sessionCount > 0 ? (summary.pricedSessions / summary.sessionCount) * 100 : 0;
  return [
    {
      comparison: presentPeriodComparison(processedTokensComparison, PROCESSED_TOKENS_COMPARISON_COPY),
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
  { outcome: apiValueComparison, relation }: PeriodComparisonPresentation,
  topItems: readonly ExecutiveInsightItem[],
): ExecutivePeriodInsight | null => {
  // The insight restates the headline percentage, so it exists only where the headline has one.
  if (apiValueComparison.kind !== 'change' || relation === null || apiValueComparison.current <= 0) {
    return null;
  }
  const pricedItems = topItems.filter(({ costKnown }) => costKnown);
  const first = pricedItems[0];
  const second = pricedItems[1];
  if (!(first && second)) {
    return null;
  }
  const changePercent = apiValueComparison.percent;
  const concentrationPercent = ((first.costApprox + second.costApprox) / apiValueComparison.current) * 100;
  if (
    Math.abs(changePercent) < EXECUTIVE_INSIGHT_MINIMUM_CHANGE_PERCENT ||
    concentrationPercent < EXECUTIVE_INSIGHT_MINIMUM_CONCENTRATION_PERCENT
  ) {
    return null;
  }
  const items = [first, second] as const;
  const sentences = [
    `API-equivalent value is ${relation}${apiValueComparison.provisional ? ' (this period is still in progress)' : ''}.`,
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
  comparisonPeriod,
  executive,
  periodInProgress,
  previousSummary,
  rangeMode,
  summary,
  topItems,
  totalSessionCount,
}: ExecutiveOverviewModelInput): ExecutiveOverviewModel => {
  // One baseline for every metric: the Overview result's previous summary is the same aggregation
  // over the previous window under the same filters.
  const baseline = resolvePeriodBaseline({ ...comparisonPeriod, previousSummary });
  const apiValueComparison = presentPeriodComparison(
    comparePeriodMetric(baseline, summary, totalApiValueReading, periodInProgress),
    API_VALUE_COMPARISON_COPY,
  );
  return {
    emptyState: emptyStateFor(summary, totalSessionCount),
    harnesses: executive.harnesses.map((group) => groupPresentation(group, summary.totalCost)),
    insight: periodInsight(apiValueComparison, topItems),
    models: executive.models.map((group) => groupPresentation(group, summary.totalCost)),
    primary: {
      comparison: apiValueComparison,
      periodScope: periodScopeFor(rangeMode),
      provenance: aggregateApiPriceProvenance(summary.priceMeasurement),
      value: aggregateApiValuePresentation(summary.priceMeasurement),
    },
    supportMetrics: buildSupportMetrics(
      summary,
      comparePeriodMetric(baseline, summary, processedTokensReading, periodInProgress),
    ),
  };
};
