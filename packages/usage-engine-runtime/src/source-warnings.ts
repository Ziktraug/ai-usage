import type { SourceWarning } from '@ai-usage/report-core/source-control';
import { sourceControlBounds } from '@ai-usage/report-core/source-control';

const MAX_REPORTED_REJECTED_RECORDS = 1_000_000;
const MAX_WARNING_CODE_CHARACTERS = 64;
// A fixed collection-wide window, independent of the report's selected period.
const RECENT_METRIC_WINDOW_MS = 7 * 86_400_000;
const warningCodeCharacters = /[^a-zA-Z0-9._-]/g;

export interface SanitizableSourceWarning {
  readonly affectedSessions?: number;
  readonly lastObservedAt?: string;
  readonly operation?: string;
  readonly rejectedRecords?: number;
}

const rejectedRecordDescription = (rejectedRecords: number | undefined): string | null =>
  rejectedRecords !== undefined &&
  Number.isSafeInteger(rejectedRecords) &&
  rejectedRecords > 0 &&
  rejectedRecords <= MAX_REPORTED_REJECTED_RECORDS
    ? `${rejectedRecords} local ${rejectedRecords === 1 ? 'record' : 'records'}`
    : null;

const warningCode = (operation: string | undefined): string => {
  const code = (operation ?? 'collector-warning')
    .replace(warningCodeCharacters, '-')
    .slice(0, MAX_WARNING_CODE_CHARACTERS);
  return code || 'collector-warning';
};

// Collector messages, paths, SQL, and causes stay below this boundary. Only a bounded operation code
// and validated aggregate counts/dates may enter the source-control projection.
export const sanitizeSourceWarnings = (
  label: string,
  warnings: readonly SanitizableSourceWarning[],
  now = new Date(),
): readonly SourceWarning[] =>
  warnings.slice(0, sourceControlBounds.maxWarningsPerSource).map((warning) => {
    const rejected = rejectedRecordDescription(warning.rejectedRecords);
    const observedAt = warning.lastObservedAt === undefined ? Number.NaN : Date.parse(warning.lastObservedAt);
    if (
      warning.operation === 'metricValidation' &&
      rejected &&
      warning.affectedSessions !== undefined &&
      warning.rejectedRecords !== undefined &&
      Number.isSafeInteger(warning.affectedSessions) &&
      warning.affectedSessions > 0 &&
      warning.affectedSessions <= warning.rejectedRecords &&
      Number.isFinite(observedAt) &&
      observedAt <= now.getTime()
    ) {
      const historical = observedAt < now.getTime() - RECENT_METRIC_WINDOW_MS;
      return {
        code: historical ? 'historicalMetricValidation' : 'metricValidation',
        message: `${warning.affectedSessions} ${historical ? 'historical ' : ''}${warning.affectedSessions === 1 ? 'session has' : 'sessions have'} uncertain metrics (${rejected}; latest occurrence: ${new Date(observedAt).toISOString().slice(0, 10)}).${historical ? ' No metric anomalies in the last 7 days.' : ''}`,
      };
    }
    return {
      code: warningCode(warning.operation),
      message: rejected
        ? `${label} rejected ${rejected} as incomplete or malformed.`
        : `${label} completed with an incomplete or rejected local record.`,
    };
  });
