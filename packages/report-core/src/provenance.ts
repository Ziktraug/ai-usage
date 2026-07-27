import type { UsageRow } from './types';

export type UsageMetricKey =
  | 'title'
  | 'tokens'
  | 'api-value'
  | 'actual-cost'
  | 'subscription-value'
  | 'duration'
  | 'calls'
  | 'turns'
  | 'tools'
  | 'lines';

export type UsageProvenanceKind =
  | 'title-derived'
  | 'usage-unavailable'
  | 'reconciliation-ambiguous'
  | 'partial-session'
  | 'partial-api-price'
  | 'unknown-api-price'
  | 'unknown-actual-cost'
  | 'unknown-subscription-value';

export type ApiPriceMeasurementState = 'measured' | 'partially measured' | 'zero';

/**
 * A priced aggregate always carries the known subtotal and the amount of fresh
 * work that could not be priced. The state prevents an incomplete $0 subtotal
 * from being presented as genuinely zero work.
 */
export interface ApiPriceMeasurement {
  knownCost: number;
  state: ApiPriceMeasurementState;
  unpricedFreshTokens: number;
}

export interface ApiPriceMeasurementInput {
  costKnown: boolean;
  freshTokens: number;
  knownCost: number;
}

const apiPriceMeasurementState = (costKnown: boolean, knownCost: number): ApiPriceMeasurementState => {
  if (!costKnown) {
    return 'partially measured';
  }
  return knownCost === 0 ? 'zero' : 'measured';
};

export const apiPriceMeasurement = ({
  costKnown,
  freshTokens,
  knownCost,
}: ApiPriceMeasurementInput): ApiPriceMeasurement => ({
  knownCost,
  state: apiPriceMeasurementState(costKnown, knownCost),
  unpricedFreshTokens: costKnown ? 0 : freshTokens,
});

export const combineApiPriceMeasurements = (measurements: Iterable<ApiPriceMeasurement>): ApiPriceMeasurement => {
  let knownCost = 0;
  let partiallyMeasured = false;
  let unpricedFreshTokens = 0;
  for (const measurement of measurements) {
    knownCost += measurement.knownCost;
    partiallyMeasured ||= measurement.state === 'partially measured';
    unpricedFreshTokens += measurement.unpricedFreshTokens;
  }
  return {
    knownCost,
    state: apiPriceMeasurementState(!partiallyMeasured, knownCost),
    unpricedFreshTokens,
  };
};

export const PARTIALLY_MEASURED_LABEL = 'Partially measured';

export const partiallyMeasuredApiPriceDescription = (formattedTokenCount: string): string =>
  `${PARTIALLY_MEASURED_LABEL} — ${formattedTokenCount} tokens in this slice come from models with no published price. Their work is counted, their value is not.`;

export interface UsageRowProvenance {
  appliesTo: UsageMetricKey[];
  description: string;
  kind: UsageProvenanceKind;
  label: string;
  severity: 'info' | 'warning';
}

export interface UsageProvenanceInput {
  ambiguous?: boolean;
  costActual: number | null;
  costApprox: number;
  costKnown: boolean;
  costQuota?: number | null;
  harness?: string;
  partial?: boolean;
  titleSource?: UsageRow['titleSource'];
  usageUnavailable?: boolean;
}

const COUNTERS_AND_AGGREGATES: UsageMetricKey[] = [
  'tokens',
  'api-value',
  'actual-cost',
  'subscription-value',
  'calls',
  'turns',
  'tools',
  'lines',
];

const USAGE_UNAVAILABLE_METRICS: UsageMetricKey[] = [
  'tokens',
  'api-value',
  'actual-cost',
  'subscription-value',
  'calls',
  'tools',
];

const hasOwn = (row: UsageProvenanceInput, key: keyof UsageProvenanceInput) => Object.hasOwn(row, key);

export const provenanceForUsageRow = (row: UsageProvenanceInput): UsageRowProvenance[] => {
  const provenance: UsageRowProvenance[] = [];

  if (row.titleSource !== 'ai') {
    provenance.push({
      kind: 'title-derived',
      appliesTo: ['title'],
      severity: 'info',
      label: 'Derived title',
      description: 'This title was derived from available session metadata rather than an explicit AI title.',
    });
  }

  if (row.usageUnavailable) {
    provenance.push({
      kind: 'usage-unavailable',
      appliesTo: USAGE_UNAVAILABLE_METRICS,
      severity: 'warning',
      label: 'Usage unavailable',
      description: 'This harness did not expose usage details for these metrics.',
    });
  }

  if (row.partial) {
    const appliesTo: UsageMetricKey[] = row.harness === 'OpenCode' ? ['duration'] : COUNTERS_AND_AGGREGATES;
    provenance.push({
      kind: 'partial-session',
      appliesTo,
      severity: 'warning',
      label: 'Partial session',
      description:
        row.harness === 'OpenCode'
          ? 'Recorded time may be missing an open or unusable assistant interval.'
          : 'This row may be missing part of the session data for counters and aggregate metrics.',
    });
  }

  if (row.ambiguous) {
    provenance.push({
      kind: 'reconciliation-ambiguous',
      appliesTo: COUNTERS_AND_AGGREGATES,
      severity: 'warning',
      label: 'Ambiguous reconciliation',
      description: 'This row was reconciled from ambiguous source data; counters and aggregates are best effort.',
    });
  }

  if (!row.costKnown) {
    if (row.costApprox > 0) {
      provenance.push({
        kind: 'partial-api-price',
        appliesTo: ['api-value'],
        severity: 'warning',
        label: 'Partial API value',
        description: 'This is a known subtotal; one or more model prices are unavailable.',
      });
    } else {
      provenance.push({
        kind: 'unknown-api-price',
        appliesTo: ['api-value'],
        severity: 'warning',
        label: 'Unknown API price',
        description: 'No known API price was available for this model.',
      });
    }
  }

  if (row.costActual == null) {
    provenance.push({
      kind: 'unknown-actual-cost',
      appliesTo: ['actual-cost'],
      severity: 'warning',
      label: 'Unknown actual cost',
      description: 'No actual charged cost was available for this session.',
    });
  }

  if (hasOwn(row, 'costQuota') && row.costQuota == null) {
    provenance.push({
      kind: 'unknown-subscription-value',
      appliesTo: ['subscription-value'],
      severity: 'warning',
      label: 'Unknown subscription value',
      description: 'This row declares subscription value, but the value is unavailable.',
    });
  }

  return provenance;
};

export const provenanceForMetric = (row: UsageProvenanceInput, metricKey: UsageMetricKey): UsageRowProvenance[] =>
  provenanceForUsageRow(row).filter((item) => item.appliesTo.includes(metricKey));
