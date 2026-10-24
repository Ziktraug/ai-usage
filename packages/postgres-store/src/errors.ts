import { DatabaseError } from 'pg';

export const platformStoreErrorCodes = [
  'configuration-invalid',
  'connection-failed',
  'migration-failed',
  'migration-incompatible',
  'migration-registry-invalid',
  'migration-required',
  'readiness-failed',
  'shutdown-failed',
  'store-closed',
  'validation-failed',
] as const;

export type PlatformStoreErrorCode = (typeof platformStoreErrorCodes)[number];

const publicMessages: Readonly<Record<PlatformStoreErrorCode, string>> = {
  'configuration-invalid': 'The PostgreSQL store configuration is invalid.',
  'connection-failed': 'The PostgreSQL store connection failed.',
  'migration-failed': 'The PostgreSQL schema migration failed.',
  'migration-incompatible': 'The PostgreSQL schema is incompatible with this application version.',
  'migration-registry-invalid': 'The compiled PostgreSQL migration registry is invalid.',
  'migration-required': 'The PostgreSQL schema requires a migration.',
  'readiness-failed': 'The PostgreSQL store readiness check failed.',
  'shutdown-failed': 'The PostgreSQL store did not close cleanly.',
  'store-closed': 'The PostgreSQL store is closed.',
  'validation-failed': 'Stored PostgreSQL data did not satisfy its domain contract.',
};

export class PlatformStoreError extends Error {
  readonly code: PlatformStoreErrorCode;
  readonly operation: string;

  constructor(code: PlatformStoreErrorCode, operation: string, options?: ErrorOptions) {
    super(publicMessages[code], options);
    this.name = 'PlatformStoreError';
    this.code = code;
    this.operation = operation;
  }
}

export const isPlatformStoreError = (error: unknown): error is PlatformStoreError =>
  error instanceof PlatformStoreError;

/**
 * What a store failure may tell an operator: its closed code, the operation
 * that failed and, when PostgreSQL refused that operation, the SQLSTATE of the
 * refusal (`IA003` for the provider-key migration, for example). Never the
 * database message or detail, which can quote row values, nor any connection
 * setting.
 */
export interface PlatformStoreFailureDiagnostic {
  readonly code: PlatformStoreErrorCode;
  readonly operation: string;
  readonly sqlState?: string;
}

const sqlStatePattern = /^[0-9A-Z]{5}$/u;

export const platformStoreFailureDiagnostic = (error: PlatformStoreError): PlatformStoreFailureDiagnostic => {
  const { cause } = error;
  return cause instanceof DatabaseError && cause.code !== undefined && sqlStatePattern.test(cause.code)
    ? { code: error.code, operation: error.operation, sqlState: cause.code }
    : { code: error.code, operation: error.operation };
};

export const asPlatformStoreError = (
  error: unknown,
  code: PlatformStoreErrorCode,
  operation: string,
): PlatformStoreError => (isPlatformStoreError(error) ? error : new PlatformStoreError(code, operation));
