import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Checkout,
  createCheckoutId,
  createProjectId,
  createRepositoryAliasId,
  createRepositoryId,
  instantNow,
  type Project,
  type Repository,
  type RepositoryAlias,
} from '@ai-usage/platform-core/identity';
import { projectSourceId } from '@ai-usage/report-core/project-group';
import { openLocalIdentityKernel } from './identity';

const roots: string[] = [];
const observedAt = instantNow(() => new Date('2026-08-29T12:00:00.000Z'));

const databaseFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-identity-'));
  roots.push(root);
  return { databasePath: path.join(root, 'memory.sqlite'), root };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('local Memory identity kernel', () => {
  test('bootstraps exactly one stable local Person, personal Space, and opaque Device', async () => {
    const fixture = await databaseFixture();
    const firstKernel = await openLocalIdentityKernel({
      clock: () => new Date(observedAt),
      databasePath: fixture.databasePath,
    });
    const first = await firstKernel.getBootstrapIdentity();
    await firstKernel.close();

    const secondKernel = await openLocalIdentityKernel({ databasePath: fixture.databasePath });
    const second = await secondKernel.getBootstrapIdentity();
    expect(second).toEqual(first);
    expect(second.space.kind).toBe('personal');
    expect(second.device.status).toBe('local');
    expect(second.device.label).toBe('Local device');
    expect((await stat(fixture.databasePath)).mode % 0o1000).toBe(0o600);
    await secondKernel.close();
    await secondKernel.close();
  });

  test('creates one coherent owner-only backup without replacing an existing snapshot', async () => {
    const fixture = await databaseFixture();
    const backupPath = path.join(fixture.root, 'memory-backup.sqlite');
    const kernel = await openLocalIdentityKernel({ databasePath: fixture.databasePath });
    const identity = await kernel.getBootstrapIdentity();

    await kernel.backupTo(backupPath);
    expect((await stat(backupPath)).mode % 0o1000).toBe(0o600);
    await expect(kernel.backupTo(backupPath)).rejects.toMatchObject({
      code: 'storage-failed',
      operation: 'backup-memory-database',
    });
    await expect(kernel.backupTo(fixture.databasePath)).rejects.toMatchObject({
      code: 'configuration-invalid',
      operation: 'backup-memory-database',
    });

    const backup = new Database(backupPath, { readonly: true, strict: true });
    try {
      expect(backup.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(backup.query('SELECT person_id, personal_space_id FROM local_identity_metadata').get()).toEqual({
        person_id: identity.person.id,
        personal_space_id: identity.space.id,
      });
    } finally {
      backup.close(false);
      await kernel.close();
    }
  });

  test('persists repository aliases and preserves Project identity through later attachment and rename', async () => {
    const fixture = await databaseFixture();
    const kernel = await openLocalIdentityKernel({
      clock: () => new Date(observedAt),
      databasePath: fixture.databasePath,
    });
    const bootstrap = await kernel.getBootstrapIdentity();
    const repositoryId = createRepositoryId();
    const projectId = createProjectId();
    const repository: Repository = {
      canonicalHost: 'github.com',
      canonicalName: 'codex',
      canonicalOwner: 'openai',
      id: repositoryId,
      owningSpaceId: bootstrap.space.id,
      provider: 'github',
      providerRepositoryId: 'R_123',
      status: 'active',
    };
    const alias: RepositoryAlias = {
      firstObservedAt: observedAt,
      id: createRepositoryAliasId(),
      lastObservedAt: null,
      normalizedRemote: 'github.com/openai/codex',
      owningSpaceId: bootstrap.space.id,
      repositoryId,
      source: 'local-git',
    };
    const project: Project = {
      displayName: 'local notes',
      id: projectId,
      kind: 'local',
      owningSpaceId: bootstrap.space.id,
      repositoryId: null,
      repositorySubpath: null,
      status: 'active',
    };
    await kernel.createRepositoryWithAlias(repository, alias);
    await kernel.createProject(project);
    await kernel.attachProjectRepository({
      projectId,
      repositoryId,
      repositorySubpath: 'packages/core',
      spaceId: bootstrap.space.id,
    });
    await kernel.updateRepositoryIdentity({
      canonicalHost: 'github.com',
      canonicalName: 'codex-renamed',
      canonicalOwner: 'openai',
      eventType: 'repository-renamed',
      repositoryId,
      spaceId: bootstrap.space.id,
      status: 'renamed',
    });
    await kernel.close();

    const reopened = await openLocalIdentityKernel({ databasePath: fixture.databasePath });
    const candidates = await reopened.listRepositoryCandidates(bootstrap.space.id);
    expect(candidates).toEqual([
      {
        aliases: [alias],
        repository: { ...repository, canonicalName: 'codex-renamed', status: 'renamed' },
      },
    ]);
    await reopened.close();
  });

  test('keeps the existing project-source identity additive through an acknowledged mapping', async () => {
    const fixture = await databaseFixture();
    const kernel = await openLocalIdentityKernel({ databasePath: fixture.databasePath });
    const bootstrap = await kernel.getBootstrapIdentity();
    const projectId = createProjectId();
    const checkoutId = createCheckoutId();
    await kernel.createProject({
      displayName: 'non-git',
      id: projectId,
      kind: 'local',
      owningSpaceId: bootstrap.space.id,
      repositoryId: null,
      repositorySubpath: null,
      status: 'active',
    });
    const checkout: Checkout = {
      deviceId: bootstrap.device.id,
      id: checkoutId,
      lastObservedAt: observedAt,
      localPath: '/opaque/non-git',
      observedRemote: null,
      projectId,
      repositoryId: null,
      status: 'available',
    };
    await kernel.upsertCheckout(bootstrap.space.id, checkout);
    const existingSourceId = projectSourceId({
      machineId: 'machine-id',
      project: 'non-git',
      sourcePath: '/opaque/non-git',
    });
    await kernel.acknowledgeProjectSourceMapping(
      {
        acknowledgedAt: observedAt,
        checkoutId,
        projectId,
        projectSourceId: existingSourceId,
      },
      bootstrap.space.id,
    );
    expect(await kernel.findProjectSourceMapping(bootstrap.space.id, existingSourceId)).toEqual({
      acknowledgedAt: observedAt,
      checkoutId,
      projectId,
      projectSourceId: existingSourceId,
    });
    await kernel.close();
  });

  test('persists ambiguous repository candidates without exposing local paths', async () => {
    const fixture = await databaseFixture();
    const kernel = await openLocalIdentityKernel({ databasePath: fixture.databasePath });
    const bootstrap = await kernel.getBootstrapIdentity();
    const repositoryId = createRepositoryId();
    const alternativeRepositoryId = createRepositoryId();
    const checkoutId = createCheckoutId();
    const repository: Repository = {
      canonicalHost: 'github.com',
      canonicalName: 'codex',
      canonicalOwner: 'openai',
      id: repositoryId,
      owningSpaceId: bootstrap.space.id,
      provider: 'github',
      providerRepositoryId: 'R_primary',
      status: 'active',
    };
    const alias: RepositoryAlias = {
      firstObservedAt: observedAt,
      id: createRepositoryAliasId(),
      lastObservedAt: null,
      normalizedRemote: 'github.com/openai/codex',
      owningSpaceId: bootstrap.space.id,
      repositoryId,
      source: 'local-git',
    };
    await kernel.createRepositoryWithAlias(repository, alias);
    await kernel.createRepositoryWithAlias(
      {
        ...repository,
        canonicalHost: 'mirror.example',
        id: alternativeRepositoryId,
        provider: 'generic',
        providerRepositoryId: null,
      },
      {
        ...alias,
        id: createRepositoryAliasId(),
        normalizedRemote: 'mirror.example/openai/codex',
        repositoryId: alternativeRepositoryId,
      },
    );
    await kernel.upsertCheckout(bootstrap.space.id, {
      deviceId: bootstrap.device.id,
      id: checkoutId,
      lastObservedAt: observedAt,
      localPath: '/private/operator/path',
      observedRemote: 'git@github.com:openai/codex.git',
      projectId: null,
      repositoryId: null,
      status: 'available',
    });
    await kernel.recordRepositoryResolution(bootstrap.space.id, checkoutId, {
      candidateRepositoryIds: [repositoryId, alternativeRepositoryId],
      kind: 'ambiguous',
      matchedBy: 'alias',
      normalizedRemote: 'github.com/openai/codex',
      spaceId: bootstrap.space.id,
    });
    await kernel.close();

    const reopened = await openLocalIdentityKernel({ databasePath: fixture.databasePath });
    const reviews = await reopened.listResolutionReviews(bootstrap.space.id);
    expect(reviews).toEqual([
      {
        candidateMatches: [
          { canonicalLabel: 'github.com/openai/codex', repositoryId },
          { canonicalLabel: 'mirror.example/openai/codex', repositoryId: alternativeRepositoryId },
        ].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
        checkoutId,
        destinationSpaceId: bootstrap.space.id,
        deviceId: bootstrap.device.id,
        deviceLabel: 'Local device',
        localLabel: `checkout:${checkoutId.slice(0, 8)}`,
        normalizedRemote: 'github.com/openai/codex',
        status: 'ambiguous',
      },
    ]);
    expect(JSON.stringify(reviews)).not.toContain('/private/operator/path');
    expect(
      await reopened.applyResolutionAction({
        checkoutId,
        kind: 'link',
        projectId: null,
        repositoryId,
        spaceId: bootstrap.space.id,
      }),
    ).toEqual({
      kind: 'linked',
      projectId: null,
      repositoryId,
    });
    expect(await reopened.listResolutionReviews(bootstrap.space.id)).toEqual([]);
    await reopened.close();
  });

  test('applies explicit create-project and leave-unassigned review actions once', async () => {
    const fixture = await databaseFixture();
    const kernel = await openLocalIdentityKernel({ databasePath: fixture.databasePath });
    const bootstrap = await kernel.getBootstrapIdentity();
    const createCheckoutIdValue = createCheckoutId();
    const leaveCheckoutIdValue = createCheckoutId();
    for (const [checkoutId, suffix] of [
      [createCheckoutIdValue, 'create'],
      [leaveCheckoutIdValue, 'leave'],
    ] as const) {
      await kernel.upsertCheckout(bootstrap.space.id, {
        deviceId: bootstrap.device.id,
        id: checkoutId,
        lastObservedAt: observedAt,
        localPath: `/private/${suffix}`,
        observedRemote: null,
        projectId: null,
        repositoryId: null,
        status: 'available',
      });
      await kernel.recordRepositoryResolution(bootstrap.space.id, checkoutId, {
        kind: 'unassigned',
        reason: 'no-remote',
        spaceId: bootstrap.space.id,
      });
    }

    const createResult = await kernel.applyResolutionAction({
      checkoutId: createCheckoutIdValue,
      displayName: '  Local research  ',
      kind: 'create-project',
      spaceId: bootstrap.space.id,
    });
    expect(createResult.kind).toBe('project-created');
    expect(
      await kernel.applyResolutionAction({
        checkoutId: leaveCheckoutIdValue,
        kind: 'leave-unassigned',
        spaceId: bootstrap.space.id,
      }),
    ).toEqual({ kind: 'left-unassigned' });
    expect(await kernel.listResolutionReviews(bootstrap.space.id)).toEqual([]);
    await kernel.close();
  });
});
