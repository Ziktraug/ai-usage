import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSessionDetail, type SessionDetail } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import {
  findLatestCodexProviderStatus,
  findLatestCodexQuotaSnapshot,
  readCodexSessionDetail,
  readCodexUsageSessions,
} from './codex-history';
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

const requireSessionDetail = (detail: SessionDetail | null): SessionDetail => {
  if (!detail) {
    throw new Error('Expected a Codex session detail');
  }
  return detail;
};

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
          payload: { type: 'task_started', turn_id: 'parent-turn' },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex', turn_id: 'parent-turn' },
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
          payload: { type: 'task_started', turn_id: 'child-turn' },
        },
        {
          timestamp: '2026-01-01T00:07:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex', turn_id: 'child-turn' },
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

  test('attributes a shared cumulative token stream only to the campaign root', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/shared-parent.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'shared-parent', cwd: '/work/shared-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/shared-child-a.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'shared-child-a',
            cwd: '/work/shared-project',
            source: { subagent: { thread_spawn: { parent_thread_id: 'shared-parent' } } },
          },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'session_meta',
          payload: { id: 'shared-parent', cwd: '/work/shared-project', source: 'vscode' },
        },
        {
          timestamp: '2026-01-01T00:03:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 50,
                input_tokens: 40,
                cached_input_tokens: 30,
                output_tokens: 10,
              },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/shared-child-b.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'shared-child-b',
            cwd: '/work/shared-project',
            source: { subagent: { thread_spawn: { parent_thread_id: 'shared-parent' } } },
          },
        },
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          type: 'session_meta',
          payload: { id: 'shared-parent', cwd: '/work/shared-project', source: 'vscode' },
        },
        {
          timestamp: '2026-01-01T00:05:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:09:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 90,
                input_tokens: 72,
                cached_input_tokens: 54,
                output_tokens: 18,
              },
            },
          },
        },
      ),
    );

    const sessions = runWithStorage(readCodexUsageSessions, storage);
    const parent = sessions.find((session) => session.source.sourceSessionId === 'shared-parent');
    const children = sessions.filter((session) => session.source.parentSourceSessionId === 'shared-parent');

    expect(parent?.tokens).toEqual({ cr: 60, cw: 0, in: 20, out: 20 });
    expect(parent?.usageUnavailable).toBe(false);
    expect(children).toHaveLength(2);
    expect(children.map((session) => session.tokens)).toEqual([
      { cr: 0, cw: 0, in: 0, out: 0 },
      { cr: 0, cw: 0, in: 0, out: 0 },
    ]);
    expect(children.every((session) => session.modelSegments === undefined)).toBe(true);
    expect(children.every((session) => session.usageUnavailable)).toBe(true);
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

  test('accepts rate-limit-only Codex snapshots without a malformed metric warning', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/quota-only.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'quota-only-thread', cwd: '/work/quota-only' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              plan_type: 'pro',
              primary: { used_percent: 50, window_minutes: 300 },
            },
          },
        },
      ),
    );

    const result = runWithStorage(collectCodexResult, storage);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.provider).toBe('Codex sub');
    expect(result.rows[0]?.usageUnavailable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('reconstructs active turns, model phases, costs, and bounded deduplicated prompts', () => {
    const storage = new TestMemoryStorage();
    const oversizedPrompt = `Second prompt ${'x'.repeat(40 * 1024)}`;
    storage.writeText(
      '.codex/sessions/2026/rollout-2026-01-01T00-00-00-trace-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'trace-thread', cwd: '/work/trace-project' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { type: 'task_started', turn_id: 'replayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:20.000Z',
          payload: { type: 'task_complete', turn_id: 'replayed-turn', duration_ms: 10_000 },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: { type: 'task_started', turn_id: 'sol-turn', started_at: 1_767_225_660 },
        },
        {
          timestamp: '2026-01-01T00:01:00.005Z',
          type: 'turn_context',
          payload: { effort: 'high', model: 'replayed-model', turn_id: 'unknown-replayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:01:00.010Z',
          type: 'turn_context',
          payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'sol-turn' },
        },
        {
          timestamp: '2026-01-01T00:01:00.020Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Injected host instructions' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'sol-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:01:00.030Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Build it' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'sol-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:01:00.040Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Build it' },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:03:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            arguments: '{}',
            internal_chat_message_metadata_passthrough: { turn_id: 'sol-turn' },
          },
        },
        {
          timestamp: '2026-01-01T01:01:05.000Z',
          payload: {
            type: 'task_complete',
            turn_id: 'unknown-replayed-turn',
            completed_at: 1_767_229_265,
            duration_ms: 9_999_999,
          },
        },
        {
          timestamp: '2026-01-01T01:01:05.100Z',
          payload: {
            type: 'task_complete',
            turn_id: 'sol-turn',
            completed_at: 1_767_229_265,
            duration_ms: 3_600_000,
          },
        },
        {
          timestamp: '2026-01-01T04:01:00.000Z',
          payload: { type: 'task_started', turn_id: 'terra-turn', started_at: 1_767_240_060 },
        },
        {
          timestamp: '2026-01-01T04:01:00.010Z',
          type: 'turn_context',
          payload: { effort: 'high', model: 'gpt-5.6-terra', turn_id: 'terra-turn' },
        },
        {
          timestamp: '2026-01-01T04:01:00.020Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Another injected message' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'terra-turn' },
          },
        },
        {
          timestamp: '2026-01-01T04:01:00.030Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: oversizedPrompt }],
            internal_chat_message_metadata_passthrough: { turn_id: 'terra-turn' },
          },
        },
        {
          timestamp: '2026-01-01T04:01:30.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 110,
                input_tokens: 88,
                cached_input_tokens: 66,
                output_tokens: 22,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T04:02:07.000Z',
          payload: {
            type: 'task_complete',
            turn_id: 'terra-turn',
            completed_at: 1_767_240_127,
            duration_ms: 60_000,
          },
        },
      ),
    );

    const sessions = runWithStorage(readCodexUsageSessions, storage);
    const detail = runWithStorage(readCodexSessionDetail('trace-thread'), storage);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.model).toBe('gpt-5.6-sol');
    expect(sessions[0]?.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(
      sessions[0]?.modelSegments?.map(({ costKnown, model, tokCr, tokCw, tokIn, tokOut }) => ({
        costKnown,
        model,
        tokCr,
        tokCw,
        tokIn,
        tokOut,
      })),
    ).toEqual([
      {
        costKnown: true,
        model: 'gpt-5.6-sol',
        tokCr: 60,
        tokCw: 0,
        tokIn: 20,
        tokOut: 20,
      },
      {
        costKnown: true,
        model: 'gpt-5.6-terra',
        tokCr: 6,
        tokCw: 0,
        tokIn: 2,
        tokOut: 2,
      },
    ]);
    expect(sessions[0]?.modelSegments?.[0]?.costApprox).toBeCloseTo(0.000_73, 10);
    expect(sessions[0]?.modelSegments?.[1]?.costApprox).toBeCloseTo(0.000_036_5, 10);
    expect(sessions[0]?.durationMs).toBe(3_660_000);
    expect(sessions[0]?.turns).toBe(2);
    expect(sessions[0]?.tools).toBe(1);
    expect(sessions[0]?.costApprox).toBeCloseTo(0.000_766_5, 10);
    expect(sessions[0]?.costKnown).toBe(true);
    expect(detail?.activeDurationMs).toBe(3_660_000);
    expect(detail?.elapsedDurationMs).toBe(14_467_000);
    expect(detail?.idleDurationMs).toBe(10_807_000);
    expect(detail?.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(detail?.efforts).toEqual(['ultra', 'high']);
    expect(detail?.phases.map((phase) => phase.tokens.total)).toEqual([100, 10]);
    expect(detail?.turns.map((turn) => turn.durationMs)).toEqual([3_600_000, 60_000]);
    expect(detail?.prompts).toHaveLength(2);
    expect(detail?.prompts[0]?.text).toBe('Build it');
    expect(detail?.prompts[1]?.text.startsWith('Second prompt')).toBe(true);
    expect(detail?.prompts[1]?.truncated).toBe(true);
    expect(Buffer.byteLength(detail?.prompts[1]?.text ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(runWithStorage(readCodexSessionDetail('../../private'), storage)).toBeNull();
  });

  test('marks a token-bearing segment with unknown model pricing as a lower bound', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/unknown-model-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'unknown-model-thread', cwd: '/work/unknown-model' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: { type: 'task_started', turn_id: 'unknown-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:01.010Z',
          type: 'turn_context',
          payload: { model: 'private-codex-model', turn_id: 'unknown-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:02.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 13,
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 3,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:03.000Z',
          payload: { duration_ms: 2000, type: 'task_complete', turn_id: 'unknown-model-turn' },
        },
      ),
    );

    const [session] = runWithStorage(readCodexUsageSessions, storage);

    expect(session?.costApprox).toBe(0);
    expect(session?.costKnown).toBe(false);
    expect(session?.modelSegments).toEqual([
      {
        costApprox: 0,
        costKnown: false,
        model: 'private-codex-model',
        tokCr: 2,
        tokCw: 0,
        tokIn: 8,
        tokOut: 3,
      },
    ]);
  });

  test('attributes cumulative tokens to the only model observed in zero-token phases', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/single-model-cumulative-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'single-model-cumulative-thread', cwd: '/work/single-model-cumulative' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
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
        {
          timestamp: '2026-01-01T00:00:02.000Z',
          payload: { type: 'task_started', turn_id: 'single-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:02.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'single-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:03.000Z',
          payload: { duration_ms: 1000, type: 'task_complete', turn_id: 'single-model-turn' },
        },
      ),
    );

    const [session] = runWithStorage(readCodexUsageSessions, storage);
    const [row] = runWithStorage(collectCodex, storage);

    expect(session?.modelSegments).toMatchObject([
      {
        costKnown: true,
        model: 'gpt-5.6-sol',
        tokCr: 2,
        tokCw: 0,
        tokIn: 8,
        tokOut: 5,
      },
    ]);
    expect(session?.modelSegments?.[0]?.costApprox).toBeCloseTo(0.000_191, 10);
    expect(session?.costApprox).toBeCloseTo(0.000_191, 10);
    expect(row).toMatchObject({
      costKnown: true,
      tokCr: 2,
      tokCw: 0,
      tokIn: 8,
      tokOut: 5,
      usageUnavailable: false,
    });
    expect(row?.costApprox).toBeCloseTo(0.000_191, 10);
  });

  test('keeps cumulative tokens unsegmented when zero-token phases observe multiple models', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/unattributed-cumulative-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'unattributed-cumulative-thread', cwd: '/work/unattributed-cumulative' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
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
        {
          timestamp: '2026-01-01T00:00:02.000Z',
          payload: { type: 'task_started', turn_id: 'later-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:02.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'later-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:03.000Z',
          payload: { duration_ms: 1000, type: 'task_complete', turn_id: 'later-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:04.000Z',
          payload: { type: 'task_started', turn_id: 'second-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:04.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-terra', turn_id: 'second-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:05.000Z',
          payload: { duration_ms: 1000, type: 'task_complete', turn_id: 'second-context-turn' },
        },
      ),
    );

    const [session] = runWithStorage(readCodexUsageSessions, storage);
    const [row] = runWithStorage(collectCodex, storage);

    expect(session?.tokens).toEqual({ cr: 2, cw: 0, in: 8, out: 5 });
    expect(session?.modelSegments).toEqual([
      {
        costApprox: 0,
        costKnown: false,
        model: '(multi-model, unsegmented)',
        tokCr: 2,
        tokCw: 0,
        tokIn: 8,
        tokOut: 5,
      },
    ]);
    expect(row).toMatchObject({
      costKnown: false,
      tokCr: 2,
      tokCw: 0,
      tokIn: 8,
      tokOut: 5,
      usageUnavailable: false,
    });
  });

  test('emits contract-valid active duration when completed turns overlap', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/overlap-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'overlap-thread', cwd: '/work/overlap-project' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'first-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'first-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:05.000Z',
          payload: { type: 'task_started', turn_id: 'second-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:05.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'second-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 10_000, type: 'task_complete', turn_id: 'first-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:15.000Z',
          payload: { duration_ms: 10_000, type: 'task_complete', turn_id: 'second-turn' },
        },
      ),
    );

    const session = runWithStorage(readCodexUsageSessions, storage)[0];
    const detail = runWithStorage(readCodexSessionDetail('overlap-thread'), storage);

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.durationMs).toBe(15_000);
    expect(validDetail.activeDurationMs).toBe(15_000);
    expect(validDetail.turns.map((turn) => turn.durationMs)).toEqual([10_000, 10_000]);
  });

  test('reconciles a recorded task duration with its turn interval while retaining the observed session end', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/recorded-duration-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'recorded-duration-thread', cwd: '/work/recorded-duration' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'recorded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'recorded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 2000, type: 'task_complete', turn_id: 'recorded-duration-turn' },
        },
      ),
    );

    const session = runWithStorage(readCodexUsageSessions, storage)[0];
    const detail = requireSessionDetail(runWithStorage(readCodexSessionDetail('recorded-duration-thread'), storage));

    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(session?.durationMs).toBe(2000);
    expect(detail).toMatchObject({
      activeDurationMs: 2000,
      elapsedDurationMs: 10_000,
      endedAt: '2026-01-01T00:00:10.000Z',
      idleDurationMs: 8000,
      startedAt: '2026-01-01T00:00:00.000Z',
      turns: [
        {
          durationMs: 2000,
          endAt: '2026-01-01T00:00:02.000Z',
          intervals: [{ endAt: '2026-01-01T00:00:02.000Z', startAt: '2026-01-01T00:00:00.000Z' }],
          startAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  test('bounds a recorded task duration to the observed completion', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/bounded-duration-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'bounded-duration-thread', cwd: '/work/bounded-duration' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'bounded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'bounded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 20_000, type: 'task_complete', turn_id: 'bounded-duration-turn' },
        },
      ),
    );

    const session = runWithStorage(readCodexUsageSessions, storage)[0];
    const detail = requireSessionDetail(runWithStorage(readCodexSessionDetail('bounded-duration-thread'), storage));

    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(session?.durationMs).toBe(10_000);
    expect(detail).toMatchObject({
      activeDurationMs: 10_000,
      elapsedDurationMs: 10_000,
      idleDurationMs: 0,
      turns: [{ durationMs: 10_000, endAt: '2026-01-01T00:00:10.000Z' }],
    });
  });

  test('keeps contextual open turns visible and marks their coverage as partial', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/open-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'open-thread', cwd: '/work/open-project' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'completed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'completed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:05.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 2,
                input_tokens: 8,
                output_tokens: 2,
                total_tokens: 10,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 10_000, type: 'task_complete', turn_id: 'completed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:20.000Z',
          payload: { type: 'task_started', turn_id: 'open-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:20.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'open-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:25.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 5,
                input_tokens: 20,
                output_tokens: 5,
                total_tokens: 25,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:30.000Z',
          type: 'response_item',
          payload: {
            internal_chat_message_metadata_passthrough: { turn_id: 'open-turn' },
            name: 'shell',
            type: 'function_call',
          },
        },
      ),
    );

    const session = runWithStorage(readCodexUsageSessions, storage)[0];
    const detail = runWithStorage(readCodexSessionDetail('open-thread'), storage);
    const row = runWithStorage(collectCodex, storage)[0];

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.partial).toBe(true);
    expect(row?.partial).toBe(true);
    expect(session?.durationMs).toBe(20_000);
    expect(session?.turns).toBe(2);
    expect(validDetail.durationStatus).toBe('partial');
    expect(validDetail.turnsStatus).toBe('partial');
    expect(validDetail.activeDurationMs).toBe(20_000);
    expect(validDetail.turns.map((turn) => [turn.durationMs, turn.tokens.total, turn.tools])).toEqual([
      [10_000, 10, 0],
      [10_000, 15, 1],
    ]);
  });

  test('keeps a delayed task that starts inside the observed rollout', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/delayed-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'delayed-thread', cwd: '/work/delayed-project' },
        },
        {
          timestamp: '2026-01-01T00:00:12.500Z',
          payload: { started_at: 1_767_225_610, type: 'task_started', turn_id: 'delayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:12.510Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'delayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:15.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 5,
                input_tokens: 15,
                output_tokens: 5,
                total_tokens: 20,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:20.000Z',
          payload: { type: 'task_complete', turn_id: 'delayed-turn' },
        },
      ),
    );

    const session = runWithStorage(readCodexUsageSessions, storage)[0];
    const detail = runWithStorage(readCodexSessionDetail('delayed-thread'), storage);

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.partial).toBe(false);
    expect(session?.turns).toBe(1);
    expect(session?.tokens).toEqual({ cr: 5, cw: 0, in: 10, out: 5 });
    expect(validDetail.turns.map((turn) => turn.tokens.total)).toEqual([20]);
  });

  test('marks an unparented pre-rollout replay candidate as partial without double counting it', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/ambiguous-replay-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:10:00.000Z',
          type: 'session_meta',
          payload: { id: 'ambiguous-replay-thread', cwd: '/work/ambiguous-replay' },
        },
        {
          timestamp: '2026-01-01T00:10:00.010Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                cached_input_tokens: 30,
                input_tokens: 40,
                output_tokens: 10,
                total_tokens: 50,
              },
              total_token_usage: {
                cached_input_tokens: 60,
                input_tokens: 80,
                output_tokens: 20,
                total_tokens: 100,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.020Z',
          payload: { started_at: 1_767_226_198, type: 'task_started', turn_id: 'ambiguous-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:00.030Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-terra', turn_id: 'ambiguous-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:00.040Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 120,
                input_tokens: 160,
                output_tokens: 40,
                total_tokens: 200,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.050Z',
          payload: { type: 'task_complete', turn_id: 'ambiguous-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:10.100Z',
          payload: { started_at: 1_767_226_210, type: 'task_started', turn_id: 'local-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:10.110Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'local-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:20.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 150,
                input_tokens: 200,
                output_tokens: 50,
                total_tokens: 250,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:11:10.000Z',
          payload: { duration_ms: 60_000, type: 'task_complete', turn_id: 'local-turn' },
        },
      ),
    );

    const session = runWithStorage(readCodexUsageSessions, storage)[0];
    const detail = runWithStorage(readCodexSessionDetail('ambiguous-replay-thread'), storage);

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.partial).toBe(true);
    expect(session?.turns).toBe(1);
    expect(session?.tokens).toEqual({ cr: 30, cw: 0, in: 10, out: 10 });
    expect(validDetail.durationStatus).toBe('partial');
    expect(validDetail.turnsStatus).toBe('partial');
    expect(validDetail.turns.map((turn) => [turn.model, turn.tokens.total])).toEqual([['gpt-5.6-sol', 50]]);
  });

  test('uses replayed token snapshots as a baseline without attributing replayed tasks', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/rollout-2026-01-01T00-00-00-replay-parent.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'replay-parent', cwd: '/work/replay-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 1000,
                input_tokens: 800,
                cached_input_tokens: 600,
                output_tokens: 200,
              },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/rollout-2026-01-01T00-10-00-replay-child.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:10:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'replay-child',
            cwd: '/work/replay-project',
            source: { subagent: { thread_spawn: { parent_thread_id: 'replay-parent' } } },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.010Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 50,
                input_tokens: 40,
                cached_input_tokens: 30,
                output_tokens: 10,
              },
              total_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.020Z',
          payload: { type: 'task_started', turn_id: 'replayed-turn', started_at: 1_767_225_600 },
        },
        {
          timestamp: '2026-01-01T00:10:00.030Z',
          type: 'turn_context',
          payload: { effort: 'high', model: 'gpt-5.6-terra', turn_id: 'replayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:00.040Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
              total_token_usage: {
                total_tokens: 200,
                input_tokens: 160,
                cached_input_tokens: 120,
                output_tokens: 40,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.050Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            internal_chat_message_metadata_passthrough: { turn_id: 'replayed-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.060Z',
          payload: {
            type: 'task_complete',
            turn_id: 'replayed-turn',
            completed_at: 1_767_225_660,
            duration_ms: 60_000,
          },
        },
        {
          timestamp: '2026-01-01T00:10:10.100Z',
          payload: { type: 'task_started', turn_id: 'local-turn', started_at: 1_767_226_210 },
        },
        {
          timestamp: '2026-01-01T00:10:10.110Z',
          type: 'turn_context',
          payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'local-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:20.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 50,
                input_tokens: 40,
                cached_input_tokens: 30,
                output_tokens: 10,
              },
              total_token_usage: {
                total_tokens: 250,
                input_tokens: 200,
                cached_input_tokens: 150,
                output_tokens: 50,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:30.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            internal_chat_message_metadata_passthrough: { turn_id: 'local-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:11:10.000Z',
          payload: {
            type: 'task_complete',
            turn_id: 'local-turn',
            completed_at: 1_767_226_270,
            duration_ms: 60_000,
          },
        },
      ),
    );

    const sessions = runWithStorage(readCodexUsageSessions, storage);
    const detail = runWithStorage(readCodexSessionDetail('replay-child'), storage);
    const child = sessions.find((session) => session.source.sourceSessionId === 'replay-child');

    expect(sessions).toHaveLength(2);
    expect(child?.tokens).toEqual({ cr: 30, cw: 0, in: 10, out: 10 });
    expect(child?.models).toEqual(['gpt-5.6-sol']);
    expect(child?.turns).toBe(1);
    expect(child?.tools).toBe(1);
    expect(child?.durationMs).toBe(60_000);
    expect(child?.costKnown).toBe(true);
    expect(detail?.phases.map((phase) => [phase.model, phase.tokens.total])).toEqual([['gpt-5.6-sol', 50]]);
    expect(detail?.turns.map((turn) => [turn.model, turn.tokens.total])).toEqual([['gpt-5.6-sol', 50]]);
  });

  test('resets cumulative token baselines without producing negative deltas', () => {
    const storage = new TestMemoryStorage();
    const tokenEvent = (timestamp: string, total: unknown, input: unknown, cached: unknown, output: unknown) => ({
      timestamp,
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            total_tokens: total,
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
          },
          total_token_usage: {
            total_tokens: total,
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
          },
        },
      },
    });
    storage.writeText(
      '.codex/sessions/2026/nonmono-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'nonmono-thread', cwd: '/work/nonmono' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: { type: 'task_started', turn_id: 'nonmono-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:01.010Z',
          type: 'turn_context',
          payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'nonmono-turn' },
        },
        tokenEvent('2026-01-01T00:00:02.000Z', 20, 15, 5, 5),
        tokenEvent('2026-01-01T00:00:03.000Z', 25, 'malformed', 6, 6),
        tokenEvent('2026-01-01T00:00:04.000Z', 8, 6, 2, 2),
        tokenEvent('2026-01-01T00:00:05.000Z', 18, 14, 4, 4),
        {
          timestamp: '2026-01-01T00:00:06.000Z',
          payload: { type: 'task_complete', turn_id: 'nonmono-turn', duration_ms: 1000 },
        },
      ),
    );

    const result = runWithStorage(collectCodexResult, storage);
    const detail = runWithStorage(readCodexSessionDetail('nonmono-thread'), storage);

    expect(result.rows[0]?.tokIn).toBe(20);
    expect(result.rows[0]?.tokCr).toBe(9);
    expect(result.rows[0]?.tokOut).toBe(9);
    expect(detail?.phases[0]?.tokens.total).toBe(38);
    expect(detail?.turns[0]?.tokens.total).toBe(38);
    expect(result.warnings[0]?.message).toBe('Rejected 2 malformed codex metric record(s).');
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
            payload: { type: 'task_started', turn_id: 'cached-turn' },
          },
          {
            timestamp: '2026-01-01T00:01:00.010Z',
            type: 'turn_context',
            payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'cached-turn' },
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
            timestamp: '2026-01-01T00:04:00.000Z',
            payload: { type: 'task_complete', turn_id: 'cached-turn', duration_ms: 180_000 },
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
      expect(second.rows[0]?.durationMs).toBe(180_000);
      expect(second.rows[0]?.model).toBe('gpt-5.6-sol');
      expect(second.rows[0]?.models).toEqual(['gpt-5.6-sol']);
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
