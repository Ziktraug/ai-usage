import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readOpenedFileBounded } from './read-opened-file';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('engine opened-file reader', () => {
  test('reads at most one sentinel byte beyond the opened size', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-bounded-read-'));
    roots.push(root);
    const filePath = path.join(root, 'input');
    await writeFile(filePath, 'safe');
    const file = await open(filePath, 'r');
    try {
      const opened = await file.stat();
      await appendFile(filePath, ' growth that must remain unread');

      const bytes = await readOpenedFileBounded(file, opened.size);

      expect(bytes.byteLength).toBe(opened.size + 1);
      expect(Buffer.from(bytes).toString('utf8')).toBe('safe ');
    } finally {
      await file.close();
    }
  });
});
