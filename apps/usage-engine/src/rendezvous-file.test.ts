import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createUsageEngineBearerToken,
  loadUsageEngineRendezvous,
  revealUsageEngineBearerToken,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';
import { publishUsageEngineRendezvous, usageEngineRendezvousPath } from './rendezvous-file';

const fixtures: string[] = [];
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const INSTANCE_ID_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_A = createUsageEngineBearerToken('a'.repeat(43));
const TOKEN_B = createUsageEngineBearerToken('b'.repeat(43));
const TARGET_ID = usageEngineTargetIdFor({ configCwd: '/isolated/config', databasePath: '/isolated/store.sqlite' });

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createFixture = async (): Promise<string> => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'plan052-engine-rendezvous-'));
  fixtures.push(fixture);
  return fixture;
};

describe('usage engine rendezvous writer', () => {
  test('atomically publishes an owner-only parser-compatible rendezvous', async () => {
    const stateDirectory = await createFixture();
    const publication = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory,
      targetId: TARGET_ID,
      token: TOKEN_A,
    });
    const filePath = usageEngineRendezvousPath(stateDirectory);
    const loaded = await loadUsageEngineRendezvous(filePath);

    expect(loaded).toMatchObject({
      instanceId: INSTANCE_ID,
      port: 41_052,
      protocolVersion: 1,
      targetId: TARGET_ID,
    });
    expect(revealUsageEngineBearerToken(loaded.token)).toBe('a'.repeat(43));
    expect(String(loaded.token)).toBe('[REDACTED]');
    expect((await lstat(filePath)).mode % 0o1000).toBe(0o600);
    expect((await lstat(stateDirectory)).mode % 0o1000).toBe(0o700);

    await publication.remove();
    await expect(Bun.file(filePath).exists()).resolves.toBe(false);
  });

  test('rotates the token and removes only the rendezvous inode it published', async () => {
    const stateDirectory = await createFixture();
    const first = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory,
      targetId: TARGET_ID,
      token: TOKEN_A,
    });
    const filePath = usageEngineRendezvousPath(stateDirectory);
    const firstToken = (JSON.parse(await readFile(filePath, 'utf8')) as { token: string }).token;
    await first.remove();
    const second = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_053,
      stateDirectory,
      targetId: TARGET_ID,
      token: TOKEN_B,
    });
    const secondToken = (JSON.parse(await readFile(filePath, 'utf8')) as { token: string }).token;
    expect(secondToken).not.toBe(firstToken);

    const displacedPath = `${filePath}.displaced`;
    await rename(filePath, displacedPath);
    await writeFile(filePath, 'foreign\n', { mode: 0o600 });
    await expect(second.remove()).rejects.toThrow('changed before removal');
    expect(await readFile(filePath, 'utf8')).toBe('foreign\n');
  });

  test('preserves suspicious existing rendezvous paths instead of replacing them', async () => {
    const symlinkDirectory = await createFixture();
    const symlinkPath = usageEngineRendezvousPath(symlinkDirectory);
    const target = path.join(symlinkDirectory, 'foreign');
    await writeFile(target, 'foreign\n');
    await symlink(target, symlinkPath);
    await expect(
      publishUsageEngineRendezvous({
        instanceId: INSTANCE_ID,
        port: 41_052,
        stateDirectory: symlinkDirectory,
        targetId: TARGET_ID,
        token: TOKEN_A,
      }),
    ).rejects.toThrow('already exists and was preserved');
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);

    const permissiveDirectory = await createFixture();
    const permissivePath = usageEngineRendezvousPath(permissiveDirectory);
    await writeFile(permissivePath, '{}\n', { mode: 0o600 });
    await chmod(permissivePath, 0o640);
    await expect(
      publishUsageEngineRendezvous({
        instanceId: INSTANCE_ID,
        port: 41_052,
        stateDirectory: permissiveDirectory,
        targetId: TARGET_ID,
        token: TOKEN_A,
      }),
    ).rejects.toThrow('already exists and was preserved');
  });

  test('rejects an invalid target identity before publishing runtime state', async () => {
    const stateDirectory = await createFixture();

    await expect(
      publishUsageEngineRendezvous({
        instanceId: INSTANCE_ID,
        port: 41_052,
        stateDirectory,
        targetId: 'forged-target' as never,
        token: TOKEN_A,
      }),
    ).rejects.toThrow('target identity');
    await expect(Bun.file(usageEngineRendezvousPath(stateDirectory)).exists()).resolves.toBe(false);
  });

  test('never overwrites an existing valid rendezvous', async () => {
    const stateDirectory = await createFixture();
    const first = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory,
      targetId: TARGET_ID,
      token: TOKEN_A,
    });
    const filePath = usageEngineRendezvousPath(stateDirectory);
    const before = await readFile(filePath);

    await expect(
      publishUsageEngineRendezvous({
        instanceId: INSTANCE_ID,
        port: 41_053,
        stateDirectory,
        targetId: TARGET_ID,
        token: TOKEN_B,
      }),
    ).rejects.toThrow('already exists and was preserved');
    expect(await readFile(filePath)).toEqual(before);
    await first.remove();
  });

  test('scavenges an old dead-owner prepublication rendezvous temporary file', async () => {
    const stateDirectory = await createFixture();
    const temporaryPath = path.join(stateDirectory, '.rendezvous-2147483647-11111111-1111-4111-8111-111111111111.tmp');
    await writeFile(temporaryPath, 'incomplete\n', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(temporaryPath, old, old);

    const publication = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory,
      targetId: TARGET_ID,
      token: TOKEN_A,
    });

    await expect(Bun.file(temporaryPath).exists()).resolves.toBe(false);
    await publication.remove();
  });

  test('atomically admits only one of two concurrent publishers', async () => {
    const stateDirectory = await createFixture();
    const outcomes = await Promise.allSettled([
      publishUsageEngineRendezvous({
        instanceId: INSTANCE_ID,
        port: 41_052,
        stateDirectory,
        targetId: TARGET_ID,
        token: TOKEN_A,
      }),
      publishUsageEngineRendezvous({
        instanceId: INSTANCE_ID_B,
        port: 41_053,
        stateDirectory,
        targetId: TARGET_ID,
        token: TOKEN_B,
      }),
    ]);
    const admitted = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof publishUsageEngineRendezvous>>> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = admitted[0]?.value;
    if (!winner) {
      throw new Error('Concurrent rendezvous publication did not produce one winner.');
    }
    const loaded = await loadUsageEngineRendezvous(usageEngineRendezvousPath(stateDirectory));
    expect(loaded).toMatchObject({ instanceId: winner.instanceId, port: winner.port, targetId: TARGET_ID });
    expect(revealUsageEngineBearerToken(loaded.token)).toBe(revealUsageEngineBearerToken(winner.token));
    await winner.remove();
  });
});
