import type { LocalHistoryWarning } from '@ai-usage/local-machine/errors';

export * from '@ai-usage/local-machine/metric-validation';

export const metricValidationWarning = (harness: string, rejectedMetricRecords: number): LocalHistoryWarning | null =>
  rejectedMetricRecords > 0
    ? {
        harness,
        operation: 'metricValidation',
        message: `Rejected ${rejectedMetricRecords} malformed ${harness} metric record(s).`,
        rejectedRecords: rejectedMetricRecords,
      }
    : null;

/**
 * Skill observations are not usage metrics, so their rejects get their own
 * operation. Folding them into `metricValidation` would report a changed skill
 * transcript shape as corrupted token counts, sending anyone reading the
 * warning to the wrong code.
 */
export const skillObservationValidationWarning = (
  harness: string,
  rejectedObservations: number,
): LocalHistoryWarning | null =>
  rejectedObservations > 0
    ? {
        harness,
        operation: 'skillObservationValidation',
        message: `Rejected ${rejectedObservations} malformed ${harness} skill observation record(s).`,
        rejectedRecords: rejectedObservations,
      }
    : null;

/**
 * A bounded read that hit its bound. The standing rule is that partial data is
 * presented faithfully, so a truncated observation set has to say so rather
 * than silently reporting a smaller count as if it were complete.
 */
export const skillObservationTruncationWarning = (harness: string, limit: number): LocalHistoryWarning => ({
  harness,
  operation: 'skillObservationTruncated',
  message: `Read only the first ${limit} ${harness} skill observation record(s); the count is a lower bound.`,
});
