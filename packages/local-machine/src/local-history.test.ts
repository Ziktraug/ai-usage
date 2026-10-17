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

test('visits UTF-8 lines incrementally and rejects invalid ones', async () => {
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
    expect(result).toEqual({ bytes: 18, lines: 3, oversizedLines: 0 });

    fs.writeFileSync(filePath, Uint8Array.from([0xff, 0x0a]));
    await expect(Effect.runPromise(storage.readLines(filePath, () => undefined))).rejects.toThrow();
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

/**
 * A pasted image lands as one base64 record far larger than the read chunk, so
 * the drop has to survive being spread across many reads. Losing that record
 * must not cost the surrounding session, which is what previously took the
 * whole collection source down.
 */
test('drops a record over the line bound and keeps reading the rest of the file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-oversized-'));
  try {
    const filePath = path.join(root, 'history.jsonl');
    const oversized = 'x'.repeat(200_000);
    const content = `first\n${oversized}\nlast\n`;
    fs.writeFileSync(filePath, content);
    const storage = createLocalHistoryStorage(root);
    const visited: string[] = [];
    const result = await Effect.runPromise(
      storage.readLines(filePath, (line) => visited.push(line), { maxLineBytes: 1024 }),
    );
    expect(visited).toEqual(['first', 'last']);
    expect(result).toEqual({ bytes: Buffer.byteLength(content, 'utf8'), lines: 2, oversizedLines: 1 });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('counts an oversized trailing record that the file ends without terminating', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-oversized-tail-'));
  try {
    const filePath = path.join(root, 'history.jsonl');
    const content = `first\n${'x'.repeat(200_000)}`;
    fs.writeFileSync(filePath, content);
    const storage = createLocalHistoryStorage(root);
    const visited: string[] = [];
    const result = await Effect.runPromise(
      storage.readLines(filePath, (line) => visited.push(line), { maxLineBytes: 1024 }),
    );
    expect(visited).toEqual(['first']);
    expect(result).toEqual({ bytes: Buffer.byteLength(content, 'utf8'), lines: 1, oversizedLines: 1 });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('counts each oversized record separately when they are adjacent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-oversized-run-'));
  try {
    const filePath = path.join(root, 'history.jsonl');
    const oversized = 'x'.repeat(200_000);
    const content = `${oversized}\n${oversized}\nlast\n`;
    fs.writeFileSync(filePath, content);
    const storage = createLocalHistoryStorage(root);
    const visited: string[] = [];
    const result = await Effect.runPromise(
      storage.readLines(filePath, (line) => visited.push(line), { maxLineBytes: 1024 }),
    );
    expect(visited).toEqual(['last']);
    expect(result).toEqual({ bytes: Buffer.byteLength(content, 'utf8'), lines: 1, oversizedLines: 2 });
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

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** One Raw block carrying `payload`, flagged as the frame's last block. */
const rawLastBlock = (payload: Buffer): Buffer => {
  const header = Buffer.alloc(3);
  // biome-ignore lint/suspicious/noBitwiseOperators: Block_Header packs Block_Size above the type and last-block bits.
  header.writeUIntLE((payload.length << 3) | 1, 0, 3);
  return Buffer.concat([header, payload]);
};

/**
 * Codex compresses finished rollouts in place (`.jsonl` → `.jsonl.zst`). The
 * archive must read exactly like its plain form: same line boundaries, same
 * CRLF handling, same oversized-record accounting, and a byte count that
 * reflects what the parser saw rather than what sat on disk.
 */
test('reads a zstd archive of history lines exactly like its plain form', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-parity-'));
  try {
    const content = `first\r\nsecond\n${'x'.repeat(2048)}\nlast`;
    const plainPath = path.join(root, 'history.jsonl');
    const archivePath = path.join(root, 'history.jsonl.zst');
    fs.writeFileSync(plainPath, content);
    fs.writeFileSync(archivePath, Bun.zstdCompressSync(content));
    const storage = createLocalHistoryStorage(root);
    const plainVisited: string[] = [];
    const archiveVisited: string[] = [];
    const plain = await Effect.runPromise(
      storage.readLines(plainPath, (line) => plainVisited.push(line), { maxLineBytes: 64 }),
    );
    const archive = await Effect.runPromise(
      storage.readLines(archivePath, (line) => archiveVisited.push(line), { maxLineBytes: 64 }),
    );
    expect(archiveVisited).toEqual(plainVisited);
    expect(archiveVisited).toEqual(['first', 'second', 'last']);
    expect(archive).toEqual(plain);
    expect(archive).toEqual({ bytes: Buffer.byteLength(content, 'utf8'), lines: 3, oversizedLines: 1 });

    // A zero-byte archive is damage, not an empty history: zstd of empty input
    // is a 9-byte frame, and Codex removes the plain source only after the
    // archive is written. An empty plain file stays an empty history.
    const emptyPath = path.join(root, 'empty.jsonl.zst');
    fs.writeFileSync(emptyPath, new Uint8Array(0));
    const emptyVisited: string[] = [];
    const empty = await Effect.runPromise(
      Effect.either(storage.readLines(emptyPath, (line) => emptyVisited.push(line))),
    );
    expect(empty._tag).toBe('Left');
    if (empty._tag === 'Left') {
      expect(empty.left).toMatchObject({ operation: 'readLines.decompress', path: emptyPath });
      expect(String((empty.left.cause as Error).cause)).toContain('Missing zstd frame magic number');
    }
    expect(emptyVisited).toEqual([]);
    const emptyPlainPath = path.join(root, 'empty.jsonl');
    fs.writeFileSync(emptyPlainPath, '');
    await expect(Effect.runPromise(storage.readLines(emptyPlainPath, () => undefined))).resolves.toEqual({
      bytes: 0,
      lines: 0,
      oversizedLines: 0,
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('bounds an archive by its declared content size and by its compressed size', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-bound-'));
  try {
    const content = `${'y'.repeat(100_000)}\n`;
    const compressed = Bun.zstdCompressSync(content);
    expect(compressed.length).toBeLessThan(1024);
    const archivePath = path.join(root, 'history.jsonl.zst');
    fs.writeFileSync(archivePath, compressed);
    const storage = createLocalHistoryStorage(root);

    // Between the compressed and the decompressed size: the frame declares its
    // content size, so the bound fires before any decompression.
    const declared = await Effect.runPromise(
      Effect.either(storage.readLines(archivePath, () => undefined, { maxBytes: 1024 })),
    );
    expect(declared._tag).toBe('Left');
    if (declared._tag === 'Left') {
      expect(declared.left).toMatchObject({ operation: 'readLines', path: archivePath });
      expect(String(declared.left.cause)).toContain('exceeds');
    }

    const compressedBound = await Effect.runPromise(
      Effect.either(storage.readLines(archivePath, () => undefined, { maxBytes: compressed.length - 1 })),
    );
    expect(compressedBound._tag).toBe('Left');
    if (compressedBound._tag === 'Left') {
      expect(compressedBound.left).toMatchObject({ operation: 'readLines', path: archivePath });
      expect(String(compressedBound.left.cause)).toContain('exceeds');
    }

    await expect(
      Effect.runPromise(storage.readLines(archivePath, () => undefined, { maxBytes: content.length })),
    ).resolves.toEqual({ bytes: content.length, lines: 1, oversizedLines: 0 });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('rejects corrupt and truncated archives as decompression failures with the cause preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-corrupt-'));
  try {
    const compressed = Bun.zstdCompressSync('first\nsecond\nthird\n');
    const corruptPath = path.join(root, 'corrupt.jsonl.zst');
    const truncatedPath = path.join(root, 'truncated.jsonl.zst');
    const corruptBytes = Buffer.alloc(64, 0xff);
    const truncatedBytes = compressed.subarray(0, compressed.length - 8);
    fs.writeFileSync(corruptPath, corruptBytes);
    fs.writeFileSync(truncatedPath, truncatedBytes);
    // A frame whose layout is intact (declared size 16, one Compressed block of
    // 8 bytes, last) but whose block is garbage passes every structural check
    // and fails inside the decompressor.
    const garbageBlockPath = path.join(root, 'garbage-block.jsonl.zst');
    const garbageBlockHeader = Buffer.alloc(3);
    // biome-ignore lint/suspicious/noBitwiseOperators: Block_Header packs Block_Size, Block_Type and Last_Block.
    garbageBlockHeader.writeUIntLE((8 << 3) | (2 << 1) | 1, 0, 3);
    const garbageBlockBytes = Buffer.concat([
      ZSTD_MAGIC,
      Buffer.from([0x20, 0x10]),
      garbageBlockHeader,
      Buffer.alloc(8, 0xff),
    ]);
    fs.writeFileSync(garbageBlockPath, garbageBlockBytes);
    const storage = createLocalHistoryStorage(root);

    let decompressorMessage: string | undefined;
    try {
      Bun.zstdDecompressSync(garbageBlockBytes);
    } catch (cause) {
      decompressorMessage = cause instanceof Error ? cause.message : undefined;
    }
    expect(decompressorMessage).toBeDefined();

    // Bytes without the frame magic and a frame whose last block runs past the
    // end are refused by the frame walk before the decompressor runs; a frame
    // with an intact layout and a garbage block fails inside it. All keep
    // their cause under the same typed operation.
    for (const [archivePath, expectedCause] of [
      [corruptPath, 'Missing zstd frame magic number'],
      [truncatedPath, 'Truncated zstd frame'],
      [garbageBlockPath, decompressorMessage],
    ] as const) {
      const visited: string[] = [];
      const result = await Effect.runPromise(
        Effect.either(storage.readLines(archivePath, (line) => visited.push(line))),
      );
      expect(result._tag).toBe('Left');
      if (result._tag !== 'Left') {
        throw new Error(`Expected ${archivePath} to fail`);
      }
      expect(result.left).toMatchObject({ operation: 'readLines.decompress', path: archivePath });
      expect(result.left.cause).toBeInstanceOf(Error);
      const archiveError = result.left.cause as Error;
      expect(archiveError.message).toBe(`History archive could not be decompressed: ${archivePath}`);
      expect(archiveError.cause).toBeInstanceOf(Error);
      expect((archiveError.cause as Error).message).toBe(expectedCause as string);
      expect(visited).toEqual([]);
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('rejects a symlink to an archive and an archive that is not exactly one frame', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-frames-'));
  try {
    const frame = Bun.zstdCompressSync('a\nb\n');
    const multiFramePath = path.join(root, 'multi.jsonl.zst');
    fs.writeFileSync(multiFramePath, Buffer.concat([frame, Bun.zstdCompressSync('c\nd')]));
    const trailingPath = path.join(root, 'trailing.jsonl.zst');
    fs.writeFileSync(trailingPath, Buffer.concat([frame, Buffer.from('xx')]));
    const linkPath = path.join(root, 'link.jsonl.zst');
    fs.symlinkSync(multiFramePath, linkPath);
    const storage = createLocalHistoryStorage(root);

    const linked = await Effect.runPromise(Effect.either(storage.readLines(linkPath, () => undefined)));
    expect(linked._tag).toBe('Left');
    if (linked._tag === 'Left') {
      expect(linked.left).toMatchObject({ operation: 'readLines', path: linkPath });
      expect(String(linked.left.cause)).toContain('not a regular file');
    }

    // The output bound is proven by the one frame's declared size; a second
    // frame or trailing bytes would decompress outside it, so they are refused.
    for (const archivePath of [multiFramePath, trailingPath]) {
      const visited: string[] = [];
      const result = await Effect.runPromise(
        Effect.either(storage.readLines(archivePath, (line) => visited.push(line))),
      );
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left).toMatchObject({ operation: 'readLines.decompress', path: archivePath });
        expect(String((result.left.cause as Error).cause)).toContain('not a single zstd frame');
      }
      expect(visited).toEqual([]);
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('refuses a frame that omits its content size even though the decompressor accepts it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-undeclared-'));
  try {
    const text = 'first\nsecond\n';
    // Frame_Header_Descriptor 0x00 declares no content size and no single
    // segment, so one Window_Descriptor byte follows it.
    const undeclared = Buffer.concat([ZSTD_MAGIC, Buffer.from([0x00, 0x80]), rawLastBlock(Buffer.from(text))]);
    expect(Bun.zstdDecompressSync(undeclared).toString()).toBe(text);
    const undeclaredPath = path.join(root, 'undeclared.jsonl.zst');
    fs.writeFileSync(undeclaredPath, undeclared);
    // Frame_Header_Descriptor 0x20: single segment with a 1-byte content size
    // that overstates the Raw block by one byte.
    const mismatchedPath = path.join(root, 'mismatched.jsonl.zst');
    fs.writeFileSync(
      mismatchedPath,
      Buffer.concat([ZSTD_MAGIC, Buffer.from([0x20, text.length + 1]), rawLastBlock(Buffer.from(text))]),
    );
    const storage = createLocalHistoryStorage(root);

    const result = await Effect.runPromise(Effect.either(storage.readLines(undeclaredPath, () => undefined)));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ operation: 'readLines.decompress', path: undeclaredPath });
      expect(String((result.left.cause as Error).cause)).toContain('does not declare its content size');
    }

    const mismatched = await Effect.runPromise(Effect.either(storage.readLines(mismatchedPath, () => undefined)));
    expect(mismatched._tag).toBe('Left');
    if (mismatched._tag === 'Left') {
      expect(mismatched.left).toMatchObject({ operation: 'readLines.decompress', path: mismatchedPath });
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('refuses a declared content size over the bound before decompressing anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-declared-'));
  try {
    const archive = Buffer.from(Bun.zstdCompressSync('{"a":1}\n'.repeat(262_144)));
    // Keep the frame header (at most 18 bytes) and destroy everything after
    // it: only a guard that runs before decompression can still report the
    // bound, and without the bound the same bytes are a decompression failure.
    archive.fill(0xff, 18);
    const archivePath = path.join(root, 'smashed.jsonl.zst');
    fs.writeFileSync(archivePath, archive);
    const storage = createLocalHistoryStorage(root);

    const bounded = await Effect.runPromise(
      Effect.either(storage.readLines(archivePath, () => undefined, { maxBytes: 1024 * 1024 })),
    );
    expect(bounded._tag).toBe('Left');
    if (bounded._tag === 'Left') {
      expect(bounded.left).toMatchObject({ operation: 'readLines', path: archivePath });
      expect(String(bounded.left.cause)).toContain('exceeds');
    }

    const unbounded = await Effect.runPromise(
      Effect.either(storage.readLines(archivePath, () => undefined, { maxBytes: 64 * 1024 * 1024 })),
    );
    expect(unbounded._tag).toBe('Left');
    if (unbounded._tag === 'Left') {
      expect(unbounded.left).toMatchObject({ operation: 'readLines.decompress', path: archivePath });
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('TestMemoryStorage reads byte fixtures and zstd archives through readLines', async () => {
  const storage = new TestMemoryStorage();
  const content = 'first\r\nsecond\nlast\n';
  storage.writeText('.codex/sessions/plain.jsonl', content);
  storage.writeBytes('.codex/sessions/archive.jsonl.zst', Bun.zstdCompressSync(content));
  storage.writeBytes('.codex/sessions/corrupt.jsonl.zst', Buffer.alloc(16, 0xff));
  const plainPath = path.join(storage.home, '.codex/sessions/plain.jsonl');
  const archivePath = path.join(storage.home, '.codex/sessions/archive.jsonl.zst');
  const corruptPath = path.join(storage.home, '.codex/sessions/corrupt.jsonl.zst');

  const plainVisited: string[] = [];
  const archiveVisited: string[] = [];
  const plain = Effect.runSync(storage.readLines(plainPath, (line) => plainVisited.push(line), { maxLineBytes: 8 }));
  const archive = Effect.runSync(
    storage.readLines(archivePath, (line) => archiveVisited.push(line), { maxLineBytes: 8 }),
  );
  expect(archiveVisited).toEqual(plainVisited);
  expect(archive).toEqual(plain);
  expect(archive.bytes).toBe(Buffer.byteLength(content, 'utf8'));

  const corrupt = Effect.runSync(Effect.either(storage.readLines(corruptPath, () => undefined)));
  expect(corrupt._tag).toBe('Left');
  if (corrupt._tag === 'Left') {
    expect(corrupt.left).toMatchObject({ operation: 'readLines.decompress', path: corruptPath });
  }

  // A zero-byte archive is refused like the real reader refuses it.
  storage.writeBytes('.codex/sessions/empty.jsonl.zst', new Uint8Array(0));
  const emptyPath = path.join(storage.home, '.codex/sessions/empty.jsonl.zst');
  const empty = Effect.runSync(Effect.either(storage.readLines(emptyPath, () => undefined)));
  expect(empty._tag).toBe('Left');
  if (empty._tag === 'Left') {
    expect(empty.left).toMatchObject({ operation: 'readLines.decompress', path: emptyPath });
  }

  const bounded = Effect.runSync(Effect.either(storage.readLines(archivePath, () => undefined, { maxBytes: 4 })));
  expect(bounded._tag).toBe('Left');
  if (bounded._tag === 'Left') {
    expect(bounded.left).toMatchObject({ operation: 'readLines', path: archivePath });
  }

  // Byte fixtures are decoded, never decompressed, by the text reader.
  storage.writeBytes('.codex/sessions/raw.jsonl', new TextEncoder().encode('raw text'));
  expect(Effect.runSync(storage.readText(path.join(storage.home, '.codex/sessions/raw.jsonl')))).toBe('raw text');
  const entries = await Effect.runPromise(storage.readDir(path.join(storage.home, '.codex/sessions')));
  expect(entries.find((entry) => entry.name === 'archive.jsonl.zst')?.size).toBe(Bun.zstdCompressSync(content).length);
  expect(entries.find((entry) => entry.name === 'raw.jsonl')?.size).toBe(8);
});
