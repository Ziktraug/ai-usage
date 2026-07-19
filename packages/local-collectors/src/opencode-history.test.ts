import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { parseSessionDetail } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { LocalHistoryStorage } from './local-history';
import {
  OPENCODE_DETAIL_MESSAGE_SQL,
  OPENCODE_DETAIL_PARENT_SQL,
  OPENCODE_DETAIL_PROMPT_SQL,
  OPENCODE_DETAIL_SESSION_SQL,
  OPENCODE_DETAIL_TOOL_SQL,
  readOpenCodeSessionDetail,
} from './opencode-history';
import { TestMemoryStorage } from './test-memory-storage';

const OPENCODE_DB = '.local/share/opencode/opencode.db';
const SESSION_ID = 'session-detail';
const SESSION_PARAMETERS = [SESSION_ID, 2] as const;
const MESSAGE_PARAMETERS = [SESSION_ID, 2049] as const;
const PARENT_PARAMETERS = [SESSION_ID, SESSION_ID, 1025] as const;
const PROMPT_PARAMETERS = [SESSION_ID, SESSION_ID, 257] as const;
const TOOL_PARAMETERS = [SESSION_ID, 1025] as const;

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

const writeDetailFixture = (storage: TestMemoryStorage): void => {
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_SESSION_SQL,
    [{ id: SESSION_ID, time_created: Date.parse('2026-07-19T10:00:00.000Z'), time_updated: null }],
    SESSION_PARAMETERS,
  );
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_MESSAGE_SQL,
    [
      {
        id: 'user-1',
        role: 'user',
        parent_id: null,
        created: Date.parse('2026-07-19T10:00:00.000Z'),
        completed: null,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parent_id: 'user-1',
        created: Date.parse('2026-07-19T10:00:05.000Z'),
        completed: Date.parse('2026-07-19T10:01:00.000Z'),
        provider_id: 'anthropic',
        model_id: 'claude-sonnet-4-6',
        variant: 'high',
        token_input: 10,
        token_output: 5,
        token_reasoning: 2,
        token_cache_read: 1,
        token_cache_write: 0,
        cost: 1.25,
      },
      {
        id: 'user-2',
        role: 'user',
        parent_id: null,
        created: Date.parse('2026-07-19T11:00:00.000Z'),
        completed: null,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        parent_id: 'user-2',
        created: Date.parse('2026-07-19T11:00:00.000Z'),
        completed: null,
        provider_id: 'openai',
        model_id: 'gpt-5.4',
        variant: null,
        token_input: 3,
        token_output: 2,
        token_reasoning: 0,
        token_cache_read: 0,
        token_cache_write: 1,
        cost: 0,
      },
    ],
    MESSAGE_PARAMETERS,
  );
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_PROMPT_SQL,
    [
      {
        id: 'prompt-1',
        message_id: 'user-1',
        created: Date.parse('2026-07-19T10:00:00.000Z'),
        text: 'private prompt sentinel',
        text_length: 23,
      },
      {
        id: 'prompt-2',
        message_id: 'user-2',
        created: Date.parse('2026-07-19T11:00:00.000Z'),
        text: 'continue',
        text_length: 8,
      },
    ],
    PROMPT_PARAMETERS,
  );
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_PARENT_SQL,
    [{ message_id: 'user-1' }, { message_id: 'user-2' }],
    PARENT_PARAMETERS,
  );
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_TOOL_SQL,
    [{ message_id: 'assistant-1', tool_count: 2 }],
    TOOL_PARAMETERS,
  );
};

const writeGroupedTurnFixture = (storage: TestMemoryStorage): void => {
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_SESSION_SQL,
    [{ id: SESSION_ID, time_created: Date.parse('2026-07-19T10:00:00.000Z'), time_updated: null }],
    SESSION_PARAMETERS,
  );
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_MESSAGE_SQL,
    [
      {
        id: 'user-1',
        role: 'user',
        parent_id: null,
        created: Date.parse('2026-07-19T10:00:00.000Z'),
        completed: null,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parent_id: 'user-1',
        created: Date.parse('2026-07-19T10:00:05.000Z'),
        completed: Date.parse('2026-07-19T10:00:10.000Z'),
        provider_id: 'provider-a',
        model_id: 'small',
        variant: 'low',
        token_input: 2,
        token_output: 3,
        token_reasoning: 0,
        token_cache_read: 0,
        token_cache_write: 0,
        cost: 0.1,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        parent_id: 'user-1',
        created: Date.parse('2026-07-19T10:00:20.000Z'),
        completed: Date.parse('2026-07-19T10:00:30.000Z'),
        provider_id: 'provider-b',
        model_id: 'large',
        variant: 'high',
        token_input: 10,
        token_output: 10,
        token_reasoning: 0,
        token_cache_read: 0,
        token_cache_write: 0,
        cost: 0.2,
      },
      {
        id: 'assistant-legacy',
        role: 'assistant',
        parent_id: null,
        created: Date.parse('2026-07-19T10:00:40.000Z'),
        completed: Date.parse('2026-07-19T10:00:45.000Z'),
        provider_id: 'provider-a',
        model_id: 'legacy',
        variant: null,
        token_input: 1,
        token_output: 1,
        token_reasoning: 0,
        token_cache_read: 0,
        token_cache_write: 0,
        cost: 0.05,
      },
      {
        id: 'user-internal',
        role: 'user',
        parent_id: null,
        created: Date.parse('2026-07-19T10:00:50.000Z'),
        completed: null,
      },
      {
        id: 'assistant-internal',
        role: 'assistant',
        parent_id: 'user-internal',
        created: Date.parse('2026-07-19T10:00:50.000Z'),
        completed: Date.parse('2026-07-19T10:00:55.000Z'),
        provider_id: 'provider-internal',
        model_id: 'compaction',
        variant: null,
        token_input: 2,
        token_output: 1,
        token_reasoning: 0,
        token_cache_read: 0,
        token_cache_write: 0,
        cost: 0,
      },
    ],
    MESSAGE_PARAMETERS,
  );
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_PROMPT_SQL,
    [
      {
        id: 'prompt-1',
        message_id: 'user-1',
        created: Date.parse('2026-07-19T10:00:00.000Z'),
        text: 'grouped turn prompt',
        text_length: 19,
      },
    ],
    PROMPT_PARAMETERS,
  );
  storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_DETAIL_PARENT_SQL, [{ message_id: 'user-1' }], PARENT_PARAMETERS);
  storage.writeDatabaseRows(
    OPENCODE_DB,
    OPENCODE_DETAIL_TOOL_SQL,
    [
      { message_id: 'assistant-1', tool_count: 1 },
      { message_id: 'assistant-2', tool_count: 2 },
      { message_id: 'assistant-legacy', tool_count: 3 },
      { message_id: 'assistant-internal', tool_count: 1 },
    ],
    TOOL_PARAMETERS,
  );
};

describe('OpenCode session detail', () => {
  test('reads bounded prompts, model phases, reported costs, tools, and partial duration from one session', () => {
    const storage = new TestMemoryStorage();
    writeDetailFixture(storage);

    const detail = runWithStorage(readOpenCodeSessionDetail(SESSION_ID), storage);

    if (!detail) {
      throw new Error('Expected OpenCode session detail');
    }
    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(detail.sourceSessionId).toBe(SESSION_ID);
    expect(detail.startedAt).toBe('2026-07-19T10:00:00.000Z');
    expect(detail.endedAt).toBe('2026-07-19T11:00:00.000Z');
    expect(detail.elapsedDurationMs).toBe(60 * 60_000);
    expect(detail.activeDurationMs).toBe(55_000);
    expect(detail.idleDurationMs).toBe(60 * 60_000 - 55_000);
    expect(detail.durationStatus).toBe('partial');
    expect(detail.models).toEqual(['anthropic/claude-sonnet-4-6', 'openai/gpt-5.4']);
    expect(detail.efforts).toEqual(['high']);
    expect(detail.prompts.map(({ text }) => text)).toEqual(['private prompt sentinel', 'continue']);
    expect(detail.promptsTruncated).toBe(false);
    expect(detail.turnsStatus).toBe('recorded');
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0]).toMatchObject({
      durationMs: 55_000,
      effort: 'high',
      effortKind: 'recorded',
      model: 'anthropic/claude-sonnet-4-6',
      intervals: [{ endAt: '2026-07-19T10:01:00.000Z', startAt: '2026-07-19T10:00:05.000Z' }],
      promptIds: ['prompt-1'],
      tokens: { cacheRead: 1, cacheWrite: 0, input: 10, output: 7, total: 18 },
      tools: 2,
    });
    expect(detail.turns[1]).toMatchObject({
      durationMs: 0,
      effort: null,
      effortKind: 'unavailable',
      intervals: [{ endAt: '2026-07-19T11:00:00.000Z', startAt: '2026-07-19T11:00:00.000Z' }],
      model: 'openai/gpt-5.4',
      promptIds: ['prompt-2'],
    });
    expect(detail.phases).toEqual([
      {
        cost: 1.25,
        costKind: 'reported',
        effort: 'high',
        effortKind: 'recorded',
        endAt: '2026-07-19T10:01:00.000Z',
        model: 'anthropic/claude-sonnet-4-6',
        startAt: '2026-07-19T10:00:05.000Z',
        tokens: { cacheRead: 1, cacheWrite: 0, input: 10, output: 7, total: 18 },
      },
      {
        cost: 0,
        costKind: 'reported',
        effort: null,
        effortKind: 'unavailable',
        endAt: '2026-07-19T11:00:00.000Z',
        model: 'openai/gpt-5.4',
        startAt: '2026-07-19T11:00:00.000Z',
        tokens: { cacheRead: 0, cacheWrite: 1, input: 3, output: 2, total: 6 },
      },
    ]);
  });

  test('preserves direct, unresolved, and internal assistant activity in reconcilable turns', () => {
    const storage = new TestMemoryStorage();
    writeGroupedTurnFixture(storage);

    const detail = runWithStorage(readOpenCodeSessionDetail(SESSION_ID), storage);

    if (!detail) {
      throw new Error('Expected grouped OpenCode session detail');
    }
    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(detail.turnsStatus).toBe('partial');
    expect(detail.turns).toHaveLength(3);
    expect(detail.turns[0]).toEqual({
      durationMs: 15_000,
      effort: 'high',
      effortKind: 'recorded',
      endAt: '2026-07-19T10:00:30.000Z',
      index: 0,
      intervals: [
        { endAt: '2026-07-19T10:00:10.000Z', startAt: '2026-07-19T10:00:05.000Z' },
        { endAt: '2026-07-19T10:00:30.000Z', startAt: '2026-07-19T10:00:20.000Z' },
      ],
      model: 'provider-b/large',
      promptIds: ['prompt-1'],
      startAt: '2026-07-19T10:00:05.000Z',
      tokens: { cacheRead: 0, cacheWrite: 0, input: 12, output: 13, total: 25 },
      tools: 3,
    });
    expect(detail.turns[1]).toMatchObject({
      durationMs: 5000,
      effort: null,
      effortKind: 'unavailable',
      model: 'provider-a/legacy',
      promptIds: [],
      tools: 3,
    });
    expect(detail.turns[2]).toMatchObject({
      durationMs: 5000,
      effort: null,
      effortKind: 'unavailable',
      model: 'provider-internal/compaction',
      promptIds: [],
      tokens: { cacheRead: 0, cacheWrite: 0, input: 2, output: 1, total: 3 },
      tools: 1,
    });
    expect(detail.turns.reduce((total, turn) => total + turn.tokens.total, 0)).toBe(30);
    expect(detail.phases.reduce((total, phase) => total + phase.tokens.total, 0)).toBe(30);
    expect(detail.turns.reduce((total, turn) => total + turn.durationMs, 0)).toBe(detail.activeDurationMs);
    expect(detail.activeDurationMs).toBe(25_000);
    expect(detail.elapsedDurationMs).toBe(55_000);
  });

  test('filters synthetic prompt parts in the bounded SQL query', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER,
          data TEXT NOT NULL
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          time_created INTEGER,
          data TEXT NOT NULL
        );
      `);
      const created = Date.parse('2026-07-19T10:00:00.000Z');
      database
        .query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
        .run('user-1', SESSION_ID, created, JSON.stringify({ role: 'user', time: { created } }));
      database
        .query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
        .run(
          'user-synthetic',
          SESSION_ID,
          created + 1,
          JSON.stringify({ role: 'user', time: { created: created + 1 } }),
        );
      const insertPart = database.query(
        'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
      );
      insertPart.run(
        'prompt-visible',
        'user-1',
        SESSION_ID,
        created,
        JSON.stringify({ text: 'visible', type: 'text' }),
      );
      insertPart.run(
        'prompt-synthetic',
        'user-synthetic',
        SESSION_ID,
        created,
        JSON.stringify({ synthetic: true, text: 'hidden', type: 'text' }),
      );

      const rows = database
        .query<{ id: string }, [string, string, number]>(OPENCODE_DETAIL_PROMPT_SQL)
        .all(SESSION_ID, SESSION_ID, 257);

      expect(rows.map(({ id }) => id)).toEqual(['prompt-visible']);
      const parentRows = database
        .query<{ message_id: string }, [string, string, number]>(OPENCODE_DETAIL_PARENT_SQL)
        .all(SESSION_ID, SESSION_ID, 1025);
      expect(parentRows.map(({ message_id }) => message_id)).toEqual(['user-1']);
    } finally {
      database.close();
    }
  });

  test('binds the requested session id instead of interpolating it into SQL', () => {
    const storage = new TestMemoryStorage();
    const sourceSessionId = "session' OR 1=1";
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_DETAIL_SESSION_SQL, [], [sourceSessionId, 2]);

    expect(runWithStorage(readOpenCodeSessionDetail(sourceSessionId), storage)).toBeNull();
  });

  test('marks internal turn attribution and open duration partial without dropping recorded metrics', () => {
    const storage = new TestMemoryStorage();
    writeDetailFixture(storage);
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_DETAIL_PROMPT_SQL, [], PROMPT_PARAMETERS);
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_DETAIL_PARENT_SQL, [], PARENT_PARAMETERS);

    const detail = runWithStorage(readOpenCodeSessionDetail(SESSION_ID), storage);

    if (!detail) {
      throw new Error('Expected partial OpenCode session detail');
    }
    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(detail.turnsStatus).toBe('partial');
    expect(detail.durationStatus).toBe('partial');
    expect(detail.prompts).toEqual([]);
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns.every(({ promptIds }) => promptIds.length === 0)).toBe(true);
    expect(detail.turns.reduce((total, turn) => total + turn.tokens.total, 0)).toBe(24);
    expect(detail.phases.reduce((total, phase) => total + phase.tokens.total, 0)).toBe(24);
    expect(detail.turns.reduce((total, turn) => total + turn.durationMs, 0)).toBe(detail.activeDurationMs);
  });
});
