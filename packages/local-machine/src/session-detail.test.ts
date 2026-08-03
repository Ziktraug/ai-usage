import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import type { LocalHistoryStorage } from './local-history';
import { readLocalSessionAnalysis } from './session-detail';
import { seedHarnessHome } from './testing/harness-home';
import { TestMemoryStorage } from './testing/memory-storage';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const snapshotHome = async (homePath: string) => {
  const entries = (await readdir(homePath, { recursive: true })).sort();
  return Promise.all(
    entries.map(async (relativePath) => {
      const absolutePath = path.join(homePath, relativePath);
      const stat = await lstat(absolutePath);
      let kind: 'directory' | 'file' | 'other' = 'other';
      if (stat.isDirectory()) {
        kind = 'directory';
      } else if (stat.isFile()) {
        kind = 'file';
      }
      return {
        hash: stat.isFile()
          ? createHash('sha256')
              .update(await readFile(absolutePath))
              .digest('hex')
          : null,
        kind,
        path: relativePath,
        size: stat.size,
      };
    }),
  );
};

describe('local session analysis', () => {
  for (const harnessKey of ['claude', 'codex', 'opencode'] as const) {
    test(`reads ${harnessKey} detail without creating or changing local state`, async () => {
      const homePath = await mkdtemp(path.join(tmpdir(), `plan052-${harnessKey}-session-detail-`));
      roots.push(homePath);
      const fixture = await seedHarnessHome(homePath, { harnesses: [harnessKey] });
      const sourceSessionId = harnessKey === 'codex' ? fixture.ids.codexRoot : fixture.ids[harnessKey];
      const before = await snapshotHome(homePath);

      const analysis = await readLocalSessionAnalysis({ harnessKey, homePath, sourceSessionId });

      expect(analysis?.detail.sourceSessionId).toBe(sourceSessionId);
      expect(analysis?.projection.calls).toBeGreaterThan(0);
      expect(await snapshotHome(homePath)).toEqual(before);
      expect(before.map((entry) => entry.path)).not.toContain(
        path.join('.config', 'ai-usage', 'codex-session-cache.sqlite'),
      );
    });
  }

  test('does not create local state while histories are absent', async () => {
    const homePath = await mkdtemp(path.join(tmpdir(), 'plan052-local-session-detail-'));
    roots.push(homePath);

    for (const harnessKey of ['claude', 'codex', 'opencode'] as const) {
      expect(
        await readLocalSessionAnalysis({
          harnessKey,
          homePath,
          sourceSessionId: 'missing-session',
        }),
      ).toBeNull();
    }

    expect(await readdir(homePath)).toEqual([]);
  });

  test('interrupts the active history Effect and completes its finalizer', async () => {
    let releaseRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolveRead) => {
      releaseRead = resolveRead;
    });
    let finalized = false;
    class InterruptibleStorage extends TestMemoryStorage implements LocalHistoryStorage {
      override readLines(): Effect.Effect<{ bytes: number; lines: number }, LocalHistoryError> {
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            releaseRead?.();
          }),
          () => Effect.never,
          () =>
            Effect.sync(() => {
              finalized = true;
            }),
        );
      }
    }
    const storage = new InterruptibleStorage();
    storage.writeText('.claude/projects/project/session-a.jsonl', '{}');
    const controller = new AbortController();
    const reason = new Error('local history superseded');
    const read = readLocalSessionAnalysis(
      { harnessKey: 'claude', sourceSessionId: 'session-a' },
      { signal: controller.signal, storage },
    );

    await readStarted;
    controller.abort(reason);
    const error = await read.catch((cause: unknown) => cause);

    expect(error).toBeDefined();
    expect(controller.signal.reason).toBe(reason);
    expect(finalized).toBe(true);
  });
});
