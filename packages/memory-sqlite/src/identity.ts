import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open as openFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryRepository } from '@ai-usage/memory-service/repository';
import {
  type Checkout,
  type CheckoutId,
  createDeviceId,
  createPersonId,
  createProjectId,
  createSpaceId,
  type Device,
  type Instant,
  instantNow,
  type Person,
  type Project,
  type ProjectId,
  parseCheckoutId,
  parseDeviceId,
  parseInstant,
  parsePersonId,
  parseProjectId,
  parseRepositoryAliasId,
  parseRepositoryId,
  parseSpaceId,
  type Repository,
  type RepositoryAlias,
  type RepositoryId,
  type Space,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import type { ProjectSourceMapping } from '@ai-usage/project-registry/mapping';
import {
  normalizeRepositoryAlias,
  type RepositoryResolution,
  type RepositoryResolutionCandidate,
} from '@ai-usage/project-registry/resolution';
import type {
  CheckoutResolutionAction,
  CheckoutResolutionActionResult,
  CheckoutResolutionReview,
} from '@ai-usage/project-registry/review';
import type { SqliteReplicationOutbox } from '@ai-usage/replication-outbox';
import { asMemoryIdentityStoreError, MemoryIdentityStoreError } from './errors';
import { createSqliteMemoryRepository } from './memory';
import {
  type BackfillLocalMemoryReplicationInput,
  backfillLocalMemoryReplication,
  type ConfigureLocalMemoryReplicationInput,
  type ConfigureLocalMemoryReplicationResult,
  configureLocalMemoryReplication,
  initializeLocalMemoryReplication,
  migrateLegacyMemoryReplicationOutbox,
} from './replication';
import {
  LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION,
  localMemoryDomainSchema,
  localMemoryIdentitySchema,
  localMemoryImportStateSchema,
  localMemoryProposalAcceptanceLinkUpgrade,
  localMemoryReplicationPublicationSchema,
  localMemorySearchSchema,
} from './schema';

export interface LocalIdentityBootstrap {
  readonly device: Device;
  readonly person: Person;
  readonly space: Space;
}

export interface OpenLocalIdentityKernelOptions {
  readonly clock?: () => Date;
  readonly databasePath: string;
  readonly deviceLabel?: string;
  readonly personDisplayName?: string;
  readonly spaceDisplayName?: string;
}

export interface RepositoryIdentityUpdate {
  readonly canonicalHost: string;
  readonly canonicalName: string;
  readonly canonicalOwner: string | null;
  readonly eventType: 'repository-renamed' | 'repository-transferred';
  readonly repositoryId: RepositoryId;
  readonly spaceId: SpaceId;
  readonly status: Repository['status'];
}

export interface LocalIdentityKernel {
  readonly acknowledgeProjectSourceMapping: (mapping: ProjectSourceMapping, spaceId: SpaceId) => Promise<void>;
  readonly applyResolutionAction: (action: CheckoutResolutionAction) => Promise<CheckoutResolutionActionResult>;
  readonly attachProjectRepository: (input: {
    readonly projectId: ProjectId;
    readonly repositoryId: RepositoryId;
    readonly repositorySubpath: string | null;
    readonly spaceId: SpaceId;
  }) => Promise<void>;
  readonly backfillReplication: (
    input: BackfillLocalMemoryReplicationInput,
  ) => Promise<ConfigureLocalMemoryReplicationResult>;
  readonly backupTo: (destinationPath: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly configureReplication: (
    input: ConfigureLocalMemoryReplicationInput,
  ) => Promise<ConfigureLocalMemoryReplicationResult>;
  readonly createProject: (project: Project) => Promise<void>;
  readonly createRepositoryWithAlias: (repository: Repository, alias: RepositoryAlias) => Promise<void>;
  readonly findProjectSourceMapping: (
    spaceId: SpaceId,
    projectSourceId: string,
  ) => Promise<ProjectSourceMapping | null>;
  readonly getBootstrapIdentity: () => Promise<LocalIdentityBootstrap>;
  readonly listRepositoryCandidates: (spaceId: SpaceId) => Promise<readonly RepositoryResolutionCandidate[]>;
  readonly listResolutionReviews: (spaceId: SpaceId) => Promise<readonly CheckoutResolutionReview[]>;
  readonly memory: MemoryRepository;
  readonly recordRepositoryResolution: (
    spaceId: SpaceId,
    checkoutId: CheckoutId,
    resolution: RepositoryResolution,
  ) => Promise<void>;
  readonly replication: SqliteReplicationOutbox;
  readonly updateRepositoryIdentity: (input: RepositoryIdentityUpdate) => Promise<void>;
  readonly upsertCheckout: (spaceId: SpaceId, checkout: Checkout) => Promise<void>;
}

interface MetadataRow {
  readonly device_id: unknown;
  readonly person_id: unknown;
  readonly personal_space_id: unknown;
}

interface SpaceRow {
  readonly created_at: unknown;
  readonly display_name: unknown;
  readonly id: unknown;
  readonly kind: unknown;
}

interface PersonRow {
  readonly display_name: unknown;
  readonly id: unknown;
  readonly personal_space_id: unknown;
  readonly status: unknown;
}

interface DeviceRow {
  readonly id: unknown;
  readonly label: unknown;
  readonly last_seen_at: unknown;
  readonly owner_person_id: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}

interface RepositoryRow {
  readonly canonical_host: unknown;
  readonly canonical_name: unknown;
  readonly canonical_owner: unknown;
  readonly id: unknown;
  readonly provider: unknown;
  readonly provider_repository_id: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}

interface RepositoryAliasRow {
  readonly first_observed_at: unknown;
  readonly id: unknown;
  readonly last_observed_at: unknown;
  readonly normalized_remote: unknown;
  readonly repository_id: unknown;
  readonly source: unknown;
  readonly space_id: unknown;
}

interface ProjectSourceMappingRow {
  readonly acknowledged_at: unknown;
  readonly checkout_id: unknown;
  readonly project_id: unknown;
  readonly project_source_id: unknown;
}

interface CheckoutReviewRow {
  readonly checkout_id: unknown;
  readonly device_id: unknown;
  readonly device_label: unknown;
  readonly observed_remote: unknown;
  readonly resolution_status: unknown;
}

interface CheckoutCandidateRow {
  readonly canonical_host: unknown;
  readonly canonical_name: unknown;
  readonly canonical_owner: unknown;
  readonly checkout_id: unknown;
  readonly repository_id: unknown;
}

const requiredText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryIdentityStoreError('validation-failed', 'map-storage-row');
  }
  return value;
};

const nullableText = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }
  return requiredText(value);
};

const nullableInstant = (value: unknown): Instant | null => (value === null ? null : parseInstant(value));

const mapSpace = (row: SpaceRow): Space => {
  if (row.kind !== 'personal') {
    throw new MemoryIdentityStoreError('validation-failed', 'map-space');
  }
  return {
    createdAt: parseInstant(row.created_at),
    displayName: requiredText(row.display_name),
    id: parseSpaceId(row.id),
    kind: row.kind,
  };
};

const mapPerson = (row: PersonRow): Person => {
  if (row.status !== 'active' && row.status !== 'suspended') {
    throw new MemoryIdentityStoreError('validation-failed', 'map-person');
  }
  return {
    displayName: requiredText(row.display_name),
    id: parsePersonId(row.id),
    personalSpaceId: parseSpaceId(row.personal_space_id),
    status: row.status,
  };
};

const mapDevice = (row: DeviceRow): Device => {
  if (row.status !== 'local' && row.status !== 'pending' && row.status !== 'active' && row.status !== 'revoked') {
    throw new MemoryIdentityStoreError('validation-failed', 'map-device');
  }
  return {
    id: parseDeviceId(row.id),
    label: requiredText(row.label),
    lastSeenAt: nullableInstant(row.last_seen_at),
    ownerPersonId: parsePersonId(row.owner_person_id),
    owningSpaceId: parseSpaceId(row.space_id),
    status: row.status,
  };
};

const mapRepository = (row: RepositoryRow): Repository => {
  if (
    (row.provider !== 'github' && row.provider !== 'gitlab' && row.provider !== 'generic') ||
    (row.status !== 'active' && row.status !== 'renamed' && row.status !== 'archived' && row.status !== 'unknown')
  ) {
    throw new MemoryIdentityStoreError('validation-failed', 'map-repository');
  }
  return {
    canonicalHost: requiredText(row.canonical_host),
    canonicalName: requiredText(row.canonical_name),
    canonicalOwner: nullableText(row.canonical_owner),
    id: parseRepositoryId(row.id),
    owningSpaceId: parseSpaceId(row.space_id),
    provider: row.provider,
    providerRepositoryId: nullableText(row.provider_repository_id),
    status: row.status,
  };
};

const mapRepositoryAlias = (row: RepositoryAliasRow): RepositoryAlias => {
  if (row.source !== 'local-git' && row.source !== 'provider-api' && row.source !== 'manual') {
    throw new MemoryIdentityStoreError('validation-failed', 'map-repository-alias');
  }
  return {
    firstObservedAt: parseInstant(row.first_observed_at),
    id: parseRepositoryAliasId(row.id),
    lastObservedAt: nullableInstant(row.last_observed_at),
    normalizedRemote: requiredText(row.normalized_remote),
    owningSpaceId: parseSpaceId(row.space_id),
    repositoryId: parseRepositoryId(row.repository_id),
    source: row.source,
  };
};

const openDatabase = async (databasePath: string): Promise<Database> => {
  if (!path.isAbsolute(databasePath)) {
    throw new MemoryIdentityStoreError('configuration-invalid', 'open-database');
  }
  await mkdir(path.dirname(databasePath), { mode: 0o700, recursive: true });
  const database = new Database(databasePath, { create: true, strict: true });
  await chmod(databasePath, 0o600);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return database;
};

const bootstrapDatabase = (database: Database, options: OpenLocalIdentityKernelOptions): void => {
  const versionRow = database.query('PRAGMA user_version').get() as { user_version?: unknown } | null;
  const version = versionRow?.user_version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'read-schema-version');
  }
  if (version > LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'read-schema-version');
  }
  if (version === LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION) {
    return;
  }

  const isNewDatabase = version === 0;
  const spaceId = createSpaceId();
  const personId = createPersonId();
  const deviceId = createDeviceId();
  const createdAt = instantNow(options.clock);
  const migrate = database.transaction(() => {
    if (isNewDatabase) {
      database.exec(localMemoryIdentitySchema);
      database
        .query('INSERT INTO spaces (id, kind, display_name, created_at) VALUES ($id, $kind, $displayName, $createdAt)')
        .run({
          createdAt,
          displayName: options.spaceDisplayName ?? 'Personal',
          id: spaceId,
          kind: 'personal',
        });
      database
        .query(
          'INSERT INTO people (id, display_name, personal_space_id, status) VALUES ($id, $displayName, $spaceId, $status)',
        )
        .run({
          displayName: options.personDisplayName ?? 'Local person',
          id: personId,
          spaceId,
          status: 'active',
        });
      database
        .query(
          `INSERT INTO devices (id, owner_person_id, space_id, label, status)
           VALUES ($id, $personId, $spaceId, $label, $status)`,
        )
        .run({
          id: deviceId,
          label: options.deviceLabel ?? 'Local device',
          personId,
          spaceId,
          status: 'local',
        });
      database
        .query(
          `INSERT INTO local_identity_metadata (singleton, person_id, personal_space_id, device_id)
           VALUES (1, $personId, $spaceId, $deviceId)`,
        )
        .run({ deviceId, personId, spaceId });
    }
    if (version < 2) {
      database.exec(localMemoryDomainSchema);
    }
    if (version < 3) {
      if (version === 2) {
        database.exec(localMemoryProposalAcceptanceLinkUpgrade);
      }
      database.exec(localMemoryImportStateSchema);
    }
    if (version < 4) {
      database.exec(localMemorySearchSchema);
    }
    if (version < 5 && version >= 2) {
      migrateLegacyMemoryReplicationOutbox(database, createdAt);
    }
    database.exec(localMemoryReplicationPublicationSchema);
    database.exec(`PRAGMA user_version = ${LOCAL_MEMORY_IDENTITY_SCHEMA_VERSION}`);
  });
  migrate.immediate();
};

const readBootstrap = (database: Database): LocalIdentityBootstrap => {
  const metadata = database
    .query('SELECT person_id, personal_space_id, device_id FROM local_identity_metadata')
    .get() as MetadataRow | null;
  if (!metadata) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'read-bootstrap');
  }
  const spaceId = parseSpaceId(metadata.personal_space_id);
  const personId = parsePersonId(metadata.person_id);
  const deviceId = parseDeviceId(metadata.device_id);
  const space = database
    .query('SELECT id, kind, display_name, created_at FROM spaces WHERE id = $id')
    .get({ id: spaceId }) as SpaceRow | null;
  const person = database
    .query('SELECT id, display_name, personal_space_id, status FROM people WHERE id = $id')
    .get({ id: personId }) as PersonRow | null;
  const device = database
    .query('SELECT id, owner_person_id, space_id, label, status, last_seen_at FROM devices WHERE id = $id')
    .get({ id: deviceId }) as DeviceRow | null;
  if (!(space && person && device)) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'read-bootstrap');
  }
  const mapped = { device: mapDevice(device), person: mapPerson(person), space: mapSpace(space) };
  if (
    mapped.person.personalSpaceId !== mapped.space.id ||
    mapped.device.ownerPersonId !== mapped.person.id ||
    mapped.device.owningSpaceId !== mapped.space.id
  ) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'read-bootstrap');
  }
  return mapped;
};

export const openLocalIdentityKernel = async (
  options: OpenLocalIdentityKernelOptions,
): Promise<LocalIdentityKernel> => {
  let database: Database | undefined;
  let replication: SqliteReplicationOutbox | undefined;
  try {
    database = await openDatabase(options.databasePath);
    bootstrapDatabase(database, options);
    readBootstrap(database);
    replication = initializeLocalMemoryReplication(database, instantNow(options.clock));
  } catch (error) {
    try {
      database?.close(false);
    } catch {
      // Preserve the typed initialization failure when best-effort cleanup also fails.
    }
    throw asMemoryIdentityStoreError(error, 'storage-failed', 'initialize-identity-kernel');
  }
  const openedDatabase = database;
  const memory = createSqliteMemoryRepository(openedDatabase);
  const openedReplication = replication;

  let lifecycle: 'closed' | 'open' = 'open';
  const requireOpen = (): Database => {
    if (lifecycle !== 'open') {
      throw new MemoryIdentityStoreError('closed', 'use-identity-kernel');
    }
    return openedDatabase;
  };
  const storageOperation = <Value>(operation: string, run: (openDatabase: Database) => Value): Promise<Value> => {
    try {
      return Promise.resolve(run(requireOpen()));
    } catch (error) {
      return Promise.reject(asMemoryIdentityStoreError(error, 'storage-failed', operation));
    }
  };

  const kernel: LocalIdentityKernel = {
    acknowledgeProjectSourceMapping: (mapping, spaceId) =>
      storageOperation('acknowledge-project-source-mapping', (open) => {
        open
          .query(
            `INSERT INTO project_source_mappings
              (space_id, project_source_id, project_id, checkout_id, acknowledged_at)
             VALUES ($spaceId, $sourceId, $projectId, $checkoutId, $acknowledgedAt)
             ON CONFLICT (space_id, project_source_id) DO UPDATE SET
               project_id = excluded.project_id,
               checkout_id = excluded.checkout_id,
               acknowledged_at = excluded.acknowledged_at`,
          )
          .run({
            acknowledgedAt: mapping.acknowledgedAt,
            checkoutId: mapping.checkoutId,
            projectId: mapping.projectId,
            sourceId: mapping.projectSourceId,
            spaceId,
          });
      }),
    backfillReplication: (input) =>
      storageOperation('backfill-replication', (open) => backfillLocalMemoryReplication(open, input)),
    applyResolutionAction: (action) =>
      storageOperation('apply-resolution-action', (open) => {
        const reviewedAt = instantNow(options.clock);
        const apply = open.transaction((): CheckoutResolutionActionResult => {
          let result: CheckoutResolutionActionResult;
          if (action.kind === 'create-project') {
            const displayName = action.displayName.trim();
            if (displayName.length === 0 || displayName.length > 256) {
              throw new MemoryIdentityStoreError('validation-failed', 'apply-resolution-action');
            }
            const projectId = createProjectId();
            open
              .query(
                `INSERT INTO projects
                  (id, space_id, kind, display_name, repository_id, repository_subpath, status)
                 VALUES ($projectId, $spaceId, 'local', $displayName, NULL, NULL, 'active')`,
              )
              .run({ displayName, projectId, spaceId: action.spaceId });
            const updated = open
              .query(
                `UPDATE checkouts
                 SET project_id = $projectId, repository_id = NULL,
                     resolution_status = 'unassigned', resolution_reviewed_at = $reviewedAt
                 WHERE id = $checkoutId AND space_id = $spaceId`,
              )
              .run({ checkoutId: action.checkoutId, projectId, reviewedAt, spaceId: action.spaceId });
            if (updated.changes !== 1) {
              throw new MemoryIdentityStoreError('validation-failed', 'apply-resolution-action');
            }
            result = { kind: 'project-created', projectId };
          } else if (action.kind === 'link') {
            if (action.projectId !== null) {
              const project = open
                .query('SELECT repository_id FROM projects WHERE id = $projectId AND space_id = $spaceId')
                .get({ projectId: action.projectId, spaceId: action.spaceId }) as {
                readonly repository_id: unknown;
              } | null;
              if (!project || (project.repository_id !== null && project.repository_id !== action.repositoryId)) {
                throw new MemoryIdentityStoreError('validation-failed', 'apply-resolution-action');
              }
              if (project.repository_id === null) {
                open
                  .query(
                    `UPDATE projects
                     SET kind = 'repository', repository_id = $repositoryId
                     WHERE id = $projectId AND space_id = $spaceId`,
                  )
                  .run({ projectId: action.projectId, repositoryId: action.repositoryId, spaceId: action.spaceId });
              }
            }
            const updated = open
              .query(
                `UPDATE checkouts
                 SET project_id = $projectId, repository_id = $repositoryId,
                     resolution_status = 'resolved', resolution_reviewed_at = $reviewedAt
                 WHERE id = $checkoutId AND space_id = $spaceId`,
              )
              .run({
                checkoutId: action.checkoutId,
                projectId: action.projectId,
                repositoryId: action.repositoryId,
                reviewedAt,
                spaceId: action.spaceId,
              });
            if (updated.changes !== 1) {
              throw new MemoryIdentityStoreError('validation-failed', 'apply-resolution-action');
            }
            result = {
              kind: 'linked',
              projectId: action.projectId,
              repositoryId: action.repositoryId,
            };
          } else {
            const updated = open
              .query(
                `UPDATE checkouts
                 SET repository_id = NULL, resolution_status = 'unassigned',
                     resolution_reviewed_at = $reviewedAt
                 WHERE id = $checkoutId AND space_id = $spaceId`,
              )
              .run({ checkoutId: action.checkoutId, reviewedAt, spaceId: action.spaceId });
            if (updated.changes !== 1) {
              throw new MemoryIdentityStoreError('validation-failed', 'apply-resolution-action');
            }
            result = { kind: 'left-unassigned' };
          }
          open
            .query(
              `DELETE FROM checkout_resolution_candidates
               WHERE checkout_id = $checkoutId AND space_id = $spaceId`,
            )
            .run({ checkoutId: action.checkoutId, spaceId: action.spaceId });
          return result;
        });
        return apply.immediate();
      }),
    attachProjectRepository: (input) =>
      storageOperation('attach-project-repository', (open) => {
        const update = open.transaction(() => {
          const result = open
            .query(
              `UPDATE projects
               SET kind = 'repository', repository_id = $repositoryId, repository_subpath = $subpath
               WHERE id = $projectId AND space_id = $spaceId`,
            )
            .run({
              projectId: input.projectId,
              repositoryId: input.repositoryId,
              spaceId: input.spaceId,
              subpath: input.repositorySubpath,
            });
          if (result.changes !== 1) {
            throw new MemoryIdentityStoreError('validation-failed', 'attach-project-repository');
          }
          open
            .query(
              `INSERT INTO identity_events
                (id, space_id, event_type, subject_type, subject_id, recorded_at)
               VALUES ($id, $spaceId, 'project-repository-attached', 'project', $projectId, $recordedAt)`,
            )
            .run({
              id: randomUUID(),
              projectId: input.projectId,
              recordedAt: instantNow(options.clock),
              spaceId: input.spaceId,
            });
        });
        update.immediate();
      }),
    backupTo: async (destinationPath) => {
      const operation = 'backup-memory-database';
      if (!path.isAbsolute(destinationPath) || path.resolve(destinationPath) === path.resolve(options.databasePath)) {
        throw new MemoryIdentityStoreError('configuration-invalid', operation);
      }
      let temporaryPath: string | null = null;
      let output: Awaited<ReturnType<typeof openFile>> | null = null;
      try {
        const serialized = requireOpen().serialize();
        temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
        output = await openFile(temporaryPath, 'wx', 0o600);
        await output.writeFile(serialized);
        await output.sync();
        await output.close();
        output = null;
        await link(temporaryPath, destinationPath);
        const parent = await openFile(path.dirname(destinationPath), 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
        await unlink(temporaryPath);
        temporaryPath = null;
      } catch (error) {
        await output?.close().catch(() => undefined);
        if (temporaryPath !== null) {
          await unlink(temporaryPath).catch(() => undefined);
        }
        throw asMemoryIdentityStoreError(error, 'storage-failed', operation);
      }
    },
    close: (): Promise<void> => {
      if (lifecycle === 'closed') {
        return Promise.resolve();
      }
      lifecycle = 'closed';
      try {
        openedDatabase.close(false);
        return Promise.resolve();
      } catch {
        return Promise.reject(new MemoryIdentityStoreError('storage-failed', 'close-identity-kernel'));
      }
    },
    configureReplication: (input) =>
      storageOperation('configure-replication', (open) => configureLocalMemoryReplication(open, input)),
    createProject: (project) =>
      storageOperation('create-project', (open) => {
        open
          .query(
            `INSERT INTO projects
              (id, space_id, kind, display_name, repository_id, repository_subpath, status)
             VALUES ($id, $spaceId, $kind, $displayName, $repositoryId, $subpath, $status)`,
          )
          .run({
            displayName: project.displayName,
            id: project.id,
            kind: project.kind,
            repositoryId: project.repositoryId,
            spaceId: project.owningSpaceId,
            status: project.status,
            subpath: project.repositorySubpath,
          });
      }),
    createRepositoryWithAlias: (repository, alias) =>
      storageOperation('create-repository-with-alias', (open) => {
        if (repository.owningSpaceId !== alias.owningSpaceId || repository.id !== alias.repositoryId) {
          throw new MemoryIdentityStoreError('validation-failed', 'create-repository-with-alias');
        }
        const create = open.transaction(() => {
          open
            .query(
              `INSERT INTO repositories
                (id, space_id, provider, provider_repository_id, canonical_host, canonical_owner, canonical_name, status)
               VALUES ($id, $spaceId, $provider, $providerId, $host, $owner, $name, $status)`,
            )
            .run({
              host: repository.canonicalHost,
              id: repository.id,
              name: repository.canonicalName,
              owner: repository.canonicalOwner,
              provider: repository.provider,
              providerId: repository.providerRepositoryId,
              spaceId: repository.owningSpaceId,
              status: repository.status,
            });
          open
            .query(
              `INSERT INTO repository_aliases
                (id, space_id, repository_id, normalized_remote, source, first_observed_at, last_observed_at)
               VALUES ($id, $spaceId, $repositoryId, $remote, $source, $firstObservedAt, $lastObservedAt)`,
            )
            .run({
              firstObservedAt: alias.firstObservedAt,
              id: alias.id,
              lastObservedAt: alias.lastObservedAt,
              remote: alias.normalizedRemote,
              repositoryId: alias.repositoryId,
              source: alias.source,
              spaceId: alias.owningSpaceId,
            });
        });
        create.immediate();
      }),
    findProjectSourceMapping: (spaceId, projectSourceId) =>
      storageOperation('find-project-source-mapping', (open) => {
        const row = open
          .query(
            `SELECT project_source_id, project_id, checkout_id, acknowledged_at
             FROM project_source_mappings
             WHERE space_id = $spaceId AND project_source_id = $sourceId`,
          )
          .get({ sourceId: projectSourceId, spaceId }) as ProjectSourceMappingRow | null;
        if (!row) {
          return null;
        }
        return {
          acknowledgedAt: parseInstant(row.acknowledged_at),
          checkoutId: parseCheckoutId(row.checkout_id),
          projectId: parseProjectId(row.project_id),
          projectSourceId: requiredText(row.project_source_id),
        };
      }),
    getBootstrapIdentity: () => storageOperation('get-bootstrap-identity', readBootstrap),
    listRepositoryCandidates: (spaceId) =>
      storageOperation('list-repository-candidates', (open) => {
        const repositories = open
          .query(
            `SELECT id, space_id, provider, provider_repository_id, canonical_host,
                    canonical_owner, canonical_name, status
             FROM repositories WHERE space_id = $spaceId ORDER BY id`,
          )
          .all({ spaceId }) as RepositoryRow[];
        const aliases = open
          .query(
            `SELECT id, space_id, repository_id, normalized_remote, source,
                    first_observed_at, last_observed_at
             FROM repository_aliases WHERE space_id = $spaceId ORDER BY id`,
          )
          .all({ spaceId }) as RepositoryAliasRow[];
        const mappedAliases = aliases.map(mapRepositoryAlias);
        return repositories.map((row) => {
          const repository = mapRepository(row);
          return {
            aliases: mappedAliases.filter((alias) => alias.repositoryId === repository.id),
            repository,
          };
        });
      }),
    listResolutionReviews: (spaceId) =>
      storageOperation('list-resolution-reviews', (open) => {
        const reviews = open
          .query(
            `SELECT checkouts.id AS checkout_id, checkouts.device_id, devices.label AS device_label,
                    checkouts.observed_remote, checkouts.resolution_status
             FROM checkouts
             JOIN devices ON devices.id = checkouts.device_id
             WHERE checkouts.space_id = $spaceId
               AND checkouts.resolution_status IN ('ambiguous', 'candidate', 'unassigned')
               AND checkouts.resolution_reviewed_at IS NULL
             ORDER BY checkouts.id
             LIMIT 101`,
          )
          .all({ spaceId }) as CheckoutReviewRow[];
        const candidates = open
          .query(
            `SELECT checkout_resolution_candidates.checkout_id,
                    repositories.id AS repository_id,
                    repositories.canonical_host,
                    repositories.canonical_owner,
                    repositories.canonical_name
             FROM checkout_resolution_candidates
             JOIN repositories ON repositories.id = checkout_resolution_candidates.repository_id
             WHERE checkout_resolution_candidates.space_id = $spaceId
             ORDER BY checkout_resolution_candidates.checkout_id, repositories.id
             LIMIT 1001`,
          )
          .all({ spaceId }) as CheckoutCandidateRow[];
        if (reviews.length > 100 || candidates.length > 1000) {
          throw new MemoryIdentityStoreError('validation-failed', 'list-resolution-reviews');
        }
        return reviews.map((row): CheckoutResolutionReview => {
          if (
            row.resolution_status !== 'ambiguous' &&
            row.resolution_status !== 'candidate' &&
            row.resolution_status !== 'unassigned'
          ) {
            throw new MemoryIdentityStoreError('validation-failed', 'map-resolution-review');
          }
          const checkoutId = parseCheckoutId(row.checkout_id);
          return {
            candidateMatches: candidates
              .filter((candidate) => candidate.checkout_id === checkoutId)
              .map((candidate) => {
                const owner = nullableText(candidate.canonical_owner);
                return {
                  canonicalLabel: [
                    requiredText(candidate.canonical_host),
                    owner,
                    requiredText(candidate.canonical_name),
                  ]
                    .filter((part): part is string => part !== null)
                    .join('/'),
                  repositoryId: parseRepositoryId(candidate.repository_id),
                };
              }),
            checkoutId,
            destinationSpaceId: spaceId,
            deviceId: parseDeviceId(row.device_id),
            deviceLabel: requiredText(row.device_label),
            localLabel: `checkout:${checkoutId.slice(0, 8)}`,
            normalizedRemote: nullableText(row.observed_remote),
            status: row.resolution_status,
          };
        });
      }),
    memory,
    replication: openedReplication,
    recordRepositoryResolution: (spaceId, checkoutId, resolution) =>
      storageOperation('record-repository-resolution', (open) => {
        if (resolution.kind === 'invalid' || ('spaceId' in resolution && resolution.spaceId !== spaceId)) {
          throw new MemoryIdentityStoreError('validation-failed', 'record-repository-resolution');
        }
        const status = resolution.kind;
        const repositoryId = resolution.kind === 'resolved' ? resolution.repositoryId : null;
        const candidateIds = resolution.kind === 'ambiguous' ? resolution.candidateRepositoryIds : [];
        const record = open.transaction(() => {
          const updated = open
            .query(
              `UPDATE checkouts
               SET repository_id = $repositoryId, resolution_status = $status,
                   resolution_reviewed_at = NULL
               WHERE id = $checkoutId AND space_id = $spaceId`,
            )
            .run({ checkoutId, repositoryId, spaceId, status });
          if (updated.changes !== 1) {
            throw new MemoryIdentityStoreError('validation-failed', 'record-repository-resolution');
          }
          open
            .query(
              `DELETE FROM checkout_resolution_candidates
               WHERE checkout_id = $checkoutId AND space_id = $spaceId`,
            )
            .run({ checkoutId, spaceId });
          const insertCandidate = open.query(
            `INSERT INTO checkout_resolution_candidates (checkout_id, space_id, repository_id)
             VALUES ($checkoutId, $spaceId, $repositoryId)`,
          );
          for (const candidateId of candidateIds) {
            insertCandidate.run({ checkoutId, repositoryId: candidateId, spaceId });
          }
        });
        record.immediate();
      }),
    updateRepositoryIdentity: (input) =>
      storageOperation('update-repository-identity', (open) => {
        const update = open.transaction(() => {
          const result = open
            .query(
              `UPDATE repositories
               SET canonical_host = $host, canonical_owner = $owner,
                   canonical_name = $name, status = $status
               WHERE id = $repositoryId AND space_id = $spaceId`,
            )
            .run({
              host: input.canonicalHost,
              name: input.canonicalName,
              owner: input.canonicalOwner,
              repositoryId: input.repositoryId,
              spaceId: input.spaceId,
              status: input.status,
            });
          if (result.changes !== 1) {
            throw new MemoryIdentityStoreError('validation-failed', 'update-repository-identity');
          }
          open
            .query(
              `INSERT INTO identity_events
                (id, space_id, event_type, subject_type, subject_id, recorded_at)
               VALUES ($id, $spaceId, $eventType, 'repository', $repositoryId, $recordedAt)`,
            )
            .run({
              eventType: input.eventType,
              id: randomUUID(),
              recordedAt: instantNow(options.clock),
              repositoryId: input.repositoryId,
              spaceId: input.spaceId,
            });
        });
        update.immediate();
      }),
    upsertCheckout: (spaceId, checkout) =>
      storageOperation('upsert-checkout', (open) => {
        const observedRemote =
          checkout.observedRemote === null ? null : normalizeRepositoryAlias(checkout.observedRemote);
        if (checkout.observedRemote !== null && observedRemote === null) {
          throw new MemoryIdentityStoreError('validation-failed', 'upsert-checkout');
        }
        const result = open
          .query(
            `INSERT INTO checkouts
              (id, space_id, project_id, device_id, local_path, repository_id,
               observed_remote, status, last_observed_at)
             VALUES ($id, $spaceId, $projectId, $deviceId, $localPath, $repositoryId,
                     $observedRemote, $status, $lastObservedAt)
             ON CONFLICT (id) DO UPDATE SET
               project_id = excluded.project_id,
               device_id = excluded.device_id,
               local_path = excluded.local_path,
               repository_id = excluded.repository_id,
               observed_remote = excluded.observed_remote,
               status = excluded.status,
               last_observed_at = excluded.last_observed_at
             WHERE checkouts.space_id = excluded.space_id`,
          )
          .run({
            deviceId: checkout.deviceId,
            id: checkout.id,
            lastObservedAt: checkout.lastObservedAt,
            localPath: checkout.localPath,
            observedRemote,
            projectId: checkout.projectId,
            repositoryId: checkout.repositoryId,
            spaceId,
            status: checkout.status,
          });
        if (result.changes !== 1) {
          throw new MemoryIdentityStoreError('validation-failed', 'upsert-checkout');
        }
      }),
  };

  return Object.freeze(kernel);
};

export type { MemoryIdentityStoreErrorCode } from './errors';
export { MemoryIdentityStoreError } from './errors';
