import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import { parseUsageEngineStatus, USAGE_ENGINE_PROTOCOL_VERSION } from '@ai-usage/usage-engine-control';
import {
  loadUsageEngineRendezvous,
  revealUsageEngineBearerToken,
  type UsageEngineRendezvous,
} from '@ai-usage/usage-engine-control/node';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import { usageEngineLockPath } from './engine-lock';
import { localMemoryIdentityDatabasePath, localMemoryIdentityLockPath } from './memory-identity-runtime';

/**
 * Real-process proofs for the two local stores the engine owns (ADR 0009,
 * ADR 0024, ADR 0038): fresh install, upgrade from a base-of-PR state, reopen,
 * newer-schema refusal, writer ownership, and interrupted-start recovery.
 * Every persistent path the runtime resolves is isolated under one temporary
 * root; nothing here touches the operator's default state.
 */

const repositoryRoot = path.resolve(import.meta.dir, '../../..');
const mainPath = path.join(repositoryRoot, 'apps/usage-engine/src/main.ts');
const cleanupTasks: Array<() => Promise<void>> = [];
const TEST_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 15_000;
const DEAD_PID = 2_147_483_647;
const STALE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const ONE_LOCAL_IDENTITY = { devices: 1, people: 1, spaces: 1 } as const;
const usageEngineFailureDiagnostic = 'Usage engine failed to start or complete its command.';
const startupFailureKindLine = (kind: 'startup-failure' | 'writer-lock-contended'): string =>
  `usage-engine startupFailureKind=${kind}`;

interface EngineFixture {
  readonly databasePath: string;
  readonly env: Record<string, string | undefined>;
  readonly homeDirectory: string;
  readonly memoryDatabasePath: string;
  readonly memoryLockPath: string;
  readonly memoryRendezvousPath: string;
  readonly rendezvousPath: string;
  readonly root: string;
  readonly stateDirectory: string;
  readonly usageLockPath: string;
}

interface MemoryIdentitySnapshot {
  readonly counts: { readonly devices: number; readonly people: number; readonly spaces: number };
  readonly deviceId: string;
  readonly personId: string;
  readonly schema: readonly string[];
  readonly spaceId: string;
  readonly userVersion: number;
}

interface UsageStoreSnapshot {
  readonly generation: number;
  readonly machineFleetGeneration: number;
  readonly rowKeys: readonly string[];
  readonly tables: readonly string[];
  readonly userVersion: number;
}

interface StartupRefusal {
  /** The last two stderr lines: the fixed diagnostic sentence, then the closed failure class. */
  readonly diagnostics: readonly string[];
  readonly exitCode: number;
  /** Whether any private fixture root leaked into the diagnostics. */
  readonly privatePathLeaked: boolean;
}

type ResidualRuntimeFile = 'memory-lease' | 'memory-rendezvous' | 'usage-lease' | 'usage-rendezvous';

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

const withTimeout = async <Value>(promise: Promise<Value>, label: string): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const createFixture = async (
  options: { readonly databasePath?: string; readonly stateDirectory?: string } = {},
): Promise<EngineFixture> => {
  // mkdtemp creates the root owner-only (0700); every directory below inherits that mode explicitly.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-usage-engine-stores-')));
  const homeDirectory = path.join(root, 'home');
  const stateDirectory = options.stateDirectory ?? path.join(root, 'state');
  const temporaryRoot = path.join(root, 'temporary');
  const databasePath = options.databasePath ?? path.join(root, 'store', 'usage.sqlite');
  await Promise.all([
    mkdir(homeDirectory, { mode: 0o700, recursive: true }),
    mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
  ]);
  cleanupTasks.push(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return {
    databasePath,
    env: {
      AI_USAGE_DATABASE_PATH: databasePath,
      AI_USAGE_ENGINE_STATE_DIR: stateDirectory,
      AI_USAGE_HOME: homeDirectory,
      AI_USAGE_LOG_DIR: path.join(root, 'logs'),
      AI_USAGE_ROOT_DIR: root,
      AI_USAGE_TEMP_ROOT: temporaryRoot,
      CODEX_HOME: path.join(homeDirectory, '.codex'),
      HOME: homeDirectory,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      PATH: process.env.PATH,
      TMPDIR: temporaryRoot,
      XDG_CACHE_HOME: path.join(homeDirectory, '.cache'),
      XDG_CONFIG_HOME: path.join(homeDirectory, '.config'),
      XDG_DATA_HOME: path.join(homeDirectory, '.local', 'share'),
      XDG_STATE_HOME: path.join(homeDirectory, '.local', 'state'),
    },
    homeDirectory,
    memoryDatabasePath: localMemoryIdentityDatabasePath(stateDirectory),
    memoryLockPath: localMemoryIdentityLockPath(stateDirectory),
    memoryRendezvousPath: memoryServiceRendezvousPath(stateDirectory),
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    root,
    stateDirectory,
    usageLockPath: usageEngineLockPath(databasePath),
  };
};

const spawnEngine = (fixture: EngineFixture, args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, '--no-env-file', mainPath, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const stdout = new Response(child.stdout).text();
  cleanupTasks.push(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await child.exited.catch(() => undefined);
  });
  return { child, stderr, stdout };
};

type EngineChild = ReturnType<typeof spawnEngine>;

const finishChild = async (engine: EngineChild) => ({
  exitCode: await withTimeout(engine.child.exited, `child PID ${engine.child.pid} to exit`),
  pid: engine.child.pid,
  stderr: await engine.stderr,
  stdout: await engine.stdout,
});

const waitForRendezvous = async (
  engine: EngineChild,
  rendezvousPath: string,
  accept: (rendezvous: UsageEngineRendezvous) => boolean,
): Promise<UsageEngineRendezvous> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (engine.child.exitCode !== null) {
      const stderr = await engine.stderr;
      throw new Error(`Usage engine child exited before readiness: ${stderr}`);
    }
    try {
      const rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
      if (accept(rendezvous)) {
        return rendezvous;
      }
    } catch {
      // Atomic publication may not have happened yet.
    }
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for usage engine rendezvous publication.');
};

const serveUntilReady = async (
  fixture: EngineFixture,
  accept: (rendezvous: UsageEngineRendezvous) => boolean = () => true,
) => {
  const engine = spawnEngine(fixture, ['serve', '--port', '0']);
  const rendezvous = await waitForRendezvous(engine, fixture.rendezvousPath, accept);
  return { engine, rendezvous };
};

const stopEngine = async (engine: EngineChild): Promise<number> => {
  engine.child.kill('SIGTERM');
  return (await finishChild(engine)).exitCode;
};

const statusRequest = (rendezvous: UsageEngineRendezvous): Promise<Response> =>
  fetch(`http://127.0.0.1:${rendezvous.port}/v1/status`, {
    headers: {
      authorization: `Bearer ${revealUsageEngineBearerToken(rendezvous.token)}`,
      'x-ai-usage-protocol-version': String(USAGE_ENGINE_PROTOCOL_VERSION),
    },
  });

const foregroundRequest = (command: 'publish' | 'run-all-enabled', commandId: string): string =>
  JSON.stringify({ command: { command }, commandId, protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION });

const runOnce = async (fixture: EngineFixture, command: 'publish' | 'run-all-enabled', commandId: string) =>
  await finishChild(spawnEngine(fixture, ['once', foregroundRequest(command, commandId)]));

const checkEngine = async (fixture: EngineFixture) => {
  const result = await finishChild(spawnEngine(fixture, ['check']));
  return { ...result, report: JSON.parse(result.stdout.trim()) as Record<string, unknown> };
};

const memoryClientFor = (fixture: EngineFixture) =>
  createMemoryServiceClient({
    resolveRendezvous: async () => await loadMemoryServiceRendezvous(fixture.memoryRendezvousPath),
  });

const exists = (filePath: string): Promise<boolean> => Bun.file(filePath).exists();

const sha256 = async (filePath: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');

/** Digest of every page byte after the 100-byte SQLite file header, which carries only journal-mode and change-counter fields. */
const sha256AfterHeader = async (filePath: string): Promise<string> =>
  createHash('sha256')
    .update((await readFile(filePath)).subarray(100))
    .digest('hex');

/** Every lease or rendezvous file still present; a clean stop leaves none. */
const residualRuntimeFiles = async (fixture: EngineFixture): Promise<readonly ResidualRuntimeFile[]> => {
  const candidates: ReadonlyArray<readonly [ResidualRuntimeFile, string]> = [
    ['usage-lease', fixture.usageLockPath],
    ['memory-lease', fixture.memoryLockPath],
    ['usage-rendezvous', fixture.rendezvousPath],
    ['memory-rendezvous', fixture.memoryRendezvousPath],
  ];
  const present = await Promise.all(
    candidates.map(async ([label, filePath]) => ((await exists(filePath)) ? label : null)),
  );
  return present.filter((label): label is ResidualRuntimeFile => label !== null);
};

const startupRefusal = (
  result: { readonly exitCode: number; readonly stderr: string },
  privateRoots: readonly string[],
): StartupRefusal => ({
  // Wide events emitted before the failure precede the diagnostics, which `main` always writes last.
  diagnostics: result.stderr.trimEnd().split('\n').slice(-2),
  exitCode: result.exitCode,
  privatePathLeaked: privateRoots.some((root) => result.stderr.includes(root)),
});

const expectedRefusal = (kind: 'startup-failure' | 'writer-lock-contended'): StartupRefusal => ({
  diagnostics: [usageEngineFailureDiagnostic, startupFailureKindLine(kind)],
  exitCode: 1,
  privatePathLeaked: false,
});

const withReadOnlyDatabase = <Value>(databasePath: string, use: (database: Database) => Value): Value => {
  const database = new Database(databasePath, { readonly: true });
  try {
    return use(database);
  } finally {
    database.close();
  }
};

const readSchema = (database: Database): readonly string[] =>
  (
    database
      .query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<{ name: string; sql: string | null; type: string }>
  ).map((row) => `${row.type}:${row.name}:${row.sql ?? ''}`);

const readUserVersion = (database: Database): number =>
  (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;

const countRows = (database: Database, table: string): number =>
  (database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const memoryIdentity = (memoryDatabasePath: string): MemoryIdentitySnapshot =>
  withReadOnlyDatabase(memoryDatabasePath, (database) => {
    const metadata = database
      .query('SELECT person_id, personal_space_id, device_id FROM local_identity_metadata WHERE singleton = 1')
      .all() as Array<{ device_id: string; person_id: string; personal_space_id: string }>;
    const [row] = metadata;
    if (metadata.length !== 1 || !row) {
      throw new Error(`Expected exactly one local identity bootstrap, found ${metadata.length}.`);
    }
    return {
      counts: {
        devices: countRows(database, 'devices'),
        people: countRows(database, 'people'),
        spaces: countRows(database, 'spaces'),
      },
      deviceId: row.device_id,
      personId: row.person_id,
      schema: readSchema(database),
      spaceId: row.personal_space_id,
      userVersion: readUserVersion(database),
    };
  });

const usageStoreSnapshot = (databasePath: string): UsageStoreSnapshot =>
  withReadOnlyDatabase(databasePath, (database) => {
    const generations = new Map(
      (
        database
          .query("SELECT key, value FROM usage_store_metadata WHERE key IN ('generation', 'machine_fleet_generation')")
          .all() as Array<{ key: string; value: number }>
      ).map((row) => [row.key, row.value]),
    );
    return {
      generation: generations.get('generation') ?? -1,
      machineFleetGeneration: generations.get('machine_fleet_generation') ?? -1,
      rowKeys: (
        database.query('SELECT row_key FROM usage_rows ORDER BY row_key').all() as Array<{ row_key: string }>
      ).map((row) => row.row_key),
      tables: (
        database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
      userVersion: readUserVersion(database),
    };
  });

/** Writes through the WAL and truncates it so the main file alone carries the state a test hashes. */
const mutateDatabase = (databasePath: string, statements: readonly string[]): void => {
  const database = new Database(databasePath, { strict: true });
  try {
    for (const statement of statements) {
      database.exec(statement);
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
};

/** The same on-disk metadata `acquireUsageEngineLock` publishes, owned by the given PID. */
const writeLockFile = async (
  lockPath: string,
  input: { readonly databasePath: string; readonly pid: number; readonly stateDirectory: string },
): Promise<void> => {
  await mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });
  await mkdir(input.stateDirectory, { mode: 0o700, recursive: true });
  const metadata = {
    createdAt: '2026-09-01T00:00:00.000Z',
    databasePath: input.databasePath,
    hostname: os.hostname(),
    instanceId: STALE_INSTANCE_ID,
    ownerId: '22222222-2222-4222-8222-222222222222',
    pid: input.pid,
    processStartTimeTicks: null,
    stateDirectory: await realpath(input.stateDirectory),
    version: 1,
  };
  await writeFile(lockPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
};

const readLockOwner = async (lockPath: string): Promise<{ readonly instanceId: string; readonly pid: number }> => {
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { instanceId: string; pid: number };
  return { instanceId: lock.instanceId, pid: lock.pid };
};

const codexSession = (id: string, cwd: string): string =>
  `${JSON.stringify({
    payload: { cwd, id },
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'session_meta',
  })}\n${JSON.stringify({
    payload: {
      info: { total_token_usage: { cached_input_tokens: 2, input_tokens: 12, output_tokens: 18, total_tokens: 30 } },
      type: 'token_count',
    },
    timestamp: '2026-01-01T00:04:00.000Z',
  })}\n`;

const writeCodexHistory = async (fixture: EngineFixture): Promise<void> => {
  const sessionsDirectory = path.join(fixture.homeDirectory, '.codex', 'sessions', '2026', '01', '01');
  await mkdir(sessionsDirectory, { mode: 0o700, recursive: true });
  await Promise.all([
    writeFile(path.join(sessionsDirectory, 'alpha.jsonl'), codexSession('fixture-thread-alpha', '/work/alpha')),
    writeFile(path.join(sessionsDirectory, 'beta.jsonl'), codexSession('fixture-thread-beta', '/work/beta')),
  ]);
};

/**
 * The only schema delta between the base-of-PR usage store (schema 3) and this
 * code (schema 4) is the replication outbox pair plus the version constant, so
 * a schema-3 store is reproduced deterministically by removing exactly that.
 */
const downgradeUsageStoreToSchemaThree = (databasePath: string): void => {
  mutateDatabase(databasePath, [
    'DROP TABLE replication_outbox_events',
    'DROP TABLE replication_outbox_state',
    'PRAGMA user_version = 3',
  ]);
};

const removeMemoryStore = async (fixture: EngineFixture): Promise<void> => {
  await Promise.all(
    ['', '-wal', '-shm'].map((suffix) => rm(`${fixture.memoryDatabasePath}${suffix}`, { force: true })),
  );
};

describe('usage engine real process store lifecycle', () => {
  test(
    'bootstraps a fresh install: usage store, one Memory identity, both services, both leases',
    async () => {
      const fixture = await createFixture();
      await expect(exists(fixture.stateDirectory)).resolves.toBe(false);

      const { engine, rendezvous } = await serveUntilReady(fixture);
      const status = await statusRequest(rendezvous);
      expect(status.status).toBe(200);
      expect(parseUsageEngineStatus(await status.json())).toMatchObject({
        readiness: 'ready',
        storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
      });

      // Both writer leases are held for the whole serving lifetime, each beside its own database.
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([
        'usage-lease',
        'memory-lease',
        'usage-rendezvous',
        'memory-rendezvous',
      ]);
      expect(path.dirname(fixture.memoryLockPath)).toBe(fixture.stateDirectory);
      expect((await lstat(fixture.memoryDatabasePath)).mode % 0o1000).toBe(0o600);
      expect((await lstat(fixture.stateDirectory)).mode % 0o1000).toBe(0o700);

      const identity = memoryIdentity(fixture.memoryDatabasePath);
      expect(identity.counts).toEqual(ONE_LOCAL_IDENTITY);
      expect(identity.userVersion).toBeGreaterThan(0);
      expect(usageStoreSnapshot(fixture.databasePath).userVersion).toBe(USAGE_STORE_SCHEMA_VERSION);

      // The Memory service is reachable through its own rendezvous and serves the bootstrapped Space.
      const reviews = await memoryClientFor(fixture).listResolutionReviews();
      expect(String(reviews.spaceId)).toBe(identity.spaceId);
      expect(reviews.reviews).toEqual([]);

      expect(await stopEngine(engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(identity);

      const check = await checkEngine(fixture);
      expect(check.exitCode).toBe(0);
      expect(check.report).toMatchObject({
        lock: { state: 'absent' },
        ok: true,
        rendezvous: { state: 'absent' },
        store: { state: 'compatible' },
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'upgrades a base-of-PR state: schema-3 usage rows survive, Memory bootstraps once, no lease is left behind',
    async () => {
      const fixture = await createFixture();
      await writeCodexHistory(fixture);
      // Collect real rows through the engine first, then reshape the store into what `main` wrote.
      const collected = await runOnce(fixture, 'run-all-enabled', 'collect-1');
      expect(collected.exitCode).toBe(0);
      const collectedStore = usageStoreSnapshot(fixture.databasePath);
      expect(collectedStore.rowKeys.length).toBeGreaterThan(0);
      expect(collectedStore.userVersion).toBe(USAGE_STORE_SCHEMA_VERSION);

      downgradeUsageStoreToSchemaThree(fixture.databasePath);
      await removeMemoryStore(fixture);
      const before = usageStoreSnapshot(fixture.databasePath);
      expect(before.userVersion).toBe(3);
      expect(before.tables).not.toContain('replication_outbox_events');
      expect(before.tables).not.toContain('replication_outbox_state');
      expect(before.rowKeys).toEqual(collectedStore.rowKeys);
      await expect(exists(fixture.memoryDatabasePath)).resolves.toBe(false);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);

      const { engine, rendezvous } = await serveUntilReady(fixture);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      const upgraded = usageStoreSnapshot(fixture.databasePath);
      expect(upgraded.userVersion).toBe(USAGE_STORE_SCHEMA_VERSION);
      expect(upgraded.rowKeys).toEqual(before.rowKeys);
      expect(upgraded.tables).toEqual(
        [...before.tables, 'replication_outbox_events', 'replication_outbox_state'].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(upgraded.generation).toBeGreaterThanOrEqual(before.generation);
      const identity = memoryIdentity(fixture.memoryDatabasePath);
      expect(identity.counts).toEqual(ONE_LOCAL_IDENTITY);

      expect(await stopEngine(engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(identity);
      expect(usageStoreSnapshot(fixture.databasePath).rowKeys).toEqual(before.rowKeys);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'reopens a state produced by this code without a new identity bootstrap or duplicated rows',
    async () => {
      const fixture = await createFixture();
      await writeCodexHistory(fixture);
      expect((await runOnce(fixture, 'run-all-enabled', 'collect-1')).exitCode).toBe(0);
      const identity = memoryIdentity(fixture.memoryDatabasePath);
      const store = usageStoreSnapshot(fixture.databasePath);
      expect(identity.counts).toEqual(ONE_LOCAL_IDENTITY);
      expect(store.rowKeys.length).toBeGreaterThan(0);

      for (const restart of [1, 2]) {
        const { engine, rendezvous } = await serveUntilReady(fixture);
        expect((await statusRequest(rendezvous)).status).toBe(200);
        expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(identity);
        expect(await stopEngine(engine)).toBe(0);
        await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
        const reopened = usageStoreSnapshot(fixture.databasePath);
        expect(reopened.userVersion).toBe(store.userVersion);
        expect(reopened.rowKeys).toEqual(store.rowKeys);
        expect(reopened.tables).toEqual(store.tables);
        expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(identity);
        expect(restart).toBeGreaterThan(0);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'refuses a newer Memory schema without touching either store',
    async () => {
      const fixture = await createFixture();
      expect((await runOnce(fixture, 'publish', 'bootstrap-1')).exitCode).toBe(0);
      const bootstrapped = memoryIdentity(fixture.memoryDatabasePath);
      expect(bootstrapped.counts).toEqual(ONE_LOCAL_IDENTITY);
      mutateDatabase(fixture.memoryDatabasePath, [`PRAGMA user_version = ${bootstrapped.userVersion + 1}`]);
      const memoryBefore = memoryIdentity(fixture.memoryDatabasePath);
      const memoryHashBefore = await sha256(fixture.memoryDatabasePath);
      const usageBefore = usageStoreSnapshot(fixture.databasePath);
      expect(memoryBefore.userVersion).toBe(bootstrapped.userVersion + 1);

      const refused = await finishChild(spawnEngine(fixture, ['serve', '--port', '0']));
      expect(startupRefusal(refused, [fixture.root])).toEqual(expectedRefusal('startup-failure'));

      // Fail closed (ADR 0038): the whole engine stops, and neither database was migrated, recreated, or repaired.
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      expect(await sha256(fixture.memoryDatabasePath)).toBe(memoryHashBefore);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(memoryBefore);
      const usageAfter = usageStoreSnapshot(fixture.databasePath);
      expect(usageAfter.userVersion).toBe(usageBefore.userVersion);
      expect(usageAfter.tables).toEqual(usageBefore.tables);
      expect(usageAfter.rowKeys).toEqual(usageBefore.rowKeys);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'refuses a newer usage schema before opening the Memory store',
    async () => {
      const fixture = await createFixture();
      expect((await runOnce(fixture, 'publish', 'bootstrap-1')).exitCode).toBe(0);
      mutateDatabase(fixture.databasePath, [`PRAGMA user_version = ${USAGE_STORE_SCHEMA_VERSION + 1}`]);
      const usageBefore = usageStoreSnapshot(fixture.databasePath);
      const usagePagesBefore = await sha256AfterHeader(fixture.databasePath);
      const memoryBefore = memoryIdentity(fixture.memoryDatabasePath);
      const memoryHashBefore = await sha256(fixture.memoryDatabasePath);

      const refused = await finishChild(spawnEngine(fixture, ['serve', '--port', '0']));
      expect(startupRefusal(refused, [fixture.root])).toEqual(expectedRefusal('startup-failure'));

      // The refused migration also refuses the shutdown quiesce, so the lifecycle keeps the usage
      // lease on disk for stale-owner recovery instead of releasing it; nothing else is left behind.
      // The writer switches the file to WAL before it reads the version, so only the 100-byte header
      // (journal mode, change counter) differs: every page, the schema, and every row are untouched.
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual(['usage-lease']);
      await expect(readLockOwner(fixture.usageLockPath)).resolves.toMatchObject({ pid: refused.pid });
      expect(await sha256AfterHeader(fixture.databasePath)).toBe(usagePagesBefore);
      expect(usageStoreSnapshot(fixture.databasePath)).toEqual(usageBefore);
      expect(await sha256(fixture.memoryDatabasePath)).toBe(memoryHashBefore);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(memoryBefore);

      // `check` is the operator's read-only verification: it names the dead lease and the unavailable
      // store without mutating either. (The typed store reason is not surfaced here: `inspectStore`
      // sees the Effect fiber failure, not the `UsageStoreError` inside it.)
      const check = await checkEngine(fixture);
      expect(check.exitCode).toBe(1);
      expect(check.report).toMatchObject({
        lock: { pid: refused.pid, state: 'stale' },
        ok: false,
        store: { state: 'unavailable' },
      });
      expect(await sha256AfterHeader(fixture.databasePath)).toBe(usagePagesBefore);
      expect(usageStoreSnapshot(fixture.databasePath)).toEqual(usageBefore);

      // Rollback is "restore a compatible store": the next compatible start recovers the dead lease itself.
      mutateDatabase(fixture.databasePath, [`PRAGMA user_version = ${USAGE_STORE_SCHEMA_VERSION}`]);
      const { engine, rendezvous } = await serveUntilReady(fixture);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(memoryBefore);
      expect(await stopEngine(engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'refuses a second engine that shares the state directory with a different usage database',
    async () => {
      const primaryFixture = await createFixture();
      const { engine: primary, rendezvous } = await serveUntilReady(primaryFixture);
      const identity = memoryIdentity(primaryFixture.memoryDatabasePath);
      const contenderFixture = await createFixture({ stateDirectory: primaryFixture.stateDirectory });
      expect(contenderFixture.databasePath).not.toBe(primaryFixture.databasePath);
      expect(contenderFixture.memoryDatabasePath).toBe(primaryFixture.memoryDatabasePath);

      const refused = await finishChild(spawnEngine(contenderFixture, ['serve', '--port', '0']));
      // The shared state directory already carries the primary's rendezvous, which the usage lease
      // refuses to adopt before the Memory lease is even reached; the ADR 0038 lease itself is
      // proven below with a directly owned memory.sqlite lock.
      expect(startupRefusal(refused, [primaryFixture.root, contenderFixture.root])).toEqual(
        expectedRefusal('startup-failure'),
      );

      // No second usage store was created, and the primary keeps serving the same untouched identity.
      await expect(exists(contenderFixture.databasePath)).resolves.toBe(false);
      await expect(exists(contenderFixture.usageLockPath)).resolves.toBe(false);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      expect(memoryIdentity(primaryFixture.memoryDatabasePath)).toEqual(identity);
      await expect(residualRuntimeFiles(primaryFixture)).resolves.toEqual([
        'usage-lease',
        'memory-lease',
        'usage-rendezvous',
        'memory-rendezvous',
      ]);

      expect(await stopEngine(primary)).toBe(0);
      await expect(residualRuntimeFiles(primaryFixture)).resolves.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'refuses a second engine on the same usage database from another state directory without bootstrapping Memory there',
    async () => {
      const primaryFixture = await createFixture();
      const { engine: primary, rendezvous } = await serveUntilReady(primaryFixture);
      const contenderFixture = await createFixture({ databasePath: primaryFixture.databasePath });
      expect(contenderFixture.stateDirectory).not.toBe(primaryFixture.stateDirectory);

      const refused = await finishChild(spawnEngine(contenderFixture, ['serve', '--port', '0']));
      expect(startupRefusal(refused, [primaryFixture.root, contenderFixture.root])).toEqual(
        expectedRefusal('writer-lock-contended'),
      );
      expect(refused.stderr).not.toContain(String(primary.child.pid));

      // The usage lease precedes every Memory step, so the refused engine never created its own memory.sqlite.
      await expect(exists(contenderFixture.memoryDatabasePath)).resolves.toBe(false);
      await expect(residualRuntimeFiles(contenderFixture)).resolves.toEqual(['usage-lease']);
      expect((await statusRequest(rendezvous)).status).toBe(200);

      expect(await stopEngine(primary)).toBe(0);
      await expect(residualRuntimeFiles(primaryFixture)).resolves.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'reports a live Memory lease as writer-lock-contended and releases the usage lease',
    async () => {
      const fixture = await createFixture();
      // A live owner of memory.sqlite (this test process) that holds no usage lease: only the
      // dedicated Memory lease of ADR 0038 can exclude the engine here.
      await writeLockFile(fixture.memoryLockPath, {
        databasePath: fixture.memoryDatabasePath,
        pid: process.pid,
        stateDirectory: fixture.stateDirectory,
      });
      const lockBefore = await readFile(fixture.memoryLockPath, 'utf8');

      const refused = await finishChild(spawnEngine(fixture, ['serve', '--port', '0']));
      expect(startupRefusal(refused, [fixture.root])).toEqual(expectedRefusal('writer-lock-contended'));
      expect(refused.stderr).not.toContain(String(process.pid));

      // The usage store was prepared, the usage lease was released, and memory.sqlite was never created.
      await expect(exists(fixture.databasePath)).resolves.toBe(true);
      await expect(exists(fixture.memoryDatabasePath)).resolves.toBe(false);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual(['memory-lease']);
      expect(await readFile(fixture.memoryLockPath, 'utf8')).toBe(lockBefore);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'recovers stale usage and Memory leases left before the Memory kernel opened',
    async () => {
      const fixture = await createFixture();
      // An engine that died after taking both leases but before memory.sqlite existed leaves exactly
      // these two files: dead-owner metadata beside each database path and no store to bootstrap from.
      await mkdir(path.dirname(fixture.databasePath), { mode: 0o700, recursive: true });
      await writeLockFile(fixture.usageLockPath, {
        databasePath: fixture.databasePath,
        pid: DEAD_PID,
        stateDirectory: fixture.stateDirectory,
      });
      await writeLockFile(fixture.memoryLockPath, {
        databasePath: fixture.memoryDatabasePath,
        pid: DEAD_PID,
        stateDirectory: fixture.stateDirectory,
      });
      await expect(exists(fixture.memoryDatabasePath)).resolves.toBe(false);

      const { engine, rendezvous } = await serveUntilReady(fixture);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      expect(rendezvous.instanceId).not.toBe(STALE_INSTANCE_ID);
      const identity = memoryIdentity(fixture.memoryDatabasePath);
      expect(identity.counts).toEqual(ONE_LOCAL_IDENTITY);
      const currentOwner = { instanceId: rendezvous.instanceId, pid: engine.child.pid };
      await expect(readLockOwner(fixture.usageLockPath)).resolves.toEqual(currentOwner);
      await expect(readLockOwner(fixture.memoryLockPath)).resolves.toEqual(currentOwner);

      expect(await stopEngine(engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(identity);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'recovers a SIGKILL crash without duplicating the local identity',
    async () => {
      const fixture = await createFixture();
      const crashed = await serveUntilReady(fixture);
      const identity = memoryIdentity(fixture.memoryDatabasePath);
      const staleMemoryRendezvous = await loadMemoryServiceRendezvous(fixture.memoryRendezvousPath);
      crashed.engine.child.kill('SIGKILL');
      expect((await finishChild(crashed.engine)).exitCode).not.toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([
        'usage-lease',
        'memory-lease',
        'usage-rendezvous',
        'memory-rendezvous',
      ]);

      const replacement = await serveUntilReady(
        fixture,
        ({ instanceId }) => instanceId !== crashed.rendezvous.instanceId,
      );
      expect((await statusRequest(replacement.rendezvous)).status).toBe(200);
      const currentMemoryRendezvous = await loadMemoryServiceRendezvous(fixture.memoryRendezvousPath);
      expect(currentMemoryRendezvous.token).not.toBe(staleMemoryRendezvous.token);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(identity);
      expect(String((await memoryClientFor(fixture).listResolutionReviews()).spaceId)).toBe(identity.spaceId);

      expect(await stopEngine(replacement.engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      expect(memoryIdentity(fixture.memoryDatabasePath)).toEqual(identity);
    },
    TEST_TIMEOUT_MS,
  );
});
