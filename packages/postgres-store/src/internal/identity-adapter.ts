import {
  createProjectId,
  type Device,
  hasExactlyOneScmCredentialOwner,
  type Instant,
  type Person,
  type Project,
  parseCheckoutId,
  parseDeviceId,
  parseIdentityText,
  parseInstant,
  parsePersonId,
  parseProjectId,
  parseRepositoryAliasId,
  parseRepositoryId,
  parseSpaceId,
  type Repository,
  type RepositoryAlias,
  type ScmAccount,
  type ScmCredential,
  type ScmInstallation,
  type Space,
} from '@ai-usage/platform-core/identity';
import type { ProjectSourceMapping } from '@ai-usage/project-registry/mapping';
import { normalizeRepositoryAlias, type RepositoryResolutionCandidate } from '@ai-usage/project-registry/resolution';
import type { CheckoutResolutionActionResult, CheckoutResolutionReview } from '@ai-usage/project-registry/review';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { asPlatformStoreError, PlatformStoreError } from '../errors';
import type { PlatformIdentityStore, SharedPersonalIdentity, SharedRepositoryIdentityUpdate } from '../identity';

interface RepositoryRow extends QueryResultRow {
  readonly canonical_host: unknown;
  readonly canonical_name: unknown;
  readonly canonical_owner: unknown;
  readonly id: unknown;
  readonly provider: unknown;
  readonly provider_repository_id: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}

interface RepositoryAliasRow extends QueryResultRow {
  readonly first_observed_at: unknown;
  readonly id: unknown;
  readonly last_observed_at: unknown;
  readonly normalized_remote: unknown;
  readonly repository_id: unknown;
  readonly source: unknown;
  readonly space_id: unknown;
}

interface ProjectSourceMappingRow extends QueryResultRow {
  readonly acknowledged_at: unknown;
  readonly checkout_id: unknown;
  readonly project_id: unknown;
  readonly project_source_id: unknown;
}

interface CheckoutReviewRow extends QueryResultRow {
  readonly checkout_id: unknown;
  readonly device_id: unknown;
  readonly device_label: unknown;
  readonly observed_remote: unknown;
  readonly resolution_status: unknown;
}

interface CheckoutCandidateRow extends QueryResultRow {
  readonly canonical_host: unknown;
  readonly canonical_name: unknown;
  readonly canonical_owner: unknown;
  readonly checkout_id: unknown;
  readonly repository_id: unknown;
}

const requiredText = (value: unknown, field: string, maximumLength = 4096): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new PlatformStoreError('validation-failed', `map-${field}`);
  }
  return value;
};

const nullableText = (value: unknown, field: string): string | null =>
  value === null ? null : requiredText(value, field);

const mappedInstant = (value: unknown, field: string): Instant => {
  if (value instanceof Date) {
    return parseInstant(value.toISOString(), field);
  }
  return parseInstant(value, field);
};

const nullableMappedInstant = (value: unknown, field: string): Instant | null =>
  value === null ? null : mappedInstant(value, field);

const mapRepository = (row: RepositoryRow): Repository => {
  if (
    (row.provider !== 'github' && row.provider !== 'gitlab' && row.provider !== 'generic') ||
    (row.status !== 'active' && row.status !== 'renamed' && row.status !== 'archived' && row.status !== 'unknown')
  ) {
    throw new PlatformStoreError('validation-failed', 'map-repository');
  }
  return {
    canonicalHost: requiredText(row.canonical_host, 'canonical-host', 256),
    canonicalName: requiredText(row.canonical_name, 'canonical-name', 256),
    canonicalOwner: nullableText(row.canonical_owner, 'canonical-owner'),
    id: parseRepositoryId(row.id),
    owningSpaceId: parseSpaceId(row.space_id),
    provider: row.provider,
    providerRepositoryId: nullableText(row.provider_repository_id, 'provider-repository-id'),
    status: row.status,
  };
};

const mapRepositoryAlias = (row: RepositoryAliasRow): RepositoryAlias => {
  if (row.source !== 'local-git' && row.source !== 'provider-api' && row.source !== 'manual') {
    throw new PlatformStoreError('validation-failed', 'map-repository-alias');
  }
  return {
    firstObservedAt: mappedInstant(row.first_observed_at, 'firstObservedAt'),
    id: parseRepositoryAliasId(row.id),
    lastObservedAt: nullableMappedInstant(row.last_observed_at, 'lastObservedAt'),
    normalizedRemote: requiredText(row.normalized_remote, 'normalized-remote', 2048),
    owningSpaceId: parseSpaceId(row.space_id),
    repositoryId: parseRepositoryId(row.repository_id),
    source: row.source,
  };
};

const withTransaction = async <Value>(
  pool: Pool,
  operation: string,
  run: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  const client = await pool.connect().catch(() => {
    throw new PlatformStoreError('connection-failed', operation);
  });
  try {
    await client.query('BEGIN');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw asPlatformStoreError(error, 'validation-failed', operation);
  } finally {
    client.release();
  }
};

const validateSpace = (space: Space): void => {
  parseSpaceId(space.id);
  parseIdentityText(space.displayName, 'space.displayName');
  parseInstant(space.createdAt, 'space.createdAt');
  if (space.kind !== 'personal' && space.kind !== 'organization') {
    throw new PlatformStoreError('validation-failed', 'validate-space');
  }
};

const validatePerson = (person: Person): void => {
  parsePersonId(person.id);
  parseSpaceId(person.personalSpaceId);
  parseIdentityText(person.displayName, 'person.displayName');
  if (person.status !== 'active' && person.status !== 'suspended') {
    throw new PlatformStoreError('validation-failed', 'validate-person');
  }
};

const validateDevice = (device: Device): void => {
  parseDeviceId(device.id);
  parsePersonId(device.ownerPersonId);
  parseSpaceId(device.owningSpaceId);
  parseIdentityText(device.label, 'device.label');
  if (device.lastSeenAt !== null) {
    parseInstant(device.lastSeenAt, 'device.lastSeenAt');
  }
};

const validateRepository = (repository: Repository): void => {
  parseRepositoryId(repository.id);
  parseSpaceId(repository.owningSpaceId);
  parseIdentityText(repository.canonicalHost, 'repository.canonicalHost');
  parseIdentityText(repository.canonicalName, 'repository.canonicalName');
  if (repository.canonicalOwner !== null) {
    parseIdentityText(repository.canonicalOwner, 'repository.canonicalOwner', 1024);
  }
};

const validateProject = (project: Project): void => {
  parseProjectId(project.id);
  parseSpaceId(project.owningSpaceId);
  parseIdentityText(project.displayName, 'project.displayName');
  if (project.repositoryId !== null) {
    parseRepositoryId(project.repositoryId);
  }
};

const storageOperation = async <Value>(operation: string, run: () => Promise<Value>): Promise<Value> => {
  try {
    return await run();
  } catch (error) {
    throw asPlatformStoreError(error, 'validation-failed', operation);
  }
};

export const createPlatformIdentityStore = (pool: Pool): PlatformIdentityStore => ({
  acknowledgeProjectSourceMapping: (mapping, spaceId) =>
    storageOperation('acknowledge-project-source-mapping', async () => {
      parseSpaceId(spaceId);
      parseProjectId(mapping.projectId);
      parseCheckoutId(mapping.checkoutId);
      parseInstant(mapping.acknowledgedAt);
      requiredText(mapping.projectSourceId, 'project-source-id');
      await pool.query(
        `INSERT INTO project_source_mappings
          (space_id, project_source_id, project_id, checkout_id, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (space_id, project_source_id) DO UPDATE SET
           project_id = excluded.project_id,
           checkout_id = excluded.checkout_id,
           acknowledged_at = excluded.acknowledged_at`,
        [spaceId, mapping.projectSourceId, mapping.projectId, mapping.checkoutId, mapping.acknowledgedAt],
      );
    }),
  applyResolutionAction: (action) =>
    withTransaction(pool, 'apply-resolution-action', async (client) => {
      parseSpaceId(action.spaceId);
      parseCheckoutId(action.checkoutId);
      let result: CheckoutResolutionActionResult;
      if (action.kind === 'create-project') {
        const displayName = action.displayName.trim();
        parseIdentityText(displayName, 'resolutionAction.displayName');
        const projectId = createProjectId();
        await client.query(
          `INSERT INTO projects
            (id, space_id, kind, display_name, repository_id, repository_subpath, status)
           VALUES ($1, $2, 'local', $3, NULL, NULL, 'active')`,
          [projectId, action.spaceId, displayName],
        );
        const updated = await client.query(
          `UPDATE checkouts
           SET project_id = $1, repository_id = NULL,
               resolution_status = 'unassigned', resolution_reviewed_at = now()
           WHERE id = $2 AND space_id = $3`,
          [projectId, action.checkoutId, action.spaceId],
        );
        if (updated.rowCount !== 1) {
          throw new PlatformStoreError('validation-failed', 'apply-resolution-action');
        }
        result = { kind: 'project-created', projectId };
      } else if (action.kind === 'link') {
        parseRepositoryId(action.repositoryId);
        if (action.projectId !== null) {
          parseProjectId(action.projectId);
          const project = await client.query<{ readonly repository_id: string | null }>(
            'SELECT repository_id FROM projects WHERE id = $1 AND space_id = $2 FOR UPDATE',
            [action.projectId, action.spaceId],
          );
          const repositoryId = project.rows[0]?.repository_id;
          if (repositoryId === undefined || (repositoryId !== null && repositoryId !== action.repositoryId)) {
            throw new PlatformStoreError('validation-failed', 'apply-resolution-action');
          }
          if (repositoryId === null) {
            await client.query(
              `UPDATE projects SET kind = 'repository', repository_id = $1
               WHERE id = $2 AND space_id = $3`,
              [action.repositoryId, action.projectId, action.spaceId],
            );
          }
        }
        const updated = await client.query(
          `UPDATE checkouts
           SET project_id = $1, repository_id = $2,
               resolution_status = 'resolved', resolution_reviewed_at = now()
           WHERE id = $3 AND space_id = $4`,
          [action.projectId, action.repositoryId, action.checkoutId, action.spaceId],
        );
        if (updated.rowCount !== 1) {
          throw new PlatformStoreError('validation-failed', 'apply-resolution-action');
        }
        result = {
          kind: 'linked',
          projectId: action.projectId,
          repositoryId: action.repositoryId,
        };
      } else {
        const updated = await client.query(
          `UPDATE checkouts
           SET repository_id = NULL, resolution_status = 'unassigned', resolution_reviewed_at = now()
           WHERE id = $1 AND space_id = $2`,
          [action.checkoutId, action.spaceId],
        );
        if (updated.rowCount !== 1) {
          throw new PlatformStoreError('validation-failed', 'apply-resolution-action');
        }
        result = { kind: 'left-unassigned' };
      }
      await client.query('DELETE FROM checkout_resolution_candidates WHERE checkout_id = $1 AND space_id = $2', [
        action.checkoutId,
        action.spaceId,
      ]);
      return result;
    }),
  attachProjectRepository: (input) =>
    withTransaction(pool, 'attach-project-repository', async (client) => {
      const result = await client.query(
        `UPDATE projects
         SET kind = 'repository', repository_id = $1, repository_subpath = $2
         WHERE id = $3 AND space_id = $4`,
        [input.repositoryId, input.repositorySubpath, input.projectId, input.spaceId],
      );
      if (result.rowCount !== 1) {
        throw new PlatformStoreError('validation-failed', 'attach-project-repository');
      }
      await client.query(
        `INSERT INTO identity_events
          (id, space_id, event_type, subject_type, subject_id, recorded_at)
         VALUES ($1, $2, 'project-repository-attached', 'project', $3, now())`,
        [crypto.randomUUID(), input.spaceId, input.projectId],
      );
    }),
  createDevice: (device) =>
    storageOperation('create-device', async () => {
      validateDevice(device);
      await pool.query(
        `INSERT INTO devices (id, owner_person_id, space_id, label, status, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [device.id, device.ownerPersonId, device.owningSpaceId, device.label, device.status, device.lastSeenAt],
      );
    }),
  createPersonalIdentity: (identity: SharedPersonalIdentity) =>
    withTransaction(pool, 'create-personal-identity', async (client) => {
      validateSpace(identity.space);
      validatePerson(identity.person);
      if (identity.space.kind !== 'personal' || identity.person.personalSpaceId !== identity.space.id) {
        throw new PlatformStoreError('validation-failed', 'create-personal-identity');
      }
      await client.query('INSERT INTO spaces (id, kind, display_name, created_at) VALUES ($1, $2, $3, $4)', [
        identity.space.id,
        identity.space.kind,
        identity.space.displayName,
        identity.space.createdAt,
      ]);
      await client.query('INSERT INTO people (id, display_name, personal_space_id, status) VALUES ($1, $2, $3, $4)', [
        identity.person.id,
        identity.person.displayName,
        identity.person.personalSpaceId,
        identity.person.status,
      ]);
    }),
  createProject: (project) =>
    storageOperation('create-project', async () => {
      validateProject(project);
      await pool.query(
        `INSERT INTO projects
          (id, space_id, kind, display_name, repository_id, repository_subpath, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          project.id,
          project.owningSpaceId,
          project.kind,
          project.displayName,
          project.repositoryId,
          project.repositorySubpath,
          project.status,
        ],
      );
    }),
  createRepositoryWithAlias: (repository, alias) =>
    withTransaction(pool, 'create-repository-with-alias', async (client) => {
      validateRepository(repository);
      if (repository.owningSpaceId !== alias.owningSpaceId || repository.id !== alias.repositoryId) {
        throw new PlatformStoreError('validation-failed', 'create-repository-with-alias');
      }
      parseRepositoryAliasId(alias.id);
      parseInstant(alias.firstObservedAt);
      if (alias.lastObservedAt !== null) {
        parseInstant(alias.lastObservedAt);
      }
      await client.query(
        `INSERT INTO repositories
          (id, space_id, provider, provider_repository_id, canonical_host, canonical_owner, canonical_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          repository.id,
          repository.owningSpaceId,
          repository.provider,
          repository.providerRepositoryId,
          repository.canonicalHost,
          repository.canonicalOwner,
          repository.canonicalName,
          repository.status,
        ],
      );
      await client.query(
        `INSERT INTO repository_aliases
          (id, space_id, repository_id, normalized_remote, source, first_observed_at, last_observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          alias.id,
          alias.owningSpaceId,
          alias.repositoryId,
          alias.normalizedRemote,
          alias.source,
          alias.firstObservedAt,
          alias.lastObservedAt,
        ],
      );
    }),
  createScmAccount: (account: ScmAccount) =>
    storageOperation('create-scm-account', async () => {
      parsePersonId(account.personId);
      parseIdentityText(account.providerAccountId, 'scmAccount.providerAccountId');
      await pool.query(
        `INSERT INTO scm_accounts (id, person_id, provider, provider_account_id, handle)
         VALUES ($1, $2, $3, $4, $5)`,
        [account.id, account.personId, account.provider, account.providerAccountId, account.handle],
      );
    }),
  createScmCredential: (credential: ScmCredential) =>
    storageOperation('create-scm-credential', async () => {
      if (!hasExactlyOneScmCredentialOwner(credential)) {
        throw new PlatformStoreError('validation-failed', 'create-scm-credential');
      }
      parseIdentityText(credential.encryptedSecretReference, 'scmCredential.encryptedSecretReference', 1024);
      await pool.query(
        `INSERT INTO scm_credentials
          (id, account_id, installation_id, encrypted_secret_reference, created_at, rotated_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          credential.id,
          credential.accountId,
          credential.installationId,
          credential.encryptedSecretReference,
          credential.createdAt,
          credential.rotatedAt,
          credential.revokedAt,
        ],
      );
    }),
  createScmInstallation: (installation: ScmInstallation) =>
    storageOperation('create-scm-installation', async () => {
      parseSpaceId(installation.owningSpaceId);
      parseIdentityText(installation.providerInstallationId, 'scmInstallation.providerInstallationId');
      await pool.query(
        `INSERT INTO scm_installations
          (id, space_id, provider, provider_installation_id, selected_repository_ids, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          installation.id,
          installation.owningSpaceId,
          installation.provider,
          installation.providerInstallationId,
          [...installation.selectedRepositoryIds],
          installation.status,
        ],
      );
    }),
  findProjectSourceMapping: (spaceId, projectSourceId) =>
    storageOperation('find-project-source-mapping', async () => {
      const result = await pool.query<ProjectSourceMappingRow>(
        `SELECT project_source_id, project_id, checkout_id, acknowledged_at
         FROM project_source_mappings WHERE space_id = $1 AND project_source_id = $2`,
        [spaceId, projectSourceId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return {
        acknowledgedAt: mappedInstant(row.acknowledged_at, 'acknowledgedAt'),
        checkoutId: parseCheckoutId(row.checkout_id),
        projectId: parseProjectId(row.project_id),
        projectSourceId: requiredText(row.project_source_id, 'project-source-id'),
      } satisfies ProjectSourceMapping;
    }),
  listRepositoryCandidates: (spaceId) =>
    storageOperation('list-repository-candidates', async () => {
      parseSpaceId(spaceId);
      const [repositories, aliases] = await Promise.all([
        pool.query<RepositoryRow>(
          `SELECT id, space_id, provider, provider_repository_id, canonical_host,
                  canonical_owner, canonical_name, status
           FROM repositories WHERE space_id = $1 ORDER BY id`,
          [spaceId],
        ),
        pool.query<RepositoryAliasRow>(
          `SELECT id, space_id, repository_id, normalized_remote, source,
                  first_observed_at, last_observed_at
           FROM repository_aliases WHERE space_id = $1 ORDER BY id`,
          [spaceId],
        ),
      ]);
      const mappedAliases = aliases.rows.map(mapRepositoryAlias);
      return repositories.rows.map((row): RepositoryResolutionCandidate => {
        const repository = mapRepository(row);
        return {
          aliases: mappedAliases.filter((alias) => alias.repositoryId === repository.id),
          repository,
        };
      });
    }),
  listResolutionReviews: (spaceId) =>
    storageOperation('list-resolution-reviews', async () => {
      parseSpaceId(spaceId);
      const [reviews, candidates] = await Promise.all([
        pool.query<CheckoutReviewRow>(
          `SELECT checkouts.id AS checkout_id, checkouts.device_id, devices.label AS device_label,
                  checkouts.observed_remote, checkouts.resolution_status
           FROM checkouts
           JOIN devices ON devices.id = checkouts.device_id
           WHERE checkouts.space_id = $1
             AND checkouts.resolution_status IN ('ambiguous', 'candidate', 'unassigned')
             AND checkouts.resolution_reviewed_at IS NULL
           ORDER BY checkouts.id
           LIMIT 101`,
          [spaceId],
        ),
        pool.query<CheckoutCandidateRow>(
          `SELECT checkout_resolution_candidates.checkout_id,
                  repositories.id AS repository_id,
                  repositories.canonical_host,
                  repositories.canonical_owner,
                  repositories.canonical_name
           FROM checkout_resolution_candidates
           JOIN repositories ON repositories.id = checkout_resolution_candidates.repository_id
           WHERE checkout_resolution_candidates.space_id = $1
           ORDER BY checkout_resolution_candidates.checkout_id, repositories.id
           LIMIT 1001`,
          [spaceId],
        ),
      ]);
      if (reviews.rows.length > 100 || candidates.rows.length > 1000) {
        throw new PlatformStoreError('validation-failed', 'list-resolution-reviews');
      }
      return reviews.rows.map((row): CheckoutResolutionReview => {
        if (
          row.resolution_status !== 'ambiguous' &&
          row.resolution_status !== 'candidate' &&
          row.resolution_status !== 'unassigned'
        ) {
          throw new PlatformStoreError('validation-failed', 'map-resolution-review');
        }
        const checkoutId = parseCheckoutId(row.checkout_id);
        return {
          candidateMatches: candidates.rows
            .filter((candidate) => candidate.checkout_id === checkoutId)
            .map((candidate) => {
              const owner = nullableText(candidate.canonical_owner, 'canonical-owner');
              return {
                canonicalLabel: [
                  requiredText(candidate.canonical_host, 'canonical-host', 256),
                  owner,
                  requiredText(candidate.canonical_name, 'canonical-name', 256),
                ]
                  .filter((part): part is string => part !== null)
                  .join('/'),
                repositoryId: parseRepositoryId(candidate.repository_id),
              };
            }),
          checkoutId,
          destinationSpaceId: spaceId,
          deviceId: parseDeviceId(row.device_id),
          deviceLabel: requiredText(row.device_label, 'device-label', 256),
          localLabel: `checkout:${checkoutId.slice(0, 8)}`,
          normalizedRemote: nullableText(row.observed_remote, 'observed-remote'),
          status: row.resolution_status,
        };
      });
    }),
  recordRepositoryResolution: (spaceId, checkoutId, resolution) =>
    withTransaction(pool, 'record-repository-resolution', async (client) => {
      if (resolution.kind === 'invalid' || ('spaceId' in resolution && resolution.spaceId !== spaceId)) {
        throw new PlatformStoreError('validation-failed', 'record-repository-resolution');
      }
      const repositoryId = resolution.kind === 'resolved' ? resolution.repositoryId : null;
      const candidateIds = resolution.kind === 'ambiguous' ? resolution.candidateRepositoryIds : [];
      const updated = await client.query(
        `UPDATE checkouts
         SET repository_id = $1, resolution_status = $2, resolution_reviewed_at = NULL
         WHERE id = $3 AND space_id = $4`,
        [repositoryId, resolution.kind, checkoutId, spaceId],
      );
      if (updated.rowCount !== 1) {
        throw new PlatformStoreError('validation-failed', 'record-repository-resolution');
      }
      await client.query('DELETE FROM checkout_resolution_candidates WHERE checkout_id = $1 AND space_id = $2', [
        checkoutId,
        spaceId,
      ]);
      for (const candidateId of candidateIds) {
        await client.query(
          `INSERT INTO checkout_resolution_candidates (checkout_id, space_id, repository_id)
           VALUES ($1, $2, $3)`,
          [checkoutId, spaceId, candidateId],
        );
      }
    }),
  saveCaptureContext: (context) =>
    storageOperation('save-capture-context', async () => {
      await pool.query(
        `INSERT INTO capture_contexts
          (id, device_id, person_id, space_id, project_id, scm_account_id, scm_installation_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          context.id,
          context.deviceId,
          context.personId,
          context.spaceId,
          context.projectId,
          context.scmAccountId,
          context.scmInstallationId,
          context.source,
        ],
      );
    }),
  updateRepositoryIdentity: (input: SharedRepositoryIdentityUpdate) =>
    withTransaction(pool, 'update-repository-identity', async (client) => {
      const result = await client.query(
        `UPDATE repositories
         SET canonical_host = $1, canonical_owner = $2, canonical_name = $3, status = $4
         WHERE id = $5 AND space_id = $6`,
        [
          input.canonicalHost,
          input.canonicalOwner,
          input.canonicalName,
          input.status,
          input.repositoryId,
          input.spaceId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new PlatformStoreError('validation-failed', 'update-repository-identity');
      }
      await client.query(
        `INSERT INTO identity_events
          (id, space_id, event_type, subject_type, subject_id, recorded_at)
         VALUES ($1, $2, $3, 'repository', $4, now())`,
        [crypto.randomUUID(), input.spaceId, input.eventType, input.repositoryId],
      );
    }),
  upsertCheckout: (spaceId, checkout) =>
    storageOperation('upsert-checkout', async () => {
      const observedRemote =
        checkout.observedRemote === null ? null : normalizeRepositoryAlias(checkout.observedRemote);
      if (checkout.observedRemote !== null && observedRemote === null) {
        throw new PlatformStoreError('validation-failed', 'upsert-checkout');
      }
      const result = await pool.query(
        `INSERT INTO checkouts
          (id, space_id, project_id, device_id, local_path, repository_id,
           observed_remote, status, last_observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           project_id = excluded.project_id,
           device_id = excluded.device_id,
           local_path = excluded.local_path,
           repository_id = excluded.repository_id,
           observed_remote = excluded.observed_remote,
           status = excluded.status,
           last_observed_at = excluded.last_observed_at
         WHERE checkouts.space_id = excluded.space_id
         RETURNING id`,
        [
          checkout.id,
          spaceId,
          checkout.projectId,
          checkout.deviceId,
          checkout.localPath,
          checkout.repositoryId,
          observedRemote,
          checkout.status,
          checkout.lastObservedAt,
        ],
      );
      if (result.rowCount !== 1) {
        throw new PlatformStoreError('validation-failed', 'upsert-checkout');
      }
    }),
});
