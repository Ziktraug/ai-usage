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
  type AuthorizationUnavailable,
  type AuthorizedResourcePage,
  type AuthorizedResourceScopeResult,
  authorizationPermissions,
} from './index';
import { readAuthorizedResourceScopeIds } from './scope-internal';
import { createSingleUserAuthorizer } from './single-user';

type PermissionResourcePair = `${AuthorizationPermission}:${AuthorizationResourceKind}`;

// Every resource kind of the contract; the mapped type stops compiling when the contract gains or
// drops one, so the matrices below always walk all of them.
const resourceKindsByName: { readonly [Kind in AuthorizationResourceKind]: Kind } = {
  device: 'device',
  memory: 'memory',
  project: 'project',
  repository: 'repository',
  session: 'session',
  space: 'space',
  'usage-aggregate': 'usage-aggregate',
  'work-handoff': 'work-handoff',
  'work-thread': 'work-thread',
};
const allResourceKinds = Object.values(resourceKindsByName);

// The complete set of pairs the local operator is allowed, pinned here rather than read from
// single-user.ts or permission-resource.ts: adding a local permission or widening the resource
// kinds of one there fails this suite, which is what keeps aggregates apart from content (an
// aggregate permission never reaches a Session). Every pair not listed is denied, including every
// pair of the organization-era permissions the contract still lists.
const localOperatorAllowedPairs: ReadonlySet<PermissionResourcePair> = new Set<PermissionResourcePair>([
  'accept_memory:memory',
  'accept_work_handoff:work-handoff',
  'archive_session_content:session',
  'create_work_handoff:project',
  'create_work_handoff:space',
  'create_work_handoff:work-thread',
  'link_repository:project',
  'link_repository:repository',
  'link_session_to_work_thread:session',
  'link_session_to_work_thread:work-thread',
  'manage_device:device',
  'manage_device:space',
  'manage_memory:memory',
  'manage_project:project',
  'manage_project:space',
  'manage_repository_binding:project',
  'manage_repository_binding:repository',
  'manage_repository_binding:space',
  'manage_session_archive_policy:session',
  'manage_session_archive_policy:space',
  'manage_work_handoff:work-handoff',
  'manage_work_thread:work-thread',
  'propose_memory:memory',
  'propose_memory:project',
  'propose_memory:space',
  'purge_session_archive:session',
  'revoke_device:device',
  'view_device:device',
  'view_memory:memory',
  'view_project:project',
  'view_project_usage_aggregate:usage-aggregate',
  'view_project_usage_detail:project',
  'view_repository_metadata:repository',
  'view_repository_metadata:space',
  'view_session_content:session',
  'view_session_metadata:session',
  'view_work_handoff:work-handoff',
  'view_work_thread:work-thread',
]);
// A local permission is one with at least one allowed pair; the others are the organization-era ones.
const localOperatorPermissions: ReadonlySet<string> = new Set(
  [...localOperatorAllowedPairs].map((pair) => pair.slice(0, pair.indexOf(':'))),
);

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
  // One resource of every kind in the personal Space, and one of every kind in a foreign Space.
  const localResources = new Map(
    allResourceKinds.map((kind) => [kind, resource(idFor(kind), kind, localSpaceId)] as const),
  );
  const foreignResources = allResourceKinds.map((kind) => resource(crypto.randomUUID(), kind, foreignSpaceId));
  const localResourceOf = (kind: AuthorizationResourceKind): AuthorizationResource => {
    const localResource = localResources.get(kind);
    if (!localResource) {
      throw new Error(`Expected a personal-Space ${kind} resource.`);
    }
    return localResource;
  };
  const errorLabel = ({ error }: { readonly error: AuthorizationUnavailable }): string =>
    `error ${error.code} ${error.operation} ${error.rule}`;

  test('pins the local operator check for every permission and every resource kind', async () => {
    const label = (decision: AuthorizationDecision): string =>
      decision.kind === 'error' ? errorLabel(decision) : `${decision.kind} ${decision.reason}`;
    const mismatch = deny('single-user.permission-resource-mismatch');
    const decisions: string[] = [];
    const expected: string[] = [];
    for (const permission of authorizationPermissions) {
      for (const kind of allResourceKinds) {
        const pair: PermissionResourcePair = `${permission}:${kind}`;
        const decision = await authorizer.check({
          context: context(localSpaceId),
          permission,
          principal: person(localPersonId),
          resource: localResourceOf(kind),
        });
        decisions.push(`${pair} ${label(decision)}`);
        expected.push(`${pair} ${label(localOperatorAllowedPairs.has(pair) ? allow : mismatch)}`);
      }
    }
    expect(decisions).toEqual(expected);
  });

  test('pins the local operator list and scope for every permission and every resource kind', async () => {
    const listingAuthorizer = createSingleUserAuthorizer({
      listKnownResources: () => Promise.resolve([...foreignResources, ...localResources.values()]),
      localPersonId,
      personalSpaceId: localSpaceId,
    });
    const pageLabel = (page: AuthorizedResourcePage): string =>
      page.kind === 'page'
        ? `page [${page.items.map((item) => item.id).join(',')}] next ${page.nextCursor}`
        : errorLabel(page);
    const scopeLabel = (scope: AuthorizedResourceScopeResult): string =>
      scope.kind === 'scope' ? `scope [${readAuthorizedResourceScopeIds(scope).join(',')}]` : errorLabel(scope);
    // An allowed pair lists and scopes exactly the personal-Space resource of its kind. A local
    // permission over a kind it does not support is an unsupported query, and an organization-era
    // permission lists and scopes nothing.
    const expectedListing = (permission: AuthorizationPermission, kind: AuthorizationResourceKind): string => {
      if (localOperatorAllowedPairs.has(`${permission}:${kind}`)) {
        const { id } = localResourceOf(kind);
        return `page [${id}] next null | scope [${id}]`;
      }
      if (localOperatorPermissions.has(permission)) {
        const rule = 'single-user.permission-resource-mismatch';
        return `error authorization-unsupported list-resources ${rule} | error authorization-unsupported materialize-resource-scope ${rule}`;
      }
      return 'page [] next null | scope []';
    };
    const listings: string[] = [];
    const expected: string[] = [];
    for (const permission of authorizationPermissions) {
      for (const kind of allResourceKinds) {
        const query = {
          context: context(localSpaceId),
          permission,
          principal: person(localPersonId),
          resourceKind: kind,
        };
        const page = await listingAuthorizer.listResources({ ...query, pageSize: 100 });
        const scope = await listingAuthorizer.materializeResourceScope(query);
        listings.push(`${permission}:${kind} ${pageLabel(page)} | ${scopeLabel(scope)}`);
        expected.push(`${permission}:${kind} ${expectedListing(permission, kind)}`);
      }
    }
    expect(listings).toEqual(expected);
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

  test('lists and scopes nothing for an organization permission, even over a kind it supports', async () => {
    const authorizer = createSingleUserAuthorizer({
      listKnownResources: () => Promise.resolve([{ id: personalSpaceId, kind: 'space', spaceId: personalSpaceId }]),
      localPersonId,
      personalSpaceId,
    });
    const query = {
      context: localContext,
      permission: 'manage_organization',
      principal: localPrincipal,
      resourceKind: 'space',
    } as const;

    await expect(authorizer.listResources({ ...query, pageSize: 10 })).resolves.toEqual({
      items: [],
      kind: 'page',
      nextCursor: null,
    });
    const scope = await authorizer.materializeResourceScope(query);
    expect(scope).toMatchObject({ kind: 'scope', permission: 'manage_organization', resourceKind: 'space' });
    if (scope.kind !== 'scope') {
      throw new Error('Expected an empty local authorization scope.');
    }
    expect(readAuthorizedResourceScopeIds(scope)).toEqual([]);
  });

  test('reports a local permission over a kind it does not support as unsupported, not as empty', async () => {
    const authorizer = createSingleUserAuthorizer({
      listKnownResources: () =>
        Promise.resolve([{ id: crypto.randomUUID(), kind: 'memory', spaceId: personalSpaceId }]),
      localPersonId,
      personalSpaceId,
    });
    const query = {
      context: localContext,
      permission: 'view_project',
      principal: localPrincipal,
      resourceKind: 'memory',
    } as const;
    const rule = 'single-user.permission-resource-mismatch';

    await expect(authorizer.listResources({ ...query, pageSize: 10 })).resolves.toEqual({
      error: { code: 'authorization-unsupported', operation: 'list-resources', rule },
      kind: 'error',
    });
    await expect(authorizer.materializeResourceScope(query)).resolves.toEqual({
      error: { code: 'authorization-unsupported', operation: 'materialize-resource-scope', rule },
      kind: 'error',
    });
  });
});
