import type { OriginProvenanceKind, UsageRow } from './types';

export type UsageMetricKey =
  | 'title'
  | 'origin'
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
  | OriginProvenanceKind
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

const apiPriceMeasurementStates = new Set<ApiPriceMeasurementState>(['measured', 'partially measured', 'zero']);

export const parseApiPriceMeasurement = (value: unknown): ApiPriceMeasurement => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('API price measurement must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(record, 'knownCost') ||
    !Object.hasOwn(record, 'state') ||
    !Object.hasOwn(record, 'unpricedFreshTokens')
  ) {
    throw new Error('API price measurement contains unknown or missing fields');
  }
  const { knownCost, state, unpricedFreshTokens } = record;
  if (!(typeof knownCost === 'number' && Number.isFinite(knownCost) && knownCost >= 0)) {
    throw new Error('API price measurement known cost must be non-negative and finite');
  }
  if (
    !(typeof unpricedFreshTokens === 'number' && Number.isSafeInteger(unpricedFreshTokens) && unpricedFreshTokens >= 0)
  ) {
    throw new Error('API price measurement unpriced tokens must be a non-negative safe integer');
  }
  if (!(typeof state === 'string' && apiPriceMeasurementStates.has(state as ApiPriceMeasurementState))) {
    throw new Error('API price measurement state is invalid');
  }
  if ((state === 'zero') !== (knownCost === 0 && state !== 'partially measured')) {
    throw new Error('API price measurement zero state is inconsistent');
  }
  if (state !== 'partially measured' && unpricedFreshTokens !== 0) {
    throw new Error('API price measurement unpriced volume is inconsistent');
  }
  return Object.freeze({ knownCost, state: state as ApiPriceMeasurementState, unpricedFreshTokens });
};

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
}: ApiPriceMeasurementInput): ApiPriceMeasurement =>
  parseApiPriceMeasurement({
    knownCost,
    state: apiPriceMeasurementState(costKnown, knownCost),
    unpricedFreshTokens: costKnown ? 0 : freshTokens,
  });

export const combineApiPriceMeasurements = (measurements: Iterable<ApiPriceMeasurement>): ApiPriceMeasurement => {
  let knownCost = 0;
  let partiallyMeasured = false;
  let unpricedFreshTokens = 0;
  for (const measurement of measurements) {
    const parsed = parseApiPriceMeasurement(measurement);
    knownCost += parsed.knownCost;
    partiallyMeasured ||= parsed.state === 'partially measured';
    unpricedFreshTokens += parsed.unpricedFreshTokens;
  }
  return parseApiPriceMeasurement({
    knownCost,
    state: apiPriceMeasurementState(!partiallyMeasured, knownCost),
    unpricedFreshTokens,
  });
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
  origin?: UsageRow['origin'];
  originProvenance?: OriginProvenanceKind;
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

export const originProvenanceFor = (kind: OriginProvenanceKind): UsageRowProvenance => {
  // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future kind fails compilation.
  switch (kind) {
    case 'origin-unsupported':
      return {
        appliesTo: ['origin'],
        description: 'Origin unsupported — this harness does not record how a session was started.',
        kind,
        label: 'Origin unsupported',
        severity: 'info',
      };
    case 'origin-absent':
      return {
        appliesTo: ['origin'],
        description: 'Origin not declared — this session records no origin, and it has no parent to infer one from.',
        kind,
        label: 'Origin not declared',
        severity: 'info',
      };
    case 'origin-degraded':
      return {
        appliesTo: ['origin'],
        description:
          'Origin unavailable — this row came from a reduced history read, so its origin could not be determined.',
        kind,
        label: 'Origin unavailable',
        severity: 'warning',
      };
  }
};

export const provenanceForUsageRow = (row: UsageProvenanceInput): UsageRowProvenance[] => {
  const provenance: UsageRowProvenance[] = [];

  if (row.origin === undefined && row.originProvenance !== undefined) {
    provenance.push(originProvenanceFor(row.originProvenance));
  }

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
