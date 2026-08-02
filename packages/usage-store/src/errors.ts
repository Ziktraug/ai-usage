import { Data } from 'effect';

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
