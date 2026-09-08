import type {
  AuthorizationPrincipal,
  AuthorizationRequestContext,
  AuthorizationUnavailable,
  AuthorizedResourceScope,
  Authorizer,
} from '@ai-usage/authorization';
import type { Project } from '@ai-usage/platform-core/identity';

export interface AuthorizedProjectCatalogQuery {
  readonly cursor?: string | null;
  readonly pageSize: number;
  readonly scope: AuthorizedResourceScope;
}

export interface AuthorizedProjectPage {
  readonly items: readonly Project[];
  readonly kind: 'page';
  readonly nextCursor: string | null;
}

export interface ProjectCatalogUnavailable {
  readonly code: 'project-catalog-invalid-query' | 'project-catalog-unavailable';
  readonly operation: 'list-authorized-projects';
}

export type AuthorizedProjectCatalogResult =
  | AuthorizedProjectPage
  | { readonly error: ProjectCatalogUnavailable; readonly kind: 'error' };

export interface AuthorizedProjectCatalog {
  readonly listAuthorizedProjects: (query: AuthorizedProjectCatalogQuery) => Promise<AuthorizedProjectCatalogResult>;
}

export interface ListProjectsQuery {
  readonly context: AuthorizationRequestContext;
  readonly cursor?: string | null;
  readonly pageSize: number;
  readonly principal: AuthorizationPrincipal;
}

export type ListProjectsResult =
  | AuthorizedProjectPage
  | { readonly error: AuthorizationUnavailable | ProjectCatalogUnavailable; readonly kind: 'error' };

export interface ProjectListingService {
  readonly listProjects: (query: ListProjectsQuery) => Promise<ListProjectsResult>;
}

export const createProjectListingService = (
  authorizer: Authorizer,
  catalog: AuthorizedProjectCatalog,
): ProjectListingService => ({
  listProjects: async (query) => {
    const scope = await authorizer.materializeResourceScope({
      context: query.context,
      permission: 'view_project',
      principal: query.principal,
      resourceKind: 'project',
    });
    if (scope.kind === 'error') {
      return scope;
    }
    return catalog.listAuthorizedProjects({
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      pageSize: query.pageSize,
      scope,
    });
  },
});
