import { describe, expect, test } from 'bun:test';
import { createPersonId, createProjectId, createSpaceId } from '@ai-usage/platform-core/identity';
import { readAuthorizedResourceScopeIds } from './scope-internal';
import { createSingleUserAuthorizer } from './single-user';

describe('SingleUserAuthorizer', () => {
  const localPersonId = createPersonId();
  const personalSpaceId = createSpaceId();
  const foreignSpaceId = createSpaceId();
  const projectId = createProjectId();
  const localPrincipal = { kind: 'person' as const, personId: localPersonId };
  const project = { id: projectId, kind: 'project' as const, spaceId: personalSpaceId };
  const localContext = { activeSpaceId: personalSpaceId, trustedDevice: true };

  test('allows only the local Person over a compatible personal-Space resource', async () => {
    const authorizer = createSingleUserAuthorizer({ localPersonId, personalSpaceId });
    await expect(
      authorizer.check({
        context: localContext,
        permission: 'view_project',
        principal: localPrincipal,
        resource: project,
      }),
    ).resolves.toEqual({ kind: 'allow', reason: 'single-user.personal-space' });
    await expect(
      authorizer.check({
        context: localContext,
        permission: 'view_memory',
        principal: localPrincipal,
        resource: project,
      }),
    ).resolves.toEqual({ kind: 'deny', reason: 'single-user.permission-resource-mismatch' });
  });

  test('denies foreign Spaces and non-local principals', async () => {
    const authorizer = createSingleUserAuthorizer({ localPersonId, personalSpaceId });
    await expect(
      authorizer.check({
        permission: 'view_project',
        context: { activeSpaceId: foreignSpaceId, trustedDevice: true },
        principal: localPrincipal,
        resource: { ...project, spaceId: foreignSpaceId },
      }),
    ).resolves.toEqual({ kind: 'deny', reason: 'single-user.foreign-space' });
    await expect(
      authorizer.check({
        permission: 'view_project',
        context: localContext,
        principal: { kind: 'person', personId: createPersonId() },
        resource: project,
      }),
    ).resolves.toEqual({ kind: 'deny', reason: 'single-user.non-local-principal' });
    await expect(
      authorizer.check({
        context: localContext,
        permission: 'view_project',
        principal: { id: 'job', kind: 'service' },
        resource: project,
      }),
    ).resolves.toEqual({ kind: 'deny', reason: 'single-user.non-local-principal' });
  });

  test('preserves infrastructure failure as error instead of deny or allow', async () => {
    const authorizer = createSingleUserAuthorizer({
      checkAvailability: () => Promise.reject(new Error('unavailable')),
      localPersonId,
      personalSpaceId,
    });
    await expect(
      authorizer.check({
        context: localContext,
        permission: 'view_project',
        principal: localPrincipal,
        resource: project,
      }),
    ).resolves.toEqual({
      error: {
        code: 'authorization-unavailable',
        operation: 'check',
        rule: 'single-user.adapter-unavailable',
      },
      kind: 'error',
    });
  });

  test('lists only bounded resources in the local personal Space', async () => {
    const secondProjectId = createProjectId();
    const authorizer = createSingleUserAuthorizer({
      listKnownResources: () =>
        Promise.resolve([
          project,
          { id: secondProjectId, kind: 'project', spaceId: personalSpaceId },
          { id: createProjectId(), kind: 'project', spaceId: foreignSpaceId },
        ]),
      localPersonId,
      personalSpaceId,
    });
    const first = await authorizer.listResources({
      context: localContext,
      pageSize: 1,
      permission: 'view_project',
      principal: localPrincipal,
      resourceKind: 'project',
    });
    expect(first).toMatchObject({ items: [expect.any(Object)], kind: 'page' });
    if (first.kind !== 'page') {
      throw new Error('Expected a local authorization page.');
    }
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await authorizer.listResources({
      cursor: first.nextCursor,
      context: localContext,
      pageSize: 1,
      permission: 'view_project',
      principal: localPrincipal,
      resourceKind: 'project',
    });
    expect(second).toMatchObject({ items: [expect.any(Object)], kind: 'page', nextCursor: null });
  });

  test('materializes the complete local scope without exposing its resource IDs', async () => {
    const secondProjectId = createProjectId();
    const authorizer = createSingleUserAuthorizer({
      listKnownResources: () =>
        Promise.resolve([
          project,
          { id: secondProjectId, kind: 'project', spaceId: personalSpaceId },
          { id: createProjectId(), kind: 'project', spaceId: foreignSpaceId },
        ]),
      localPersonId,
      personalSpaceId,
    });

    const scope = await authorizer.materializeResourceScope({
      context: localContext,
      permission: 'view_project',
      principal: localPrincipal,
      resourceKind: 'project',
    });
    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') {
      throw new Error('Expected a complete local authorization scope.');
    }
    expect(Object.keys(scope)).not.toContain('resourceIds');
    expect(readAuthorizedResourceScopeIds(scope)).toEqual([projectId, secondProjectId].sort());
  });
});
