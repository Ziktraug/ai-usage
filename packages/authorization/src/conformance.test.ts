import { describe, expect, test } from 'bun:test';
import { createTeamId } from '@ai-usage/platform-core/identity';
import { createAuthorizationConformanceFixture } from './conformance';
import type { AuthorizationReadDomain } from './in-memory';
import { AuthorizationModelError, createInMemoryOrganizationAuthorizer } from './in-memory';
import { permissionResourceKinds } from './permission-resource';
import { readAuthorizedResourceScopeIds } from './scope-internal';
import { createSingleUserAuthorizer } from './single-user';

const fixture = createAuthorizationConformanceFixture();
const organizationAuthorizer = createInMemoryOrganizationAuthorizer({ state: fixture.state });
const singleUserAuthorizer = createSingleUserAuthorizer({
  localPersonId: fixture.identities.localPersonId,
  personalSpaceId: fixture.identities.localSpaceId,
});

describe('authorization golden scenarios', () => {
  test('covers every permission/resource query with both an allow and a deny outcome', () => {
    for (const [permission, resourceKinds] of Object.entries(permissionResourceKinds)) {
      for (const resourceKind of resourceKinds) {
        const outcomes = fixture.scenarios
          .filter(
            (scenario) => scenario.input.permission === permission && scenario.input.resource.kind === resourceKind,
          )
          .map((scenario) => scenario.expected.organization);
        expect({ outcomes, permission, resourceKind }).toMatchObject({
          outcomes: expect.arrayContaining(['allow', 'deny']),
        });
      }
    }
  });

  for (const scenario of fixture.scenarios) {
    test(`organization: ${scenario.name}`, async () => {
      const decision = await organizationAuthorizer.check(scenario.input);
      expect(decision.kind).toBe(scenario.expected.organization);
    });

    test(`single-user: ${scenario.name}`, async () => {
      const decision = await singleUserAuthorizer.check(scenario.input);
      expect(decision.kind).toBe(scenario.expected['single-user']);
    });
  }

  test('ordinary listing is cursor-bound and complete without duplicates or omissions', async () => {
    const input = {
      context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
      pageSize: 2,
      permission: 'view_project_usage_aggregate' as const,
      principal: { kind: 'person' as const, personId: fixture.identities.usageAuditorPersonId },
      resourceKind: 'usage-aggregate' as const,
    };
    const first = await organizationAuthorizer.listResources(input);
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') {
      throw new Error('Expected the first authorization page.');
    }
    const second = await organizationAuthorizer.listResources({ ...input, cursor: first.nextCursor });
    expect(second.kind).toBe('page');
    if (second.kind !== 'page') {
      throw new Error('Expected the second authorization page.');
    }
    const ids = [...first.items, ...second.items].map((resource) => resource.id);
    expect(ids).toEqual([...fixture.identities.organizationProjectIds].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.nextCursor).toBeNull();

    const wrongPrincipal = await organizationAuthorizer.listResources({
      ...input,
      cursor: first.nextCursor,
      principal: { kind: 'person', personId: fixture.identities.collaboratorPersonId },
    });
    expect(wrongPrincipal).toMatchObject({
      error: { code: 'authorization-invalid-query', rule: 'organization.cursor-invalid' },
      kind: 'error',
    });
  });

  test('materializes every authorized candidate before a later ranking step', async () => {
    const scope = await organizationAuthorizer.materializeResourceScope({
      context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
      permission: 'view_project_usage_aggregate',
      principal: { kind: 'person', personId: fixture.identities.usageAuditorPersonId },
      resourceKind: 'usage-aggregate',
    });
    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') {
      throw new Error('Expected a complete organization authorization scope.');
    }
    expect(Object.keys(scope)).not.toContain('resourceIds');
    expect(readAuthorizedResourceScopeIds(scope)).toEqual([...fixture.identities.organizationProjectIds].sort());
  });

  test('aggregate authorization never reads Session, Memory, or Work handoff content state', async () => {
    const reads: AuthorizationReadDomain[] = [];
    const authorizer = createInMemoryOrganizationAuthorizer({
      onRead: (domain) => reads.push(domain),
      state: fixture.state,
    });
    await expect(
      authorizer.check({
        context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
        permission: 'view_organization_usage_aggregate',
        principal: { kind: 'person', personId: fixture.identities.usageAuditorPersonId },
        resource: {
          id: fixture.identities.organizationSpaceId,
          kind: 'usage-aggregate',
          spaceId: fixture.identities.organizationSpaceId,
        },
      }),
    ).resolves.toMatchObject({ kind: 'allow' });
    expect(reads).not.toContain('sessions');
    expect(reads).not.toContain('session-content-grants');
    expect(reads).not.toContain('memory-items');
    expect(reads).not.toContain('memory-content-grants');
    expect(reads).not.toContain('work-handoffs');
    expect(reads).not.toContain('work-handoff-grants');
  });

  test('adapter failure is operational, fails closed, and performs no model read', async () => {
    let reads = 0;
    const authorizer = createInMemoryOrganizationAuthorizer({
      checkAvailability: () => Promise.reject(new Error('unavailable')),
      onRead: () => {
        reads += 1;
      },
      state: fixture.state,
    });
    const result = await authorizer.check(
      fixture.scenarios[0]?.input ??
        (() => {
          throw new Error('Missing golden scenario.');
        })(),
    );
    expect(result).toEqual({
      error: {
        code: 'authorization-unavailable',
        operation: 'check',
        rule: 'organization.adapter-unavailable',
      },
      kind: 'error',
    });
    expect(reads).toBe(0);
  });

  test('rejects cyclic or over-deep Team nesting instead of expanding a recursive policy graph', () => {
    const [parent, child] = fixture.state.teams;
    if (!(parent && child)) {
      throw new Error('Missing Team fixture.');
    }
    expect(() =>
      createInMemoryOrganizationAuthorizer({
        state: {
          ...fixture.state,
          teamNestings: [
            ...fixture.state.teamNestings,
            {
              childTeamId: parent.id,
              parentTeamId: child.id,
              spaceId: fixture.identities.organizationSpaceId,
              status: 'active',
            },
          ],
        },
      }),
    ).toThrow(AuthorizationModelError);

    const thirdTeamId = createTeamId();
    const fourthTeamId = createTeamId();
    const fifthTeamId = createTeamId();
    expect(() =>
      createInMemoryOrganizationAuthorizer({
        state: {
          ...fixture.state,
          teamNestings: [
            ...fixture.state.teamNestings,
            {
              childTeamId: parent.id,
              parentTeamId: thirdTeamId,
              spaceId: fixture.identities.organizationSpaceId,
              status: 'active',
            },
            {
              childTeamId: thirdTeamId,
              parentTeamId: fourthTeamId,
              spaceId: fixture.identities.organizationSpaceId,
              status: 'active',
            },
            {
              childTeamId: fourthTeamId,
              parentTeamId: fifthTeamId,
              spaceId: fixture.identities.organizationSpaceId,
              status: 'active',
            },
          ],
          teams: [
            ...fixture.state.teams,
            ...[thirdTeamId, fourthTeamId, fifthTeamId].map((id) => ({
              id,
              spaceId: fixture.identities.organizationSpaceId,
              status: 'active' as const,
            })),
          ],
        },
      }),
    ).toThrow(AuthorizationModelError);
  });
});
