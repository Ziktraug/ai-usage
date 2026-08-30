import { describe, expect, test } from 'bun:test';
import { createAuthorizationConformanceFixture } from '@ai-usage/authorization/conformance';
import type { AuthorizationGrantSubject } from '@ai-usage/authorization/organization-model';
import { readAuthorizedResourceScopeIds } from '@ai-usage/authorization/scope-internal';
import { createSpaceId, instantNow, type PersonId, type SpaceId } from '@ai-usage/platform-core/identity';
import { createPlatformTestingDatabase, type PlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { createProjectListingService } from '@ai-usage/project-application';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const observedAt = instantNow(() => new Date('2026-08-29T18:00:00.000Z'));
const authorizationTableNames = [
  'authorization_audit_events',
  'device_managers',
  'memory_authorization_scopes',
  'memory_content_grants',
  'organizations',
  'project_grants',
  'repository_grants',
  'scm_installation_repository_grants',
  'session_authorization_scopes',
  'session_content_grants',
  'session_metadata_grants',
  'space_memberships',
  'team_memberships',
  'team_nestings',
  'teams',
  'work_handoff_authorization_scopes',
  'work_handoff_grants',
  'work_thread_authorization_scopes',
  'work_thread_grants',
] as const;
const authorizationIndexNames = [
  'authorization_audit_subject_idx',
  'device_managers_person_idx',
  'devices_authorization_space_idx',
  'memory_authorization_scopes_space_idx',
  'memory_content_grants_person_idx',
  'memory_content_grants_team_idx',
  'project_grants_person_idx',
  'project_grants_person_unique',
  'project_grants_team_idx',
  'project_grants_team_unique',
  'repositories_authorization_space_idx',
  'repository_grants_person_idx',
  'repository_grants_person_unique',
  'repository_grants_team_idx',
  'repository_grants_team_unique',
  'session_authorization_scopes_space_idx',
  'session_content_grants_person_idx',
  'session_content_grants_team_idx',
  'session_metadata_grants_person_idx',
  'session_metadata_grants_team_idx',
  'space_memberships_person_idx',
  'team_memberships_person_idx',
  'team_nestings_child_idx',
  'work_handoff_authorization_scopes_space_idx',
  'work_handoff_grants_person_idx',
  'work_handoff_grants_team_idx',
  'work_thread_authorization_scopes_space_idx',
  'work_thread_grants_person_idx',
  'work_thread_grants_team_idx',
] as const;

const subjectColumns = (subject: AuthorizationGrantSubject): readonly [PersonId | null, string | null] =>
  subject.kind === 'person' ? [subject.personId, null] : [null, subject.teamId];

const collectPeople = (fixture: ReturnType<typeof createAuthorizationConformanceFixture>): ReadonlySet<PersonId> => {
  const people = new Set<PersonId>();
  const addSubject = (subject: AuthorizationGrantSubject): void => {
    if (subject.kind === 'person') {
      people.add(subject.personId);
    }
  };
  for (const space of fixture.state.personalSpaces) {
    people.add(space.ownerPersonId);
  }
  for (const membership of fixture.state.spaceMemberships) {
    people.add(membership.personId);
  }
  for (const membership of fixture.state.teamMemberships) {
    people.add(membership.personId);
  }
  for (const device of fixture.state.devices) {
    people.add(device.ownerPersonId);
  }
  for (const manager of fixture.state.deviceManagers) {
    people.add(manager.personId);
  }
  for (const session of fixture.state.sessions) {
    people.add(session.ownerPersonId);
  }
  for (const memory of fixture.state.memoryItems) {
    people.add(memory.ownerPersonId);
  }
  for (const grant of [
    ...fixture.state.projectGrants,
    ...fixture.state.repositoryGrants,
    ...fixture.state.sessionMetadataGrants,
    ...fixture.state.sessionContentGrants,
    ...fixture.state.memoryContentGrants,
    ...fixture.state.workThreadGrants,
    ...fixture.state.workHandoffGrants,
  ]) {
    addSubject(grant.subject);
  }
  return people;
};

const seedIdentity = async (
  database: PlatformTestingDatabase,
  fixture: ReturnType<typeof createAuthorizationConformanceFixture>,
): Promise<void> => {
  const personalSpaceByPerson = new Map<PersonId, SpaceId>(
    fixture.state.personalSpaces.map((space) => [space.ownerPersonId, space.spaceId]),
  );
  for (const personId of collectPeople(fixture)) {
    if (!personalSpaceByPerson.has(personId)) {
      personalSpaceByPerson.set(personId, createSpaceId());
    }
  }
  for (const spaceId of personalSpaceByPerson.values()) {
    await database.query(
      `INSERT INTO spaces (id, kind, display_name, created_at)
       VALUES ($1, 'personal', $2, $3)`,
      [spaceId, `personal-${spaceId.slice(0, 8)}`, observedAt],
    );
  }
  for (const organization of fixture.state.organizations) {
    await database.query(
      `INSERT INTO spaces (id, kind, display_name, created_at)
       VALUES ($1, 'organization', $2, $3)`,
      [organization.spaceId, `organization-${organization.spaceId.slice(0, 8)}`, observedAt],
    );
  }
  for (const [personId, personalSpaceId] of personalSpaceByPerson) {
    await database.query(
      `INSERT INTO people (id, display_name, personal_space_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [personId, `person-${personId.slice(0, 8)}`, personalSpaceId],
    );
  }
  for (const repository of fixture.state.repositories) {
    await database.query(
      `INSERT INTO repositories
        (id, space_id, provider, canonical_host, canonical_name, status)
       VALUES ($1, $2, 'generic', 'example.test', $3, $4)`,
      [repository.id, repository.spaceId, `repository-${repository.id.slice(0, 8)}`, repository.status],
    );
  }
  for (const project of fixture.state.projects) {
    await database.query(
      `INSERT INTO projects
        (id, space_id, kind, display_name, repository_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        project.id,
        project.spaceId,
        project.repositoryId === null ? 'local' : 'repository',
        `project-${project.id.slice(0, 8)}`,
        project.repositoryId,
        project.status,
      ],
    );
  }
  for (const device of fixture.state.devices) {
    await database.query(
      `INSERT INTO devices (id, owner_person_id, space_id, label, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [device.id, device.ownerPersonId, device.spaceId, `device-${device.id.slice(0, 8)}`, device.status],
    );
  }
  const installations = new Set(fixture.state.scmInstallationRepositoryGrants.map((grant) => grant.installationId));
  for (const installationId of installations) {
    await database.query(
      `INSERT INTO scm_installations
        (id, space_id, provider, provider_installation_id, selected_repository_ids, status)
       VALUES ($1, $2, 'generic', $3, $4, 'active')`,
      [installationId, fixture.identities.organizationSpaceId, `installation-${installationId}`, []],
    );
  }
};

const seedAuthorizationSpace = async (
  database: PlatformTestingDatabase,
  fixture: ReturnType<typeof createAuthorizationConformanceFixture>,
  spaceId: SpaceId,
): Promise<void> => {
  await database.withSpaceContext(spaceId, async (query) => {
    for (const organization of fixture.state.organizations.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO organizations (space_id, status, created_at)
         VALUES ($1, $2, $3)`,
        [organization.spaceId, organization.status, observedAt],
      );
    }
    for (const membership of fixture.state.spaceMemberships.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO space_memberships
          (space_id, person_id, role, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [membership.spaceId, membership.personId, membership.role, membership.status, observedAt],
      );
    }
    for (const team of fixture.state.teams.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO teams (id, space_id, name, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [team.id, team.spaceId, `team-${team.id.slice(0, 8)}`, team.status, observedAt],
      );
    }
    for (const membership of fixture.state.teamMemberships.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO team_memberships
          (space_id, team_id, person_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [membership.spaceId, membership.teamId, membership.personId, membership.status, observedAt],
      );
    }
    for (const nesting of fixture.state.teamNestings.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO team_nestings
          (space_id, parent_team_id, child_team_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [nesting.spaceId, nesting.parentTeamId, nesting.childTeamId, nesting.status, observedAt],
      );
    }
    for (const grant of fixture.state.projectGrants.filter((item) => item.spaceId === spaceId)) {
      const [personId, teamId] = subjectColumns(grant.subject);
      await query(
        `INSERT INTO project_grants
          (id, space_id, project_id, person_id, team_id, role, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          crypto.randomUUID(),
          grant.spaceId,
          grant.projectId,
          personId,
          teamId,
          grant.role,
          grant.status,
          grant.expiresAt,
          observedAt,
        ],
      );
    }
    for (const grant of fixture.state.repositoryGrants.filter((item) => item.spaceId === spaceId)) {
      const [personId, teamId] = subjectColumns(grant.subject);
      await query(
        `INSERT INTO repository_grants
          (id, space_id, repository_id, person_id, team_id, role, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          crypto.randomUUID(),
          grant.spaceId,
          grant.repositoryId,
          personId,
          teamId,
          grant.role,
          grant.status,
          grant.expiresAt,
          observedAt,
        ],
      );
    }
    for (const grant of fixture.state.scmInstallationRepositoryGrants.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO scm_installation_repository_grants
          (space_id, installation_id, repository_id, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [grant.spaceId, grant.installationId, grant.repositoryId, grant.status, grant.expiresAt, observedAt],
      );
    }
    for (const manager of fixture.state.deviceManagers.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO device_managers
          (space_id, device_id, person_id, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [manager.spaceId, manager.deviceId, manager.personId, manager.status, manager.expiresAt, observedAt],
      );
    }
    for (const session of fixture.state.sessions.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO session_authorization_scopes
          (id, space_id, project_id, owner_person_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.id, session.spaceId, session.projectId, session.ownerPersonId, session.status],
      );
    }
    for (const memory of fixture.state.memoryItems.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO memory_authorization_scopes
          (id, space_id, project_id, owner_person_id, status, sensitivity, requires_trusted_device)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          memory.id,
          memory.spaceId,
          memory.projectId,
          memory.ownerPersonId,
          memory.status,
          memory.sensitivity,
          memory.requiresTrustedDevice,
        ],
      );
    }
    for (const thread of fixture.state.workThreads.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO work_thread_authorization_scopes (id, space_id, project_id, status)
         VALUES ($1, $2, $3, $4)`,
        [thread.id, thread.spaceId, thread.projectId, thread.status],
      );
    }
    for (const handoff of fixture.state.workHandoffs.filter((item) => item.spaceId === spaceId)) {
      await query(
        `INSERT INTO work_handoff_authorization_scopes
          (id, space_id, work_thread_id, project_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [handoff.id, handoff.spaceId, handoff.workThreadId, handoff.projectId, handoff.status],
      );
    }

    const contentGrantRows = [
      ...fixture.state.sessionMetadataGrants.map((grant) => ({
        grant,
        resourceColumn: 'session_id',
        resourceId: grant.sessionId,
        table: 'session_metadata_grants',
      })),
      ...fixture.state.sessionContentGrants.map((grant) => ({
        grant,
        resourceColumn: 'session_id',
        resourceId: grant.sessionId,
        table: 'session_content_grants',
      })),
      ...fixture.state.memoryContentGrants.map((grant) => ({
        grant,
        resourceColumn: 'memory_id',
        resourceId: grant.memoryId,
        table: 'memory_content_grants',
      })),
      ...fixture.state.workThreadGrants.map((grant) => ({
        grant,
        resourceColumn: 'work_thread_id',
        resourceId: grant.workThreadId,
        table: 'work_thread_grants',
      })),
      ...fixture.state.workHandoffGrants.map((grant) => ({
        grant,
        resourceColumn: 'work_handoff_id',
        resourceId: grant.workHandoffId,
        table: 'work_handoff_grants',
      })),
    ].filter((row) => row.grant.spaceId === spaceId);
    for (const row of contentGrantRows) {
      const [personId, teamId] = subjectColumns(row.grant.subject);
      await query(
        `INSERT INTO ${row.table}
          (id, space_id, ${row.resourceColumn}, person_id, team_id, role, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          crypto.randomUUID(),
          row.grant.spaceId,
          row.resourceId,
          personId,
          teamId,
          row.grant.role,
          row.grant.status,
          row.grant.expiresAt,
          observedAt,
        ],
      );
    }
  });
};

const appRoleUrl = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  url.username = 'platform_app';
  return url.toString();
};

if (runPostgresTests) {
  describe('PostgreSQL domain authorization', () => {
    test('passes the unchanged organization scenarios and materializes the complete scope', async () => {
      const cluster = await startPostgresCluster('authorization-conformance');
      const database = createPlatformTestingDatabase(cluster.url);
      const fixture = createAuthorizationConformanceFixture();
      let appDatabase: PlatformTestingDatabase | undefined;
      let store: Awaited<ReturnType<typeof createPlatformStore>> | undefined;
      try {
        await database.runMigrations({ mode: 'apply' });
        expect(
          await database.queryRowCount(
            `SELECT indexname FROM pg_indexes
             WHERE schemaname = 'public' AND indexname = ANY($1::TEXT[])`,
            [authorizationIndexNames],
          ),
        ).toBe(authorizationIndexNames.length);
        expect(
          await database.queryRowCount(
            `SELECT c.relname
             FROM pg_class c
             JOIN pg_namespace namespace ON namespace.oid = c.relnamespace
             WHERE namespace.nspname = 'public'
               AND c.relname = ANY($1::TEXT[])
               AND c.relrowsecurity = TRUE
               AND c.relforcerowsecurity = TRUE`,
            [authorizationTableNames],
          ),
        ).toBe(authorizationTableNames.length);
        await seedIdentity(database, fixture);
        for (const spaceId of [fixture.identities.localSpaceId, fixture.identities.organizationSpaceId]) {
          await seedAuthorizationSpace(database, fixture, spaceId);
        }
        await database.query('CREATE ROLE platform_app LOGIN NOSUPERUSER');
        await database.query('GRANT USAGE, CREATE ON SCHEMA public TO platform_app');
        await database.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app');

        const applicationUrl = appRoleUrl(cluster.url);
        appDatabase = createPlatformTestingDatabase(applicationUrl);
        expect(await appDatabase.queryRowCount('SELECT space_id FROM organizations')).toBe(0);
        expect(
          await appDatabase.queryRowCountInSpace(
            fixture.identities.organizationSpaceId,
            'SELECT id FROM session_authorization_scopes WHERE space_id = $1',
            [fixture.identities.localSpaceId],
          ),
        ).toBe(0);
        await expect(
          appDatabase.withSpaceContext(fixture.identities.organizationSpaceId, (query) =>
            query(
              `INSERT INTO authorization_audit_events
                (id, space_id, actor_person_id, action, subject_type, subject_id, result, recorded_at)
               VALUES ($1, $2, $3, 'cross-space-probe', 'space', $2, 'rejected', $4)`,
              [crypto.randomUUID(), fixture.identities.localSpaceId, fixture.identities.localPersonId, observedAt],
            ),
          ),
        ).rejects.toMatchObject({ code: 'validation-failed' });

        store = await createPlatformStore({
          connectTimeoutMs: 5000,
          databaseUrl: applicationUrl,
          migrationMode: 'verify',
          poolSize: 4,
          queryTimeoutMs: 5000,
          tlsMode: 'disable',
        });
        for (const scenario of fixture.scenarios) {
          const decision = await store.authorization.check(scenario.input);
          expect({ kind: decision.kind, scenario: scenario.name }).toEqual({
            kind: scenario.expected.organization,
            scenario: scenario.name,
          });
        }

        const scope = await store.authorization.materializeResourceScope({
          context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
          permission: 'view_project_usage_aggregate',
          principal: { kind: 'person', personId: fixture.identities.usageAuditorPersonId },
          resourceKind: 'usage-aggregate',
        });
        expect(scope.kind).toBe('scope');
        if (scope.kind !== 'scope') {
          throw new Error('Expected the PostgreSQL complete authorization scope.');
        }
        expect(readAuthorizedResourceScopeIds(scope)).toEqual([...fixture.identities.organizationProjectIds].sort());

        const listing = await createProjectListingService(store.authorization, store.projects).listProjects({
          context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
          pageSize: 100,
          principal: { kind: 'person', personId: fixture.identities.collaboratorPersonId },
        });
        expect(listing.kind).toBe('page');
        if (listing.kind !== 'page') {
          throw new Error('Expected the authorized Project listing.');
        }
        const expectedProjectIds: (typeof fixture.identities.organizationProjectIds)[number][] = [];
        for (const projectId of fixture.identities.organizationProjectIds) {
          const decision = await store.authorization.check({
            context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
            permission: 'view_project',
            principal: { kind: 'person', personId: fixture.identities.collaboratorPersonId },
            resource: { id: projectId, kind: 'project', spaceId: fixture.identities.organizationSpaceId },
          });
          if (decision.kind === 'allow') {
            expectedProjectIds.push(projectId);
          }
        }
        expect(listing.items.map((project) => project.id)).toEqual(expectedProjectIds.sort());
      } finally {
        await store?.close().catch(() => undefined);
        await appDatabase?.close().catch(() => undefined);
        await database.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('commits organization/grant mutations with audit and makes revocation immediate', async () => {
      const cluster = await startPostgresCluster('authorization-mutations');
      const database = createPlatformTestingDatabase(cluster.url);
      const fixture = createAuthorizationConformanceFixture();
      const newOrganizationSpaceId = createSpaceId();
      const administratorId = fixture.identities.adminPersonId;
      let appDatabase: PlatformTestingDatabase | undefined;
      let store: Awaited<ReturnType<typeof createPlatformStore>> | undefined;
      try {
        await database.runMigrations({ mode: 'apply' });
        await seedIdentity(database, fixture);
        await seedAuthorizationSpace(database, fixture, fixture.identities.organizationSpaceId);
        await database.query(
          `INSERT INTO spaces (id, kind, display_name, created_at)
           VALUES ($1, 'organization', 'transactional organization', $2)`,
          [newOrganizationSpaceId, observedAt],
        );
        await database.query('CREATE ROLE platform_app LOGIN NOSUPERUSER');
        await database.query('GRANT USAGE, CREATE ON SCHEMA public TO platform_app');
        await database.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app');
        const applicationUrl = appRoleUrl(cluster.url);
        appDatabase = createPlatformTestingDatabase(applicationUrl);
        store = await createPlatformStore({
          connectTimeoutMs: 5000,
          databaseUrl: applicationUrl,
          migrationMode: 'verify',
          poolSize: 4,
          queryTimeoutMs: 5000,
          tlsMode: 'disable',
        });

        await store.authorization.administration.createOrganizationWithAdmin({
          actorPersonId: administratorId,
          createdAt: observedAt,
          spaceId: newOrganizationSpaceId,
        });
        await expect(
          store.authorization.check({
            context: { activeSpaceId: newOrganizationSpaceId, trustedDevice: true },
            permission: 'manage_members',
            principal: { kind: 'person', personId: administratorId },
            resource: { id: newOrganizationSpaceId, kind: 'space', spaceId: newOrganizationSpaceId },
          }),
        ).resolves.toMatchObject({ kind: 'allow' });

        const projectId = fixture.identities.organizationProjectIds[0];
        if (!projectId) {
          throw new Error('Missing Project fixture.');
        }
        const localProjectId = fixture.state.projects.find(
          (project) => project.spaceId === fixture.identities.localSpaceId,
        )?.id;
        if (!localProjectId) {
          throw new Error('Missing personal Project fixture.');
        }
        await expect(
          store.authorization.administration.grantProjectAccess({
            actorPersonId: administratorId,
            expiresAt: null,
            grantedAt: observedAt,
            grantId: crypto.randomUUID(),
            projectId: localProjectId,
            role: 'viewer',
            spaceId: fixture.identities.organizationSpaceId,
            subject: { kind: 'person', personId: administratorId },
          }),
        ).rejects.toMatchObject({ code: 'validation-failed' });
        const grantId = crypto.randomUUID();
        const granteePersonId = fixture.identities.usageAuditorPersonId;
        await store.authorization.administration.grantProjectAccess({
          actorPersonId: administratorId,
          expiresAt: null,
          grantedAt: observedAt,
          grantId,
          projectId,
          role: 'viewer',
          spaceId: fixture.identities.organizationSpaceId,
          subject: { kind: 'person', personId: granteePersonId },
        });
        const projectCheck = {
          context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
          permission: 'view_project' as const,
          principal: { kind: 'person' as const, personId: granteePersonId },
          resource: { id: projectId, kind: 'project' as const, spaceId: fixture.identities.organizationSpaceId },
        };
        await expect(store.authorization.check(projectCheck)).resolves.toMatchObject({ kind: 'allow' });
        const grantedScope = await store.authorization.materializeResourceScope({
          context: { activeSpaceId: fixture.identities.organizationSpaceId, trustedDevice: true },
          permission: 'view_project',
          principal: { kind: 'person', personId: granteePersonId },
          resourceKind: 'project',
        });
        if (grantedScope.kind !== 'scope') {
          throw new Error('Expected a complete Project scope before revocation.');
        }
        expect(readAuthorizedResourceScopeIds(grantedScope)).toContain(projectId);
        await store.authorization.administration.revokeProjectAccess({
          actorPersonId: administratorId,
          grantId,
          revokedAt: observedAt,
          spaceId: fixture.identities.organizationSpaceId,
        });
        await expect(store.authorization.check(projectCheck)).resolves.toMatchObject({ kind: 'deny' });
        await expect(
          store.projects.listAuthorizedProjects({ pageSize: 100, scope: grantedScope }),
        ).resolves.toMatchObject({ items: [], kind: 'page' });
        expect(
          await appDatabase.queryRowCountInSpace(
            fixture.identities.organizationSpaceId,
            'SELECT id FROM authorization_audit_events',
          ),
        ).toBe(2);
      } finally {
        await store?.close().catch(() => undefined);
        await appDatabase?.close().catch(() => undefined);
        await database.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  describe.skip('PostgreSQL domain authorization', () => {
    test('requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
  });
}
