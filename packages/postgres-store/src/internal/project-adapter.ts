import { AUTHORIZATION_MODEL_VERSION } from '@ai-usage/authorization';
import { readAuthorizedResourceScopeAdapterBinding } from '@ai-usage/authorization/scope-internal';
import {
  type Project,
  parseIdentityText,
  parsePersonId,
  parseProjectId,
  parseRepositoryId,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import type {
  AuthorizedProjectCatalogQuery,
  AuthorizedProjectCatalogResult,
  ProjectCatalogUnavailable,
} from '@ai-usage/project-application';
import type { Pool, QueryResultRow } from 'pg';
import type { PlatformProjectCatalog } from '../projects';
import { authorizationScopeSql } from './authorization-query';
import { isPostgreSqlAuthorizationScopeBinding } from './authorization-scope-binding';
import { withPlatformSpaceTransaction } from './space-transaction';

const maximumPageSize = 100;

interface ProjectCursorPayload {
  readonly activeSpaceId: SpaceId;
  readonly afterProjectId: string;
  readonly modelVersion: typeof AUTHORIZATION_MODEL_VERSION;
  readonly version: 1;
}

interface ProjectRow extends QueryResultRow {
  readonly display_name: unknown;
  readonly id: unknown;
  readonly kind: unknown;
  readonly repository_id: unknown;
  readonly repository_subpath: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}

const unavailable = (code: ProjectCatalogUnavailable['code']): AuthorizedProjectCatalogResult => ({
  error: { code, operation: 'list-authorized-projects' },
  kind: 'error',
});

const encodeCursor = (payload: ProjectCursorPayload): string => btoa(JSON.stringify(payload));

const decodeCursor = (cursor: string | null | undefined): ProjectCursorPayload | null => {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = parsed as Partial<ProjectCursorPayload>;
    if (
      value.version !== 1 ||
      value.modelVersion !== AUTHORIZATION_MODEL_VERSION ||
      typeof value.activeSpaceId !== 'string' ||
      typeof value.afterProjectId !== 'string'
    ) {
      return null;
    }
    parseSpaceId(value.activeSpaceId);
    parseProjectId(value.afterProjectId);
    return value as ProjectCursorPayload;
  } catch {
    return null;
  }
};

const optionalText = (value: unknown, field: string, maximumLength: number): string | null => {
  if (value === null) {
    return null;
  }
  return parseIdentityText(value, field, maximumLength);
};

const mapProject = (row: ProjectRow): Project => {
  if ((row.kind !== 'local' && row.kind !== 'repository') || (row.status !== 'active' && row.status !== 'archived')) {
    throw new Error('Stored Project enum value is invalid.');
  }
  return {
    displayName: parseIdentityText(row.display_name, 'project.displayName'),
    id: parseProjectId(row.id),
    kind: row.kind,
    owningSpaceId: parseSpaceId(row.space_id),
    repositoryId: row.repository_id === null ? null : parseRepositoryId(row.repository_id),
    repositorySubpath: optionalText(row.repository_subpath, 'project.repositorySubpath', 1024),
    status: row.status,
  };
};

export const createPlatformProjectCatalog = (pool: Pool): PlatformProjectCatalog => ({
  listAuthorizedProjects: async (query: AuthorizedProjectCatalogQuery): Promise<AuthorizedProjectCatalogResult> => {
    if (
      !Number.isSafeInteger(query.pageSize) ||
      query.pageSize <= 0 ||
      query.pageSize > maximumPageSize ||
      query.scope.permission !== 'view_project' ||
      query.scope.resourceKind !== 'project' ||
      query.scope.modelVersion !== AUTHORIZATION_MODEL_VERSION
    ) {
      return unavailable('project-catalog-invalid-query');
    }
    const cursor = decodeCursor(query.cursor);
    if (
      query.cursor !== undefined &&
      query.cursor !== null &&
      (!cursor || cursor.activeSpaceId !== query.scope.activeSpaceId)
    ) {
      return unavailable('project-catalog-invalid-query');
    }

    let binding: ReturnType<typeof readAuthorizedResourceScopeAdapterBinding>;
    try {
      binding = readAuthorizedResourceScopeAdapterBinding(query.scope);
    } catch {
      return unavailable('project-catalog-invalid-query');
    }
    if (!isPostgreSqlAuthorizationScopeBinding(binding)) {
      return unavailable('project-catalog-invalid-query');
    }
    if (binding.personId === null) {
      return { items: [], kind: 'page', nextCursor: null };
    }
    try {
      parsePersonId(binding.personId);
    } catch {
      return unavailable('project-catalog-invalid-query');
    }
    const authorizationQuery = authorizationScopeSql('view_project', 'project');
    if (authorizationQuery === null) {
      return unavailable('project-catalog-unavailable');
    }

    try {
      const projects = await withPlatformSpaceTransaction(
        pool,
        query.scope.activeSpaceId,
        'list-authorized-projects',
        async (client) => {
          const result = await client.query<ProjectRow>(
            `WITH authorized_projects(id) AS (
               ${authorizationQuery}
             )
             SELECT p.id, p.space_id, p.kind, p.display_name,
                    p.repository_id, p.repository_subpath, p.status
             FROM projects p
             INNER JOIN authorized_projects authorized ON authorized.id = p.id
             WHERE p.space_id = $1
               AND ($4::UUID IS NULL OR p.id > $4::UUID)
             ORDER BY p.id ASC
             LIMIT $5`,
            [
              query.scope.activeSpaceId,
              binding.personId,
              binding.trustedDevice,
              cursor?.afterProjectId ?? null,
              query.pageSize + 1,
            ],
          );
          return result.rows.map(mapProject);
        },
      );
      const hasNext = projects.length > query.pageSize;
      const items = hasNext ? projects.slice(0, query.pageSize) : projects;
      const lastProjectId = items.at(-1)?.id;
      return {
        items,
        kind: 'page',
        nextCursor:
          hasNext && lastProjectId
            ? encodeCursor({
                activeSpaceId: query.scope.activeSpaceId,
                afterProjectId: lastProjectId,
                modelVersion: AUTHORIZATION_MODEL_VERSION,
                version: 1,
              })
            : null,
      };
    } catch {
      return unavailable('project-catalog-unavailable');
    }
  },
});
