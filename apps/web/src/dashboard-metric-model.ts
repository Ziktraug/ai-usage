import type { DateRangeMode } from './date-range';

export type DashboardMetricKind =
  | 'actual-cost'
  | 'api-value'
  | 'fresh-tokens'
  | 'mean-cost'
  | 'rtk-savings'
  | 'sessions'
  | 'subscription-value'
  | 'tool-calls'
  | 'turns';

export interface MetricDelta {
  hint: string;
  pct: number;
}

export interface Metric {
  delta?: MetricDelta | null;
  hint?: string;
  kind: DashboardMetricKind;
  label: string;
  value: string;
}

export type MetricComparisonState = 'available' | 'full-range' | 'no-prior-data';

const metricComparisonMessages: Record<Exclude<MetricComparisonState, 'available'>, string> = {
  'full-range': 'No previous period exists before the full recorded range.',
  'no-prior-data': 'No sessions exist in the previous period.',
};

export const metricComparisonStateFor = (
  rangeMode: DateRangeMode,
  previousSummary: object | null | undefined,
): MetricComparisonState => {
  if (previousSummary) {
    return 'available';
  }
  return rangeMode === 'all' ? 'full-range' : 'no-prior-data';
};

export const metricComparisonMessage = (state: MetricComparisonState): string | null =>
  state === 'available' ? null : metricComparisonMessages[state];

type ValueBasisMetricKind = 'actual-cost' | 'api-value' | 'subscription-value';

const VALUE_BASIS_ORDER = [
  'api-value',
  'actual-cost',
  'subscription-value',
] as const satisfies readonly ValueBasisMetricKind[];
const VALUE_BASIS_LABELS = {
  'actual-cost': 'Actual recorded cost',
  'api-value': 'Estimated API-equivalent value',
  'subscription-value': 'Subscription value',
} as const satisfies Record<ValueBasisMetricKind, string>;

const isValueBasisMetricKind = (kind: DashboardMetricKind): kind is ValueBasisMetricKind =>
  kind === 'actual-cost' || kind === 'api-value' || kind === 'subscription-value';

export const splitDashboardMetrics = (
  metrics: readonly Metric[],
): { remainingMetrics: Metric[]; valueBases: Metric[] } => {
  const valueBasesByKind = new Map<ValueBasisMetricKind, Metric>();
  const remainingMetrics: Metric[] = [];
  for (const metric of metrics) {
    if (isValueBasisMetricKind(metric.kind)) {
      valueBasesByKind.set(metric.kind, metric);
    } else {
      remainingMetrics.push(metric);
    }
  }
  return {
    remainingMetrics,
    valueBases: VALUE_BASIS_ORDER.flatMap((kind) => {
      const metric = valueBasesByKind.get(kind);
      return metric ? [metric] : [];
    }),
  };
};

export const valueBasisLabelFor = (metric: Metric): string =>
  isValueBasisMetricKind(metric.kind) ? VALUE_BASIS_LABELS[metric.kind] : metric.label;
