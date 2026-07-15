import type { LocalHistoryWarning } from './errors';

export type MetricValidation<Value> = { ok: true; value: Value } | { ok: false };

const invalidMetric: MetricValidation<never> = { ok: false };

export const parseNonNegativeSafeInteger = (value: unknown): MetricValidation<number> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { ok: true, value } : invalidMetric;

export const parseNonNegativeFiniteNumber = (value: unknown): MetricValidation<number> =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { ok: true, value } : invalidMetric;

export const parseOptionalNonNegativeSafeInteger = (value: unknown): MetricValidation<number> =>
  value === undefined || value === null ? { ok: true, value: 0 } : parseNonNegativeSafeInteger(value);

export const parseOptionalNonNegativeFiniteNumber = (value: unknown): MetricValidation<number> =>
  value === undefined || value === null ? { ok: true, value: 0 } : parseNonNegativeFiniteNumber(value);

export const addNonNegativeSafeIntegers = (left: number, right: number): MetricValidation<number> => {
  const validLeft = parseNonNegativeSafeInteger(left);
  const validRight = parseNonNegativeSafeInteger(right);
  if (!(validLeft.ok && validRight.ok)) {
    return invalidMetric;
  }
  const value = left + right;
  return Number.isSafeInteger(value) ? { ok: true, value } : invalidMetric;
};

export const addNonNegativeFiniteNumbers = (left: number, right: number): MetricValidation<number> => {
  const validLeft = parseNonNegativeFiniteNumber(left);
  const validRight = parseNonNegativeFiniteNumber(right);
  if (!(validLeft.ok && validRight.ok)) {
    return invalidMetric;
  }
  const value = left + right;
  return Number.isFinite(value) ? { ok: true, value } : invalidMetric;
};

export const parseNonEmptyString = (value: unknown): MetricValidation<string> =>
  typeof value === 'string' && value.trim().length > 0 ? { ok: true, value } : invalidMetric;

export const parseFiniteTimestamp = (value: unknown): MetricValidation<Date> => {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) {
    return invalidMetric;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { ok: true, value: date } : invalidMetric;
};

export const metricValidationWarning = (harness: string, rejectedMetricRecords: number): LocalHistoryWarning | null =>
  rejectedMetricRecords > 0
    ? {
        harness,
        operation: 'metricValidation',
        message: `Rejected ${rejectedMetricRecords} malformed ${harness} metric record(s).`,
      }
    : null;
