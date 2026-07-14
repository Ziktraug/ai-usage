import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { createLocalHistoryStorage, readRegularFileText, walkFiles } from './local-history';

const PREVIOUS_AGGREGATE_HISTORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

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
      Effect.succeed([
        {
          isDirectory: false,
          isRegularFile: true,
          name: 'large-session.jsonl',
          size: PREVIOUS_AGGREGATE_HISTORY_LIMIT_BYTES + 1,
        },
      ]),
  };

  await expect(Effect.runPromise(walkFiles(storage, root, () => true))).resolves.toEqual([
    path.join(root, 'large-session.jsonl'),
  ]);
  const explicitlyBounded = await Effect.runPromise(
    Effect.either(walkFiles(storage, root, () => true, { maxBytes: PREVIOUS_AGGREGATE_HISTORY_LIMIT_BYTES })),
  );
  expect(explicitlyBounded._tag).toBe('Left');
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
      writer.exec('INSERT INTO events (id) VALUES (2);');
      const sameSnapshot = await Effect.runPromise(database.all<{ id: number }>('SELECT id FROM events ORDER BY id'));
      expect(sameSnapshot).toEqual([{ id: 1 }]);
    } finally {
      await Effect.runPromise(database.close);
    }
  } finally {
    writer.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});
