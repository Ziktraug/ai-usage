import { Data } from 'effect';
import { ServedRevisionQueryValidationError, ServedRevisionSchemaValidationError } from './served-revision';

export const usageStoreErrorReasons = [
  'busy',
  'corrupt',
  'invalid-input',
  'machine-unavailable',
  'migration-failure',
  'preview-stale',
  'preview-unavailable',
  'revision-expired',
  'revision-unavailable',
  'schema-too-new',
  'schema-too-old',
  'self-import',
  'storage-failure',
  'store-missing',
] as const;

export type UsageStoreErrorReason = (typeof usageStoreErrorReasons)[number];

const usageStoreErrorReasonSet = new Set<string>(usageStoreErrorReasons);

export const isUsageStoreErrorReason = (value: unknown): value is UsageStoreErrorReason =>
  typeof value === 'string' && usageStoreErrorReasonSet.has(value);

export const usageStoreErrorReasonFrom = (error: unknown): UsageStoreErrorReason | undefined => {
  if (!(typeof error === 'object' && error !== null && 'reason' in error)) {
    return;
  }
  return isUsageStoreErrorReason(error.reason) ? error.reason : undefined;
};

export class UsageStoreError extends Data.TaggedError('UsageStoreError')<{
  readonly operation: string;
  readonly message: string;
  readonly reason: UsageStoreErrorReason;
  readonly cause?: unknown;
}> {}

export const usageStoreError = (operation: string, dbPath: string, cause: unknown, reason: UsageStoreErrorReason) =>
  new UsageStoreError({
    operation,
    message: `${operation} ${dbPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    reason,
    cause,
  });

const sqliteErrorText = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name} ${cause.message}`.toLowerCase() : String(cause).toLowerCase();

const readFailureReason = (cause: unknown): UsageStoreErrorReason => {
  if (cause instanceof ServedRevisionSchemaValidationError) {
    return 'corrupt';
  }
  if (cause instanceof ServedRevisionQueryValidationError) {
    return 'invalid-input';
  }
  const sqliteCode =
    cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code.toUpperCase() : '';
  if (sqliteCode.startsWith('SQLITE_BUSY') || sqliteCode.startsWith('SQLITE_LOCKED')) {
    return 'busy';
  }
  if (sqliteCode.startsWith('SQLITE_CORRUPT') || sqliteCode.startsWith('SQLITE_NOTADB')) {
    return 'corrupt';
  }
  const errorText = sqliteErrorText(cause);
  if (errorText.includes('busy') || errorText.includes('locked')) {
    return 'busy';
  }
  if (
    errorText.includes('corrupt') ||
    errorText.includes('malformed') ||
    errorText.includes('not a database') ||
    errorText.includes('file is encrypted')
  ) {
    return 'corrupt';
  }
  if (errorText.includes('unsafe') || errorText.includes('not owner-only')) {
    return 'corrupt';
  }
  return 'storage-failure';
};

export const usageStoreReadError = (operation: string, dbPath: string, cause: unknown): UsageStoreError =>
  cause instanceof UsageStoreError ? cause : usageStoreError(operation, dbPath, cause, readFailureReason(cause));

export const usageStorePreviewReadError = (operation: string, dbPath: string, cause: unknown): UsageStoreError => {
  const reason = cause instanceof UsageStoreError ? cause.reason : readFailureReason(cause);
  if (reason === 'corrupt' || reason === 'schema-too-new' || reason === 'schema-too-old') {
    return usageStoreError(operation, dbPath, cause, 'preview-unavailable');
  }
  return cause instanceof UsageStoreError ? cause : usageStoreError(operation, dbPath, cause, reason);
};

export const usageStorePreviewStateError = (operation: string, dbPath: string, cause: unknown): UsageStoreError => {
  const reason = cause instanceof UsageStoreError ? cause.reason : readFailureReason(cause);
  if (reason === 'busy') {
    return cause instanceof UsageStoreError ? cause : usageStoreError(operation, dbPath, cause, reason);
  }
  return usageStoreError(operation, dbPath, cause, 'preview-unavailable');
};

export const usageStoreServedReadError = (operation: string, dbPath: string, cause: unknown): UsageStoreError => {
  if (cause instanceof UsageStoreError) {
    return cause;
  }
  const reason = readFailureReason(cause);
  return usageStoreError(operation, dbPath, cause, reason === 'storage-failure' ? 'corrupt' : reason);
};

export const previewStaleError = (cause?: unknown): UsageStoreError =>
  new UsageStoreError({
    operation: 'confirmPeerMergeBundle',
    message: 'The usage-store state changed after preview; create a new preview before confirming.',
    reason: 'preview-stale',
    ...(cause === undefined ? {} : { cause }),
  });
