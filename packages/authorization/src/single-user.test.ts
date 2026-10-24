import { describe, expect, test } from 'bun:test';
import {
  createDeviceId,
  createPersonId,
  createProjectId,
  createRepositoryId,
  createSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  type AuthorizationCheck,
  type AuthorizationDecision,
  type AuthorizationPermission,
  type AuthorizationResource,
  type AuthorizationResourceKind,
  authorizationPermissions,
} from './index';
import { permissionResourceKinds } from './permission-resource';
import { readAuthorizedResourceScopeIds } from './scope-internal';
import { createSingleUserAuthorizer } from './single-user';

// Pinned here rather than read from single-user.ts, so adding or dropping a
// local permission there fails this suite. The organization-era permissions the
// contract still lists are absent and therefore fail closed.
const localOperatorPermissions: readonly AuthorizationPermission[] = [
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
];

const allow: AuthorizationDecision = { kind: 'allow', reason: 'single-user.personal-space' };
const deny = (reason: string): AuthorizationDecision => ({ kind: 'deny', reason });

describe('SingleUserAuthorizer golden decisions', () => {
  const localPersonId = createPersonId();
  const localSpaceId = createSpaceId();
  const otherPersonalPersonId = createPersonId();
  const otherPersonalSpaceId = createSpaceId();
  const foreignPersonId = createPersonId();
  const foreignSpaceId = createSpaceId();
  const localProjectId = createProjectId();
  const authorizer = createSingleUserAuthorizer({ localPersonId, personalSpaceId: localSpaceId });

  const person = (personId: ReturnType<typeof createPersonId>) => ({ kind: 'person' as const, personId });
  const context = (activeSpaceId: SpaceId) => ({ activeSpaceId, trustedDevice: true });
  const resource = (id: string, kind: AuthorizationResourceKind, spaceId: SpaceId): AuthorizationResource => ({
    id,
    kind,
    spaceId,
  });
  const localSpace = resource(localSpaceId, 'space', localSpaceId);

  // The single-user rows of the retired organization/single-user golden
  // fixture, each with the decision the single-user authorizer gave it.
  const scenarios: readonly {
    readonly expected: AuthorizationDecision;
    readonly input: AuthorizationCheck;
    readonly name: string;
  }[] = [
    {
      expected: allow,
      input: {
        context: context(localSpaceId),
        permission: 'view_project',
        principal: person(localPersonId),
        resource: resource(localProjectId, 'project', localSpaceId),
      },
      name: 'local operator sees the personal Project',
    },
    {
      expected: allow,
      input: {
        context: context(localSpaceId),
        permission: 'view_memory',
        principal: person(localPersonId),
        resource: resource(crypto.randomUUID(), 'memory', localSpaceId),
      },
      name: 'local operator sees personal Memory',
    },
    {
      expected: allow,
      input: {
        context: context(localSpaceId),
        permission: 'view_work_handoff',
        principal: person(localPersonId),
        resource: resource(crypto.randomUUID(), 'work-handoff', localSpaceId),
      },
      name: 'local operator sees personal Work handoff',
    },
    {
      expected: deny('single-user.non-local-principal'),
      input: {
        context: context(otherPersonalSpaceId),
        permission: 'view_project',
        principal: person(foreignPersonId),
        resource: resource(localProjectId, 'project', otherPersonalSpaceId),
      },
      name: 'another Person cannot see a different personal Space',
    },
    {
      expected: deny('single-user.active-space-mismatch'),
      input: {
        context: context(localSpaceId),
        permission: 'view_project',
        principal: person(foreignPersonId),
        resource: resource(createProjectId(), 'project', foreignSpaceId),
      },
      name: 'active Space mismatch fails closed',
    },
    ...(['manage_project', 'manage_repository_binding', 'view_repository_metadata'] as const).flatMap((permission) => [
      {
        expected: allow,
        input: {
          context: context(localSpaceId),
          permission,
          principal: person(localPersonId),
          resource: localSpace,
        },
        name: `permission pair allows ${permission}:space`,
      },
      {
        expected: deny('single-user.non-local-principal'),
        input: {
          context: context(localSpaceId),
          permission,
          principal: person(otherPersonalPersonId),
          resource: localSpace,
        },
        name: `permission pair denies unrelated principal for ${permission}:space`,
      },
    ]),
  ];

  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      await expect(authorizer.check(scenario.input)).resolves.toEqual(scenario.expected);
    });
  }

  test('pins the local operator decision for every permission/resource pair', async () => {
    const idFor = (kind: AuthorizationResourceKind): string => {
      switch (kind) {
        case 'device':
          return createDeviceId();
        case 'project':
        case 'usage-aggregate':
          return localProjectId;
        case 'repository':
          return createRepositoryId();
        case 'space':
          return localSpaceId;
        default:
          return crypto.randomUUID();
      }
    };
    const label = (decision: AuthorizationDecision): string =>
      decision.kind === 'error' ? `error ${decision.error.rule}` : `${decision.kind} ${decision.reason}`;
    const pairs = authorizationPermissions.flatMap((permission) =>
      permissionResourceKinds[permission].map((kind) => ({ kind, permission })),
    );
    const decisions: string[] = [];
    for (const { kind, permission } of pairs) {
      const decision = await authorizer.check({
        context: context(localSpaceId),
        permission,
        principal: person(localPersonId),
        resource: resource(idFor(kind), kind, localSpaceId),
      });
      decisions.push(`${permission}:${kind} ${label(decision)}`);
    }
    const mismatch = deny('single-user.permission-resource-mismatch');
    expect(decisions).toEqual(
      pairs.map(
        ({ kind, permission }) =>
          `${permission}:${kind} ${label(localOperatorPermissions.includes(permission) ? allow : mismatch)}`,
      ),
    );
    expect(decisions.filter((decision) => decision.includes(' deny '))).toEqual([
      'manage_authorization:space deny single-user.permission-resource-mismatch',
      'manage_members:space deny single-user.permission-resource-mismatch',
      'manage_organization:space deny single-user.permission-resource-mismatch',
      'manage_teams:space deny single-user.permission-resource-mismatch',
      'view_organization:space deny single-user.permission-resource-mismatch',
      'view_organization_usage_aggregate:usage-aggregate deny single-user.permission-resource-mismatch',
    ]);
  });
});

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
