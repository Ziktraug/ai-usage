import { describe, expect, test } from 'bun:test';
import type { Authorizer } from '@ai-usage/authorization';
import { createAuthorizedResourceScope } from '@ai-usage/authorization/scope-internal';
import { createPersonId, createProjectId, createSpaceId } from '@ai-usage/platform-core/identity';
import { type AuthorizedProjectCatalog, createProjectListingService, type ListProjectsQuery } from './index';

const spaceId = createSpaceId();
const personId = createPersonId();
const query: ListProjectsQuery = {
  context: { activeSpaceId: spaceId, trustedDevice: true },
  pageSize: 20,
  principal: { kind: 'person', personId },
};

describe('Project listing application service', () => {
  test('passes one opaque complete scope to the persistence query without application filtering', async () => {
    const scope = createAuthorizedResourceScope({
      activeSpaceId: spaceId,
      permission: 'view_project',
      resourceIds: [createProjectId(), createProjectId()],
      resourceKind: 'project',
    });
    const calls: unknown[] = [];
    const authorizer: Authorizer = {
      check: () => Promise.reject(new Error('Project listing must use a complete scope.')),
      listResources: () => Promise.reject(new Error('Project listing must not page the authorization graph.')),
      materializeResourceScope: (input) => {
        calls.push(input);
        return Promise.resolve(scope);
      },
    };
    const catalog: AuthorizedProjectCatalog = {
      listAuthorizedProjects: (input) => {
        calls.push(input);
        return Promise.resolve({ items: [], kind: 'page', nextCursor: null });
      },
    };

    await expect(createProjectListingService(authorizer, catalog).listProjects(query)).resolves.toEqual({
      items: [],
      kind: 'page',
      nextCursor: null,
    });
    expect(calls).toEqual([
      {
        context: query.context,
        permission: 'view_project',
        principal: query.principal,
        resourceKind: 'project',
      },
      { pageSize: 20, scope },
    ]);
  });

  test('fails closed before persistence when complete authorization is unavailable', async () => {
    const unavailable = {
      code: 'authorization-unavailable' as const,
      operation: 'materialize-resource-scope' as const,
      rule: 'test.unavailable',
    };
    const authorizer: Authorizer = {
      check: () => Promise.reject(new Error('unused')),
      listResources: () => Promise.reject(new Error('unused')),
      materializeResourceScope: () => Promise.resolve({ error: unavailable, kind: 'error' }),
    };
    const catalog: AuthorizedProjectCatalog = {
      listAuthorizedProjects: () => Promise.reject(new Error('Persistence must not run after authorization failure.')),
    };

    await expect(createProjectListingService(authorizer, catalog).listProjects(query)).resolves.toEqual({
      error: unavailable,
      kind: 'error',
    });
  });
});
