import {
  formatLocalHistoryError,
  type LocalHistoryError,
  type LocalHistoryWarning,
} from '@ai-usage/local-machine/errors';

export * from '@ai-usage/local-machine/metric-validation';

export const metricValidationWarning = (
  harness: string,
  rejectedMetricRecords: number,
  context: Pick<LocalHistoryWarning, 'affectedSessions' | 'lastObservedAt'> = {},
): LocalHistoryWarning | null =>
  rejectedMetricRecords > 0
    ? {
        harness,
        operation: 'metricValidation',
        message: `Rejected ${rejectedMetricRecords} malformed ${harness} metric record(s).`,
        rejectedRecords: rejectedMetricRecords,
        ...context,
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
 * A record the reader dropped for exceeding its per-line byte bound — most
 * often a pasted image inlined as base64. It gets its own operation because the
 * record was never seen by the parser: nothing about it was malformed, so
 * folding it into `metricValidation` would report a working harness as
 * corrupted. The session around it is still collected, which is exactly why the
 * loss has to be stated rather than inferred from a missing turn.
 */
export const oversizedHistoryLineWarning = (harness: string, oversizedLines: number): LocalHistoryWarning | null =>
  oversizedLines > 0
    ? {
        harness,
        operation: 'oversizedHistoryLine',
        message: `Dropped ${oversizedLines} oversized ${harness} history record(s); the affected sessions are lower bounds.`,
        rejectedRecords: oversizedLines,
      }
    : null;

/**
 * History files the reader could not open or decompress, so the sessions they
 * hold are missing from this pass. One warning carries the count because the
 * engine's sanitizer keeps only the operation code and `rejectedRecords`: one
 * warning per file would collapse into identical codes cut at its cap. The
 * first failure names its path for local diagnosis.
 */
export const unreadableHistoryFileWarning = (
  harness: string,
  failures: readonly LocalHistoryError[],
): LocalHistoryWarning | null => {
  const first = failures[0];
  if (!first) {
    return null;
  }
  return {
    harness,
    operation: 'unreadableHistoryFile',
    message: `Skipped ${failures.length} ${harness} history file(s) that could not be read; their sessions are missing from this pass. First: ${formatLocalHistoryError(first)}`,
    rejectedRecords: failures.length,
    ...(first.path ? { path: first.path } : {}),
  };
};

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
