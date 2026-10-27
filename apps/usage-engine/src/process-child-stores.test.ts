import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUsageEngineStatus, USAGE_ENGINE_PROTOCOL_VERSION } from '@ai-usage/usage-engine-control';
import {
  loadUsageEngineRendezvous,
  revealUsageEngineBearerToken,
  type UsageEngineRendezvous,
} from '@ai-usage/usage-engine-control/node';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import { usageEngineLockPath } from './engine-lock';

/**
 * Real-process proofs for the usage store the engine owns (ADR 0009, ADR
 * 0084): fresh install, upgrade from a schema-4 store, reopen, newer-schema
 * refusal, writer ownership, interrupted-start recovery, and a Memory store
 * left by an earlier version staying untouched. Every persistent path the
 * runtime resolves is isolated under one temporary root; nothing here touches
 * the operator's default state.
 */

const repositoryRoot = path.resolve(import.meta.dir, '../../..');
const mainPath = path.join(repositoryRoot, 'apps/usage-engine/src/main.ts');
const cleanupTasks: Array<() => Promise<void>> = [];
const TEST_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 15_000;
const DEAD_PID = 2_147_483_647;
const STALE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const usageEngineFailureDiagnostic = 'Usage engine failed to start or complete its command.';
const startupFailureKindLine = (kind: 'startup-failure' | 'writer-lock-contended'): string =>
  `usage-engine startupFailureKind=${kind}`;

interface EngineFixture {
  readonly databasePath: string;
  readonly env: Record<string, string | undefined>;
  readonly homeDirectory: string;
  readonly rendezvousPath: string;
  /** The files an earlier engine wrote for its accepted-Memory store; this engine never creates or opens them. */
  readonly retiredMemory: {
    readonly databasePath: string;
    readonly lockPath: string;
    readonly rendezvousPath: string;
  };
  readonly root: string;
  readonly stateDirectory: string;
  readonly usageLockPath: string;
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

type ResidualRuntimeFile = 'usage-lease' | 'usage-rendezvous';

type RetiredMemoryFile = 'memory-lease' | 'memory-rendezvous' | 'memory-store';

interface RetiredMemoryDigests {
  readonly database: string;
  readonly lease: string;
  readonly rendezvous: string;
}

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
  const fixtureBinDirectory = path.join(root, 'bin');
  await Promise.all([
    mkdir(homeDirectory, { mode: 0o700, recursive: true }),
    mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    mkdir(fixtureBinDirectory, { mode: 0o700, recursive: true }),
  ]);
  // The engine observes and discovers pull requests and Jira issues through the operator's CLIs. A
  // store lifecycle test must never reach them: these stand-ins answer "not signed in" at once.
  await Promise.all(
    ['gh', 'acli'].map(async (command) => {
      await writeFile(path.join(fixtureBinDirectory, command), '#!/bin/sh\nexit 4\n', { mode: 0o700 });
    }),
  );
  cleanupTasks.push(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const retiredMemoryDatabasePath = path.join(stateDirectory, 'memory.sqlite');
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
      PATH: `${fixtureBinDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      TMPDIR: temporaryRoot,
      XDG_CACHE_HOME: path.join(homeDirectory, '.cache'),
      XDG_CONFIG_HOME: path.join(homeDirectory, '.config'),
      XDG_DATA_HOME: path.join(homeDirectory, '.local', 'share'),
      XDG_STATE_HOME: path.join(homeDirectory, '.local', 'state'),
    },
    homeDirectory,
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    retiredMemory: {
      databasePath: retiredMemoryDatabasePath,
      lockPath: usageEngineLockPath(retiredMemoryDatabasePath),
      rendezvousPath: path.join(stateDirectory, 'memory-service.json'),
    },
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

const presentFiles = async <Label extends string>(
  candidates: ReadonlyArray<readonly [Label, string]>,
): Promise<readonly Label[]> => {
  const present = await Promise.all(candidates.map(([, filePath]) => exists(filePath)));
  return candidates.filter((_candidate, index) => present[index]).map(([label]) => label);
};

/** Every lease or rendezvous file still present; a clean stop leaves none. */
const residualRuntimeFiles = (fixture: EngineFixture): Promise<readonly ResidualRuntimeFile[]> =>
  presentFiles<ResidualRuntimeFile>([
    ['usage-lease', fixture.usageLockPath],
    ['usage-rendezvous', fixture.rendezvousPath],
  ]);

/** Every file of the retired Memory runtime present in the state directory, including SQLite sidecars. */
const retiredMemoryFiles = (fixture: EngineFixture): Promise<readonly RetiredMemoryFile[]> =>
  presentFiles<RetiredMemoryFile>([
    ['memory-store', fixture.retiredMemory.databasePath],
    ['memory-store', `${fixture.retiredMemory.databasePath}-wal`],
    ['memory-store', `${fixture.retiredMemory.databasePath}-shm`],
    ['memory-lease', fixture.retiredMemory.lockPath],
    ['memory-rendezvous', fixture.retiredMemory.rendezvousPath],
  ]);

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

/** Every schema object (tables and indexes) with its defining SQL. */
const readSchema = (database: Database): readonly string[] =>
  (
    database
      .query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<{ name: string; sql: string | null; type: string }>
  ).map((row) => `${row.type}:${row.name}:${row.sql ?? ''}`);

const readUserVersion = (database: Database): number =>
  (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;

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
 * A schema-4 usage store differs from the schema-5 layout only by the
 * replication outbox it still carried: two tables, their two indexes, and the
 * version constant. Re-adding exactly that, with one enqueued event so the
 * upgrade has to drop populated tables, reproduces it deterministically. The
 * version stays pinned to 4: that is the store the outbox drop must upgrade.
 */
const previousUsageSchemaVersion = 4;
const restoreSchemaFourReplicationOutbox = (databasePath: string): void => {
  mutateDatabase(databasePath, [
    `CREATE TABLE replication_outbox_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      device_id TEXT NOT NULL,
      stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
      next_generation INTEGER NOT NULL CHECK (next_generation > 0),
      acknowledged_through_generation INTEGER NOT NULL DEFAULT 0
        CHECK (acknowledged_through_generation >= 0),
      previous_ack_proof TEXT CHECK (previous_ack_proof IS NULL OR length(previous_ack_proof) = 64),
      last_acknowledged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE replication_outbox_events (
      event_id             TEXT PRIMARY KEY,
      generation           INTEGER NOT NULL CHECK (generation > 0),
      fact_key             TEXT NOT NULL CHECK (length(fact_key) BETWEEN 1 AND 512),
      content_hash         TEXT NOT NULL CHECK (length(content_hash) = 64),
      change_kind          TEXT NOT NULL,
      payload              TEXT NOT NULL CHECK (json_valid(payload)),
      state                TEXT NOT NULL CHECK (
        state IN ('pending', 'in-flight', 'acknowledged', 'blocked')
      ),
      enqueued_at          TEXT NOT NULL,
      attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at      TEXT,
      last_error_code      TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
      acknowledged_at      TEXT,
      UNIQUE (generation, fact_key, content_hash),
      CHECK (
        (state = 'acknowledged' AND acknowledged_at IS NOT NULL)
        OR (state <> 'acknowledged' AND acknowledged_at IS NULL)
      )
    ) STRICT`,
    'CREATE INDEX idx_replication_outbox_ready ON replication_outbox_events(state, next_attempt_at, generation)',
    'CREATE INDEX idx_replication_outbox_fact_history ON replication_outbox_events(fact_key, generation)',
    `INSERT INTO replication_outbox_state
       (singleton, device_id, stream_id, next_generation, created_at, updated_at)
     VALUES (1, 'fixture-device', 'usage-v1', 2, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    `INSERT INTO replication_outbox_events
       (event_id, generation, fact_key, content_hash, change_kind, payload, state, enqueued_at)
     VALUES ('fixture-event', 1, 'fixture-fact', '${'0'.repeat(64)}', 'upsert', '{}', 'pending',
             '2026-09-01T00:00:00.000Z')`,
    `PRAGMA user_version = ${previousUsageSchemaVersion}`,
  ]);
};

const retiredMemoryDigests = async (fixture: EngineFixture): Promise<RetiredMemoryDigests> => ({
  database: await sha256(fixture.retiredMemory.databasePath),
  lease: await sha256(fixture.retiredMemory.lockPath),
  rendezvous: await sha256(fixture.retiredMemory.rendezvousPath),
});

/** A Memory store, live-owned lease, and rendezvous as an earlier engine version left them. */
const writeRetiredMemoryRuntime = async (fixture: EngineFixture): Promise<RetiredMemoryDigests> => {
  await writeLockFile(fixture.retiredMemory.lockPath, {
    databasePath: fixture.retiredMemory.databasePath,
    pid: process.pid,
    stateDirectory: fixture.stateDirectory,
  });
  const database = new Database(fixture.retiredMemory.databasePath, { create: true, strict: true });
  try {
    database.exec('CREATE TABLE local_identity_metadata (singleton INTEGER PRIMARY KEY, person_id TEXT NOT NULL)');
    database.exec("INSERT INTO local_identity_metadata VALUES (1, 'fixture-person')");
    database.exec('PRAGMA user_version = 6');
  } finally {
    database.close();
  }
  await writeFile(fixture.retiredMemory.rendezvousPath, '{"port":1,"token":"retired","version":1}\n', {
    mode: 0o600,
  });
  return await retiredMemoryDigests(fixture);
};

describe('usage engine real process store lifecycle', () => {
  test(
    'bootstraps a fresh install: usage store, its lease and rendezvous, and no Memory store',
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

      // The usage writer lease is held for the whole serving lifetime; no Memory file is ever created.
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual(['usage-lease', 'usage-rendezvous']);
      await expect(retiredMemoryFiles(fixture)).resolves.toEqual([]);
      expect((await lstat(fixture.stateDirectory)).mode % 0o1000).toBe(0o700);
      expect(usageStoreSnapshot(fixture.databasePath).userVersion).toBe(USAGE_STORE_SCHEMA_VERSION);

      expect(await stopEngine(engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      await expect(retiredMemoryFiles(fixture)).resolves.toEqual([]);

      const check = await checkEngine(fixture);
      expect(check.exitCode).toBe(0);
      expect(check.report).toEqual({
        lock: { state: 'absent' },
        ok: true,
        rendezvous: { state: 'absent' },
        store: expect.objectContaining({ state: 'compatible' }),
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'upgrades a schema-4 store: usage rows survive and the replication outbox is dropped',
    async () => {
      const fixture = await createFixture();
      await writeCodexHistory(fixture);
      // Collect real rows through the engine first, then reshape the store into what `main` wrote.
      const collected = await runOnce(fixture, 'run-all-enabled', 'collect-1');
      expect(collected.exitCode).toBe(0);
      const collectedStore = usageStoreSnapshot(fixture.databasePath);
      const collectedSchema = withReadOnlyDatabase(fixture.databasePath, readSchema);
      expect(collectedStore.rowKeys.length).toBeGreaterThan(0);
      expect(collectedStore.userVersion).toBe(USAGE_STORE_SCHEMA_VERSION);
      expect(collectedSchema.some((entry) => entry.includes('replication_outbox'))).toBe(false);

      restoreSchemaFourReplicationOutbox(fixture.databasePath);
      const before = usageStoreSnapshot(fixture.databasePath);
      expect(before.userVersion).toBe(previousUsageSchemaVersion);
      expect(before.tables).toContain('replication_outbox_events');
      expect(before.tables).toContain('replication_outbox_state');
      expect(before.rowKeys).toEqual(collectedStore.rowKeys);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);

      const { engine, rendezvous } = await serveUntilReady(fixture);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      const upgraded = usageStoreSnapshot(fixture.databasePath);
      expect(upgraded.userVersion).toBe(USAGE_STORE_SCHEMA_VERSION);
      expect(upgraded.rowKeys).toEqual(before.rowKeys);
      expect(upgraded.tables).toEqual(collectedStore.tables);
      expect(upgraded.generation).toBeGreaterThanOrEqual(before.generation);
      // Both outbox tables and both of their indexes are gone; every other schema object is unchanged.
      expect(withReadOnlyDatabase(fixture.databasePath, readSchema)).toEqual(collectedSchema);

      expect(await stopEngine(engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      await expect(retiredMemoryFiles(fixture)).resolves.toEqual([]);
      expect(usageStoreSnapshot(fixture.databasePath).rowKeys).toEqual(before.rowKeys);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'reopens a state produced by this code without duplicated rows',
    async () => {
      const fixture = await createFixture();
      await writeCodexHistory(fixture);
      expect((await runOnce(fixture, 'run-all-enabled', 'collect-1')).exitCode).toBe(0);
      const store = usageStoreSnapshot(fixture.databasePath);
      expect(store.rowKeys.length).toBeGreaterThan(0);

      for (const restart of [1, 2]) {
        const { engine, rendezvous } = await serveUntilReady(fixture);
        expect((await statusRequest(rendezvous)).status).toBe(200);
        expect(await stopEngine(engine)).toBe(0);
        await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
        const reopened = usageStoreSnapshot(fixture.databasePath);
        expect(reopened.userVersion).toBe(store.userVersion);
        expect(reopened.rowKeys).toEqual(store.rowKeys);
        expect(reopened.tables).toEqual(store.tables);
        expect(restart).toBeGreaterThan(0);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'leaves a Memory store, lease, and rendezvous from an earlier version untouched',
    async () => {
      const fixture = await createFixture();
      // The earlier Memory lease names this live test process as its owner: an engine that still
      // honoured it would refuse to start, and one that still opened memory.sqlite would rewrite it.
      const retiredBefore = await writeRetiredMemoryRuntime(fixture);

      const { engine, rendezvous } = await serveUntilReady(fixture);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      expect(await stopEngine(engine)).toBe(0);
      expect((await runOnce(fixture, 'publish', 'publish-1')).exitCode).toBe(0);

      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      await expect(retiredMemoryFiles(fixture)).resolves.toEqual(['memory-store', 'memory-lease', 'memory-rendezvous']);
      await expect(retiredMemoryDigests(fixture)).resolves.toEqual(retiredBefore);

      // `check` reports only the usage store, its lease, and the control rendezvous.
      const check = await checkEngine(fixture);
      expect(check.exitCode).toBe(0);
      expect(Object.keys(check.report).sort((left, right) => left.localeCompare(right))).toEqual([
        'lock',
        'ok',
        'rendezvous',
        'store',
      ]);
      expect(check.report).toMatchObject({ lock: { state: 'absent' }, ok: true, rendezvous: { state: 'absent' } });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'refuses a newer usage schema without touching the store',
    async () => {
      const fixture = await createFixture();
      expect((await runOnce(fixture, 'publish', 'bootstrap-1')).exitCode).toBe(0);
      mutateDatabase(fixture.databasePath, [`PRAGMA user_version = ${USAGE_STORE_SCHEMA_VERSION + 1}`]);
      const usageBefore = usageStoreSnapshot(fixture.databasePath);
      const usagePagesBefore = await sha256AfterHeader(fixture.databasePath);

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

      // `check` is the operator's read-only verification: it names the dead lease and the unavailable
      // store without mutating either. Effect 4's `runPromise` rejects with the `UsageStoreError` itself,
      // so `inspectStore` reports its typed reason rather than a generic storage failure.
      const check = await checkEngine(fixture);
      expect(check.exitCode).toBe(1);
      expect(check.report).toMatchObject({
        lock: { pid: refused.pid, state: 'stale' },
        ok: false,
        store: { reason: 'schema-too-new', state: 'unavailable' },
      });
      expect(await sha256AfterHeader(fixture.databasePath)).toBe(usagePagesBefore);
      expect(usageStoreSnapshot(fixture.databasePath)).toEqual(usageBefore);

      // Rollback is "restore a compatible store": the next compatible start recovers the dead lease itself.
      mutateDatabase(fixture.databasePath, [`PRAGMA user_version = ${USAGE_STORE_SCHEMA_VERSION}`]);
      const { engine, rendezvous } = await serveUntilReady(fixture);
      expect((await statusRequest(rendezvous)).status).toBe(200);
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
      const contenderFixture = await createFixture({ stateDirectory: primaryFixture.stateDirectory });
      expect(contenderFixture.databasePath).not.toBe(primaryFixture.databasePath);

      const refused = await finishChild(spawnEngine(contenderFixture, ['serve', '--port', '0']));
      // The shared state directory already carries the primary's rendezvous, which the contender's
      // usage lease refuses to adopt.
      expect(startupRefusal(refused, [primaryFixture.root, contenderFixture.root])).toEqual(
        expectedRefusal('startup-failure'),
      );

      // No second usage store was created, and the primary keeps serving.
      await expect(exists(contenderFixture.databasePath)).resolves.toBe(false);
      await expect(exists(contenderFixture.usageLockPath)).resolves.toBe(false);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      await expect(residualRuntimeFiles(primaryFixture)).resolves.toEqual(['usage-lease', 'usage-rendezvous']);

      expect(await stopEngine(primary)).toBe(0);
      await expect(residualRuntimeFiles(primaryFixture)).resolves.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'refuses a second engine on the same usage database from another state directory',
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

      // The contender sees only the primary's lease beside the shared database and publishes nothing.
      await expect(residualRuntimeFiles(contenderFixture)).resolves.toEqual(['usage-lease']);
      expect((await statusRequest(rendezvous)).status).toBe(200);

      expect(await stopEngine(primary)).toBe(0);
      await expect(residualRuntimeFiles(primaryFixture)).resolves.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'recovers a stale usage lease left before the store opened',
    async () => {
      const fixture = await createFixture();
      // An engine that died right after taking its lease leaves dead-owner metadata beside the
      // database path and no store yet.
      await mkdir(path.dirname(fixture.databasePath), { mode: 0o700, recursive: true });
      await writeLockFile(fixture.usageLockPath, {
        databasePath: fixture.databasePath,
        pid: DEAD_PID,
        stateDirectory: fixture.stateDirectory,
      });
      await expect(exists(fixture.databasePath)).resolves.toBe(false);

      const { engine, rendezvous } = await serveUntilReady(fixture);
      expect((await statusRequest(rendezvous)).status).toBe(200);
      expect(rendezvous.instanceId).not.toBe(STALE_INSTANCE_ID);
      await expect(readLockOwner(fixture.usageLockPath)).resolves.toEqual({
        instanceId: rendezvous.instanceId,
        pid: engine.child.pid,
      });

      expect(await stopEngine(engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'recovers a SIGKILL crash without duplicating rows',
    async () => {
      const fixture = await createFixture();
      await writeCodexHistory(fixture);
      expect((await runOnce(fixture, 'run-all-enabled', 'collect-1')).exitCode).toBe(0);
      const store = usageStoreSnapshot(fixture.databasePath);
      const crashed = await serveUntilReady(fixture);
      crashed.engine.child.kill('SIGKILL');
      expect((await finishChild(crashed.engine)).exitCode).not.toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual(['usage-lease', 'usage-rendezvous']);

      const replacement = await serveUntilReady(
        fixture,
        ({ instanceId }) => instanceId !== crashed.rendezvous.instanceId,
      );
      expect((await statusRequest(replacement.rendezvous)).status).toBe(200);
      await expect(readLockOwner(fixture.usageLockPath)).resolves.toEqual({
        instanceId: replacement.rendezvous.instanceId,
        pid: replacement.engine.child.pid,
      });

      expect(await stopEngine(replacement.engine)).toBe(0);
      await expect(residualRuntimeFiles(fixture)).resolves.toEqual([]);
      const recovered = usageStoreSnapshot(fixture.databasePath);
      expect(recovered.rowKeys).toEqual(store.rowKeys);
      expect(recovered.tables).toEqual(store.tables);
    },
    TEST_TIMEOUT_MS,
  );
});
