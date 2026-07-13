import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializeSessionQueryRevision } from './session-query-materializer.server';

const privateMode = (mode: number): number => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return mode & 0o777;
};

describe('production Session query materializer boundary', () => {
  test('spawns the silent Bun materializer for a private staging revision', async () => {
    const revisionDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-session-materializer-'));
    try {
      await chmod(revisionDirectory, 0o700);
      await writeFile(path.join(revisionDirectory, 'rows.json'), '[]', { mode: 0o600 });
      await writeFile(path.join(revisionDirectory, 'support.json'), '{}', { mode: 0o600 });

      await materializeSessionQueryRevision(revisionDirectory);

      const database = await stat(path.join(revisionDirectory, 'sessions.sqlite'));
      expect(database.isFile()).toBe(true);
      expect(privateMode(database.mode)).toBe(0o600);
      expect(database.size).toBeGreaterThan(0);
    } finally {
      await rm(revisionDirectory, { force: true, recursive: true });
    }
  });
});
