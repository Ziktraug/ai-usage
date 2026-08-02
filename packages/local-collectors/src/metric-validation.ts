import type { LocalHistoryWarning } from '@ai-usage/local-machine/errors';

export * from '@ai-usage/local-machine/metric-validation';

export const metricValidationWarning = (harness: string, rejectedMetricRecords: number): LocalHistoryWarning | null =>
  rejectedMetricRecords > 0
    ? {
        harness,
        operation: 'metricValidation',
        message: `Rejected ${rejectedMetricRecords} malformed ${harness} metric record(s).`,
      }
    : null;
