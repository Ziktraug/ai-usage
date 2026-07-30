import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageEngineBearerToken } from '@ai-usage/usage-engine-control/node';
import { initializeUsageStore, quiesceUsageStoreForShutdown } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { acquireUsageEngineLock } from './engine-lock';
import type { UsageEngineProcessPaths } from './process';
import { checkUsageEngine } from './process-check';
import { publishUsageEngineRendezvous } from './rendezvous-file';

const fixtures: string[] = [];
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_TEXT = 'a'.repeat(43);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createPaths = async (): Promise<UsageEngineProcessPaths> => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-check-'));
  fixtures.push(root);
  return {
    configCwd: path.join(root, 'config'),
    databasePath: path.join(root, 'store', 'usage-store.sqlite'),
    homeDirectory: path.join(root, 'home'),
    inboxDirectory: path.join(root, 'state', 'inbox'),
    logDirectory: path.join(root, 'logs'),
    operatorCwd: path.join(root, 'operator'),
    stateDirectory: path.join(root, 'state'),
    temporaryRoot: path.join(root, 'temporary'),
  };
};

const fileSnapshot = async (filePath: string) => {
  const metadata = await lstat(filePath, { bigint: true }).catch(() => undefined);
  if (!metadata) {
    return null;
  }
  return {
    bytes: metadata.isFile() ? await readFile(filePath) : null,
    mode: metadata.mode,
    modifiedAtNanoseconds: metadata.mtimeNs,
    size: metadata.size,
  };
};

test('check reads a compatible stopped store without creating or changing runtime state', async () => {
  const paths = await createPaths();
  await mkdir(path.dirname(paths.databasePath), { mode: 0o700, recursive: true });
  await mkdir(paths.stateDirectory, { mode: 0o700 });
  await Effect.runPromise(initializeUsageStore({ dbPath: paths.databasePath }));
  await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath: paths.databasePath }));
  const trackedPaths = [
    paths.databasePath,
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`,
    paths.stateDirectory,
  ];
  const before = await Promise.all(trackedPaths.map(fileSnapshot));
  const entriesBefore = await readdir(paths.stateDirectory);

  const report = await checkUsageEngine(paths);

  expect(report).toMatchObject({
    lock: { state: 'absent' },
    ok: true,
    rendezvous: { state: 'absent' },
    store: { state: 'compatible' },
  });
  expect(await Promise.all(trackedPaths.map(fileSnapshot))).toEqual(before);
  expect(await readdir(paths.stateDirectory)).toEqual(entriesBefore);
  await expect(Bun.file(paths.inboxDirectory).exists()).resolves.toBe(false);
  await expect(Bun.file(paths.temporaryRoot).exists()).resolves.toBe(false);
});

describe('running engine check identity', () => {
  test('cross-checks lock and rendezvous identities without exposing the token', async () => {
    const paths = await createPaths();
    await mkdir(path.dirname(paths.databasePath), { mode: 0o700, recursive: true });
    await Effect.runPromise(initializeUsageStore({ dbPath: paths.databasePath }));
    await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath: paths.databasePath }));
    const lock = await acquireUsageEngineLock({
      databasePath: paths.databasePath,
      instanceId: INSTANCE_ID,
      stateDirectory: paths.stateDirectory,
    });
    const rendezvous = await publishUsageEngineRendezvous({
      instanceId: INSTANCE_ID,
      port: 41_052,
      stateDirectory: paths.stateDirectory,
      token: createUsageEngineBearerToken(TOKEN_TEXT),
    });

    const report = await checkUsageEngine(paths);

    expect(report).toMatchObject({
      lock: { instanceId: INSTANCE_ID, pid: process.pid, state: 'live' },
      ok: true,
      rendezvous: { instanceId: INSTANCE_ID, port: 41_052, state: 'valid' },
    });
    expect(JSON.stringify(report)).not.toContain(TOKEN_TEXT);
    await rendezvous.remove();
    await lock.release();
  });

  test('reports a lock and rendezvous identity mismatch without mutation', async () => {
    const paths = await createPaths();
    await mkdir(path.dirname(paths.databasePath), { mode: 0o700, recursive: true });
    await Effect.runPromise(initializeUsageStore({ dbPath: paths.databasePath }));
    await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath: paths.databasePath }));
    const lock = await acquireUsageEngineLock({
      databasePath: paths.databasePath,
      instanceId: INSTANCE_ID,
      stateDirectory: paths.stateDirectory,
    });
    const rendezvous = await publishUsageEngineRendezvous({
      instanceId: OTHER_INSTANCE_ID,
      port: 41_052,
      stateDirectory: paths.stateDirectory,
      token: createUsageEngineBearerToken(TOKEN_TEXT),
    });
    const before = await Promise.all([fileSnapshot(lock.path), fileSnapshot(rendezvous.path)]);

    const report = await checkUsageEngine(paths);

    expect(report).toMatchObject({ ok: false, rendezvous: { state: 'mismatched' } });
    expect(await Promise.all([fileSnapshot(lock.path), fileSnapshot(rendezvous.path)])).toEqual(before);
    await rendezvous.remove();
    await lock.release();
  });
});
