import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { findLatestCodexQuotaSnapshot, readCodexUsageSessions } from './codex-history';
import { collectCodex } from './collectors/codex';
import { LocalHistoryStorage } from './local-history';
import { TestMemoryStorage } from './test-memory-storage';

const jsonl = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

describe('Codex local history', () => {
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
              subagent: { thread_spawn: { parent_thread_id: 'parent-thread' } },
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
    expect(sessions[0]?.tokens.in).toBe(10);
    expect(sessions[0]?.tokens.cr).toBe(2);
    expect(sessions[0]?.tokens.out).toBe(18);
    expect(sessions[0]?.calls).toBe(1);
    expect(sessions[0]?.turns).toBe(1);
    expect(sessions[0]?.hasSubagents).toBe(true);
    expect(sessions[0]?.isSubagent).toBe(false);
    expect(sessions[0]?.usageUnavailable).toBe(false);
    expect(sessions[1]?.name).toBe('codex child-th');
    expect(sessions[1]?.tokens.in).toBe(4);
    expect(sessions[1]?.tokens.cr).toBe(1);
    expect(sessions[1]?.tokens.out).toBe(4);
    expect(sessions[1]?.calls).toBe(1);
    expect(sessions[1]?.turns).toBe(1);
    expect(sessions[1]?.hasSubagents).toBe(false);
    expect(sessions[1]?.isSubagent).toBe(true);
    expect(sessions[1]?.subscription).toBe(true);

    const quota = runWithStorage(findLatestCodexQuotaSnapshot(), storage);
    expect(quota?.planType).toBe('pro');
    expect(quota?.primary?.usedPercent).toBe(50);
    expect(quota?.primary?.windowMinutes).toBe(300);

    const rows = runWithStorage(collectCodex, storage);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe('Fixture thread');
    expect(rows[0]?.provider).toBe('Codex sub');
    expect(rows[0]?.project).toBe('fixture-project');
    expect(rows[0]?.tokIn).toBe(10);
    expect(rows[0]?.tokCr).toBe(2);
    expect(rows[0]?.tokOut).toBe(18);
    expect(rows[0]?.calls).toBe(1);
    expect(rows[0]?.turns).toBe(1);
    expect(rows[0]?.subagent).toBe(true);
    expect(rows[0]?.usageUnavailable).toBe(false);
    expect(rows[1]?.name).toBe('codex child-th');
    expect(rows[1]?.provider).toBe('Codex sub');
    expect(rows[1]?.tokIn).toBe(4);
    expect(rows[1]?.tokCr).toBe(1);
    expect(rows[1]?.tokOut).toBe(4);
    expect(rows[1]?.subagent).toBe(true);
    expect(rows[1]?.usageUnavailable).toBe(false);
  });
});
