import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { collectClaude } from './collectors/claude';
import { collectCursor } from './collectors/cursor';
import { collectOpenCode } from './collectors/opencode';
import { LocalHistoryStorage } from './local-history';
import { TestMemoryStorage } from './test-memory-storage';

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

const OPENCODE_DB = '.local/share/opencode/opencode.db';
const OPENCODE_SESSION_SQL = 'SELECT id, title, directory, summary_additions, summary_deletions FROM session';
const OPENCODE_TOOL_SQL =
  "SELECT session_id, count(*) n FROM part WHERE json_extract(data,'$.type')='tool' GROUP BY session_id";
const OPENCODE_MESSAGE_SQL = 'SELECT session_id, data FROM message';

const CURSOR_DB = 'Library/Application Support/Cursor/User/globalStorage/state.vscdb';
const CURSOR_COMPOSER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'";
const CURSOR_TOKEN_SQL =
  "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"inputTokens\"%'";
const CURSOR_USER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"type\":1%'";

const jsonl = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

describe('DB-backed Harness collectors', () => {
  test('collects Claude prompt-history fallbacks when detailed usage files are missing', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.claude/projects/-work-ai-usage/existing-session.jsonl',
      jsonl({
        type: 'assistant',
        timestamp: '2026-04-25T08:00:00.000Z',
        cwd: '/work/ai-usage',
        requestId: 'request-1',
        message: {
          id: 'message-1',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      }),
    );
    storage.writeText(
      '.claude/history.jsonl',
      jsonl(
        {
          timestamp: Date.parse('2026-04-24T07:17:43.816Z'),
          project: '/work/ai-usage',
          sessionId: 'missing-session',
          display: 'fait moi un plan pour traiter tous ces findings',
        },
        {
          timestamp: Date.parse('2026-04-24T08:33:07.361Z'),
          project: '/work/ai-usage',
          sessionId: 'missing-session',
          display: 'On a une regression',
        },
        {
          timestamp: Date.parse('2026-04-24T09:00:00.000Z'),
          project: '/work/ai-usage',
          sessionId: 'clear-only',
          display: '/clear',
        },
        {
          timestamp: Date.parse('2026-04-25T08:01:00.000Z'),
          project: '/work/ai-usage',
          sessionId: 'existing-session',
          display: 'existing detailed session',
        },
      ),
    );

    const rows = runWithStorage(collectClaude, storage);
    const unavailable = rows.find((row) => row.usageUnavailable);

    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.name === 'existing detailed session')).toBe(false);
    expect(rows.some((row) => row.name === '/clear')).toBe(false);
    expect(unavailable?.harness).toBe('Claude Code');
    expect(unavailable?.name).toBe('fait moi un plan pour traiter tous ces findings');
    expect(unavailable?.project).toBe('ai-usage');
    expect(unavailable?.tokIn).toBe(0);
    expect(unavailable?.costActual).toBeNull();
    expect(unavailable?.costKnown).toBe(false);
    expect(unavailable?.turns).toBe(2);
    expect(unavailable?.date?.toISOString()).toBe('2026-04-24T07:17:43.816Z');
    expect(unavailable?.endDate?.toISOString()).toBe('2026-04-24T08:33:07.361Z');
  });

  test('collects OpenCode Usage rows through SQLite fixture storage', () => {
    const storage = new TestMemoryStorage();
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_SESSION_SQL, [
      {
        id: 'session-1',
        title: 'Build usage report',
        directory: '/work/ai-usage',
        summary_additions: 12,
        summary_deletions: 3,
      },
    ]);
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_TOOL_SQL, [{ session_id: 'session-1', n: 2 }]);
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_MESSAGE_SQL, [
      { session_id: 'session-1', data: JSON.stringify({ role: 'user' }) },
      {
        session_id: 'session-1',
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-5.3',
          cost: 0.12,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 4 } },
          time: { created: '2026-01-01T00:00:00.000Z', completed: '2026-01-01T00:01:00.000Z' },
        }),
      },
    ]);

    const rows = runWithStorage(collectOpenCode, storage);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.harness).toBe('OpenCode');
    expect(rows[0]?.provider).toBe('OpenAI API');
    expect(rows[0]?.project).toBe('ai-usage');
    expect(rows[0]?.tokOut).toBe(25);
    expect(rows[0]?.costActual).toBe(0.12);
    expect(rows[0]?.turns).toBe(1);
    expect(rows[0]?.tools).toBe(2);
    expect(rows[0]?.linesAdded).toBe(12);
  });

  test('collects Cursor partial Usage rows through SQLite fixture storage', () => {
    const storage = new TestMemoryStorage();
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_COMPOSER_SQL, [
      {
        key: 'composerData:composer-1',
        value: JSON.stringify({
          name: 'Fix UI',
          modelConfig: { modelName: 'gpt-5.3' },
          createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
          totalLinesAdded: 7,
          totalLinesRemoved: 2,
        }),
      },
    ]);
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_TOKEN_SQL, [
      {
        key: 'bubbleId:composer-1:assistant-1',
        value: JSON.stringify({ tokenCount: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } }),
      },
    ]);
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_USER_SQL, [
      { key: 'bubbleId:composer-1:user-1', value: JSON.stringify({ type: 1, text: 'Fix the UI' }) },
    ]);

    const rows = runWithStorage(collectCursor, storage);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.harness).toBe('Cursor');
    expect(rows[0]?.provider).toBe('Cursor sub');
    expect(rows[0]?.name).toBe('Fix UI');
    expect(rows[0]?.partial).toBe(true);
    expect(rows[0]?.tokIn).toBe(10);
    expect(rows[0]?.tokCr).toBe(2);
    expect(rows[0]?.turns).toBe(1);
    expect(rows[0]?.linesDeleted).toBe(2);
  });

  test('surfaces token-less Cursor composers as usage-unavailable rows', () => {
    const storage = new TestMemoryStorage();
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_COMPOSER_SQL, [
      {
        key: 'composerData:tokenless',
        value: JSON.stringify({
          name: 'Refactor agent loop',
          modelConfig: { modelName: 'gpt-5.3' },
          createdAt: Date.parse('2026-03-10T00:00:00.000Z'),
          totalLinesAdded: 9,
          totalLinesRemoved: 4,
        }),
      },
    ]);
    // Recent Cursor bubbles keep the inputTokens field but always at 0.
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_TOKEN_SQL, [
      {
        key: 'bubbleId:tokenless:assistant-1',
        value: JSON.stringify({ tokenCount: { inputTokens: 0, outputTokens: 0 } }),
      },
    ]);
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_USER_SQL, [
      { key: 'bubbleId:tokenless:user-1', value: JSON.stringify({ type: 1, text: 'Refactor the agent loop' }) },
      { key: 'bubbleId:tokenless:user-2', value: JSON.stringify({ type: 1, text: 'And add a test' }) },
    ]);

    const rows = runWithStorage(collectCursor, storage);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.harness).toBe('Cursor');
    expect(rows[0]?.name).toBe('Refactor agent loop');
    expect(rows[0]?.usageUnavailable).toBe(true);
    expect(rows[0]?.tokIn).toBe(0);
    expect(rows[0]?.costActual).toBeNull();
    expect(rows[0]?.costKnown).toBe(false);
    expect(rows[0]?.turns).toBe(2);
    expect(rows[0]?.linesAdded).toBe(9);
    expect(rows[0]?.date?.toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });
});
