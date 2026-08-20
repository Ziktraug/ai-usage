import type { SourceWarning } from '@ai-usage/report-core/source-control';
import { sourceControlBounds } from '@ai-usage/report-core/source-control';

const MAX_REPORTED_REJECTED_RECORDS = 1_000_000;
const MAX_WARNING_CODE_CHARACTERS = 64;
const warningCodeCharacters = /[^a-zA-Z0-9._-]/g;

export interface SanitizableSourceWarning {
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
// and a validated aggregate count may enter the source-control projection.
export const sanitizeSourceWarnings = (
  label: string,
  warnings: readonly SanitizableSourceWarning[],
): readonly SourceWarning[] =>
  warnings.slice(0, sourceControlBounds.maxWarningsPerSource).map((warning) => {
    const rejected = rejectedRecordDescription(warning.rejectedRecords);
    return {
      code: warningCode(warning.operation),
      message: rejected
        ? `${label} rejected ${rejected} as incomplete or malformed.`
        : `${label} completed with an incomplete or rejected local record.`,
    };
  });
