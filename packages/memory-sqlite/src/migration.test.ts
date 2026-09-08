import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import { createMemoryApplicationService } from '@ai-usage/memory-service/application';
import { memoryFingerprint } from '@ai-usage/memory-service/domain';
import {
  createCaptureContextId,
  createCheckoutId,
  createDeviceId,
  createPersonId,
  createProjectId,
  createRepositoryAliasId,
  createRepositoryId,
  createSpaceId,
  instantNow,
  type MemoryItemId,
} from '@ai-usage/platform-core/identity';
import { type LocalIdentityBootstrap, openLocalIdentityKernel } from './identity';
import { LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION } from './schema';

const roots: string[] = [];
const clock = () => new Date('2026-09-01T09:00:00.000Z');
const observedAt = instantNow(clock);

// The index definition every memory.sqlite created between commits 9808c87e and
// cf270c95 carries under user_version 5; b949af04 changed it without a bump.
const preB949af04RepositoryIndexSql = `
  CREATE UNIQUE INDEX repositories_provider_identity_unique
    ON repositories (provider, provider_repository_id)
    WHERE provider_repository_id IS NOT NULL;
`;
const spaceScopedRepositoryIndexClause = 'ON repositories (space_id, provider, provider_repository_id)';

interface SchemaObject {
  readonly name: string;
  readonly sql: string | null;
  readonly tbl_name: string;
  readonly type: string;
}

interface StoreSnapshot {
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
  readonly schema: readonly SchemaObject[];
  readonly userVersion: number;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const databaseFixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-migration-'));
  roots.push(root);
  return path.join(root, 'memory.sqlite');
};

const isSnapshotTable = (object: SchemaObject): boolean =>
  object.type === 'table' &&
  !object.sql?.startsWith('CREATE VIRTUAL') &&
  !object.name.startsWith('memory_search_fts') &&
  !object.name.startsWith('memory_search_trigram_fts');

const snapshotStore = (databasePath: string): StoreSnapshot => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const userVersion = (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    const schema = database
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as SchemaObject[];
    const rows = Object.fromEntries(
      schema
        .filter(isSnapshotTable)
        .map((object) => [object.name, database.query(`SELECT * FROM "${object.name}" ORDER BY rowid`).all()]),
    );
    return { rows, schema, userVersion };
  } finally {
    database.close(false);
  }
};

const repositoryIndexSql = (snapshot: StoreSnapshot): string | null =>
  snapshot.schema.find((object) => object.name === 'repositories_provider_identity_unique')?.sql ?? null;

const rewriteStore = (databasePath: string, sql: string): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    database.exec(sql);
  } finally {
    database.close(false);
  }
};

const consistent = { foreignKeyViolations: [], integrity: { integrity_check: 'ok' } };

const readConsistency = (databasePath: string): typeof consistent => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return {
      foreignKeyViolations: database.query('PRAGMA foreign_key_check').all() as never[],
      integrity: database.query('PRAGMA integrity_check').get() as { integrity_check: string },
    };
  } finally {
    database.close(false);
  }
};

const seedStore = async (databasePath: string): Promise<LocalIdentityBootstrap> => {
  const kernel = await openLocalIdentityKernel({ clock, databasePath });
  try {
    const bootstrap = await kernel.getBootstrapIdentity();
    const repositoryId = createRepositoryId();
    const projectId = createProjectId();
    await kernel.createRepositoryWithAlias(
      {
        canonicalHost: 'github.com',
        canonicalName: 'synthetic',
        canonicalOwner: 'example',
        id: repositoryId,
        owningSpaceId: bootstrap.space.id,
        provider: 'github',
        providerRepositoryId: 'R_synthetic',
        status: 'active',
      },
      {
        firstObservedAt: observedAt,
        id: createRepositoryAliasId(),
        lastObservedAt: null,
        normalizedRemote: 'github.com/example/synthetic',
        owningSpaceId: bootstrap.space.id,
        repositoryId,
        source: 'local-git',
      },
    );
    await kernel.createProject({
      displayName: 'synthetic project',
      id: projectId,
      kind: 'local',
      owningSpaceId: bootstrap.space.id,
      repositoryId: null,
      repositorySubpath: null,
      status: 'active',
    });
    await kernel.attachProjectRepository({
      projectId,
      repositoryId,
      repositorySubpath: null,
      spaceId: bootstrap.space.id,
    });
    await kernel.upsertCheckout(bootstrap.space.id, {
      deviceId: bootstrap.device.id,
      id: createCheckoutId(),
      lastObservedAt: observedAt,
      localPath: '/synthetic/checkout',
      observedRemote: 'git@github.com:example/synthetic.git',
      projectId,
      repositoryId,
      status: 'available',
    });

    const authorizer = createSingleUserAuthorizer({
      listKnownResources: async () =>
        (await kernel.memory.listAuthorizationResourceIds(bootstrap.space.id)).map((id) => ({
          id,
          kind: 'memory' as const,
          spaceId: bootstrap.space.id,
        })),
      localPersonId: bootstrap.person.id,
      personalSpaceId: bootstrap.space.id,
    });
    const service = createMemoryApplicationService(authorizer, kernel.memory, clock);
    const authorization = { activeSpaceId: bootstrap.space.id, trustedDevice: true } as const;
    const principal = { kind: 'person' as const, personId: bootstrap.person.id };
    const itemIds: MemoryItemId[] = [];
    for (const title of ['First synthetic decision', 'Second synthetic decision']) {
      const evidence = { source: title };
      const observation = await service.recordObservation({
        authorization,
        captureContextId: null,
        content: evidence,
        fingerprint: memoryFingerprint(evidence),
        principal,
        projectId: null,
        sensitivity: 'normal',
        sourceKind: 'user',
        sourceLocator: 'synthetic:migration',
      });
      if (observation.kind !== 'success') {
        throw new Error('Synthetic observation was not recorded.');
      }
      const proposal = await service.createProposal({
        authorization,
        guidance: ['Synthetic guidance.'],
        observationIds: [observation.value.id],
        principal,
        projectId: null,
        proposedKind: 'decision',
        sensitivity: 'normal',
        structuredContent: { synthetic: true },
        summary: `${title} summary.`,
        title,
        trustCandidate: 'harvest-accepted',
      });
      if (proposal.kind !== 'success') {
        throw new Error('Synthetic proposal was not created.');
      }
      const accepted = await service.acceptProposal({
        authorization,
        principal,
        proposalId: proposal.value,
        scope: 'space',
        spaceId: bootstrap.space.id,
      });
      if (accepted.kind !== 'success') {
        throw new Error('Synthetic proposal was not accepted.');
      }
      itemIds.push(accepted.value.item.id);
    }
    const [fromMemoryItemId, toMemoryItemId] = itemIds;
    if (fromMemoryItemId === undefined || toMemoryItemId === undefined) {
      throw new Error('Synthetic Memory items were not created.');
    }
    const relation = await service.createRelation({
      authorization,
      fromMemoryItemId,
      kind: 'related-to',
      principal,
      reason: null,
      spaceId: bootstrap.space.id,
      toMemoryItemId,
    });
    if (relation.kind !== 'success') {
      throw new Error('Synthetic Memory relation was not created.');
    }
    const configured = await kernel.configureReplication({
      captureContext: {
        deviceId: createDeviceId(),
        id: createCaptureContextId(),
        personId: createPersonId(),
        projectId: null,
        scmAccountId: null,
        scmInstallationId: null,
        source: 'personal-fallback',
        spaceId: createSpaceId(),
      },
      configuredAt: clock(),
      localProjectId: null,
      localSpaceId: bootstrap.space.id,
    });
    if (configured.backfilled !== 2 || configured.unchanged !== 0 || configured.nextCursor !== null) {
      throw new Error('Synthetic Memory outbox was not backfilled.');
    }
    return await kernel.getBootstrapIdentity();
  } finally {
    await kernel.close();
  }
};

const seededTables = [
  'checkouts',
  'local_identity_metadata',
  'memory_items',
  'memory_relations',
  'memory_revisions',
  'replication_outbox_events',
  'replication_outbox_state',
  'repositories',
] as const;

const seededShape = {
  rowCounts: {
    checkouts: 1,
    local_identity_metadata: 1,
    memory_items: 2,
    memory_relations: 1,
    memory_revisions: 2,
    replication_outbox_events: 2,
    replication_outbox_state: 1,
    repositories: 1,
  },
  spaceScopedRepositoryIndex: true,
  userVersion: LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION,
};

const shapeOf = (snapshot: StoreSnapshot): typeof seededShape => ({
  rowCounts: Object.fromEntries(seededTables.map((table) => [table, snapshot.rows[table]?.length])) as Record<
    (typeof seededTables)[number],
    number
  >,
  spaceScopedRepositoryIndex: repositoryIndexSql(snapshot)?.includes(spaceScopedRepositoryIndexClause) === true,
  userVersion: snapshot.userVersion,
});

interface OpenedStore {
  readonly acknowledgedThroughGeneration: number;
  readonly identity: LocalIdentityBootstrap;
  readonly pending: number;
}

const openStore = async (databasePath: string): Promise<OpenedStore> => {
  const kernel = await openLocalIdentityKernel({ clock, databasePath });
  try {
    const status = kernel.replication.status();
    return {
      acknowledgedThroughGeneration: status.acknowledgedThroughGeneration,
      identity: await kernel.getBootstrapIdentity(),
      pending: status.pending,
    };
  } finally {
    await kernel.close();
  }
};

describe('local Memory store migration', () => {
  test('rebuilds the pre-b949af04 repository index when carrying a version-5 store to version 6', async () => {
    const databasePath = await databaseFixture();
    const identity = await seedStore(databasePath);
    const seeded = snapshotStore(databasePath);
    expect(shapeOf(seeded)).toEqual(seededShape);

    rewriteStore(
      databasePath,
      `DROP INDEX repositories_provider_identity_unique; ${preB949af04RepositoryIndexSql} PRAGMA user_version = 5;`,
    );
    const legacy = snapshotStore(databasePath);
    expect(legacy.userVersion).toBe(5);
    expect(repositoryIndexSql(legacy)).toContain('ON repositories (provider, provider_repository_id)');
    expect(legacy.rows).toEqual(seeded.rows);

    expect(await openStore(databasePath)).toEqual({ acknowledgedThroughGeneration: 0, identity, pending: 2 });

    const migrated = snapshotStore(databasePath);
    expect(migrated.userVersion).toBe(LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION);
    expect(repositoryIndexSql(migrated)).toContain(spaceScopedRepositoryIndexClause);
    expect(migrated).toEqual(seeded);
    expect(readConsistency(databasePath)).toEqual(consistent);
  });

  test('carries a current version-5 store to version 6 without re-bootstrapping and stays idempotent', async () => {
    const databasePath = await databaseFixture();
    const identity = await seedStore(databasePath);
    const seeded = snapshotStore(databasePath);
    expect(shapeOf(seeded)).toEqual(seededShape);

    rewriteStore(databasePath, 'PRAGMA user_version = 5;');
    expect(snapshotStore(databasePath)).toEqual({ ...seeded, userVersion: 5 });

    expect(await openStore(databasePath)).toEqual({ acknowledgedThroughGeneration: 0, identity, pending: 2 });
    expect(snapshotStore(databasePath)).toEqual(seeded);

    expect(await openStore(databasePath)).toEqual({ acknowledgedThroughGeneration: 0, identity, pending: 2 });
    expect(snapshotStore(databasePath)).toEqual(seeded);
    expect(readConsistency(databasePath)).toEqual(consistent);
  });

  test('refuses a newer store with a typed error and leaves it untouched', async () => {
    const databasePath = await databaseFixture();
    await seedStore(databasePath);
    rewriteStore(databasePath, `PRAGMA user_version = ${LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION + 1};`);
    const newer = snapshotStore(databasePath);
    expect(newer.userVersion).toBe(LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION + 1);

    await expect(openLocalIdentityKernel({ clock, databasePath })).rejects.toMatchObject({
      code: 'migration-incompatible',
      name: 'MemoryIdentityStoreError',
      operation: 'read-schema-version',
    });

    expect(snapshotStore(databasePath)).toEqual(newer);
  });

  test('rolls the version-6 rebuild back when the index name is taken and succeeds once the conflict is removed', async () => {
    const databasePath = await databaseFixture();
    const identity = await seedStore(databasePath);
    const seeded = snapshotStore(databasePath);
    expect(shapeOf(seeded)).toEqual(seededShape);

    rewriteStore(
      databasePath,
      `DROP INDEX repositories_provider_identity_unique;
       CREATE TABLE repositories_provider_identity_unique (marker TEXT NOT NULL) STRICT;
       PRAGMA user_version = 5;`,
    );
    const conflicting = snapshotStore(databasePath);
    expect(conflicting.userVersion).toBe(5);
    expect(conflicting.schema.find((object) => object.name === 'repositories_provider_identity_unique')?.type).toBe(
      'table',
    );

    await expect(openLocalIdentityKernel({ clock, databasePath })).rejects.toMatchObject({
      code: 'storage-failed',
      name: 'MemoryIdentityStoreError',
      operation: 'initialize-identity-kernel',
    });
    expect(snapshotStore(databasePath)).toEqual(conflicting);

    rewriteStore(
      databasePath,
      `DROP TABLE repositories_provider_identity_unique; ${preB949af04RepositoryIndexSql} PRAGMA user_version = 5;`,
    );
    expect(await openStore(databasePath)).toEqual({ acknowledgedThroughGeneration: 0, identity, pending: 2 });
    expect(snapshotStore(databasePath)).toEqual(seeded);
    expect(readConsistency(databasePath)).toEqual(consistent);
  });
});
