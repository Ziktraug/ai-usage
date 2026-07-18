import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaBatchSource } from '@ai-usage/local-collectors';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { collectionSourceIds } from '@ai-usage/report-core/source-control';
import {
  queryLatestProviderQuotaObservations,
  queryNormalizedDatasetItems,
  queryReportRows,
  usageStorePath,
} from '@ai-usage/usage-store';
import { Duration, Effect } from 'effect';
import { createScheduledSourceRegistry, type SourceRunContext } from './source-adapters';

const machine = { id: 'machine-a', label: 'Machine A' };

const createRegistry = async (home: string, options: Parameters<typeof createScheduledSourceRegistry>[0] = {}) =>
  Effect.runPromise(
    createScheduledSourceRegistry({ machine, ...options }).pipe(
      Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
    ),
  );

const writeClaudeSession = (home: string, inputTokens = 10): void => {
  const directory = path.join(home, '.claude', 'projects', '-work-project');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'session-1.jsonl'),
    `${JSON.stringify({
      cwd: '/work/project',
      message: {
        content: [],
        id: 'message-1',
        model: 'claude-sonnet-4-6',
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: inputTokens,
          output_tokens: 5,
        },
      },
      requestId: 'request-1',
      timestamp: '2026-07-16T10:00:00.000Z',
      type: 'assistant',
    })}\n`,
  );
};

const progressContext = (progress: unknown[]): SourceRunContext => ({
  reportProgress: (update) =>
    Effect.sync(() => {
      progress.push(update);
    }),
});

describe('scheduled source adapters', () => {
  test('registers the complete catalogue with independent cadence and detection', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-source-adapters-'));
    try {
      writeClaudeSession(home);
      const registry = await createRegistry(home, { codexLiveAvailable: () => false });

      expect([...registry.keys()]).toEqual([...collectionSourceIds]);
      expect(Duration.toMillis(registry.get('claude.sessions')?.cadence ?? Duration.zero)).toBe(60_000);
      expect(Duration.toMillis(registry.get('codex.usage-limits')?.cadence ?? Duration.zero)).toBe(300_000);
      expect(
        (await Effect.runPromise(registry.get('claude.sessions')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('detected');
      expect(
        (await Effect.runPromise(registry.get('opencode.sessions')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('not-detected');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('normalizes and imports one session source without global enrichment', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-source-claude-'));
    try {
      writeClaudeSession(home);
      const registry = await createRegistry(home);
      const source = registry.get('claude.sessions');
      if (!source) {
        throw new Error('Claude source is missing');
      }
      const progress: unknown[] = [];
      const first = await Effect.runPromise(source.run(progressContext(progress)));
      const second = await Effect.runPromise(source.run(progressContext([])));
      const stored = await Effect.runPromise(
        queryReportRows({
          dbPath: usageStorePath(home),
          harnessKeys: ['claude'],
          originMachineIds: [machine.id],
        }),
      );

      expect(first).toMatchObject({ changed: true, inputCount: 1, outputCount: 1 });
      expect(second).toMatchObject({ changed: false, inputCount: 1, outputCount: 1 });
      expect(progress).toEqual([
        { phase: 'reading' },
        { completed: 1, phase: 'normalizing', total: 1 },
        { completed: 0, phase: 'importing', total: 1 },
      ]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.rtkSavedTokens).toBeUndefined();
      expect(JSON.stringify(first)).not.toContain(home);

      rmSync(path.join(home, '.claude'), { force: true, recursive: true });
      expect(await Effect.runPromise(source.run(progressContext([])))).toMatchObject({
        changed: false,
        unavailable: { code: 'run-unavailable' },
      });
      expect((await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }))).rows).toHaveLength(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('enriches the complete stored local row set without clearing prior facts', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-source-rtk-'));
    try {
      writeClaudeSession(home);
      const rtkPath = path.join(home, '.local', 'share', 'rtk', 'history.db');
      mkdirSync(path.dirname(rtkPath), { recursive: true });
      const { Database } = await import('bun:sqlite');
      const db = new Database(rtkPath);
      db.exec(`
        CREATE TABLE commands (
          timestamp TEXT,
          project_path TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          saved_tokens INTEGER
        )
      `);
      db.query('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run('2026-07-16T10:00:30.000Z', '/work/project', 4, 2, 9);
      db.close();

      const registry = await createRegistry(home);
      await Effect.runPromise(registry.get('claude.sessions')?.run(progressContext([])) ?? Effect.die('missing'));
      const result = await Effect.runPromise(
        registry.get('rtk.savings')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      const stored = await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }));

      expect(result).toMatchObject({ changed: true, inputCount: 1, outputCount: 1 });
      expect(stored.rows[0]).toMatchObject({
        rtkCommandCount: 1,
        rtkInputTokens: 4,
        rtkOutputTokens: 2,
        rtkSavedTokens: 9,
      });
      await Effect.runPromise(registry.get('claude.sessions')?.run(progressContext([])) ?? Effect.die('missing'));
      writeClaudeSession(home, 11);
      await Effect.runPromise(registry.get('claude.sessions')?.run(progressContext([])) ?? Effect.die('missing'));
      const afterBaseReimports = await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }));
      expect(afterBaseReimports.rows[0]).toMatchObject({ rtkSavedTokens: 9, tokIn: 11 });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('persists Cursor attribution as versioned normalized items', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-source-cursor-attribution-'));
    try {
      const attributionPath = path.join(home, '.cursor', 'ai-tracking', 'ai-code-tracking.db');
      mkdirSync(path.dirname(attributionPath), { recursive: true });
      const { Database } = await import('bun:sqlite');
      const db = new Database(attributionPath);
      db.exec(`
        CREATE TABLE scored_commits (
          commitHash TEXT,
          branchName TEXT,
          scoredAt INTEGER,
          linesAdded INTEGER,
          linesDeleted INTEGER,
          tabLinesAdded INTEGER,
          tabLinesDeleted INTEGER,
          composerLinesAdded INTEGER,
          composerLinesDeleted INTEGER,
          humanLinesAdded INTEGER,
          humanLinesDeleted INTEGER,
          blankLinesAdded INTEGER,
          blankLinesDeleted INTEGER,
          commitMessage TEXT,
          commitDate TEXT,
          v1AiPercentage REAL,
          v2AiPercentage REAL
        )
      `);
      db.query('INSERT INTO scored_commits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'abc123',
        'main',
        Date.parse('2026-07-16T10:00:00.000Z'),
        5,
        1,
        0,
        0,
        3,
        1,
        2,
        0,
        0,
        0,
        null,
        null,
        60,
        60,
      );
      db.close();

      const registry = await createRegistry(home);
      const result = await Effect.runPromise(
        registry.get('cursor.commit-attribution')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      const stored = await Effect.runPromise(
        queryNormalizedDatasetItems({
          datasetKey: 'cursor.commit-attribution',
          dbPath: usageStorePath(home),
        }),
      );

      expect(result).toMatchObject({ changed: true, inputCount: 1, outputCount: 1 });
      expect(stored.items[0]).toMatchObject({
        machineId: machine.id,
        payload: { branchName: 'main', commitHash: 'abc123' },
        schemaVersion: 1,
      });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('owns live and backfill quota substeps behind one source', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-source-quota-'));
    try {
      const liveSource: ProviderQuotaBatchSource = {
        collect: (request) =>
          Effect.succeed({
            checkpoints: [],
            hasMore: false,
            observations: [
              {
                accountScope: null,
                machineId: request.machineId,
                machineLabel: request.machineLabel ?? null,
                observedAt: (request.observedAt ?? new Date()).toISOString(),
                plan: 'plus',
                providerGeneratedAt: null,
                providerKey: 'codex',
                providerLabel: 'Codex',
                source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
                state: 'ok',
                windows: [],
              },
            ],
            sourceEvents: [],
          }),
      };
      const registry = await createRegistry(home, {
        codexLiveAvailable: () => true,
        now: () => new Date('2026-07-16T10:00:00.000Z'),
        providerQuotaOptions: { backfillSource: null, liveSource },
      });
      const source = registry.get('codex.usage-limits');
      if (!source) {
        throw new Error('Quota source is missing');
      }

      expect((await Effect.runPromise(source.detect)).availability).toBe('detected');
      expect(await Effect.runPromise(source.run(progressContext([])))).toMatchObject({
        changed: true,
        inputCount: 1,
        outputCount: 1,
      });
      const latest = await Effect.runPromise(
        queryLatestProviderQuotaObservations({
          dbPath: usageStorePath(home),
          machineId: machine.id,
          providerKey: 'codex',
        }),
      );
      expect(latest.observations).toHaveLength(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
