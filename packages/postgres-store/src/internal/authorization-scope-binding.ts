import type { PersonId } from '@ai-usage/platform-core/identity';

const bindingKind = 'postgres-authorization-scope-v1' as const;

export interface PostgreSqlAuthorizationScopeBinding {
  readonly kind: typeof bindingKind;
  readonly personId: PersonId | null;
  readonly trustedDevice: boolean;
}

export const createPostgreSqlAuthorizationScopeBinding = (
  personId: PersonId | null,
  trustedDevice: boolean,
): PostgreSqlAuthorizationScopeBinding => Object.freeze({ kind: bindingKind, personId, trustedDevice });

export const isPostgreSqlAuthorizationScopeBinding = (value: unknown): value is PostgreSqlAuthorizationScopeBinding => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<PostgreSqlAuthorizationScopeBinding>;
  return (
    candidate.kind === bindingKind &&
    (candidate.personId === null || typeof candidate.personId === 'string') &&
    typeof candidate.trustedDevice === 'boolean'
  );
};
