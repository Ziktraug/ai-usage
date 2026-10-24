import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import fs, { type BigIntStats, type PathLike, type StatOptions, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES,
  HISTORY_JSONL_MAX_BYTES,
} from '@ai-usage/local-machine/history-budgets';
import {
  createBoundedLineEmitter,
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

const emitPieces = (pieces: readonly string[], maxLineBytes: number) => {
  const visited: string[] = [];
  const emitter = createBoundedLineEmitter((line) => visited.push(line), maxLineBytes);
  for (const piece of pieces) {
    emitter.push(piece);
  }
  emitter.finish();
  return { lines: emitter.lines, oversizedLines: emitter.oversizedLines, visited };
};

/**
 * Codex rollouts carry single records of several megabytes, each spread over
 * hundreds of read chunks. Re-scanning the whole buffered record on every
 * chunk made a cold pass quadratic in record length and drove its memory peak
 * to several gigabytes of discarded copies.
 */
test('assembles a record spread over thousands of pushes in linear work', () => {
  const piece = 'x'.repeat(4096);
  const pieceCount = 2048;
  const visited: string[] = [];
  const emitter = createBoundedLineEmitter((line) => visited.push(line), 32 * 1024 * 1024);
  const startedAt = performance.now();
  for (let index = 0; index < pieceCount; index++) {
    emitter.push(piece);
  }
  emitter.push('\n');
  emitter.finish();
  const elapsedMs = performance.now() - startedAt;
  expect(visited.map((line) => line.length)).toEqual([piece.length * pieceCount]);
  expect(elapsedMs).toBeLessThan(1000);
}, 30_000);

test('joins records across pushes, including a carriage return split from its newline', () => {
  expect(emitPieces(['ab', 'cd\r', '\nef\n', '', '\n', 'gh'], 1024)).toEqual({
    lines: 4,
    oversizedLines: 0,
    visited: ['abcd', 'ef', '', 'gh'],
  });
});

test('bounds a record by its UTF-8 bytes whether it arrives whole or split', () => {
  // 'é' is 2 bytes, '—' 3 and '😀' 4: nine bytes in all.
  const atBound = 'é—😀';
  const overBound = `a${atBound}`;
  expect(emitPieces([`${atBound}\n`], 9)).toEqual({ lines: 1, oversizedLines: 0, visited: [atBound] });
  expect(emitPieces(['é', '—😀', '\n'], 9)).toEqual({ lines: 1, oversizedLines: 0, visited: [atBound] });
  expect(emitPieces([`${overBound}\nnext\n`], 9)).toEqual({ lines: 1, oversizedLines: 1, visited: ['next'] });
  expect(emitPieces(['aé', '—😀', '\nnext\n'], 9)).toEqual({ lines: 1, oversizedLines: 1, visited: ['next'] });
});

test('discards a record once its unterminated bytes pass the bound and resumes after its newline', () => {
  expect(emitPieces(['ok\nlong', 'erthan8', 'bytes', '\nnext\n'], 8)).toEqual({
    lines: 2,
    oversizedLines: 1,
    visited: ['ok', 'next'],
  });
  // One push closes a discarded record and starts another over the bound.
  expect(emitPieces(['x'.repeat(10), `x\n${'y'.repeat(10)}`], 8)).toEqual({
    lines: 0,
    oversizedLines: 2,
    visited: [],
  });
});

test('closes the trailing record at finish', () => {
  expect(emitPieces(['a\nb'], 8)).toEqual({ lines: 2, oversizedLines: 0, visited: ['a', 'b'] });
  expect(emitPieces(['a\n\r'], 8)).toEqual({ lines: 2, oversizedLines: 0, visited: ['a', ''] });
  expect(emitPieces(['a\n', 'x'.repeat(20)], 8)).toEqual({ lines: 1, oversizedLines: 1, visited: ['a'] });
  expect(emitPieces([], 8)).toEqual({ lines: 0, oversizedLines: 0, visited: [] });
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
    Effect.result(walkFiles(storage, root, () => true, { maxBytes: PREVIOUS_AGGREGATE_HISTORY_LIMIT_BYTES })),
  );
  expect(explicitlyBounded._tag).toBe('Failure');
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
      const result = await Effect.runPromise(Effect.result(storage.openDatabase(candidatePath)));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Success') {
        await Effect.runPromise(result.success.close);
        throw new Error(`Expected SQLite identity rejection for ${candidatePath}`);
      }
      expect(result.failure).toMatchObject({ operation: 'sqlite.identity', path: rejectedPath });
      expect(String(result.failure.cause)).not.toContain('regular-row');
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
    const result = await Effect.runPromise(Effect.result(storage.openDatabase(dbPath)));
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Success') {
      await Effect.runPromise(result.success.close);
      throw new Error('Expected replacement to reject openDatabase');
    }
    expect(result.failure).toMatchObject({ operation: 'sqlite.identityChanged', path: dbPath });
    expect(String(result.failure.cause)).not.toContain('redirected-row');
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
    const result = await Effect.runPromise(Effect.result(storage.openDatabase(dbPath)));
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Success') {
      await Effect.runPromise(result.success.close);
      throw new Error('Expected new WAL identity to reject openDatabase');
    }
    expect(result.failure).toMatchObject({ operation: 'sqlite.identityChanged', path: walPath });
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

/**
 * Every way source can reach a Bun zstd decompressor (sync or async): member
 * access, bracket access, a destructuring pattern taken from `Bun`, and a
 * named import from the `bun` module.
 */
const BUN_ZSTD_DECOMPRESSOR_PATTERNS = [
  /\bBun\s*\.\s*zstdDecompress(?:Sync)?\b/,
  /\bBun\s*\[\s*['"`]zstdDecompress(?:Sync)?['"`]\s*\]/,
  /\{[^}]*\bzstdDecompress(?:Sync)?\b[^}]*\}\s*=\s*Bun\b/,
  /\bimport\s*\{[^}]*\bzstdDecompress(?:Sync)?\b[^}]*\}\s*from\s*['"]bun['"]/,
];

const DOLLAR_SIGN = /\$/g;

/** A namespace or default import of the `bun` module, capturing its local name. */
const BUN_MODULE_BINDINGS = /\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"]bun['"]/g;

const reachesBunZstdDecompressor = (source: string): boolean =>
  BUN_ZSTD_DECOMPRESSOR_PATTERNS.some((pattern) => pattern.test(source)) ||
  [...source.matchAll(BUN_MODULE_BINDINGS)].some(([, binding]) =>
    new RegExp(`\\b${binding?.replace(DOLLAR_SIGN, '\\$')}\\s*\\.\\s*zstdDecompress(?:Sync)?\\b`).test(source),
  );

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
      Effect.result(storage.readLines(emptyPath, (line) => emptyVisited.push(line))),
    );
    expect(empty._tag).toBe('Failure');
    if (empty._tag === 'Failure') {
      expect(empty.failure).toMatchObject({ operation: 'readLines.decompress', path: emptyPath });
      expect(String((empty.failure.cause as Error).cause)).toContain('Missing zstd frame magic number');
    }
    expect(emptyVisited).toEqual([]);
    const emptyPlainPath = path.join(root, 'empty.jsonl');
    fs.writeFileSync(emptyPlainPath, '');
    await expect(Effect.runPromise(storage.readLines(emptyPlainPath, () => undefined))).resolves.toEqual({
      bytes: 0,
      lines: 0,
      oversizedLines: 0,
    });
    // A well-formed archive of empty input (the 9-byte frame declaring 0
    // bytes) is an empty history, read through the decompressor's smallest
    // output cap: the option refuses 0, so the declaration is capped at 1.
    const emptyFramePath = path.join(root, 'empty-frame.jsonl.zst');
    const emptyFrame = Bun.zstdCompressSync('');
    expect(emptyFrame.length).toBe(9);
    fs.writeFileSync(emptyFramePath, emptyFrame);
    const emptyFrameVisited: string[] = [];
    await expect(
      Effect.runPromise(storage.readLines(emptyFramePath, (line) => emptyFrameVisited.push(line))),
    ).resolves.toEqual({ bytes: 0, lines: 0, oversizedLines: 0 });
    expect(emptyFrameVisited).toEqual([]);
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
      Effect.result(storage.readLines(archivePath, () => undefined, { maxBytes: 1024 })),
    );
    expect(declared._tag).toBe('Failure');
    if (declared._tag === 'Failure') {
      expect(declared.failure).toMatchObject({ operation: 'readLines', path: archivePath });
      expect(String(declared.failure.cause)).toContain('exceeds');
    }

    const compressedBound = await Effect.runPromise(
      Effect.result(storage.readLines(archivePath, () => undefined, { maxBytes: compressed.length - 1 })),
    );
    expect(compressedBound._tag).toBe('Failure');
    if (compressedBound._tag === 'Failure') {
      expect(compressedBound.failure).toMatchObject({ operation: 'readLines', path: archivePath });
      expect(String(compressedBound.failure.cause)).toContain('exceeds');
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

    // The same call the reader makes: `node:zlib` capped at the declared size.
    let decompressorMessage: string | undefined;
    try {
      zstdDecompressSync(garbageBlockBytes, { maxOutputLength: 16 });
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
        Effect.result(storage.readLines(archivePath, (line) => visited.push(line))),
      );
      expect(result._tag).toBe('Failure');
      if (result._tag !== 'Failure') {
        throw new Error(`Expected ${archivePath} to fail`);
      }
      expect(result.failure).toMatchObject({ operation: 'readLines.decompress', path: archivePath });
      expect(result.failure.cause).toBeInstanceOf(Error);
      const archiveError = result.failure.cause as Error;
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

    const linked = await Effect.runPromise(Effect.result(storage.readLines(linkPath, () => undefined)));
    expect(linked._tag).toBe('Failure');
    if (linked._tag === 'Failure') {
      expect(linked.failure).toMatchObject({ operation: 'readLines', path: linkPath });
      expect(String(linked.failure.cause)).toContain('not a regular file');
    }

    // The output bound is proven by the one frame's declared size; a second
    // frame or trailing bytes would decompress outside it, so they are refused.
    for (const archivePath of [multiFramePath, trailingPath]) {
      const visited: string[] = [];
      const result = await Effect.runPromise(
        Effect.result(storage.readLines(archivePath, (line) => visited.push(line))),
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure).toMatchObject({ operation: 'readLines.decompress', path: archivePath });
        expect(String((result.failure.cause as Error).cause)).toContain('not a single zstd frame');
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
    expect(zstdDecompressSync(undeclared).toString()).toBe(text);
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

    const result = await Effect.runPromise(Effect.result(storage.readLines(undeclaredPath, () => undefined)));
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({ operation: 'readLines.decompress', path: undeclaredPath });
      expect(String((result.failure.cause as Error).cause)).toContain('does not declare its content size');
    }

    const mismatched = await Effect.runPromise(Effect.result(storage.readLines(mismatchedPath, () => undefined)));
    expect(mismatched._tag).toBe('Failure');
    if (mismatched._tag === 'Failure') {
      expect(mismatched.failure).toMatchObject({ operation: 'readLines.decompress', path: mismatchedPath });
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
      Effect.result(storage.readLines(archivePath, () => undefined, { maxBytes: 1024 * 1024 })),
    );
    expect(bounded._tag).toBe('Failure');
    if (bounded._tag === 'Failure') {
      expect(bounded.failure).toMatchObject({ operation: 'readLines', path: archivePath });
      expect(String(bounded.failure.cause)).toContain('exceeds');
    }

    const unbounded = await Effect.runPromise(
      Effect.result(storage.readLines(archivePath, () => undefined, { maxBytes: 64 * 1024 * 1024 })),
    );
    expect(unbounded._tag).toBe('Failure');
    if (unbounded._tag === 'Failure') {
      expect(unbounded.failure).toMatchObject({ operation: 'readLines.decompress', path: archivePath });
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('refuses an archive declaring more than the archive budget even under the plain-file budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-budget-'));
  try {
    // A single-segment frame header declaring one byte over the archive
    // budget (Frame_Content_Size_Flag 2, four size bytes), nothing after it:
    // the plain-file budget admits the declaration, so only the archive budget,
    // checked before any block is walked or decoded, can refuse it.
    const header = Buffer.alloc(9);
    ZSTD_MAGIC.copy(header, 0);
    header.writeUInt8(0xa0, 4);
    header.writeUInt32LE(HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES + 1, 5);
    const archivePath = path.join(root, 'declares-too-much.jsonl.zst');
    fs.writeFileSync(archivePath, header);
    expect(HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES).toBeLessThan(HISTORY_JSONL_MAX_BYTES);

    const real = await Effect.runPromise(
      Effect.result(createLocalHistoryStorage(root).readLines(archivePath, () => undefined)),
    );
    expect(real._tag).toBe('Failure');
    if (real._tag === 'Failure') {
      expect(real.failure).toMatchObject({ operation: 'readLines', path: archivePath });
      expect(String(real.failure.cause)).toContain(`${HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES}-byte limit`);
    }

    const memory = new TestMemoryStorage(root);
    memory.writeBytes('declares-too-much.jsonl.zst', header);
    const fixture = await Effect.runPromise(Effect.result(memory.readLines(archivePath, () => undefined)));
    expect(fixture._tag).toBe('Failure');
    if (fixture._tag === 'Failure') {
      expect(fixture.failure).toMatchObject({ operation: 'readLines', path: archivePath });
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('refuses a frame whose blocks would emit more than it declares without decoding them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-archive-overrun-'));
  try {
    // An intact layout that lies: a 1-byte content size of 7 followed by
    // 2,000 RLE blocks of 128 KiB each (an 8 KB archive that would expand to
    // 256 MiB). The frame walk accepts it, so only the decompressor's output
    // cap can refuse it, and it must do so before the blocks are decoded.
    const RLE_BLOCK_BYTES = 128 * 1024;
    const rleBlock = (last: boolean): Buffer => {
      const header = Buffer.alloc(3);
      // biome-ignore lint/suspicious/noBitwiseOperators: Block_Header packs Block_Size above the type and last-block bits.
      header.writeUIntLE((RLE_BLOCK_BYTES << 3) | (1 << 1) | (last ? 1 : 0), 0, 3);
      return Buffer.concat([header, Buffer.from([0x41])]);
    };
    const blocks = Array.from({ length: 2000 }, (_, index) => rleBlock(index === 1999));
    const overrun = Buffer.concat([ZSTD_MAGIC, Buffer.from([0x20, 7]), ...blocks]);
    const overrunPath = path.join(root, 'overrun.jsonl.zst');
    fs.writeFileSync(overrunPath, overrun);
    const storage = createLocalHistoryStorage(root);

    const visited: string[] = [];
    const result = await Effect.runPromise(
      Effect.result(storage.readLines(overrunPath, (line) => visited.push(line), { maxBytes: 1024 * 1024 })),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({ operation: 'readLines.decompress', path: overrunPath });
      const archiveError = result.failure.cause as Error;
      expect(archiveError.message).toBe(`History archive could not be decompressed: ${overrunPath}`);
      // The decompressor's output cap refused the frame (either of its two
      // error codes for an overrun), not the declared-size check that runs
      // on a completed output afterwards.
      const cause = archiveError.cause as Error & { code?: string };
      expect(['ZSTD_error_dstSize_tooSmall', 'ERR_BUFFER_TOO_LARGE']).toContain(cause.code ?? '');
      expect(cause.message).not.toContain('does not match its declared size');
    }
    expect(visited).toEqual([]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

/**
 * Bun's own zstd decompressors corrupted the heap when measured on Bun 1.3.13
 * (the engine's runtime at the time): intermittent mimalloc segfaults in later
 * allocations, measured 2026-10-19. Every archive goes through `node:zlib`
 * instead; Bun's compressor is not implicated and stays available to fixtures.
 */
test('no local-machine or local-collectors source reaches a Bun zstd decompressor', () => {
  const sourceRoots = [import.meta.dir, path.resolve(import.meta.dir, '../../local-collectors/src')];
  const sourceFiles: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        sourceFiles.push(entryPath);
      }
    }
  };
  for (const sourceRoot of sourceRoots) {
    walk(sourceRoot);
  }
  expect(sourceFiles.length).toBeGreaterThan(0);
  const offenders = sourceFiles
    .filter((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      return reachesBunZstdDecompressor(source);
    })
    .map((filePath) => path.relative(path.resolve(import.meta.dir, '../..'), filePath));
  expect(offenders).toEqual([]);
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

  const corrupt = Effect.runSync(Effect.result(storage.readLines(corruptPath, () => undefined)));
  expect(corrupt._tag).toBe('Failure');
  if (corrupt._tag === 'Failure') {
    expect(corrupt.failure).toMatchObject({ operation: 'readLines.decompress', path: corruptPath });
  }

  // The double reads through the reader's frame walk, so a zero-byte archive
  // and a truncated frame are refused exactly as the real reader refuses
  // them, and the well-formed 9-byte frame of empty input is an empty history.
  storage.writeBytes('.codex/sessions/empty.jsonl.zst', new Uint8Array(0));
  const emptyPath = path.join(storage.home, '.codex/sessions/empty.jsonl.zst');
  const empty = Effect.runSync(Effect.result(storage.readLines(emptyPath, () => undefined)));
  expect(empty._tag).toBe('Failure');
  if (empty._tag === 'Failure') {
    expect(empty.failure).toMatchObject({ operation: 'readLines.decompress', path: emptyPath });
    expect(String((empty.failure.cause as Error).cause)).toContain('Missing zstd frame magic number');
  }
  const fullArchive = Bun.zstdCompressSync(content);
  storage.writeBytes('.codex/sessions/truncated.jsonl.zst', fullArchive.subarray(0, fullArchive.length - 8));
  const truncatedPath = path.join(storage.home, '.codex/sessions/truncated.jsonl.zst');
  const truncatedVisited: string[] = [];
  const truncated = Effect.runSync(
    Effect.result(storage.readLines(truncatedPath, (line) => truncatedVisited.push(line))),
  );
  expect(truncated._tag).toBe('Failure');
  if (truncated._tag === 'Failure') {
    expect(truncated.failure).toMatchObject({ operation: 'readLines.decompress', path: truncatedPath });
    expect(String((truncated.failure.cause as Error).cause)).toContain('Truncated zstd frame');
  }
  expect(truncatedVisited).toEqual([]);
  storage.writeBytes('.codex/sessions/empty-frame.jsonl.zst', Bun.zstdCompressSync(''));
  const emptyFrameVisited: string[] = [];
  const emptyFrame = Effect.runSync(
    storage.readLines(path.join(storage.home, '.codex/sessions/empty-frame.jsonl.zst'), (line) =>
      emptyFrameVisited.push(line),
    ),
  );
  // The double splits text, so empty content is one empty segment where the
  // real reader emits no line; the decompressed byte count is what the
  // shared archive path pins here.
  expect(emptyFrame).toMatchObject({ bytes: 0, oversizedLines: 0 });
  expect(emptyFrameVisited.filter((line) => line !== '')).toEqual([]);

  // Under the compressed size the archive itself is refused; between the
  // compressed and the declared size (a compressible fixture) the declaration
  // is refused before decompression. Both are plain read errors.
  const compressibleText = `${'y'.repeat(100_000)}\n`;
  const compressible = Bun.zstdCompressSync(compressibleText);
  expect(compressible.length).toBeLessThan(1024);
  storage.writeBytes('.codex/sessions/compressible.jsonl.zst', compressible);
  const compressiblePath = path.join(storage.home, '.codex/sessions/compressible.jsonl.zst');
  for (const [boundedPath, maxBytes] of [
    [archivePath, 4],
    [compressiblePath, 1024],
  ] as const) {
    const bounded = Effect.runSync(Effect.result(storage.readLines(boundedPath, () => undefined, { maxBytes })));
    expect(bounded._tag).toBe('Failure');
    if (bounded._tag === 'Failure') {
      expect(bounded.failure).toMatchObject({ operation: 'readLines', path: boundedPath });
      expect(String(bounded.failure.cause)).toContain('exceeds');
    }
  }
  expect(
    Effect.runSync(storage.readLines(compressiblePath, () => undefined, { maxBytes: compressibleText.length })),
  ).toMatchObject({ bytes: compressibleText.length, oversizedLines: 0 });

  // Byte fixtures are decoded, never decompressed, by the text reader.
  storage.writeBytes('.codex/sessions/raw.jsonl', new TextEncoder().encode('raw text'));
  expect(Effect.runSync(storage.readText(path.join(storage.home, '.codex/sessions/raw.jsonl')))).toBe('raw text');
  const entries = await Effect.runPromise(storage.readDir(path.join(storage.home, '.codex/sessions')));
  expect(entries.find((entry) => entry.name === 'archive.jsonl.zst')?.size).toBe(Bun.zstdCompressSync(content).length);
  expect(entries.find((entry) => entry.name === 'raw.jsonl')?.size).toBe(8);
});
