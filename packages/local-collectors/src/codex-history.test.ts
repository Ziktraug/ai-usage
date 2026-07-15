import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { findLatestCodexProviderStatus, findLatestCodexQuotaSnapshot, readCodexUsageSessions } from './codex-history';
import { collectCodex, collectCodexResult } from './collectors/codex';
import { LocalHistoryError } from './errors';
import {
  createLocalHistoryStorage,
  type LocalHistoryDirEntry,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from './local-history';
import { TestMemoryStorage } from './test-memory-storage';

const SIMULATED_LARGE_SESSION_BYTES = 600 * 1024 * 1024;

class LargeAggregateCodexStorage extends TestMemoryStorage {
  override readDir(dirPath: string) {
    return super
      .readDir(dirPath)
      .pipe(
        Effect.map((entries) =>
          entries.map(
            (entry): LocalHistoryDirEntry =>
              entry.isRegularFile && entry.name.endsWith('.jsonl')
                ? { ...entry, size: SIMULATED_LARGE_SESSION_BYTES }
                : entry,
          ),
        ),
      );
  }
}

const jsonl = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
const runWithRealStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, home: string) =>
  Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))));

describe('Codex local history', () => {
  test('closes the metadata database when a query fails', async () => {
    const home = '/home/codex-close-fixture';
    const stateDbPath = path.join(home, '.codex', 'state_5.sqlite');
    let closed = false;
    const storage: LocalHistoryStorageService = {
      home,
      exists: (filePath) => Effect.succeed(filePath === stateDbPath),
      openDatabase: () =>
        Effect.succeed({
          all: () =>
            Effect.fail(
              new LocalHistoryError({
                operation: 'sqlite.all',
                path: stateDbPath,
                cause: new Error('Fixture query failure'),
              }),
            ),
          close: Effect.sync(() => {
            closed = true;
          }),
        }),
      readDir: () => Effect.succeed([]),
      readLines: (filePath) =>
        Effect.fail(
          new LocalHistoryError({
            operation: 'readLines',
            path: filePath,
            cause: new Error('Unexpected fixture read'),
          }),
        ),
      readText: (filePath) =>
        Effect.fail(
          new LocalHistoryError({
            operation: 'readText',
            path: filePath,
            cause: new Error('Unexpected fixture read'),
          }),
        ),
      readConfigText: (filePath) =>
        Effect.fail(
          new LocalHistoryError({
            operation: 'readConfigText',
            path: filePath,
            cause: new Error('Unexpected fixture read'),
          }),
        ),
    };

    const sessions = await Effect.runPromise(
      readCodexUsageSessions.pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );

    expect(sessions).toEqual([]);
    expect(closed).toBe(true);
  });

  test('parses sessions, child sessions, names, and quota snapshots through fixture storage', () => {
    const storage = new TestMemoryStorage();
    storage.writeText('.codex/session_index.jsonl', jsonl({ id: 'parent-thread', thread_name: 'Fixture thread' }));
    storage.writeText(
      '.codex/sessions/2026/parent.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'parent-thread', cwd: '/work/fixture-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          payload: { type: 'task_started' },
        },
        {
          timestamp: '2026-01-01T00:03:00.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ input_text: 'Build the report' }],
          },
        },
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 30,
                input_tokens: 12,
                cached_input_tokens: 2,
                output_tokens: 18,
              },
            },
            rate_limits: {
              plan_type: 'pro',
              primary: { used_percent: 50, window_minutes: 300 },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/child.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:05:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'child-thread',
            cwd: '/work/fixture-project',
            source: {
              subagent: { thread_spawn: { parent_thread_id: 'parent-thread', agent_nickname: 'builder-agent' } },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:06:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        },
        {
          timestamp: '2026-01-01T00:07:00.000Z',
          payload: { type: 'task_started' },
        },
        {
          timestamp: '2026-01-01T00:08:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 10,
                input_tokens: 5,
                cached_input_tokens: 1,
                output_tokens: 4,
              },
            },
          },
        },
      ),
    );

    const sessions = runWithStorage(readCodexUsageSessions, storage);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.name).toBe('Fixture thread');
    expect(sessions[0]?.provider).toBe('Codex sub');
    expect(sessions[0]?.project).toBe('fixture-project');
    expect(sessions[0]?.projectPath).toBe('/work/fixture-project');
    expect(sessions[0]?.source).toEqual({
      harnessKey: 'codex',
      sourceSessionId: 'parent-thread',
      sourcePath: '/work/fixture-project',
    });
    expect(sessions[0]?.titleSource).toBe('first-prompt');
    expect(sessions[0]?.tokens.in).toBe(10);
    expect(sessions[0]?.tokens.cr).toBe(2);
    expect(sessions[0]?.tokens.out).toBe(18);
    expect(sessions[0]?.calls).toBe(1);
    expect(sessions[0]?.turns).toBe(1);
    expect(sessions[0]?.subagent).toBe(true);
    expect(sessions[0]?.usageUnavailable).toBe(false);
    expect(sessions[1]?.name).toBe('builder-agent');
    expect(sessions[1]?.titleSource).toBe('agent-role');
    expect(sessions[1]?.provider).toBe('Codex sub');
    expect(sessions[1]?.projectPath).toBe('/work/fixture-project');
    expect(sessions[1]?.source.parentSourceSessionId).toBe('parent-thread');
    expect(sessions[1]?.tokens.in).toBe(4);
    expect(sessions[1]?.tokens.cr).toBe(1);
    expect(sessions[1]?.tokens.out).toBe(4);
    expect(sessions[1]?.calls).toBe(1);
    expect(sessions[1]?.turns).toBe(1);
    expect(sessions[1]?.subagent).toBe(true);
    expect(sessions[1]?.usageUnavailable).toBe(false);

    const quota = runWithStorage(findLatestCodexQuotaSnapshot(), storage);
    expect(quota?.planType).toBe('pro');
    expect(quota?.primary?.usedPercent).toBe(50);
    expect(quota?.primary?.windowMinutes).toBe(300);

    const status = runWithStorage(
      findLatestCodexProviderStatus({ machineId: 'machine-1', machineLabel: 'Test Machine' }),
      storage,
    );
    expect(status).toMatchObject({
      key: 'codex',
      label: 'Codex',
      machineId: 'machine-1',
      machineLabel: 'Test Machine',
      plan: 'pro',
      source: 'local-history',
      state: 'ok',
    });
    expect(status?.windows[0]).toMatchObject({ id: 'primary', label: '5h', usedPercent: 50, limitSeconds: 18_000 });

    const rows = runWithStorage(collectCodex, storage);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe('Fixture thread');
    expect(rows[0]?.provider).toBe('Codex sub');
    expect(rows[0]?.project).toBe('fixture-project');
    expect(rows[0]?.projectPath).toBe('/work/fixture-project');
    expect(rows[0]?.source).toEqual({
      harnessKey: 'codex',
      sourceSessionId: 'parent-thread',
      sourcePath: '/work/fixture-project',
    });
    expect(rows[0]?.titleSource).toBe('first-prompt');
    expect(rows[0]?.tokIn).toBe(10);
    expect(rows[0]?.tokCr).toBe(2);
    expect(rows[0]?.tokOut).toBe(18);
    expect(rows[0]?.calls).toBe(1);
    expect(rows[0]?.turns).toBe(1);
    expect(rows[0]?.subagent).toBe(true);
    expect(rows[0]?.usageUnavailable).toBe(false);
    expect(rows[1]?.name).toBe('builder-agent');
    expect(rows[1]?.titleSource).toBe('agent-role');
    expect(rows[1]?.provider).toBe('Codex sub');
    expect(rows[1]?.source?.parentSourceSessionId).toBe('parent-thread');
    expect(rows[1]?.tokIn).toBe(4);
    expect(rows[1]?.tokCr).toBe(1);
    expect(rows[1]?.tokOut).toBe(4);
    expect(rows[1]?.subagent).toBe(true);
    expect(rows[1]?.usageUnavailable).toBe(false);
  });

  test('collects sessions whose aggregate metadata exceeds the former 2 GiB ceiling', () => {
    const storage = new LargeAggregateCodexStorage();
    const sessionIds = ['large-one', 'large-two', 'large-three', 'large-four'];
    for (const [index, sessionId] of sessionIds.entries()) {
      storage.writeText(
        `.codex/sessions/2026/${sessionId}.jsonl`,
        jsonl(
          {
            timestamp: `2026-01-0${index + 1}T00:00:00.000Z`,
            type: 'session_meta',
            payload: { id: sessionId, cwd: `/work/${sessionId}` },
          },
          {
            timestamp: `2026-01-0${index + 1}T00:01:00.000Z`,
            type: 'event_msg',
            payload: { type: 'task_started' },
          },
          {
            timestamp: `2026-01-0${index + 1}T00:02:00.000Z`,
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  total_tokens: 15,
                  input_tokens: 10,
                  cached_input_tokens: 2,
                  output_tokens: 5,
                },
              },
            },
          },
        ),
      );
    }

    const rows = runWithStorage(collectCodex, storage);

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.source?.sourceSessionId).sort()).toEqual(sessionIds.sort());
    expect(rows.every((row) => row.tokIn === 8 && row.tokCr === 2 && row.tokOut === 5)).toBe(true);
  });

  test('keeps the last valid Codex snapshot and reports malformed metrics once', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/metrics.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'metrics-thread', cwd: '/work/metrics' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 20,
                input_tokens: 12,
                cached_input_tokens: 2,
                output_tokens: 8,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 30,
                input_tokens: 'private-invalid-value',
                cached_input_tokens: 3,
                output_tokens: 10,
              },
            },
          },
        },
      ),
    );

    const result = runWithStorage(collectCodexResult, storage);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.tokIn).toBe(10);
    expect(result.rows[0]?.tokCr).toBe(2);
    expect(result.rows[0]?.tokOut).toBe(8);
    expect(result.warnings).toEqual([
      {
        harness: 'codex',
        operation: 'metricValidation',
        message: 'Rejected 1 malformed codex metric record(s).',
      },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain('private-invalid-value');
  });

  test('caches parsed Codex session files by mtime and size', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-cache-'));
    try {
      const sessionPath = path.join(home, '.codex', 'sessions', '2026', 'cached.jsonl');
      mkdirSync(path.dirname(sessionPath), { recursive: true });
      writeFileSync(
        sessionPath,
        jsonl(
          {
            timestamp: '2026-01-01T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: 'cached-thread', cwd: '/work/cache-project' },
          },
          {
            timestamp: '2026-01-01T00:01:00.000Z',
            type: 'event_msg',
            payload: { type: 'task_started' },
          },
          {
            timestamp: '2026-01-01T00:02:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  total_tokens: 42,
                  input_tokens: 30,
                  cached_input_tokens: 10,
                  output_tokens: 12,
                },
              },
            },
          },
          {
            timestamp: '2026-01-01T00:03:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  total_tokens: 43,
                  input_tokens: 'private-invalid-cache-value',
                  cached_input_tokens: 10,
                  output_tokens: 13,
                },
              },
            },
          },
        ),
      );

      const first = await runWithRealStorage(collectCodexResult, home);
      const second = await runWithRealStorage(collectCodexResult, home);

      expect(second).toEqual(first);
      expect(second.rows[0]?.name).toBe('codex cached-t');
      expect(second.rows[0]?.tokIn).toBe(20);
      expect(second.rows[0]?.tokCr).toBe(10);
      expect(second.rows[0]?.tokOut).toBe(12);
      expect(second.warnings).toEqual([
        {
          harness: 'codex',
          operation: 'metricValidation',
          message: 'Rejected 1 malformed codex metric record(s).',
        },
      ]);
      expect(JSON.stringify(second.warnings)).not.toContain('private-invalid-cache-value');

      const db = new Database(path.join(home, '.config', 'ai-usage', 'codex-session-cache.sqlite'));
      try {
        const row = db.query('SELECT count(*) as count FROM codex_session_cache').get() as { count: number };
        expect(row.count).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
