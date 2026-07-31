import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import fs, { type BigIntStats, type PathLike, type StatOptions, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalHistoryStorage,
  readConfigFileText,
  readRegularFileText,
  walkFiles,
} from '@ai-usage/local-machine/local-history';
import { TestMemoryStorage } from '@ai-usage/local-machine/testing/memory-storage';
import { Effect } from 'effect';

const PREVIOUS_AGGREGATE_HISTORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const SIMULATED_LARGE_SESSION_BYTES = 600 * 1024 * 1024;

const originalLstatSync = fs.lstatSync;
let beforeLstatRead: ((filePath: PathLike) => void) | undefined;

function instrumentedLstatSync(
  filePath: PathLike,
  options?: StatOptions & { bigint?: false | undefined; throwIfNoEntry?: true | undefined },
): Stats;
function instrumentedLstatSync(
  filePath: PathLike,
  options: StatOptions & { bigint: true; throwIfNoEntry?: true | undefined },
): BigIntStats;
function instrumentedLstatSync(
  filePath: PathLike,
  options: StatOptions & { bigint?: false | undefined; throwIfNoEntry: false },
): Stats | undefined;
function instrumentedLstatSync(
  filePath: PathLike,
  options: StatOptions & { bigint: true; throwIfNoEntry: false },
): BigIntStats | undefined;
function instrumentedLstatSync(
  filePath: PathLike,
  options: StatOptions & { throwIfNoEntry?: true | undefined },
): BigIntStats | Stats;
function instrumentedLstatSync(filePath: PathLike, options?: StatOptions): BigIntStats | Stats | undefined;
function instrumentedLstatSync(filePath: PathLike, options?: StatOptions): BigIntStats | Stats | undefined {
  beforeLstatRead?.(filePath);
  return originalLstatSync(filePath, options);
}

test('reads exact-limit regular UTF-8 files and rejects limit+1 and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-read-'));
  try {
    const exactPath = path.join(root, 'exact.txt');
    fs.writeFileSync(exactPath, '1234');
    expect(readRegularFileText(exactPath, 4)).toBe('1234');
    expect(() => readRegularFileText(exactPath, 3)).toThrow('3-byte limit');
    const linkPath = path.join(root, 'link.txt');
    fs.symlinkSync(exactPath, linkPath);
    expect(() => readRegularFileText(linkPath, 4)).toThrow('not a regular file');
    const invalidPath = path.join(root, 'invalid.txt');
    fs.writeFileSync(invalidPath, Uint8Array.from([0xff]));
    expect(() => readRegularFileText(invalidPath, 1)).toThrow();
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('readConfigText follows config symlinks while keeping the hardened target read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-config-'));
  try {
    const storage = createLocalHistoryStorage(root);
    const targetPath = path.join(root, 'settings.json');
    fs.writeFileSync(targetPath, '{"cleanupPeriodDays":9999}');
    const linkPath = path.join(root, 'settings-link.json');
    fs.symlinkSync(targetPath, linkPath);

    // Dotfiles managers install configs as symlinks; the config read resolves
    // them where the history read (below) must keep rejecting them.
    expect(Effect.runSync(storage.readConfigText(linkPath))).toBe('{"cleanupPeriodDays":9999}');
    expect(() => Effect.runSync(storage.readConfigText(linkPath, 4))).toThrow();
    expect(() => Effect.runSync(storage.readText(linkPath))).toThrow();

    const secondLinkPath = path.join(root, 'settings-link-2.json');
    fs.symlinkSync(linkPath, secondLinkPath);
    expect(readConfigFileText(secondLinkPath)).toBe('{"cleanupPeriodDays":9999}');

    const cyclePath = path.join(root, 'cycle.json');
    fs.symlinkSync(cyclePath, cyclePath);
    expect(() => readConfigFileText(cyclePath)).toThrow('cyclic');
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('visits UTF-8 lines incrementally and rejects oversized or invalid lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-lines-'));
  try {
    const filePath = path.join(root, 'history.jsonl');
    fs.writeFileSync(filePath, 'first\r\nsecond\nlast');
    const storage = createLocalHistoryStorage(root);
    const visited: string[] = [];
    const result = await Effect.runPromise(
      storage.readLines(filePath, (line) => visited.push(line), { maxBytes: 18, maxLineBytes: 6 }),
    );
    expect(visited).toEqual(['first', 'second', 'last']);
    expect(result).toEqual({ bytes: 18, lines: 3 });

    await expect(
      Effect.runPromise(storage.readLines(filePath, () => undefined, { maxBytes: 18, maxLineBytes: 5 })),
    ).rejects.toThrow();
    fs.writeFileSync(filePath, Uint8Array.from([0xff, 0x0a]));
    await expect(Effect.runPromise(storage.readLines(filePath, () => undefined))).rejects.toThrow();
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('bounds iterative history traversal and ignores symlink entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-walk-'));
  try {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'one.jsonl'), '1');
    fs.writeFileSync(path.join(root, 'a', 'b', 'two.jsonl'), '22');
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'linked-directory'));
    const storage = createLocalHistoryStorage(root);
    const files = await Effect.runPromise(walkFiles(storage, root, (name) => name.endsWith('.jsonl')));
    expect(files.map((file) => path.relative(root, file))).toEqual(['a/one.jsonl', 'a/b/two.jsonl']);
    await expect(Effect.runPromise(walkFiles(storage, root, () => true, { maxDepth: 0 }))).rejects.toThrow();
    await expect(Effect.runPromise(walkFiles(storage, root, () => true, { maxFiles: 1 }))).rejects.toThrow();
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('discovers large streaming histories without treating total bytes as resident memory', async () => {
  const root = '/virtual/large-history';
  const storage = {
    ...createLocalHistoryStorage(root),
    exists: () => Effect.succeed(true),
    readDir: () =>
      Effect.succeed(
        ['one', 'two', 'three', 'four'].map((name) => ({
          isDirectory: false,
          isRegularFile: true,
          name: `${name}.jsonl`,
          size: SIMULATED_LARGE_SESSION_BYTES,
        })),
      ),
  };

  const discovered = await Effect.runPromise(walkFiles(storage, root, () => true));
  expect(discovered.sort()).toEqual(
    ['four', 'one', 'three', 'two'].map((name) => path.join(root, `${name}.jsonl`)).sort(),
  );
  const explicitlyBounded = await Effect.runPromise(
    Effect.either(walkFiles(storage, root, () => true, { maxBytes: PREVIOUS_AGGREGATE_HISTORY_LIMIT_BYTES })),
  );
  expect(explicitlyBounded._tag).toBe('Left');
});

test('accepts a regular SQLite main without a WAL and rejects unsafe identities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-sqlite-identity-'));
  try {
    const storage = createLocalHistoryStorage(root);
    const dbPath = path.join(root, 'history.sqlite');
    const writer = new Database(dbPath, { create: true });
    writer.exec('CREATE TABLE events (id TEXT PRIMARY KEY)');
    writer.query('INSERT INTO events (id) VALUES (?)').run('regular-row');
    writer.close();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);

    const regularDatabase = await Effect.runPromise(storage.openDatabase(dbPath));
    try {
      const rows = await Effect.runPromise(regularDatabase.all<{ id: string }>('SELECT id FROM events'));
      expect(rows).toEqual([{ id: 'regular-row' }]);
    } finally {
      await Effect.runPromise(regularDatabase.close);
    }
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);

    const redirectedMain = path.join(root, 'redirected-main.sqlite');
    fs.symlinkSync(dbPath, redirectedMain);

    const walSymlinkMain = path.join(root, 'wal-symlink.sqlite');
    const walMainWriter = new Database(walSymlinkMain, { create: true });
    walMainWriter.exec('CREATE TABLE events (id TEXT PRIMARY KEY)');
    walMainWriter.close();
    const walPath = `${walSymlinkMain}-wal`;
    fs.symlinkSync(dbPath, walPath);

    const directoryPath = path.join(root, 'directory.sqlite');
    fs.mkdirSync(directoryPath);
    const absentPath = path.join(root, 'absent.sqlite');

    for (const [candidatePath, rejectedPath] of [
      [redirectedMain, redirectedMain],
      [walSymlinkMain, walPath],
      [directoryPath, directoryPath],
      [absentPath, absentPath],
    ] as const) {
      const result = await Effect.runPromise(Effect.either(storage.openDatabase(candidatePath)));
      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') {
        await Effect.runPromise(result.right.close);
        throw new Error(`Expected SQLite identity rejection for ${candidatePath}`);
      }
      expect(result.left).toMatchObject({ operation: 'sqlite.identity', path: rejectedPath });
      expect(String(result.left.cause)).not.toContain('regular-row');
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('rejects a main identity replacement after BEGIN and closes the opened database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-sqlite-replacement-'));
  const dbPath = path.join(root, 'history.sqlite');
  const replacementPath = path.join(root, 'replacement.sqlite');
  const displacedPath = path.join(root, 'opened.sqlite');
  for (const [filePath, id] of [
    [dbPath, 'original-row'],
    [replacementPath, 'redirected-row'],
  ] as const) {
    const database = new Database(filePath, { create: true });
    database.exec('CREATE TABLE events (id TEXT PRIMARY KEY)');
    database.query('INSERT INTO events (id) VALUES (?)').run(id);
    database.close();
  }

  let mainIdentityReads = 0;
  beforeLstatRead = (filePath) => {
    if (filePath === dbPath) {
      mainIdentityReads++;
      if (mainIdentityReads === 2) {
        fs.renameSync(dbPath, displacedPath);
        fs.renameSync(replacementPath, dbPath);
      }
    }
  };
  const lstatSpy = spyOn(fs, 'lstatSync').mockImplementation(instrumentedLstatSync);
  const closeSpy = spyOn(Database.prototype, 'close');
  try {
    const storage = createLocalHistoryStorage(root);
    const result = await Effect.runPromise(Effect.either(storage.openDatabase(dbPath)));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') {
      await Effect.runPromise(result.right.close);
      throw new Error('Expected replacement to reject openDatabase');
    }
    expect(result.left).toMatchObject({ operation: 'sqlite.identityChanged', path: dbPath });
    expect(String(result.left.cause)).not.toContain('redirected-row');
    expect(mainIdentityReads).toBe(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  } finally {
    beforeLstatRead = undefined;
    lstatSpy.mockRestore();
    closeSpy.mockRestore();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('rejects an absent-to-present WAL transition for the current collection attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-sqlite-new-wal-'));
  const dbPath = path.join(root, 'history.sqlite');
  const walPath = `${dbPath}-wal`;
  const writer = new Database(dbPath, { create: true });
  writer.exec('CREATE TABLE events (id TEXT PRIMARY KEY)');
  writer.close();

  let walIdentityReads = 0;
  beforeLstatRead = (filePath) => {
    if (filePath === walPath) {
      walIdentityReads++;
      if (walIdentityReads === 2) {
        fs.writeFileSync(walPath, 'new WAL from a concurrent writer');
      }
    }
  };
  const lstatSpy = spyOn(fs, 'lstatSync').mockImplementation(instrumentedLstatSync);
  try {
    const storage = createLocalHistoryStorage(root);
    const result = await Effect.runPromise(Effect.either(storage.openDatabase(dbPath)));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') {
      await Effect.runPromise(result.right.close);
      throw new Error('Expected new WAL identity to reject openDatabase');
    }
    expect(result.left).toMatchObject({ operation: 'sqlite.identityChanged', path: walPath });
    expect(walIdentityReads).toBe(2);
  } finally {
    beforeLstatRead = undefined;
    lstatSpy.mockRestore();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('keeps one read-only SQLite snapshot and sees committed WAL rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-wal-'));
  const dbPath = path.join(root, 'history.sqlite');
  const writer = new Database(dbPath, { create: true });
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events (id INTEGER PRIMARY KEY);');
    writer.exec('INSERT INTO events (id) VALUES (1);');
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    const storage = createLocalHistoryStorage(root);
    const database = await Effect.runPromise(storage.openDatabase(dbPath));
    try {
      const rows = await Effect.runPromise(database.all<{ id: number }>('SELECT id FROM events ORDER BY id'));
      expect(rows).toEqual([{ id: 1 }]);
      const selected = await Effect.runPromise(database.all<{ id: number }>('SELECT id FROM events WHERE id = ?', [1]));
      expect(selected).toEqual([{ id: 1 }]);
      const injectionShapedParameter = await Effect.runPromise(
        database.all<{ id: number }>('SELECT id FROM events WHERE id = ?', ['1 OR 1=1']),
      );
      expect(injectionShapedParameter).toEqual([]);
      writer.exec('INSERT INTO events (id) VALUES (2);');
      const sameSnapshot = await Effect.runPromise(database.all<{ id: number }>('SELECT id FROM events ORDER BY id'));
      expect(sameSnapshot).toEqual([{ id: 1 }]);
    } finally {
      await Effect.runPromise(database.close);
      await Effect.runPromise(database.close);
    }
  } finally {
    writer.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('keys in-memory SQLite fixtures by SQL and positional parameters', async () => {
  const storage = new TestMemoryStorage();
  const sql = 'SELECT id FROM events WHERE session_id = ? LIMIT ?';
  storage.writeDatabaseRows('history.sqlite', sql, [{ id: 1 }], ['session-a', 2]);
  storage.writeDatabaseRows('history.sqlite', sql, [], ['session-b', 2]);
  const database = await Effect.runPromise(storage.openDatabase(path.join(storage.home, 'history.sqlite')));
  try {
    await expect(Effect.runPromise(database.all(sql, ['session-a', 2]))).resolves.toEqual([{ id: 1 }]);
    await expect(Effect.runPromise(database.all(sql, ['session-b', 2]))).resolves.toEqual([]);
  } finally {
    await Effect.runPromise(database.close);
  }
});
