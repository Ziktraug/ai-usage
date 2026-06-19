import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageSnapshot } from '@ai-usage/core/snapshot';
import type { SourcedRow } from '@ai-usage/core/types';
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import {
  listSyncRemotes,
  readSyncedSnapshotRecords,
  removeSyncRemote,
  resolveSyncToken,
  storeSyncedSnapshot,
  syncedSnapshotsDir,
  upsertSyncRemote,
  userEnvPath,
} from './sync-storage';

const row = (): SourcedRow => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name: 'session',
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 10,
  tokOut: 5,
  tokCr: 0,
  tokCw: 0,
  costActual: 0,
  costApprox: 0,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  source: { harnessKey: 'codex', sourceSessionId: 'session-1' },
});

describe('sync storage', () => {
  test('stores remotes, resolves env tokens, and reads stored snapshots with warnings', async () => {
    const home = await mkdtemp('ai-usage-sync-storage-');
    try {
      const storage = createLocalHistoryStorage(home);
      const remote = {
        name: 'macbook',
        url: 'http://192.168.1.63:3847/snapshot',
        tokenEnv: 'AI_USAGE_SYNC_MACBOOK_TOKEN',
      };

      await Effect.runPromise(upsertSyncRemote(remote).pipe(Effect.provideService(LocalHistoryStorage, storage)));
      const remotes = await Effect.runPromise(listSyncRemotes.pipe(Effect.provideService(LocalHistoryStorage, storage)));
      expect(remotes).toEqual([{ ...remote, enabled: true }]);

      mkdirSync(path.dirname(userEnvPath(storage)), { recursive: true });
      writeFileSync(userEnvPath(storage), 'AI_USAGE_SYNC_MACBOOK_TOKEN=from-user-env\n');
      const token = await Effect.runPromise(
        resolveSyncToken('AI_USAGE_SYNC_MACBOOK_TOKEN').pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(token).toBe('from-user-env');

      const snapshot = createUsageSnapshot({
        machine: { id: 'remote-machine', label: 'MacBook' },
        rows: [row()],
        generatedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      await Effect.runPromise(
        storeSyncedSnapshot({ remote, snapshot, fetchedAt: new Date('2026-01-03T00:00:00.000Z') }).pipe(
          Effect.provideService(LocalHistoryStorage, storage),
        ),
      );
      mkdirSync(syncedSnapshotsDir(storage), { recursive: true });
      writeFileSync(path.join(syncedSnapshotsDir(storage), 'bad.json'), '{nope');

      const result = await Effect.runPromise(
        readSyncedSnapshotRecords.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.snapshot.machine.label).toBe('MacBook');
      expect(result.warnings).toHaveLength(1);

      const removed = await Effect.runPromise(
        removeSyncRemote('macbook').pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      expect(removed).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const mkdtemp = async (prefix: string) => {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(tmpdir(), prefix));
};
