import type { SpaceId } from '@ai-usage/platform-core/identity';
import {
  AUTHORIZATION_MODEL_VERSION,
  type AuthorizationPermission,
  type AuthorizationResourceKind,
  type AuthorizedResourceScope,
} from './index';

const resourceIdsByScope = new WeakMap<AuthorizedResourceScope, readonly string[]>();
const adapterBindingByScope = new WeakMap<AuthorizedResourceScope, unknown>();

export interface CreateAuthorizedResourceScopeInput {
  readonly activeSpaceId: SpaceId;
  readonly adapterBinding?: unknown;
  readonly permission: AuthorizationPermission;
  readonly resourceIds: readonly string[];
  readonly resourceKind: AuthorizationResourceKind;
}

export const createAuthorizedResourceScope = (input: CreateAuthorizedResourceScopeInput): AuthorizedResourceScope => {
  const scope = Object.freeze({
    activeSpaceId: input.activeSpaceId,
    kind: 'scope' as const,
    modelVersion: AUTHORIZATION_MODEL_VERSION,
    permission: input.permission,
    resourceKind: input.resourceKind,
    scopeId: crypto.randomUUID(),
  }) as AuthorizedResourceScope;
  resourceIdsByScope.set(scope, Object.freeze([...new Set(input.resourceIds)].sort()));
  if (input.adapterBinding !== undefined) {
    adapterBindingByScope.set(scope, input.adapterBinding);
  }
  return scope;
};

export const readAuthorizedResourceScopeIds = (scope: AuthorizedResourceScope): readonly string[] => {
  const resourceIds = resourceIdsByScope.get(scope);
  if (!resourceIds) {
    throw new Error('The authorization scope is unavailable or belongs to another runtime.');
  }
  return resourceIds;
};

export const readAuthorizedResourceScopeAdapterBinding = (scope: AuthorizedResourceScope): unknown => {
  if (!resourceIdsByScope.has(scope)) {
    throw new Error('The authorization scope is unavailable or belongs to another runtime.');
  }
  return adapterBindingByScope.get(scope);
};
