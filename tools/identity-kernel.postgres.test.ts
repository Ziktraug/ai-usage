import { describe, expect, test } from 'bun:test';
import {
  type Checkout,
  createCaptureContextId,
  createCheckoutId,
  createDeviceId,
  createPersonId,
  createProjectId,
  createRepositoryAliasId,
  createRepositoryId,
  createScmAccountId,
  createScmCredentialId,
  createScmInstallationId,
  createSpaceId,
  instantNow,
  type Project,
  type Repository,
  type RepositoryAlias,
} from '@ai-usage/platform-core/identity';
import { PLATFORM_MIGRATIONS, type PlatformMigrationTrace } from '@ai-usage/postgres-store/migrations';
import { createPlatformTestingDatabase, type PlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { projectSourceId } from '@ai-usage/report-core/project-group';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const foundationMigrations = PLATFORM_MIGRATIONS.slice(0, 1);
const identityMigrations = PLATFORM_MIGRATIONS.slice(0, 2);
const observedAt = instantNow(() => new Date('2026-08-29T12:00:00.000Z'));

interface DatabaseFixture {
  readonly database: PlatformTestingDatabase;
  readonly stop: () => Promise<void>;
}

const startDatabase = async (label: string): Promise<DatabaseFixture> => {
  const cluster = await startPostgresCluster(label);
  const database = createPlatformTestingDatabase(cluster.url);
  return {
    database,
    stop: async (): Promise<void> => {
      await database.close().catch(() => undefined);
      await cluster.stop();
    },
  };
};

const insertPersonalKernel = async (database: PlatformTestingDatabase, label: string) => {
  const spaceId = createSpaceId();
  const personId = createPersonId();
  const deviceId = createDeviceId();
  await database.query('INSERT INTO spaces (id, kind, display_name, created_at) VALUES ($1, $2, $3, $4)', [
    spaceId,
    'personal',
    `${label} space`,
    observedAt,
  ]);
  await database.query('INSERT INTO people (id, display_name, personal_space_id, status) VALUES ($1, $2, $3, $4)', [
    personId,
    `${label} person`,
    spaceId,
    'active',
  ]);
  await database.query(
    'INSERT INTO devices (id, owner_person_id, space_id, label, status) VALUES ($1, $2, $3, $4, $5)',
    [deviceId, personId, spaceId, `${label} device`, 'local'],
  );
  return { deviceId, personId, spaceId };
};

if (runPostgresTests) {
  describe('PostgreSQL identity kernel', () => {
    test('applies the domain migration after a foundation fixture in explicit ordinal order', async () => {
      const { database, stop } = await startDatabase('identity-forward');
      try {
        await database.runMigrations({ migrations: foundationMigrations, mode: 'apply' });
        const trace: PlatformMigrationTrace[] = [];
        expect(
          await database.runMigrations({
            migrations: identityMigrations,
            mode: 'apply',
            onTrace: (event) => trace.push(event),
          }),
        ).toEqual({
          appliedIds: ['0002_identity_kernel'],
          currentOrdinal: 2,
        });
        expect(trace).toEqual([
          { type: 'lock-acquired' },
          { id: '0002_identity_kernel', ordinal: 2, type: 'migration-applied' },
          { type: 'lock-released' },
        ]);
        expect(await database.listPublicTables()).toEqual([
          'capture_contexts',
          'checkout_resolution_candidates',
          'checkouts',
          'devices',
          'identity_events',
          'people',
          'platform_migrations',
          'platform_schema_metadata',
          'project_source_mappings',
          'projects',
          'repositories',
          'repository_aliases',
          'scm_accounts',
          'scm_credentials',
          'scm_installations',
          'spaces',
        ]);
      } finally {
        await stop();
      }
    }, 30_000);

    test('rejects repository, alias, Project, and Checkout references across Spaces', async () => {
      const { database, stop } = await startDatabase('identity-space-fences');
      try {
        await database.runMigrations({ mode: 'apply' });
        const left = await insertPersonalKernel(database, 'left');
        const right = await insertPersonalKernel(database, 'right');
        const repositoryId = createRepositoryId();
        await database.query(
          `INSERT INTO repositories
            (id, space_id, provider, canonical_host, canonical_owner, canonical_name, status)
           VALUES ($1, $2, 'github', 'github.com', 'openai', 'codex', 'active')`,
          [repositoryId, left.spaceId],
        );

        await expect(
          database.query(
            `INSERT INTO repository_aliases
              (id, space_id, repository_id, normalized_remote, source, first_observed_at)
             VALUES ($1, $2, $3, 'github.com/openai/codex', 'local-git', $4)`,
            [createRepositoryAliasId(), right.spaceId, repositoryId, observedAt],
          ),
        ).rejects.toBeDefined();
        await expect(
          database.query(
            `INSERT INTO projects
              (id, space_id, kind, display_name, repository_id, status)
             VALUES ($1, $2, 'repository', 'foreign', $3, 'active')`,
            [createProjectId(), right.spaceId, repositoryId],
          ),
        ).rejects.toBeDefined();

        const projectId = createProjectId();
        await database.query(
          `INSERT INTO projects
            (id, space_id, kind, display_name, repository_id, status)
           VALUES ($1, $2, 'repository', 'codex', $3, 'active')`,
          [projectId, left.spaceId, repositoryId],
        );
        await expect(
          database.query(
            `INSERT INTO checkouts
              (id, space_id, project_id, device_id, local_path, status, last_observed_at)
             VALUES ($1, $2, $3, $4, '/opaque/checkout', 'available', $5)`,
            [createCheckoutId(), right.spaceId, projectId, right.deviceId, observedAt],
          ),
        ).rejects.toBeDefined();
      } finally {
        await stop();
      }
    }, 30_000);

    test('keeps SCM Person accounts, Space installations, and exclusive credentials distinct', async () => {
      const { database, stop } = await startDatabase('identity-scm-seams');
      try {
        await database.runMigrations({ mode: 'apply' });
        const local = await insertPersonalKernel(database, 'scm');
        const accountId = createScmAccountId();
        const installationId = createScmInstallationId();
        await expect(
          database.query(
            `INSERT INTO scm_accounts (id, person_id, provider, provider_account_id)
             VALUES ($1, NULL, 'github', 'account-without-person')`,
            [createScmAccountId()],
          ),
        ).rejects.toBeDefined();
        await database.query(
          `INSERT INTO scm_accounts (id, person_id, provider, provider_account_id)
           VALUES ($1, $2, 'github', 'A_123')`,
          [accountId, local.personId],
        );
        await database.query(
          `INSERT INTO scm_installations
            (id, space_id, provider, provider_installation_id, status)
           VALUES ($1, $2, 'github', 'I_456', 'active')`,
          [installationId, local.spaceId],
        );
        await expect(
          database.query(
            `INSERT INTO scm_credentials
              (id, account_id, installation_id, encrypted_secret_reference, created_at)
             VALUES ($1, $2, $3, 'secret-ref', $4)`,
            [createScmCredentialId(), accountId, installationId, observedAt],
          ),
        ).rejects.toBeDefined();
        await expect(
          database.query(
            `INSERT INTO scm_credentials
              (id, account_id, installation_id, encrypted_secret_reference, created_at)
             VALUES ($1, NULL, NULL, 'secret-ref', $2)`,
            [createScmCredentialId(), observedAt],
          ),
        ).rejects.toBeDefined();
        await expect(
          database.query(
            `INSERT INTO scm_credentials
              (id, account_id, installation_id, encrypted_secret_reference, created_at)
             VALUES ($1, $2, NULL, 'secret-ref', $3)`,
            [createScmCredentialId(), accountId, observedAt],
          ),
        ).resolves.toBeUndefined();
      } finally {
        await stop();
      }
    }, 30_000);

    test('accepts non-Git Projects, unresolved Checkouts, and additive source mappings', async () => {
      const { database, stop } = await startDatabase('identity-unresolved');
      try {
        await database.runMigrations({ mode: 'apply' });
        const local = await insertPersonalKernel(database, 'local');
        const projectId = createProjectId();
        const checkoutId = createCheckoutId();
        await database.query(
          `INSERT INTO projects (id, space_id, kind, display_name, status)
           VALUES ($1, $2, 'local', 'notes', 'active')`,
          [projectId, local.spaceId],
        );
        await database.query(
          `INSERT INTO checkouts
            (id, space_id, project_id, device_id, local_path, status, last_observed_at)
           VALUES ($1, $2, NULL, $3, '/opaque/notes', 'unknown', $4)`,
          [checkoutId, local.spaceId, local.deviceId, observedAt],
        );
        await database.query('UPDATE checkouts SET project_id = $1 WHERE id = $2 AND space_id = $3', [
          projectId,
          checkoutId,
          local.spaceId,
        ]);
        await expect(
          database.query(
            `INSERT INTO project_source_mappings
              (space_id, project_source_id, project_id, checkout_id, acknowledged_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [local.spaceId, 'machine-id|opaque-source', projectId, checkoutId, observedAt],
          ),
        ).resolves.toBeUndefined();
      } finally {
        await stop();
      }
    }, 30_000);

    test('preserves stable Project and Repository identities through attachment, path change, and rename', async () => {
      const cluster = await startPostgresCluster('identity-adapter');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 4,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      try {
        const spaceId = createSpaceId();
        const personId = createPersonId();
        const deviceId = createDeviceId();
        const repositoryId = createRepositoryId();
        const alternativeRepositoryId = createRepositoryId();
        const projectId = createProjectId();
        const checkoutId = createCheckoutId();
        await store.identity.createPersonalIdentity({
          person: { displayName: 'Operator', id: personId, personalSpaceId: spaceId, status: 'active' },
          space: { createdAt: observedAt, displayName: 'Personal', id: spaceId, kind: 'personal' },
        });
        await store.identity.createDevice({
          id: deviceId,
          label: 'Opaque device',
          lastSeenAt: null,
          ownerPersonId: personId,
          owningSpaceId: spaceId,
          status: 'local',
        });
        const repository: Repository = {
          canonicalHost: 'github.com',
          canonicalName: 'codex',
          canonicalOwner: 'openai',
          id: repositoryId,
          owningSpaceId: spaceId,
          provider: 'github',
          providerRepositoryId: 'R_adapter',
          status: 'active',
        };
        const alias: RepositoryAlias = {
          firstObservedAt: observedAt,
          id: createRepositoryAliasId(),
          lastObservedAt: null,
          normalizedRemote: 'github.com/openai/codex',
          owningSpaceId: spaceId,
          repositoryId,
          source: 'local-git',
        };
        const project: Project = {
          displayName: 'Codex workspace',
          id: projectId,
          kind: 'local',
          owningSpaceId: spaceId,
          repositoryId: null,
          repositorySubpath: null,
          status: 'active',
        };
        await store.identity.createRepositoryWithAlias(repository, alias);
        await store.identity.createRepositoryWithAlias(
          {
            ...repository,
            canonicalName: 'codex-mirror',
            id: alternativeRepositoryId,
            providerRepositoryId: 'R_adapter_mirror',
          },
          {
            ...alias,
            id: createRepositoryAliasId(),
            normalizedRemote: 'mirror.example/openai/codex',
            repositoryId: alternativeRepositoryId,
          },
        );
        await store.identity.createProject(project);
        await store.identity.attachProjectRepository({
          projectId,
          repositoryId,
          repositorySubpath: 'packages/sdk',
          spaceId,
        });
        const checkout: Checkout = {
          deviceId,
          id: checkoutId,
          lastObservedAt: observedAt,
          localPath: '/opaque/old-path',
          observedRemote: 'git@github.com:openai/codex.git',
          projectId,
          repositoryId,
          status: 'available',
        };
        await store.identity.upsertCheckout(spaceId, checkout);
        await store.identity.recordRepositoryResolution(spaceId, checkoutId, {
          candidateRepositoryIds: [repositoryId, alternativeRepositoryId],
          kind: 'ambiguous',
          matchedBy: 'alias',
          normalizedRemote: 'github.com/openai/codex',
          spaceId,
        });
        expect(await store.identity.listResolutionReviews(spaceId)).toEqual([
          {
            candidateMatches: [
              { canonicalLabel: 'github.com/openai/codex', repositoryId },
              { canonicalLabel: 'github.com/openai/codex-mirror', repositoryId: alternativeRepositoryId },
            ].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
            checkoutId,
            destinationSpaceId: spaceId,
            deviceId,
            deviceLabel: 'Opaque device',
            localLabel: `checkout:${checkoutId.slice(0, 8)}`,
            normalizedRemote: 'github.com/openai/codex',
            status: 'ambiguous',
          },
        ]);
        expect(
          await store.identity.applyResolutionAction({
            checkoutId,
            kind: 'link',
            projectId,
            repositoryId,
            spaceId,
          }),
        ).toEqual({
          kind: 'linked',
          projectId,
          repositoryId,
        });
        await store.identity.upsertCheckout(spaceId, { ...checkout, localPath: '/opaque/new-path' });
        await store.identity.updateRepositoryIdentity({
          canonicalHost: 'github.com',
          canonicalName: 'codex-renamed',
          canonicalOwner: 'openai-labs',
          eventType: 'repository-transferred',
          repositoryId,
          spaceId,
          status: 'renamed',
        });
        await store.identity.saveCaptureContext({
          deviceId,
          id: createCaptureContextId(),
          personId,
          projectId,
          scmAccountId: null,
          scmInstallationId: null,
          source: 'explicit',
          spaceId,
        });
        const sourceId = projectSourceId({ machineId: 'machine', project: 'codex', sourcePath: '/opaque/source' });
        await store.identity.acknowledgeProjectSourceMapping(
          { acknowledgedAt: observedAt, checkoutId, projectId, projectSourceId: sourceId },
          spaceId,
        );

        const repositoryCandidates = await store.identity.listRepositoryCandidates(spaceId);
        expect(repositoryCandidates.find((candidate) => candidate.repository.id === repositoryId)).toEqual({
          aliases: [alias],
          repository: {
            ...repository,
            canonicalName: 'codex-renamed',
            canonicalOwner: 'openai-labs',
            status: 'renamed',
          },
        });
        expect(await store.identity.listResolutionReviews(spaceId)).toEqual([]);
        expect(await store.identity.findProjectSourceMapping(spaceId, sourceId)).toEqual({
          acknowledgedAt: observedAt,
          checkoutId,
          projectId,
          projectSourceId: sourceId,
        });
      } finally {
        await store.close();
        await cluster.stop();
      }
    }, 30_000);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  describe.skip('PostgreSQL identity kernel', () => {
    test('requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
  });
}
