import type { BetterAuthOptions } from '@better-auth/core';
import { checksSchema, registerSchemaCheck, schemaCheckFor } from '@better-auth/core/db/internal';

export type AuthenticationAdapterErrorCode = 'schema-check-missing';

/** The Better Auth database adapter could not be composed; nothing was served. */
export class AuthenticationAdapterError extends Error {
  readonly code: AuthenticationAdapterErrorCode;
  readonly operation: 'compose-database-adapter';

  constructor(code: AuthenticationAdapterErrorCode) {
    super('The authentication database adapter registers no schema check while schema validation is enabled.');
    this.name = 'AuthenticationAdapterError';
    this.code = code;
    this.operation = 'compose-database-adapter';
  }
}

/**
 * Better Auth keeps an adapter's schema check in a registry keyed by the
 * adapter object and looks it up on the object the `database` factory returns.
 * A wrapper that returns a new object would hide the check: Better Auth then
 * skips schema validation with a log line (disabled in this package) instead
 * of refusing requests. Every adapter wrapper of this package therefore
 * registers the inner adapter's check on the object it returns, with the same
 * runtime policy, and refuses to wrap an adapter that has no check while
 * validation is enabled: there would be nothing to enforce.
 */
export const carrySchemaCheck = <Wrapped extends object>(
  inner: object,
  wrapped: Wrapped,
  options: BetterAuthOptions,
): Wrapped => {
  const check = schemaCheckFor(inner);
  const enforced = checksSchema(options);
  if (!check) {
    if (enforced) {
      throw new AuthenticationAdapterError('schema-check-missing');
    }
    return wrapped;
  }
  registerSchemaCheck(wrapped, check, { runtimeEnabled: enforced });
  return wrapped;
};
