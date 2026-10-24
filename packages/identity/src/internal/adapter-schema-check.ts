import type { BetterAuthOptions } from '@better-auth/core';
import { checksSchema, registerSchemaCheck, schemaCheckFor } from '@better-auth/core/db/internal';

/**
 * Better Auth keeps an adapter's schema check in a registry keyed by the
 * adapter object and looks it up on the object the `database` factory returns.
 * A wrapper that returns a new object would hide the check: Better Auth then
 * skips schema validation with a debug log instead of refusing requests. Every
 * adapter wrapper of this package therefore registers the inner adapter's
 * check on the object it returns, with the same runtime policy.
 */
export const carrySchemaCheck = <Wrapped extends object>(
  inner: object,
  wrapped: Wrapped,
  options: BetterAuthOptions,
): Wrapped => {
  const check = schemaCheckFor(inner);
  if (check) {
    registerSchemaCheck(wrapped, check, { runtimeEnabled: checksSchema(options) });
  }
  return wrapped;
};
