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
} from '@ai-usage/authorization';
import { permissionSupportsResource } from '@ai-usage/authorization/permission-resource';
import { createAuthorizedResourceScope } from '@ai-usage/authorization/scope-internal';
import type { PersonId, SpaceId } from '@ai-usage/platform-core/identity';
import {
  parseInstant,
  parsePersonId,
  parseProjectId,
  parseSpaceId,
  parseTeamId,
} from '@ai-usage/platform-core/identity';
import type { Pool, QueryResultRow } from 'pg';
import type {
  CreateOrganizationWithAdminInput,
  GrantProjectAccessInput,
  PlatformAuthorizationStore,
  RevokeProjectAccessInput,
} from '../authorization';
import { PlatformStoreError } from '../errors';
import { authorizationScopeSql } from './authorization-query';
import { createPostgreSqlAuthorizationScopeBinding } from './authorization-scope-binding';
import { withPlatformSpaceTransaction } from './space-transaction';

const maximumPageSize = 100;
const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface IdRow extends QueryResultRow {
  readonly id: unknown;
}

interface CursorPayload {
  readonly activeSpaceId: SpaceId;
  readonly afterId: string | null;
  readonly permission: AuthorizationPermission;
  readonly personId: PersonId;
  readonly resourceKind: AuthorizationResourceKind;
  readonly version: 1;
}

const unavailable = (
  operation: AuthorizationOperation,
  rule: string,
  code: AuthorizationUnavailable['code'] = 'authorization-unavailable',
): AuthorizationUnavailable => ({ code, operation, rule });

const principalPersonId = (principal: AuthorizationPrincipal): PersonId | null =>
  principal.kind === 'person' ? principal.personId : null;

const encodeCursor = (payload: CursorPayload): string => btoa(JSON.stringify(payload));

const decodeCursor = (cursor: string | null | undefined): CursorPayload | null => {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = parsed as Partial<CursorPayload>;
    if (
      value.version !== 1 ||
      typeof value.activeSpaceId !== 'string' ||
      (value.afterId !== null && typeof value.afterId !== 'string') ||
      typeof value.permission !== 'string' ||
      typeof value.personId !== 'string' ||
      typeof value.resourceKind !== 'string'
    ) {
      return null;
    }
    return value as CursorPayload;
  } catch {
    return null;
  }
};

const mapIdRows = (rows: readonly IdRow[], operation: string): readonly string[] =>
  rows.map((row) => {
    if (typeof row.id !== 'string' || !canonicalUuidPattern.test(row.id)) {
      throw new PlatformStoreError('validation-failed', operation);
    }
    return row.id;
  });

const validateQueryIdentity = (spaceId: string, personId: string, resourceId?: string | null): boolean =>
  canonicalUuidPattern.test(spaceId) &&
  canonicalUuidPattern.test(personId) &&
  (resourceId === undefined || resourceId === null || canonicalUuidPattern.test(resourceId));

const auditEventId = (): string => crypto.randomUUID();

export const createPlatformAuthorizationStore = (pool: Pool): PlatformAuthorizationStore => {
  const loadCompleteScope = async (
    input: AuthorizedResourceScopeQuery,
    operation: AuthorizationOperation,
  ): Promise<AuthorizationUnavailable | readonly string[]> => {
    const personId = principalPersonId(input.principal);
    if (personId === null) {
      return [];
    }
    const scopeSql = authorizationScopeSql(input.permission, input.resourceKind);
    if (!scopeSql) {
      return unavailable(operation, 'postgres.permission-resource-unsupported', 'authorization-unsupported');
    }
    if (!validateQueryIdentity(input.context.activeSpaceId, personId)) {
      return unavailable(operation, 'postgres.query-identity-invalid', 'authorization-invalid-query');
    }
    try {
      return await withPlatformSpaceTransaction(
        pool,
        input.context.activeSpaceId,
        `authorization-${operation}`,
        async (client) => {
          const result = await client.query<IdRow>(`${scopeSql} ORDER BY id ASC`, [
            input.context.activeSpaceId,
            personId,
            input.context.trustedDevice,
          ]);
          return mapIdRows(result.rows, `authorization-${operation}-row`);
        },
      );
    } catch {
      return unavailable(operation, 'postgres.authorization-query-unavailable');
    }
  };

  const check = async (input: AuthorizationCheck): Promise<AuthorizationDecision> => {
    if (!permissionSupportsResource(input.permission, input.resource.kind)) {
      return { kind: 'deny', reason: 'postgres.permission-resource-mismatch' };
    }
    if (input.context.activeSpaceId !== input.resource.spaceId) {
      return { kind: 'deny', reason: 'postgres.active-space-mismatch' };
    }
    const personId = principalPersonId(input.principal);
    if (personId === null) {
      return { kind: 'deny', reason: 'postgres.unsupported-principal' };
    }
    const scopeSql = authorizationScopeSql(input.permission, input.resource.kind);
    if (!(scopeSql && validateQueryIdentity(input.context.activeSpaceId, personId, input.resource.id))) {
      return { kind: 'deny', reason: 'postgres.resource-or-permission-invalid' };
    }
    try {
      const allowed = await withPlatformSpaceTransaction(
        pool,
        input.context.activeSpaceId,
        'authorization-check',
        async (client) => {
          const result = await client.query<IdRow>(
            `SELECT id FROM (${scopeSql}) complete_scope WHERE id = $4::UUID LIMIT 1`,
            [input.context.activeSpaceId, personId, input.context.trustedDevice, input.resource.id],
          );
          return result.rows.length === 1;
        },
      );
      return allowed
        ? { kind: 'allow', reason: 'postgres.explicit-domain-query' }
        : { kind: 'deny', reason: 'postgres.no-authorized-relation' };
    } catch {
      return {
        error: unavailable('check', 'postgres.authorization-query-unavailable'),
        kind: 'error',
      };
    }
  };

  const listResources = async (input: AuthorizedResourceListQuery): Promise<AuthorizedResourcePage> => {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0 || input.pageSize > maximumPageSize) {
      return {
        error: unavailable('list-resources', 'postgres.page-size-invalid', 'authorization-invalid-query'),
        kind: 'error',
      };
    }
    const personId = principalPersonId(input.principal);
    if (personId === null) {
      return { items: [], kind: 'page', nextCursor: null };
    }
    const cursor = decodeCursor(input.cursor);
    if (
      input.cursor !== undefined &&
      input.cursor !== null &&
      (!cursor ||
        cursor.personId !== personId ||
        cursor.activeSpaceId !== input.context.activeSpaceId ||
        cursor.permission !== input.permission ||
        cursor.resourceKind !== input.resourceKind)
    ) {
      return {
        error: unavailable('list-resources', 'postgres.cursor-invalid', 'authorization-invalid-query'),
        kind: 'error',
      };
    }
    const scopeSql = authorizationScopeSql(input.permission, input.resourceKind);
    if (!scopeSql) {
      return {
        error: unavailable('list-resources', 'postgres.permission-resource-unsupported', 'authorization-unsupported'),
        kind: 'error',
      };
    }
    if (!validateQueryIdentity(input.context.activeSpaceId, personId, cursor?.afterId)) {
      return {
        error: unavailable('list-resources', 'postgres.query-identity-invalid', 'authorization-invalid-query'),
        kind: 'error',
      };
    }
    try {
      const ids = await withPlatformSpaceTransaction(
        pool,
        input.context.activeSpaceId,
        'authorization-list-resources',
        async (client) => {
          const result = await client.query<IdRow>(
            `SELECT id
             FROM (${scopeSql}) complete_scope
             WHERE ($4::UUID IS NULL OR id > $4::UUID)
             ORDER BY id ASC
             LIMIT $5`,
            [
              input.context.activeSpaceId,
              personId,
              input.context.trustedDevice,
              cursor?.afterId ?? null,
              input.pageSize + 1,
            ],
          );
          return mapIdRows(result.rows, 'authorization-list-resource-row');
        },
      );
      const hasNext = ids.length > input.pageSize;
      const pageIds = hasNext ? ids.slice(0, input.pageSize) : ids;
      const items: readonly AuthorizationResource[] = pageIds.map((id) => ({
        id,
        kind: input.resourceKind,
        spaceId: input.context.activeSpaceId,
      }));
      const lastId = pageIds.at(-1);
      return {
        items,
        kind: 'page',
        nextCursor:
          hasNext && lastId
            ? encodeCursor({
                activeSpaceId: input.context.activeSpaceId,
                afterId: lastId,
                permission: input.permission,
                personId,
                resourceKind: input.resourceKind,
                version: 1,
              })
            : null,
      };
    } catch {
      return {
        error: unavailable('list-resources', 'postgres.authorization-query-unavailable'),
        kind: 'error',
      };
    }
  };

  const materializeResourceScope = async (
    input: AuthorizedResourceScopeQuery,
  ): Promise<AuthorizedResourceScopeResult> => {
    const ids = await loadCompleteScope(input, 'materialize-resource-scope');
    if ('code' in ids) {
      return { error: ids, kind: 'error' };
    }
    return createAuthorizedResourceScope({
      activeSpaceId: input.context.activeSpaceId,
      adapterBinding: createPostgreSqlAuthorizationScopeBinding(
        principalPersonId(input.principal),
        input.context.trustedDevice,
      ),
      permission: input.permission,
      resourceIds: ids,
      resourceKind: input.resourceKind,
    });
  };

  const createOrganizationWithAdmin = async (input: CreateOrganizationWithAdminInput): Promise<void> => {
    parseSpaceId(input.spaceId);
    parsePersonId(input.actorPersonId);
    parseInstant(input.createdAt);
    await withPlatformSpaceTransaction(pool, input.spaceId, 'create-organization-with-admin', async (client) => {
      await client.query(
        `INSERT INTO organizations (space_id, status, created_at)
         VALUES ($1, 'active', $2)`,
        [input.spaceId, input.createdAt],
      );
      await client.query(
        `INSERT INTO space_memberships (space_id, person_id, role, status, created_at)
         VALUES ($1, $2, 'admin', 'active', $3)`,
        [input.spaceId, input.actorPersonId, input.createdAt],
      );
      await client.query(
        `INSERT INTO authorization_audit_events
          (id, space_id, actor_person_id, action, subject_type, subject_id, result, recorded_at)
         VALUES ($1, $2, $3, 'organization-created', 'space', $2, 'applied', $4)`,
        [auditEventId(), input.spaceId, input.actorPersonId, input.createdAt],
      );
    });
  };

  const grantProjectAccess = async (input: GrantProjectAccessInput): Promise<void> => {
    if (!canonicalUuidPattern.test(input.grantId)) {
      throw new PlatformStoreError('validation-failed', 'grant-project-access');
    }
    parseSpaceId(input.spaceId);
    parseProjectId(input.projectId);
    parsePersonId(input.actorPersonId);
    parseInstant(input.grantedAt);
    if (input.expiresAt !== null) {
      parseInstant(input.expiresAt);
    }
    const personId = input.subject.kind === 'person' ? parsePersonId(input.subject.personId) : null;
    const teamId = input.subject.kind === 'team' ? parseTeamId(input.subject.teamId) : null;
    await withPlatformSpaceTransaction(pool, input.spaceId, 'grant-project-access', async (client) => {
      await client.query(
        `INSERT INTO project_grants
          (id, space_id, project_id, person_id, team_id, role, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
        [input.grantId, input.spaceId, input.projectId, personId, teamId, input.role, input.expiresAt, input.grantedAt],
      );
      await client.query(
        `INSERT INTO authorization_audit_events
          (id, space_id, actor_person_id, action, subject_type, subject_id, result, recorded_at, details)
         VALUES ($1, $2, $3, 'project-access-granted', 'project', $4, 'applied', $5, $6)`,
        [
          auditEventId(),
          input.spaceId,
          input.actorPersonId,
          input.projectId,
          input.grantedAt,
          { role: input.role, subjectKind: input.subject.kind },
        ],
      );
    });
  };

  const revokeProjectAccess = async (input: RevokeProjectAccessInput): Promise<void> => {
    if (!canonicalUuidPattern.test(input.grantId)) {
      throw new PlatformStoreError('validation-failed', 'revoke-project-access');
    }
    parseSpaceId(input.spaceId);
    parsePersonId(input.actorPersonId);
    parseInstant(input.revokedAt);
    await withPlatformSpaceTransaction(pool, input.spaceId, 'revoke-project-access', async (client) => {
      const result = await client.query(
        `UPDATE project_grants
         SET status = 'revoked', revoked_at = $1
         WHERE id = $2 AND space_id = $3 AND status = 'active'`,
        [input.revokedAt, input.grantId, input.spaceId],
      );
      if (result.rowCount !== 1) {
        throw new PlatformStoreError('validation-failed', 'revoke-project-access');
      }
      await client.query(
        `INSERT INTO authorization_audit_events
          (id, space_id, actor_person_id, action, subject_type, subject_id, result, recorded_at)
         VALUES ($1, $2, $3, 'project-access-revoked', 'project-grant', $4, 'applied', $5)`,
        [auditEventId(), input.spaceId, input.actorPersonId, input.grantId, input.revokedAt],
      );
    });
  };

  return Object.freeze({
    administration: Object.freeze({ createOrganizationWithAdmin, grantProjectAccess, revokeProjectAccess }),
    check,
    listResources,
    materializeResourceScope,
  });
};
