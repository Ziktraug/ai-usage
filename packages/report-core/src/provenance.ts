import type { UsageRow } from './types';

export type UsageMetricKey =
  | 'title'
  | 'tokens'
  | 'api-value'
  | 'actual-cost'
  | 'subscription-value'
  | 'calls'
  | 'turns'
  | 'tools'
  | 'lines';

export type UsageProvenanceKind =
  | 'title-derived'
  | 'usage-unavailable'
  | 'reconciliation-ambiguous'
  | 'partial-session'
  | 'unknown-api-price'
  | 'unknown-actual-cost'
  | 'unknown-subscription-value';

export interface UsageRowProvenance {
  kind: UsageProvenanceKind;
  appliesTo: UsageMetricKey[];
  severity: 'info' | 'warning';
  label: string;
  description: string;
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

const hasOwn = (row: UsageRow, key: keyof UsageRow) => Object.prototype.hasOwnProperty.call(row, key);

export const provenanceForUsageRow = (row: UsageRow): UsageRowProvenance[] => {
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
    provenance.push({
      kind: 'partial-session',
      appliesTo: COUNTERS_AND_AGGREGATES,
      severity: 'warning',
      label: 'Partial session',
      description: 'This row may be missing part of the session data for counters and aggregate metrics.',
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
    provenance.push({
      kind: 'unknown-api-price',
      appliesTo: ['api-value'],
      severity: 'warning',
      label: 'Unknown API price',
      description: 'No known API price was available for this model.',
    });
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

export const provenanceForMetric = (row: UsageRow, metricKey: UsageMetricKey): UsageRowProvenance[] =>
  provenanceForUsageRow(row).filter((item) => item.appliesTo.includes(metricKey));
