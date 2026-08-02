import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  isUsageStoreErrorReason,
  queryReportRows,
  USAGE_STORE_SCHEMA_VERSION,
  type UsageStoreError,
  type UsageStoreErrorReason,
  usageStoreErrorReasonFrom,
} from './reader';
import { importLocalRows, quiesceUsageStoreForShutdown } from './writer';

const roots: string[] = [];
const machine: UsageMachine = { id: 'reader-machine', label: 'Reader Machine' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-reader-'));
  roots.push(root);
  return root;
};

describe('usage-store error reasons', () => {
  test('narrows only the closed public reason set', () => {
    expect(isUsageStoreErrorReason('store-missing')).toBe(true);
    expect(isUsageStoreErrorReason('unrelated-failure')).toBe(false);
    expect(usageStoreErrorReasonFrom({ reason: 'busy' })).toBe('busy');
    expect(usageStoreErrorReasonFrom({ reason: 'unrelated-failure' })).toBeUndefined();
    expect(usageStoreErrorReasonFrom(new Error('busy'))).toBeUndefined();
  });
});

const fixtureRow = (): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-07-29T10:00:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-07-29T10:01:00.000Z'),
    harness: 'Codex',
    model: 'gpt-5',
    name: 'Reader fixture',
    project: 'ai-usage',
    provider: 'OpenAI',
    tokens: { cr: 0, cw: 0, in: 10, out: 20 },
  }),
  source: { harnessKey: 'codex', sourceSessionId: 'reader-session' },
});

const failureReason = async (
  effect: Effect.Effect<unknown, UsageStoreError>,
): Promise<UsageStoreErrorReason | undefined> => {
  const outcome = await Effect.runPromise(Effect.either(effect));
  if (outcome._tag === 'Right') {
    throw new Error('Expected the read to fail.');
  }
  return outcome.left.reason;
};

interface FileSnapshot {
  readonly bytesHash: string;
  readonly mode: number;
  readonly modifiedAtNanoseconds: bigint;
  readonly size: number;
}

const snapshotFile = async (filePath: string): Promise<FileSnapshot | null> => {
  try {
    const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath, { bigint: true })]);
    return {
      bytesHash: createHash('sha256').update(bytes).digest('hex'),
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode extraction is a bitmask operation.
      mode: Number(metadata.mode & 0o777n),
      modifiedAtNanoseconds: metadata.mtimeNs,
      size: bytes.byteLength,
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const setSchemaVersion = async (dbPath: string, version: number): Promise<void> => {
  const { Database } = await import('bun:sqlite');
  const database = new Database(dbPath, { create: false, readwrite: true });
  try {
    database.exec(`PRAGMA user_version = ${version}`);
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpoint.get();
    checkpoint.finalize();
    const journalMode = database.prepare('PRAGMA journal_mode = DELETE');
    journalMode.get();
    journalMode.finalize();
  } finally {
    database.close();
  }
};

describe('usage-store read-only facade', () => {
  test('does not create a missing store or its parent directory', async () => {
    const root = await createRoot();
    const parent = path.join(root, 'missing-parent');
    const dbPath = path.join(parent, 'usage-store.sqlite');

    expect(await failureReason(queryReportRows({ dbPath }))).toBe('store-missing');
    await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('classifies old, new, and corrupt schemas without migrating them', async () => {
    const root = await createRoot();
    const oldPath = path.join(root, 'old.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath: oldPath, machine, rows: [fixtureRow()] }));
    await setSchemaVersion(oldPath, USAGE_STORE_SCHEMA_VERSION - 1);
    const oldBefore = await snapshotFile(oldPath);
    expect(await failureReason(queryReportRows({ dbPath: oldPath }))).toBe('schema-too-old');
    expect(await snapshotFile(oldPath)).toEqual(oldBefore);

    const newPath = path.join(root, 'new.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath: newPath, machine, rows: [fixtureRow()] }));
    await setSchemaVersion(newPath, USAGE_STORE_SCHEMA_VERSION + 1);
    const newBefore = await snapshotFile(newPath);
    expect(await failureReason(queryReportRows({ dbPath: newPath }))).toBe('schema-too-new');
    expect(await snapshotFile(newPath)).toEqual(newBefore);

    const corruptPath = path.join(root, 'corrupt.sqlite');
    await writeFile(corruptPath, new TextEncoder().encode('not a SQLite database'), { mode: 0o600 });
    const corruptBefore = await snapshotFile(corruptPath);
    expect(await failureReason(queryReportRows({ dbPath: corruptPath }))).toBe('corrupt');
    expect(await snapshotFile(corruptPath)).toEqual(corruptBefore);
  });

  test('classifies a malformed same-version projection schema as corrupt without repairing it', async () => {
    const root = await createRoot();
    const dbPath = path.join(root, 'malformed.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [fixtureRow()] }));
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    database.exec('DROP INDEX idx_served_report_rows_active_time');
    database.close(true);
    const before = await snapshotFile(dbPath);

    expect(await failureReason(queryReportRows({ dbPath }))).toBe('corrupt');
    expect(await snapshotFile(dbPath)).toEqual(before);
  });

  test('rejects same-name projection columns with incompatible declared semantics', async () => {
    const root = await createRoot();
    const dbPath = path.join(root, 'malformed-column.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [fixtureRow()] }));
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    database.exec(`
      DROP TABLE served_report_support;
      CREATE TABLE served_report_support (
        revision TEXT PRIMARY KEY REFERENCES served_report_revisions(revision) ON DELETE CASCADE,
        support_json BLOB NOT NULL,
        support_bytes INTEGER NOT NULL CHECK (support_bytes >= 0)
      );
    `);
    database.close(true);
    const before = await snapshotFile(dbPath);

    expect(await failureReason(queryReportRows({ dbPath }))).toBe('corrupt');
    expect(await snapshotFile(dbPath)).toEqual(before);
  });

  test('leaves database, WAL, SHM, permissions, timestamps, and schema byte-for-byte unchanged', async () => {
    const root = await createRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    await mkdir(path.dirname(dbPath), { recursive: true });
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [fixtureRow()] }));
    await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath }));
    const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`] as const;
    const before = await Promise.all(paths.map(snapshotFile));

    const result = await Effect.runPromise(queryReportRows({ dbPath }));

    expect(result.rows).toHaveLength(1);
    expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
    expect(before[0]?.mode).toBe(0o600);
  });

  test('rejects an insecure private store without repairing its permissions', async () => {
    const root = await createRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [fixtureRow()] }));
    await chmod(dbPath, 0o644);
    const before = await snapshotFile(dbPath);

    expect(await failureReason(queryReportRows({ dbPath }))).toBe('corrupt');
    expect(await snapshotFile(dbPath)).toEqual(before);
  });

  test('returns typed busy after a finite wait without mutating a locked store', async () => {
    const root = await createRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [fixtureRow()] }));
    await Effect.runPromise(quiesceUsageStoreForShutdown({ dbPath }));
    const { Database } = await import('bun:sqlite');
    const writer = new Database(dbPath, { create: false, readwrite: true });
    writer.exec('BEGIN EXCLUSIVE');
    const startedAt = performance.now();
    try {
      expect(await failureReason(queryReportRows({ dbPath }))).toBe('busy');
      expect(performance.now() - startedAt).toBeLessThan(2000);
    } finally {
      writer.exec('ROLLBACK');
      writer.close(true);
    }
  });

  test('reads the committed WAL snapshot while a writer has uncommitted changes', async () => {
    const root = await createRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [fixtureRow()] }));
    const { Database } = await import('bun:sqlite');
    const writer = new Database(dbPath, { create: false, readwrite: true });
    writer.exec('BEGIN IMMEDIATE');
    writer.query("UPDATE usage_rows SET row_json = '{}' WHERE source_session_id = ?").run('reader-session');
    try {
      const result = await Effect.runPromise(queryReportRows({ dbPath }));

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.source.sourceSessionId).toBe('reader-session');
    } finally {
      writer.exec('ROLLBACK');
      writer.close(true);
    }
  });
});
