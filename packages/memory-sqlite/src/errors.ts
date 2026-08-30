export type MemoryIdentityStoreErrorCode =
  | 'closed'
  | 'configuration-invalid'
  | 'migration-incompatible'
  | 'storage-failed'
  | 'validation-failed';

export class MemoryIdentityStoreError extends Error {
  readonly code: MemoryIdentityStoreErrorCode;
  readonly operation: string;

  constructor(code: MemoryIdentityStoreErrorCode, operation: string) {
    super('The local Memory identity store operation failed.');
    this.name = 'MemoryIdentityStoreError';
    this.code = code;
    this.operation = operation;
  }
}

export const asMemoryIdentityStoreError = (
  error: unknown,
  code: MemoryIdentityStoreErrorCode,
  operation: string,
): MemoryIdentityStoreError =>
  error instanceof MemoryIdentityStoreError ? error : new MemoryIdentityStoreError(code, operation);
