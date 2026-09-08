import type { PersonId, SpaceId } from '@ai-usage/platform-core/identity';

export const AUTHORIZATION_MODEL_VERSION = 'authorization-v1' as const;

export const authorizationPermissions = [
  'accept_memory',
  'accept_work_handoff',
  'archive_session_content',
  'create_work_handoff',
  'link_repository',
  'link_session_to_work_thread',
  'manage_authorization',
  'manage_device',
  'manage_members',
  'manage_memory',
  'manage_organization',
  'manage_project',
  'manage_repository_binding',
  'manage_session_archive_policy',
  'manage_teams',
  'manage_work_handoff',
  'manage_work_thread',
  'propose_memory',
  'purge_session_archive',
  'revoke_device',
  'view_device',
  'view_memory',
  'view_organization',
  'view_organization_usage_aggregate',
  'view_project',
  'view_project_usage_aggregate',
  'view_project_usage_detail',
  'view_repository_metadata',
  'view_session_content',
  'view_session_metadata',
  'view_work_handoff',
  'view_work_thread',
] as const;

export type AuthorizationPermission = (typeof authorizationPermissions)[number];

export type AuthorizationResourceKind =
  | 'device'
  | 'memory'
  | 'project'
  | 'repository'
  | 'session'
  | 'space'
  | 'usage-aggregate'
  | 'work-handoff'
  | 'work-thread';

export type AuthorizationPrincipal =
  | { readonly kind: 'person'; readonly personId: PersonId }
  | { readonly id: string; readonly kind: 'service' };

export interface AuthorizationResource {
  readonly id: string;
  readonly kind: AuthorizationResourceKind;
  readonly spaceId: SpaceId;
}

export interface AuthorizationRequestContext {
  readonly activeSpaceId: SpaceId;
  readonly trustedDevice: boolean;
}

export interface AuthorizationCheck {
  readonly context: AuthorizationRequestContext;
  readonly permission: AuthorizationPermission;
  readonly principal: AuthorizationPrincipal;
  readonly resource: AuthorizationResource;
}

export type AuthorizationOperation = 'check' | 'list-resources' | 'materialize-resource-scope';

export interface AuthorizationUnavailable {
  readonly code: 'authorization-invalid-query' | 'authorization-unavailable' | 'authorization-unsupported';
  readonly operation: AuthorizationOperation;
  readonly rule: string;
}

export type AuthorizationDecision =
  | { readonly kind: 'allow'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly error: AuthorizationUnavailable; readonly kind: 'error' };

export interface AuthorizedResourceListQuery {
  readonly context: AuthorizationRequestContext;
  readonly cursor?: string | null;
  readonly pageSize: number;
  readonly permission: AuthorizationPermission;
  readonly principal: AuthorizationPrincipal;
  readonly resourceKind: AuthorizationResourceKind;
}

export type AuthorizedResourcePage =
  | {
      readonly items: readonly AuthorizationResource[];
      readonly kind: 'page';
      readonly nextCursor: string | null;
    }
  | { readonly error: AuthorizationUnavailable; readonly kind: 'error' };

export interface AuthorizedResourceScopeQuery {
  readonly context: AuthorizationRequestContext;
  readonly permission: AuthorizationPermission;
  readonly principal: AuthorizationPrincipal;
  readonly resourceKind: AuthorizationResourceKind;
}

declare const authorizedResourceScopeBrand: unique symbol;

export interface AuthorizedResourceScope {
  readonly activeSpaceId: SpaceId;
  readonly kind: 'scope';
  readonly modelVersion: typeof AUTHORIZATION_MODEL_VERSION;
  readonly permission: AuthorizationPermission;
  readonly resourceKind: AuthorizationResourceKind;
  readonly scopeId: string;
  readonly [authorizedResourceScopeBrand]: true;
}

export type AuthorizedResourceScopeResult =
  | AuthorizedResourceScope
  | { readonly error: AuthorizationUnavailable; readonly kind: 'error' };

export interface Authorizer {
  readonly check: (input: AuthorizationCheck) => Promise<AuthorizationDecision>;
  readonly listResources: (input: AuthorizedResourceListQuery) => Promise<AuthorizedResourcePage>;
  readonly materializeResourceScope: (input: AuthorizedResourceScopeQuery) => Promise<AuthorizedResourceScopeResult>;
}
