import type { PersonId, SpaceId } from '@ai-usage/platform-core/identity';
import type {
  AuthorizationCheck,
  AuthorizationDecision,
  AuthorizationOperation,
  AuthorizationPermission,
  AuthorizationPrincipal,
  AuthorizationResource,
  AuthorizationResourceKind,
  AuthorizationUnavailable,
  AuthorizedResourceListQuery,
  AuthorizedResourcePage,
  AuthorizedResourceScopeQuery,
  AuthorizedResourceScopeResult,
  Authorizer,
} from './index';
import { permissionSupportsResource } from './permission-resource';
import { createAuthorizedResourceScope } from './scope-internal';

const maximumPageSize = 100;

const localPermissions = new Set<AuthorizationPermission>([
  'accept_memory',
  'accept_work_handoff',
  'archive_session_content',
  'create_work_handoff',
  'link_repository',
  'link_session_to_work_thread',
  'manage_device',
  'manage_memory',
  'manage_project',
  'manage_repository_binding',
  'manage_session_archive_policy',
  'manage_work_handoff',
  'manage_work_thread',
  'propose_memory',
  'purge_session_archive',
  'revoke_device',
  'view_device',
  'view_memory',
  'view_project',
  'view_project_usage_aggregate',
  'view_project_usage_detail',
  'view_repository_metadata',
  'view_session_content',
  'view_session_metadata',
  'view_work_handoff',
  'view_work_thread',
]);

const unavailable = (
  operation: AuthorizationOperation,
  rule = 'single-user.adapter-unavailable',
  code: AuthorizationUnavailable['code'] = 'authorization-unavailable',
): AuthorizationUnavailable => ({ code, operation, rule });

interface CursorPayload {
  readonly activeSpaceId: SpaceId;
  readonly offset: number;
  readonly permission: AuthorizationPermission;
  readonly personId: PersonId;
  readonly resourceKind: AuthorizationResourceKind;
  readonly version: 1;
}

const encodeCursor = (payload: CursorPayload): string => btoa(JSON.stringify(payload));

const decodeCursor = (cursor: string | null | undefined): CursorPayload | null => {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(atob(cursor));
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const candidate = value as Partial<CursorPayload>;
    if (
      candidate.version !== 1 ||
      typeof candidate.activeSpaceId !== 'string' ||
      typeof candidate.personId !== 'string' ||
      typeof candidate.permission !== 'string' ||
      typeof candidate.resourceKind !== 'string' ||
      !Number.isSafeInteger(candidate.offset) ||
      (candidate.offset ?? -1) < 0
    ) {
      return null;
    }
    return candidate as CursorPayload;
  } catch {
    return null;
  }
};

const personIdFor = (principal: AuthorizationPrincipal): PersonId | null =>
  principal.kind === 'person' ? principal.personId : null;

export interface SingleUserAuthorizerConfig {
  readonly checkAvailability?: () => Promise<void>;
  readonly listKnownResources?: () => Promise<readonly AuthorizationResource[]>;
  readonly localPersonId: PersonId;
  readonly personalSpaceId: SpaceId;
}

export const createSingleUserAuthorizer = (config: SingleUserAuthorizerConfig): Authorizer => {
  const checkPrincipalAndSpace = (
    principal: AuthorizationPrincipal,
    activeSpaceId: SpaceId,
    resourceSpaceId: SpaceId,
  ): AuthorizationDecision | null => {
    if (activeSpaceId !== resourceSpaceId) {
      return { kind: 'deny', reason: 'single-user.active-space-mismatch' };
    }
    if (principal.kind !== 'person' || principal.personId !== config.localPersonId) {
      return { kind: 'deny', reason: 'single-user.non-local-principal' };
    }
    if (resourceSpaceId !== config.personalSpaceId) {
      return { kind: 'deny', reason: 'single-user.foreign-space' };
    }
    return null;
  };

  const check = async (input: AuthorizationCheck): Promise<AuthorizationDecision> => {
    const scopeDecision = checkPrincipalAndSpace(input.principal, input.context.activeSpaceId, input.resource.spaceId);
    if (scopeDecision) {
      return scopeDecision;
    }
    if (
      !(permissionSupportsResource(input.permission, input.resource.kind) && localPermissions.has(input.permission))
    ) {
      return { kind: 'deny', reason: 'single-user.permission-resource-mismatch' };
    }
    try {
      await config.checkAvailability?.();
    } catch {
      return { error: unavailable('check'), kind: 'error' };
    }
    return { kind: 'allow', reason: 'single-user.personal-space' };
  };

  const loadAuthorizedResources = async (
    input: AuthorizedResourceScopeQuery,
    operation: AuthorizationOperation,
  ): Promise<readonly AuthorizationResource[] | AuthorizationUnavailable> => {
    const syntheticResource: AuthorizationResource = {
      id: input.context.activeSpaceId,
      kind: input.resourceKind,
      spaceId: input.context.activeSpaceId,
    };
    const scopeDecision = checkPrincipalAndSpace(
      input.principal,
      input.context.activeSpaceId,
      syntheticResource.spaceId,
    );
    if (scopeDecision || !localPermissions.has(input.permission)) {
      return [];
    }
    if (!permissionSupportsResource(input.permission, input.resourceKind)) {
      return unavailable(operation, 'single-user.permission-resource-mismatch', 'authorization-unsupported');
    }
    try {
      await config.checkAvailability?.();
      const resources = (await config.listKnownResources?.()) ?? [];
      return resources
        .filter((resource) => resource.spaceId === config.personalSpaceId && resource.kind === input.resourceKind)
        .sort((left, right) => left.id.localeCompare(right.id));
    } catch {
      return unavailable(operation);
    }
  };

  const listResources = async (input: AuthorizedResourceListQuery): Promise<AuthorizedResourcePage> => {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0 || input.pageSize > maximumPageSize) {
      return {
        error: unavailable('list-resources', 'single-user.page-size-invalid', 'authorization-invalid-query'),
        kind: 'error',
      };
    }
    const personId = personIdFor(input.principal);
    const cursor = decodeCursor(input.cursor);
    if (
      personId === null ||
      (input.cursor !== undefined &&
        input.cursor !== null &&
        (!cursor ||
          cursor.personId !== personId ||
          cursor.activeSpaceId !== input.context.activeSpaceId ||
          cursor.permission !== input.permission ||
          cursor.resourceKind !== input.resourceKind))
    ) {
      return {
        error: unavailable('list-resources', 'single-user.cursor-invalid', 'authorization-invalid-query'),
        kind: 'error',
      };
    }
    const resources = await loadAuthorizedResources(input, 'list-resources');
    if ('code' in resources) {
      return { error: resources, kind: 'error' };
    }
    const offset = cursor?.offset ?? 0;
    const items = resources.slice(offset, offset + input.pageSize);
    const nextOffset = offset + items.length;
    return {
      items,
      kind: 'page',
      nextCursor:
        nextOffset < resources.length
          ? encodeCursor({
              activeSpaceId: input.context.activeSpaceId,
              offset: nextOffset,
              permission: input.permission,
              personId,
              resourceKind: input.resourceKind,
              version: 1,
            })
          : null,
    };
  };

  const materializeResourceScope = async (
    input: AuthorizedResourceScopeQuery,
  ): Promise<AuthorizedResourceScopeResult> => {
    const resources = await loadAuthorizedResources(input, 'materialize-resource-scope');
    if ('code' in resources) {
      return { error: resources, kind: 'error' };
    }
    return createAuthorizedResourceScope({
      activeSpaceId: input.context.activeSpaceId,
      permission: input.permission,
      resourceIds: resources.map((resource) => resource.id),
      resourceKind: input.resourceKind,
    });
  };

  return Object.freeze({ check, listResources, materializeResourceScope });
};
