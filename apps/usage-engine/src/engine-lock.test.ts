import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageEngineBearerToken, usageEngineTargetIdFor } from '@ai-usage/usage-engine-control/node';
import { acquireUsageEngineLock, inspectUsageEngineLock, usageEngineLockPath } from './engine-lock';
import { publishUsageEngineRendezvous, usageEngineRendezvousPath } from './rendezvous-file';

const fixtures: string[] = [];
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = createUsageEngineBearerToken('a'.repeat(43));
const LOCK_ARTIFACT_PATTERN = /\.(claim|intent|tmp)$/;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createFixture = async (): Promise<string> => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'plan052-engine-lock-'));
  fixtures.push(fixture);
  return fixture;
};

const databasePathFor = (stateDirectory: string): string => path.join(stateDirectory, 'store', 'usage.sqlite');
const targetIdFor = (stateDirectory: string) =>
  usageEngineTargetIdFor({ configCwd: stateDirectory, databasePath: databasePathFor(stateDirectory) });

const acquireLock = (stateDirectory: string, instanceId = INSTANCE_ID) =>
  acquireUsageEngineLock({
    databasePath: databasePathFor(stateDirectory),
    instanceId,
    stateDirectory,
  });

const lockMetadata = async (stateDirectory: string, pid: number, processStartTimeTicks: string | null = '1') => {
  const databasePath = databasePathFor(stateDirectory);
  await mkdir(path.dirname(databasePath), { mode: 0o700, recursive: true });
  return {
    createdAt: '2026-07-29T00:00:00.000Z',
    databasePath,
    hostname: os.hostname(),
    instanceId: INSTANCE_ID,
    ownerId: '22222222-2222-4222-8222-222222222222',
    pid,
    processStartTimeTicks,
    stateDirectory: await realpath(stateDirectory),
    version: 1,
  };
};

const writeLock = async (stateDirectory: string, value: unknown, mode = 0o600): Promise<string> => {
  await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  const databasePath = databasePathFor(stateDirectory);
  await mkdir(path.dirname(databasePath), { mode: 0o700, recursive: true });
  const lockPath = usageEngineLockPath(databasePath);
  await writeFile(lockPath, `${JSON.stringify(value)}\n`, { mode });
  return lockPath;
};

const recoveryClaimPathFor = (lockPath: string, pid: number, processStartTimeTicks = 'none'): string => {
  const scopeKey = createHash('sha256').update(lockPath, 'utf8').digest('hex').slice(0, 16);
  return path.join(
    path.dirname(lockPath),
    `.ai-usage-engine-recovery-${scopeKey}-${pid}-${processStartTimeTicks}-${Date.now() - 60_000}-11111111-1111-4111-8111-111111111111.claim`,
  );
};

describe('usage engine writer lock', () => {
  test('allows one engine and rejects a second live owner with its PID and path', async () => {
    const stateDirectory = await createFixture();
    const first = await acquireLock(stateDirectory);
    const lockPath = usageEngineLockPath(databasePathFor(stateDirectory));

    await expect(acquireLock(stateDirectory)).rejects.toThrow(
      `Usage engine lock ${lockPath} is owned by live PID ${process.pid}`,
    );

    await first.release();
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  test('canonicalizes database parent aliases into one exclusion scope', async () => {
    const fixture = await createFixture();
    const databaseDirectory = path.join(fixture, 'canonical-store');
    const aliasDirectory = path.join(fixture, 'store-alias');
    const firstStateDirectory = path.join(fixture, 'state-a');
    const secondStateDirectory = path.join(fixture, 'state-b');
    await mkdir(databaseDirectory, { mode: 0o700 });
    await symlink(databaseDirectory, aliasDirectory, 'dir');
    const first = await acquireUsageEngineLock({
      databasePath: path.join(databaseDirectory, 'usage.sqlite'),
      instanceId: INSTANCE_ID,
      stateDirectory: firstStateDirectory,
    });

    await expect(
      acquireUsageEngineLock({
        databasePath: path.join(aliasDirectory, 'usage.sqlite'),
        instanceId: OTHER_INSTANCE_ID,
        stateDirectory: secondStateDirectory,
      }),
    ).rejects.toThrow(`owned by live PID ${process.pid}`);
    await first.release();
  });

  test('rejects a shared database parent without changing its mode', async () => {
    const fixture = await createFixture();
    const sharedDirectory = path.join(fixture, 'shared-store');
    const stateDirectory = path.join(fixture, 'private-state');
    await mkdir(sharedDirectory, { mode: 0o755 });
    const modeBefore = (await lstat(sharedDirectory)).mode % 0o1000;

    await expect(
      acquireUsageEngineLock({
        databasePath: path.join(sharedDirectory, 'usage.sqlite'),
        instanceId: INSTANCE_ID,
        stateDirectory,
      }),
    ).rejects.toThrow('must be an owned directory');
    expect((await lstat(sharedDirectory)).mode % 0o1000).toBe(modeBefore);
  });

  test('recovers a validated dead owner and a reused live PID without weakening permissions', async () => {
    const deadDirectory = await createFixture();
    const deadPath = await writeLock(deadDirectory, await lockMetadata(deadDirectory, 2_147_483_647));
    const recovered = await acquireLock(deadDirectory);
    expect((await lstat(deadDirectory)).mode % 0o1000).toBe(0o700);
    expect((await lstat(deadPath)).mode % 0o1000).toBe(0o600);
    await recovered.release();

    const reusedDirectory = await createFixture();
    const reusedPath = await writeLock(reusedDirectory, await lockMetadata(reusedDirectory, process.pid, '0'));
    const reused = await acquireLock(reusedDirectory);
    expect(JSON.parse(await readFile(reusedPath, 'utf8')).instanceId).toBe(INSTANCE_ID);
    await reused.release();
  });

  test('admits exactly one writer when stale-lock recovery races', async () => {
    const stateDirectory = await createFixture();
    const databasePath = databasePathFor(stateDirectory);
    await writeLock(stateDirectory, await lockMetadata(stateDirectory, 2_147_483_647));
    const workerPath = path.join(import.meta.dir, 'test-fixtures', 'engine-lock-race-worker.ts');
    const barrierPath = path.join(stateDirectory, 'race.go');
    const releasePath = path.join(stateDirectory, 'race.release');
    const workerInputs = [INSTANCE_ID, OTHER_INSTANCE_ID].map((instanceId, index) => ({
      instanceId,
      readyPath: path.join(stateDirectory, `worker-${index}.ready`),
      resultPath: path.join(stateDirectory, `worker-${index}.json`),
      statePath: path.join(stateDirectory, `worker-${index}-state`),
    }));
    const workers = workerInputs.map((input) =>
      Bun.spawn(
        [
          process.execPath,
          workerPath,
          databasePath,
          input.statePath,
          input.instanceId,
          input.readyPath,
          barrierPath,
          input.resultPath,
          releasePath,
        ],
        { stderr: 'pipe', stdout: 'pipe' },
      ),
    );
    const waitForPaths = async (paths: readonly string[]): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!(await Promise.all(paths.map((filePath) => Bun.file(filePath).exists()))).every(Boolean)) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for usage engine lock race workers.');
        }
        await Bun.sleep(5);
      }
    };

    try {
      await waitForPaths(workerInputs.map(({ readyPath }) => readyPath));
      await writeFile(barrierPath, 'go\n', { mode: 0o600 });
      await waitForPaths(workerInputs.map(({ resultPath }) => resultPath));
      const results = await Promise.all(
        workerInputs.map(async ({ resultPath }) => JSON.parse(await readFile(resultPath, 'utf8'))),
      );

      expect(results.filter(({ state }) => state === 'acquired')).toHaveLength(1);
      expect(results.filter(({ state }) => state === 'rejected')).toHaveLength(1);
    } finally {
      await writeFile(barrierPath, 'go\n', { mode: 0o600 });
      await writeFile(releasePath, 'release\n', { mode: 0o600 });
      const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
      expect(exitCodes).toEqual([0, 0]);
    }
    const remainingArtifacts = (await readdir(path.dirname(databasePath))).filter((entry) =>
      LOCK_ARTIFACT_PATTERN.test(entry),
    );
    expect(remainingArtifacts).toEqual([]);
  }, 10_000);

  test('rolls back a takeover when recovered-lock publication is denied', async () => {
    const stateDirectory = await createFixture();
    const lockPath = await writeLock(stateDirectory, await lockMetadata(stateDirectory, 2_147_483_647));
    const staleIdentity = await lstat(lockPath);
    let faultCount = 0;

    await expect(
      acquireUsageEngineLock({
        beforeRecoveredLockPublication: () => {
          faultCount++;
          return Promise.reject(
            Object.assign(new Error('injected recovered publication permission failure'), { code: 'EACCES' }),
          );
        },
        databasePath: databasePathFor(stateDirectory),
        instanceId: OTHER_INSTANCE_ID,
        stateDirectory,
      }),
    ).rejects.toThrow('injected recovered publication permission failure');

    const restored = await lstat(lockPath);
    expect({ dev: restored.dev, ino: restored.ino, nlink: restored.nlink }).toEqual({
      dev: staleIdentity.dev,
      ino: staleIdentity.ino,
      nlink: 1,
    });
    expect(faultCount).toBe(1);
    expect((await readdir(path.dirname(lockPath))).filter((entry) => LOCK_ARTIFACT_PATTERN.test(entry))).toEqual([]);

    const retry = await acquireLock(stateDirectory, OTHER_INSTANCE_ID);
    await retry.release();
  });

  test('preserves the recovery claim when replacement-final rollback is unproven', async () => {
    const stateDirectory = await createFixture();
    const lockPath = await writeLock(stateDirectory, await lockMetadata(stateDirectory, 2_147_483_647));
    const displacedPath = `${lockPath}.displaced`;

    await expect(
      acquireUsageEngineLock({
        afterRecoveredLockLinked: async (linkedPath) => {
          await rename(linkedPath, displacedPath);
          await writeFile(linkedPath, 'foreign\n', { mode: 0o600 });
        },
        databasePath: databasePathFor(stateDirectory),
        instanceId: OTHER_INSTANCE_ID,
        stateDirectory,
      }),
    ).rejects.toThrow('publication rollback could not be proven');

    expect(await readFile(lockPath, 'utf8')).toBe('foreign\n');
    await expect(Bun.file(displacedPath).exists()).resolves.toBe(true);
    const artifacts = await readdir(path.dirname(lockPath));
    expect(artifacts.filter((entry) => entry.endsWith('.claim'))).toHaveLength(1);
    expect(artifacts.filter((entry) => entry.endsWith('.intent'))).toHaveLength(0);
    expect(artifacts.filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0);
    await expect(inspectUsageEngineLock(databasePathFor(stateDirectory))).resolves.toMatchObject({
      reason: 'Usage engine lock recovery is in progress and was not mutated.',
      state: 'unsafe',
    });
  });

  test('preserves the recovery claim when a foreign final appears after absence is proven', async () => {
    const stateDirectory = await createFixture();
    const lockPath = await writeLock(stateDirectory, await lockMetadata(stateDirectory, 2_147_483_647));
    const displacedPath = `${lockPath}.displaced`;

    await expect(
      acquireUsageEngineLock({
        afterPublishedLockRollbackAbsent: async (absentPath) => {
          await writeFile(absentPath, 'foreign\n', { mode: 0o600 });
        },
        afterRecoveredLockLinked: async (linkedPath) => {
          await rename(linkedPath, displacedPath);
          throw new Error('injected post-publication failure');
        },
        databasePath: databasePathFor(stateDirectory),
        instanceId: OTHER_INSTANCE_ID,
        stateDirectory,
      }),
    ).rejects.toThrow('rollback failed');

    expect(await readFile(lockPath, 'utf8')).toBe('foreign\n');
    await expect(Bun.file(displacedPath).exists()).resolves.toBe(true);
    const artifacts = await readdir(path.dirname(lockPath));
    expect(artifacts.filter((entry) => entry.endsWith('.claim'))).toHaveLength(1);
    expect(artifacts.filter((entry) => entry.endsWith('.intent'))).toHaveLength(0);
    expect(artifacts.filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0);
  });

  test('preserves the recovery claim when rollback inspection fails with a non-absence error', async () => {
    const stateDirectory = await createFixture();
    const lockPath = await writeLock(stateDirectory, await lockMetadata(stateDirectory, 2_147_483_647));
    const displacedPath = `${lockPath}.displaced`;

    await expect(
      acquireUsageEngineLock({
        afterRecoveredLockLinked: async (linkedPath) => {
          await rename(linkedPath, displacedPath);
          throw new Error('injected post-publication failure');
        },
        beforePublishedLockRollbackInspection: () =>
          Promise.reject(Object.assign(new Error('injected I/O failure'), { code: 'EIO' })),
        databasePath: databasePathFor(stateDirectory),
        instanceId: OTHER_INSTANCE_ID,
        stateDirectory,
      }),
    ).rejects.toThrow('publication rollback could not be proven');

    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
    await expect(Bun.file(displacedPath).exists()).resolves.toBe(true);
    const artifacts = await readdir(path.dirname(lockPath));
    expect(artifacts.filter((entry) => entry.endsWith('.claim'))).toHaveLength(1);
    expect(artifacts.filter((entry) => entry.endsWith('.intent'))).toHaveLength(0);
    expect(artifacts.filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0);
  });

  test('adopts a dead final-linked claim whose PID was reused', async () => {
    const stateDirectory = await createFixture();
    const lockPath = await writeLock(stateDirectory, await lockMetadata(stateDirectory, 2_147_483_647));
    const claimPath = recoveryClaimPathFor(lockPath, process.pid, '0');
    await link(lockPath, claimPath);

    const recovered = await acquireLock(stateDirectory, OTHER_INSTANCE_ID);

    await expect(Bun.file(claimPath).exists()).resolves.toBe(false);
    expect((await lstat(lockPath)).nlink).toBe(1);
    await recovered.release();
  });

  test('recovers a dead claim after the stale final was unlinked', async () => {
    const stateDirectory = await createFixture();
    const stalePid = 2_147_483_647;
    const rendezvous = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory,
      targetId: targetIdFor(stateDirectory),
      token: TOKEN,
    });
    const lockPath = await writeLock(stateDirectory, await lockMetadata(stateDirectory, stalePid));
    const claimPath = recoveryClaimPathFor(lockPath, stalePid);
    await link(lockPath, claimPath);
    await unlink(lockPath);

    const recovered = await acquireLock(stateDirectory, OTHER_INSTANCE_ID);

    await expect(Bun.file(claimPath).exists()).resolves.toBe(false);
    await expect(Bun.file(rendezvous.path).exists()).resolves.toBe(false);
    await expect(Bun.file(lockPath).exists()).resolves.toBe(true);
    await recovered.release();
  });

  test('preserves a live recovery claim and reports it read-only', async () => {
    const stateDirectory = await createFixture();
    const lockPath = await writeLock(stateDirectory, await lockMetadata(stateDirectory, 2_147_483_647));
    const claimPath = recoveryClaimPathFor(lockPath, process.pid);
    await link(lockPath, claimPath);

    await expect(acquireLock(stateDirectory, OTHER_INSTANCE_ID)).rejects.toThrow(
      `recovery is owned by live PID ${process.pid}`,
    );
    await expect(Bun.file(lockPath).exists()).resolves.toBe(true);
    await expect(Bun.file(claimPath).exists()).resolves.toBe(true);

    await unlink(lockPath);
    await expect(acquireLock(stateDirectory, OTHER_INSTANCE_ID)).rejects.toThrow(
      `recovery is owned by live PID ${process.pid}`,
    );
    await expect(inspectUsageEngineLock(databasePathFor(stateDirectory))).resolves.toMatchObject({
      reason: 'Usage engine lock recovery is in progress and was not mutated.',
      state: 'unsafe',
    });
    await expect(Bun.file(claimPath).exists()).resolves.toBe(true);
  });

  test('revalidates stale rendezvous ownership and instance identity before recovery', async () => {
    const matchingDirectory = await createFixture();
    await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory: matchingDirectory,
      targetId: targetIdFor(matchingDirectory),
      token: TOKEN,
    });
    await writeLock(matchingDirectory, await lockMetadata(matchingDirectory, 2_147_483_647));
    const recovered = await acquireLock(matchingDirectory, OTHER_INSTANCE_ID);
    await expect(Bun.file(usageEngineRendezvousPath(matchingDirectory)).exists()).resolves.toBe(false);
    await recovered.release();
    await writeLock(matchingDirectory, {
      ...(await lockMetadata(matchingDirectory, 2_147_483_647)),
      instanceId: OTHER_INSTANCE_ID,
    });
    const recoveredAfterCrashBoundary = await acquireLock(matchingDirectory);
    await recoveredAfterCrashBoundary.release();

    const mismatchedDirectory = await createFixture();
    await publishUsageEngineRendezvous({
      instanceId: OTHER_INSTANCE_ID,
      port: 41_053,
      stateDirectory: mismatchedDirectory,
      targetId: targetIdFor(mismatchedDirectory),
      token: TOKEN,
    });
    const mismatchedLock = await writeLock(mismatchedDirectory, await lockMetadata(mismatchedDirectory, 2_147_483_647));
    await expect(acquireLock(mismatchedDirectory, OTHER_INSTANCE_ID)).rejects.toThrow(
      'stale lock and rendezvous identities differ and were preserved',
    );
    await expect(Bun.file(mismatchedLock).exists()).resolves.toBe(true);
    await expect(Bun.file(usageEngineRendezvousPath(mismatchedDirectory)).exists()).resolves.toBe(true);
  });

  test('repairs the exact interrupted rendezvous hard link before stale recovery', async () => {
    const stateDirectory = await createFixture();
    const stalePid = 2_147_483_647;
    const rendezvous = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory,
      targetId: targetIdFor(stateDirectory),
      token: TOKEN,
    });
    const interruptedTemporaryPath = path.join(
      stateDirectory,
      `.rendezvous-${stalePid}-11111111-1111-4111-8111-111111111111.tmp`,
    );
    await link(rendezvous.path, interruptedTemporaryPath);
    await writeLock(stateDirectory, await lockMetadata(stateDirectory, stalePid));

    const recovered = await acquireLock(stateDirectory, OTHER_INSTANCE_ID);

    await expect(Bun.file(interruptedTemporaryPath).exists()).resolves.toBe(false);
    await expect(Bun.file(rendezvous.path).exists()).resolves.toBe(false);
    await recovered.release();
  });

  test('repairs the exact interrupted lock hard link before validating its owner', async () => {
    const stateDirectory = await createFixture();
    const first = await acquireLock(stateDirectory);
    const lockPath = usageEngineLockPath(databasePathFor(stateDirectory));
    const interruptedTemporaryPath = path.join(
      path.dirname(lockPath),
      `.ai-usage-engine-lock-${process.pid}-11111111-1111-4111-8111-111111111111.tmp`,
    );
    await link(lockPath, interruptedTemporaryPath);

    await expect(acquireLock(stateDirectory, OTHER_INSTANCE_ID)).rejects.toThrow(`owned by live PID ${process.pid}`);
    await expect(Bun.file(interruptedTemporaryPath).exists()).resolves.toBe(false);
    expect((await lstat(lockPath)).nlink).toBe(1);
    await first.release();
  });

  test('scavenges an old dead-owner prepublication lock temporary file', async () => {
    const stateDirectory = await createFixture();
    const databasePath = databasePathFor(stateDirectory);
    const databaseDirectory = path.dirname(databasePath);
    await mkdir(databaseDirectory, { mode: 0o700, recursive: true });
    const temporaryPath = path.join(
      databaseDirectory,
      '.ai-usage-engine-lock-2147483647-11111111-1111-4111-8111-111111111111.tmp',
    );
    await writeFile(temporaryPath, 'incomplete\n', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(temporaryPath, old, old);

    const lock = await acquireLock(stateDirectory);

    await expect(Bun.file(temporaryPath).exists()).resolves.toBe(false);
    await lock.release();
  });

  test('preserves and rejects an orphan rendezvous without a lock', async () => {
    const stateDirectory = await createFixture();
    const rendezvous = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory,
      targetId: targetIdFor(stateDirectory),
      token: TOKEN,
    });

    await expect(acquireLock(stateDirectory, OTHER_INSTANCE_ID)).rejects.toThrow('orphan rendezvous was preserved');
    await expect(Bun.file(rendezvous.path).exists()).resolves.toBe(true);
    await rendezvous.remove();
  });

  test('preserves malformed, symlinked, hard-linked, and permissive locks', async () => {
    const malformedDirectory = await createFixture();
    const malformedPath = await writeLock(malformedDirectory, { pid: 123 });
    await expect(acquireLock(malformedDirectory)).rejects.toThrow('invalid metadata and was preserved');
    await expect(Bun.file(malformedPath).exists()).resolves.toBe(true);

    const symlinkDirectory = await createFixture();
    const symlinkTarget = path.join(symlinkDirectory, 'foreign');
    await writeFile(symlinkTarget, 'foreign\n');
    const symlinkDatabasePath = databasePathFor(symlinkDirectory);
    await mkdir(path.dirname(symlinkDatabasePath), { mode: 0o700, recursive: true });
    await symlink(symlinkTarget, usageEngineLockPath(symlinkDatabasePath));
    await expect(acquireLock(symlinkDirectory)).rejects.toThrow('must not be a symlink');

    const permissiveDirectory = await createFixture();
    const permissivePath = await writeLock(permissiveDirectory, await lockMetadata(permissiveDirectory, 2_147_483_647));
    await chmod(permissivePath, 0o640);
    await expect(acquireLock(permissiveDirectory)).rejects.toThrow('owner-only and singly linked');

    const hardLinkedDirectory = await createFixture();
    const hardLinkedPath = await writeLock(hardLinkedDirectory, await lockMetadata(hardLinkedDirectory, 2_147_483_647));
    const hardLinkedAlias = `${hardLinkedPath}.alias`;
    await link(hardLinkedPath, hardLinkedAlias);
    await expect(acquireLock(hardLinkedDirectory)).rejects.toThrow('owner-only and singly linked');
    await expect(Bun.file(hardLinkedPath).exists()).resolves.toBe(true);
    await expect(Bun.file(hardLinkedAlias).exists()).resolves.toBe(true);
  });

  test('removes only the inode acquired by this process during release', async () => {
    const stateDirectory = await createFixture();
    const lock = await acquireLock(stateDirectory);
    const lockPath = usageEngineLockPath(databasePathFor(stateDirectory));
    const oldPath = `${lockPath}.old`;
    await rename(lockPath, oldPath);
    await writeFile(lockPath, 'foreign\n', { mode: 0o600 });

    await expect(lock.release()).rejects.toThrow('changed before release');

    expect(await readFile(lockPath, 'utf8')).toBe('foreign\n');
    await expect(Bun.file(oldPath).exists()).resolves.toBe(true);
  });

  test('inspects absent, live, stale, and unsafe locks without creating or recovering them', async () => {
    const fixture = await createFixture();
    const absentDatabasePath = path.join(fixture, 'absent-store', 'usage.sqlite');
    await expect(inspectUsageEngineLock(absentDatabasePath)).resolves.toMatchObject({ state: 'absent' });
    await expect(Bun.file(path.dirname(absentDatabasePath)).exists()).resolves.toBe(false);

    const liveDirectory = path.join(fixture, 'live-state');
    const live = await acquireLock(liveDirectory);
    await expect(inspectUsageEngineLock(databasePathFor(liveDirectory))).resolves.toMatchObject({
      pid: process.pid,
      state: 'live',
    });
    await live.release();

    const staleDirectory = path.join(fixture, 'stale-state');
    await mkdir(staleDirectory, { mode: 0o700 });
    const stalePath = await writeLock(staleDirectory, await lockMetadata(staleDirectory, 2_147_483_647));
    await expect(inspectUsageEngineLock(databasePathFor(staleDirectory))).resolves.toMatchObject({ state: 'stale' });
    await expect(Bun.file(stalePath).exists()).resolves.toBe(true);

    const unsafeDirectory = path.join(fixture, 'unsafe-state');
    await mkdir(unsafeDirectory, { mode: 0o700 });
    const unsafePath = await writeLock(unsafeDirectory, { pid: 123 });
    await expect(inspectUsageEngineLock(databasePathFor(unsafeDirectory))).resolves.toMatchObject({ state: 'unsafe' });
    await expect(Bun.file(unsafePath).exists()).resolves.toBe(true);
  });
});
