import { describe, expect, test } from 'bun:test';
import { LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { OPENCODE_SCHEMA_SQL } from '@ai-usage/local-machine/opencode-schema';
import { TestMemoryStorage } from '@ai-usage/local-machine/testing/memory-storage';
import { Effect } from 'effect';
import { collectSelectedHarnessResults, collectSelectedHarnessRows } from './collectors';
import { collectClaude, collectClaudeRetentionWarnings } from './collectors/claude';
import { collectCursor } from './collectors/cursor';
import {
  classifyOpenCodeTitle,
  collectOpenCode,
  collectOpenCodeResult,
  MAX_OPENCODE_SKILL_PARTS,
  OPENCODE_LEGACY_MESSAGE_SQL,
  OPENCODE_LEGACY_SESSION_SQL,
  OPENCODE_LEGACY_TOOL_COUNT_SQL,
  OPENCODE_LEGACY_TURN_SQL,
  OPENCODE_V2_MALFORMED_ASSISTANT_SQL,
  OPENCODE_V2_MESSAGE_SQL,
  OPENCODE_V2_SESSION_SQL,
  OPENCODE_V2_TOOL_COUNT_SQL,
  OPENCODE_V2_TURN_SQL,
  openCodeLegacySkillPartSql,
  openCodeV2SkillPartSql,
} from './collectors/opencode';

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
const runAsyncWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

const OPENCODE_DB = '.local/share/opencode/opencode.db';
const OPENCODE_STABLE_DB = '.local/share/opencode/opencode-stable.db';
const OPENCODE_LEGACY_TABLES = ['session', 'message', 'part'] as const;
const OPENCODE_V2_TABLES = ['session_v2', 'session_message'] as const;

interface OpenCodeSessionFixture {
  directory: string;
  id: string;
  parent_id?: string | null;
  summary_additions: number;
  summary_deletions: number;
  title: string;
  [column: string]: unknown;
}
/** The metric columns the collector projects out of a message payload in SQL. */
interface OpenCodeMessageFixture {
  completed?: number | string | null;
  cost?: number | null;
  created?: number | string;
  id: string;
  model_id?: string;
  provider_id?: string;
  role?: string;
  session_id: string;
  token_cache_read?: unknown;
  token_cache_write?: unknown;
  token_input?: unknown;
  token_output?: unknown;
  token_reasoning?: unknown;
  tokens_type?: string | null;
  variant?: string | null;
  [column: string]: unknown;
}
interface OpenCodeTableFixture {
  malformedAssistantRows?: number;
  messages: OpenCodeMessageFixture[];
  sessions: OpenCodeSessionFixture[];
  skillParts?: Array<{ data: string; id?: string; message_id: string; session_id: string; time_created?: number }>;
  tools?: Array<{ message_id: string; n: number; session_id: string }>;
  turns?: Array<{ message_id: string; session_id: string }>;
}

/** Which of the known OpenCode tables the fixture database declares. */
const writeOpenCodeSchema = (storage: TestMemoryStorage, dbPath: string, tables: readonly string[]) => {
  storage.writeDatabaseRows(
    dbPath,
    OPENCODE_SCHEMA_SQL,
    tables.map((name) => ({ name })),
  );
};

const writeOpenCodeLegacyTables = (storage: TestMemoryStorage, dbPath: string, fixture: OpenCodeTableFixture) => {
  storage.writeDatabaseRows(dbPath, OPENCODE_LEGACY_SESSION_SQL, fixture.sessions);
  storage.writeDatabaseRows(dbPath, OPENCODE_LEGACY_TOOL_COUNT_SQL, fixture.tools ?? []);
  storage.writeDatabaseRows(dbPath, OPENCODE_LEGACY_TURN_SQL, fixture.turns ?? []);
  storage.writeDatabaseRows(dbPath, OPENCODE_LEGACY_MESSAGE_SQL, fixture.messages);
  storage.writeDatabaseRows(dbPath, openCodeLegacySkillPartSql(MAX_OPENCODE_SKILL_PARTS), fixture.skillParts ?? []);
};

const writeOpenCodeV2Tables = (storage: TestMemoryStorage, dbPath: string, fixture: OpenCodeTableFixture) => {
  storage.writeDatabaseRows(dbPath, OPENCODE_V2_SESSION_SQL, fixture.sessions);
  storage.writeDatabaseRows(dbPath, OPENCODE_V2_TOOL_COUNT_SQL, fixture.tools ?? []);
  storage.writeDatabaseRows(dbPath, OPENCODE_V2_TURN_SQL, fixture.turns ?? []);
  storage.writeDatabaseRows(dbPath, OPENCODE_V2_MESSAGE_SQL, fixture.messages);
  storage.writeDatabaseRows(dbPath, OPENCODE_V2_MALFORMED_ASSISTANT_SQL, [{ n: fixture.malformedAssistantRows ?? 0 }]);
  storage.writeDatabaseRows(dbPath, openCodeV2SkillPartSql(MAX_OPENCODE_SKILL_PARTS), fixture.skillParts ?? []);
};

const writeOpenCodeLegacyDatabase = (storage: TestMemoryStorage, dbPath: string, fixture: OpenCodeTableFixture) => {
  writeOpenCodeSchema(storage, dbPath, OPENCODE_LEGACY_TABLES);
  writeOpenCodeLegacyTables(storage, dbPath, fixture);
};

const writeOpenCodeV2Database = (storage: TestMemoryStorage, dbPath: string, fixture: OpenCodeTableFixture) => {
  writeOpenCodeSchema(storage, dbPath, OPENCODE_V2_TABLES);
  writeOpenCodeV2Tables(storage, dbPath, fixture);
};

/** One assistant message as the collector's SQL projects it; both schemas yield the same columns. */
const assistantRow = (
  id: string,
  sessionId: string,
  columns: Omit<OpenCodeMessageFixture, 'id' | 'session_id'>,
): OpenCodeMessageFixture => ({ id, role: 'assistant', session_id: sessionId, tokens_type: 'object', ...columns });

const CURSOR_DB = '.config/Cursor/User/globalStorage/state.vscdb';
const CURSOR_COMPOSER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'";
const CURSOR_TOKEN_SQL =
  "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"inputTokens\"%'";
const CURSOR_USER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"type\":1%'";

const jsonl = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const cursorCsv = (rows: string[]) =>
  [
    'Date,User,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    ...rows,
  ].join('\n');

describe('DB-backed Harness collectors', () => {
  test('aggregates redacted metric warnings per harness while preserving valid neighboring records', () => {
    const claudeStorage = new TestMemoryStorage();
    claudeStorage.writeText(
      '.claude/projects/-work-ai-usage/metrics.jsonl',
      jsonl(
        {
          type: 'assistant',
          timestamp: '2026-04-25T08:00:00.000Z',
          requestId: 'invalid',
          message: { id: 'invalid', usage: { input_tokens: 'private-invalid-value' } },
        },
        {
          type: 'assistant',
          timestamp: '2026-04-25T08:01:00.000Z',
          requestId: 'valid',
          message: { id: 'valid', usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ),
    );
    const claude = runWithStorage(
      collectSelectedHarnessResults({ harness: 'claude', includeCursor: false }),
      claudeStorage,
    );

    const cursorStorage = new TestMemoryStorage();
    cursorStorage.writeDatabaseRows(CURSOR_DB, CURSOR_COMPOSER_SQL, [
      { key: 'composerData:cursor-session', value: JSON.stringify({ name: 'Cursor session', createdAt: 1 }) },
    ]);
    cursorStorage.writeDatabaseRows(CURSOR_DB, CURSOR_TOKEN_SQL, [
      {
        key: 'bubbleId:cursor-session:invalid',
        value: JSON.stringify({ tokenCount: { inputTokens: -1 } }),
      },
      {
        key: 'bubbleId:cursor-session:valid',
        value: JSON.stringify({ tokenCount: { inputTokens: 10, outputTokens: 5 } }),
      },
    ]);
    cursorStorage.writeDatabaseRows(CURSOR_DB, CURSOR_USER_SQL, []);
    const cursor = runWithStorage(
      collectSelectedHarnessResults({ harness: 'cursor', includeCursor: true }),
      cursorStorage,
    );

    const openCodeStorage = new TestMemoryStorage();
    writeOpenCodeLegacyDatabase(openCodeStorage, OPENCODE_DB, {
      sessions: [
        { id: 'open-session', title: 'Open session', directory: '/work', summary_additions: 0, summary_deletions: 0 },
      ],
      messages: [
        assistantRow('invalid-message', 'open-session', { token_input: 'private-invalid-value' }),
        assistantRow('valid-message', 'open-session', { token_input: 10, token_output: 5 }),
      ],
    });
    const opencode = runWithStorage(
      collectSelectedHarnessResults({ harness: 'opencode', includeCursor: false }),
      openCodeStorage,
    );

    for (const result of [claude, cursor, opencode]) {
      const warnings = result.warnings.filter((warning) => warning.operation === 'metricValidation');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain('Rejected 1 malformed');
      expect(JSON.stringify(warnings)).not.toContain('private-invalid-value');
      expect(result.rows).toHaveLength(1);
    }
  });

  test('reports one failing harness while keeping successful harness rows', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText('.codex/session_index.jsonl', jsonl({ id: 'codex-thread', thread_name: 'Fixture thread' }));
    storage.writeText(
      '.codex/sessions/2026/codex-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-thread', cwd: '/work/fixture-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: { type: 'message', role: 'user', content: [{ input_text: 'Build the report' }] },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
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
          },
        },
      ),
    );
    // Only the legacy session query has fixture rows: the schema probe fails, so the database read fails.
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_LEGACY_SESSION_SQL, [
      {
        id: 'broken-opencode',
        title: 'Broken OpenCode DB',
        directory: '/work/opencode',
        summary_additions: 0,
        summary_deletions: 0,
      },
    ]);

    const selection = { harness: null, includeCursor: false, keepSource: true } as const;
    // The Codex scan can sleep between slices of work, which `runSync` cannot run.
    const result = await runAsyncWithStorage(collectSelectedHarnessResults(selection), storage);
    const flatRows = await runAsyncWithStorage(collectSelectedHarnessRows(selection), storage);
    const opencode = result.harnesses.find((harness) => harness.harness === 'opencode');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.harness).toBe('Codex');
    expect(flatRows).toHaveLength(1);
    expect(opencode?.status).toBe('warning');
    expect(opencode?.warnings[0]?.message).toContain('Failed to read OpenCode live database');
    expect(result.warnings.some((warning) => warning.harness === 'opencode')).toBe(true);
    // No shipped collector declares retirements yet: successful and failed harnesses alike carry an
    // empty list, never an absent field (ADR 0089).
    expect(result.harnesses.map((harness) => harness.retiredSourceSessionIds)).toEqual([[], [], []]);
  });

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
    expect(unavailable?.origin).toBeUndefined();
    expect(unavailable?.originProvenance).toBe('origin-degraded');
    expect(unavailable?.name).toBe('claude missing-');
    expect(unavailable?.titleSource).toBe('id');
    expect(unavailable?.project).toBe('ai-usage');
    expect(unavailable?.tokIn).toBe(0);
    expect(unavailable?.costActual).toBeNull();
    expect(unavailable?.costKnown).toBe(false);
    expect(unavailable?.turns).toBe(2);
    expect(unavailable?.date?.toISOString()).toBe('2026-04-24T07:17:43.816Z');
    expect(unavailable?.endDate?.toISOString()).toBe('2026-04-24T08:33:07.361Z');
  });

  test('collects Claude title provenance and agent parent lineage from transcript files', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.claude/projects/-work-ai-usage/parent-session.jsonl',
      jsonl(
        {
          type: 'ai-title',
          timestamp: '2026-04-25T07:59:00.000Z',
          aiTitle: 'Refresh dashboard UX',
        },
        {
          type: 'assistant',
          timestamp: '2026-04-25T08:00:00.000Z',
          cwd: '/work/ai-usage',
          requestId: 'request-1',
          sessionId: 'parent-session',
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
        },
      ),
    );
    storage.writeText(
      '.claude/projects/-work-ai-usage/agent-child.jsonl',
      jsonl({
        type: 'assistant',
        timestamp: '2026-04-25T08:01:00.000Z',
        cwd: '/work/ai-usage',
        requestId: 'request-2',
        sessionId: 'parent-session',
        isSidechain: true,
        message: {
          id: 'message-2',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 6,
            output_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    );

    const rows = await Effect.runPromise(collectClaude.pipe(Effect.provideService(LocalHistoryStorage, storage)));
    const parent = rows.find((row) => row.source?.sourceSessionId === 'parent-session');
    const child = rows.find((row) => row.source?.sourceSessionId === 'agent-child');

    expect(parent?.name).toBe('Refresh dashboard UX');
    expect(parent?.origin).toBe('human');
    expect(parent?.titleSource).toBe('ai');
    expect(child?.origin).toBe('subagent');
    expect(child?.source?.parentSourceSessionId).toBe('parent-session');
    expect(child?.titleSource).toBe('agent-role');
    expect(child?.subagent).toBe(true);
  });

  test('keeps an untimed Claude report duration unavailable', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.claude/projects/-work-ai-usage/untimed-session.jsonl',
      jsonl(
        {
          type: 'user',
          timestamp: '2026-04-25T08:00:00.000Z',
          uuid: 'untimed-user',
          cwd: '/work/ai-usage',
          message: { content: 'Investigate the unavailable timing case' },
        },
        {
          type: 'assistant',
          timestamp: '2026-04-25T08:01:00.000Z',
          uuid: 'untimed-assistant',
          parentUuid: 'untimed-user',
          requestId: 'untimed-request',
          message: {
            id: 'untimed-message',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ),
    );

    const [row] = runWithStorage(collectClaude, storage);

    expect(row?.durationMs).toBeNull();
  });

  test('attributes Claude tokens and API value to each message model', () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.claude/projects/-work-ai-usage/multi-model-session.jsonl',
      jsonl(
        {
          type: 'assistant',
          timestamp: '2026-04-25T08:00:00.000Z',
          requestId: 'sonnet-request',
          message: {
            id: 'sonnet-message',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 1_000_000 },
          },
        },
        {
          type: 'assistant',
          timestamp: '2026-04-25T08:01:00.000Z',
          requestId: 'opus-request',
          message: {
            id: 'opus-message',
            model: 'claude-opus-4-6',
            usage: { output_tokens: 1_000_000 },
          },
        },
        {
          type: 'assistant',
          timestamp: '2026-04-25T08:02:00.000Z',
          requestId: 'unpriced-request',
          message: {
            id: 'unpriced-message',
            model: 'private-unpriced-model',
            usage: { input_tokens: 500_000 },
          },
        },
      ),
    );

    const [row] = runWithStorage(collectClaude, storage);

    expect(row?.models).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6', 'private-unpriced-model']);
    expect(row?.modelSegments).toEqual([
      {
        model: 'claude-sonnet-4-6',
        tokIn: 1_000_000,
        tokOut: 0,
        tokCr: 0,
        tokCw: 0,
        costApprox: 3,
        costKnown: true,
      },
      {
        model: 'claude-opus-4-6',
        tokIn: 0,
        tokOut: 1_000_000,
        tokCr: 0,
        tokCw: 0,
        costApprox: 25,
        costKnown: true,
      },
      {
        model: 'private-unpriced-model',
        tokIn: 500_000,
        tokOut: 0,
        tokCr: 0,
        tokCw: 0,
        costApprox: 0,
        costKnown: false,
      },
    ]);
    expect(row?.costApprox).toBe(28);
    expect(row?.costKnown).toBe(false);
  });

  test('warns when Claude Code is set to delete transcripts at the lossy default', () => {
    const storage = new TestMemoryStorage();

    // No settings.json at all -> the 30-day default applies, so we warn.
    const missing = runWithStorage(collectClaudeRetentionWarnings, storage);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.harness).toBe('claude');
    expect(missing[0]?.operation).toBe('claude.settings');
    expect(missing[0]?.message).toContain('30 days');
    expect(missing[0]?.message).toContain('unset');

    // Explicit value at or below the default still prunes history -> warn with the value.
    storage.writeText('.claude/settings.json', JSON.stringify({ cleanupPeriodDays: 7 }));
    const low = runWithStorage(collectClaudeRetentionWarnings, storage);
    expect(low).toHaveLength(1);
    expect(low[0]?.message).toContain('7 days');
    expect(low[0]?.message).toContain('set to 7');

    // Raising the value beyond the default keeps history -> stay quiet.
    storage.writeText('.claude/settings.json', JSON.stringify({ cleanupPeriodDays: 3650 }));
    expect(runWithStorage(collectClaudeRetentionWarnings, storage)).toHaveLength(0);
  });

  test('reports unverifiable retention instead of claiming the default when settings cannot be read', () => {
    // Settings that exist but do not parse leave retention unknown; claiming
    // "unset -> 30-day default" here would be a false positive.
    const unparsable = new TestMemoryStorage();
    unparsable.writeText('.claude/settings.json', 'not-json');
    const parseFailure = runWithStorage(collectClaudeRetentionWarnings, unparsable);
    expect(parseFailure).toHaveLength(1);
    expect(parseFailure[0]?.message).toContain('could not be verified');
    expect(parseFailure[0]?.message).not.toContain('is unset, so');

    // Same when the read itself fails (permissions, size budget, …).
    const unreadable = new TestMemoryStorage();
    unreadable.writeText(
      '.claude/settings.json',
      JSON.stringify({ cleanupPeriodDays: 3650, padding: 'x'.repeat(2 * 1024 * 1024) }),
    );
    const readFailure = runWithStorage(collectClaudeRetentionWarnings, unreadable);
    expect(readFailure).toHaveLength(1);
    expect(readFailure[0]?.message).toContain('could not be verified');
  });

  test('collects OpenCode Usage rows through SQLite fixture storage', () => {
    const storage = new TestMemoryStorage();
    writeOpenCodeLegacyDatabase(storage, OPENCODE_DB, {
      sessions: [
        {
          id: 'session-1',
          parent_id: 'parent-session',
          title: 'Build usage report',
          directory: '/work/ai-usage',
          summary_additions: 12,
          summary_deletions: 3,
        },
      ],
      tools: [{ session_id: 'session-1', message_id: 'assistant-1', n: 2 }],
      turns: [{ session_id: 'session-1', message_id: 'user-1' }],
      messages: [
        assistantRow('assistant-1', 'session-1', {
          completed: '2026-01-01T00:01:00.000Z',
          cost: 0.12,
          created: '2026-01-01T00:00:00.000Z',
          model_id: 'gpt-5.3',
          provider_id: 'openai',
          token_cache_read: 30,
          token_cache_write: 4,
          token_input: 100,
          token_output: 20,
          token_reasoning: 5,
        }),
      ],
    });

    const rows = runWithStorage(collectOpenCode, storage);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.harness).toBe('OpenCode');
    expect(rows[0]?.provider).toBe('OpenAI API');
    expect(rows[0]?.project).toBe('ai-usage');
    expect(rows[0]?.titleSource).toBe('ai');
    expect(rows[0]?.origin).toBe('subagent');
    expect(rows[0]?.source?.parentSourceSessionId).toBe('parent-session');
    expect(rows[0]?.tokOut).toBe(25);
    expect(rows[0]?.costActual).toBe(0.12);
    expect(rows[0]?.durationMs).toBe(60_000);
    expect(rows[0]?.models).toEqual(['openai/gpt-5.3']);
    expect(rows[0]?.turns).toBe(1);
    expect(rows[0]?.tools).toBe(2);
    expect(rows[0]?.linesAdded).toBe(12);
  });

  test('preserves OpenCode provider/model chronology and separates active time from pauses', () => {
    const storage = new TestMemoryStorage();
    const assistant = (id: string, columns: Omit<OpenCodeMessageFixture, 'id' | 'session_id'>) =>
      assistantRow(id, 'mixed-session', columns);
    writeOpenCodeLegacyDatabase(storage, OPENCODE_DB, {
      sessions: [
        {
          id: 'mixed-session',
          parent_id: null,
          title: 'Mixed providers',
          directory: '/work/ai-usage',
          summary_additions: 0,
          summary_deletions: 0,
        },
      ],
      turns: [
        { session_id: 'mixed-session', message_id: 'user-1' },
        { session_id: 'mixed-session', message_id: 'user-2' },
      ],
      messages: [
        assistant('assistant-1', {
          completed: '2026-02-01T00:01:00.000Z',
          cost: 0,
          created: '2026-02-01T00:00:00.000Z',
          model_id: 'gpt-5',
          provider_id: 'openai',
          token_input: 1_100_000,
          token_output: 0,
        }),
        assistant('assistant-2', {
          completed: '2026-02-01T01:01:00.000Z',
          cost: 1,
          created: '2026-02-01T01:00:00.000Z',
          model_id: 'claude-sonnet-4-5',
          provider_id: 'anthropic',
          token_input: 1_000_000,
          token_output: 0,
        }),
        assistant('assistant-3', {
          cost: 0,
          created: '2026-02-01T02:00:00.000Z',
          model_id: 'gpt-5',
          provider_id: 'openai',
          token_input: 200_000,
          token_output: 0,
        }),
        assistant('assistant-4', {
          cost: 0,
          created: '2026-02-01T03:00:00.000Z',
          model_id: 'unpriced-zero-token-model',
          provider_id: 'local',
          token_input: 0,
          token_output: 0,
        }),
        assistant('assistant-5', {
          cost: 0,
          created: '2026-02-01T04:00:00.000Z',
          model_id: 'unpriced-token-model',
          provider_id: 'local',
          token_cache_read: 4,
          token_cache_write: 5,
          token_input: 7,
          token_output: 2,
          token_reasoning: 1,
        }),
      ],
    });

    const [row] = runWithStorage(collectOpenCode, storage);

    expect(row?.origin).toBeUndefined();
    expect(row?.originProvenance).toBe('origin-absent');
    expect(row?.model).toBe('openai/gpt-5');
    expect(row?.models).toEqual([
      'openai/gpt-5',
      'anthropic/claude-sonnet-4-5',
      'local/unpriced-zero-token-model',
      'local/unpriced-token-model',
    ]);
    expect(row?.modelSegments).toEqual([
      {
        costApprox: 1.625,
        costKnown: true,
        model: 'openai/gpt-5',
        tokCr: 0,
        tokCw: 0,
        tokIn: 1_300_000,
        tokOut: 0,
      },
      {
        costApprox: 3,
        costKnown: true,
        model: 'anthropic/claude-sonnet-4-5',
        tokCr: 0,
        tokCw: 0,
        tokIn: 1_000_000,
        tokOut: 0,
      },
      {
        costApprox: 0,
        costKnown: true,
        model: 'local/unpriced-zero-token-model',
        tokCr: 0,
        tokCw: 0,
        tokIn: 0,
        tokOut: 0,
      },
      {
        costApprox: 0,
        costKnown: false,
        model: 'local/unpriced-token-model',
        tokCr: 4,
        tokCw: 5,
        tokIn: 7,
        tokOut: 3,
      },
    ]);
    expect(row?.provider).toBe('Codex sub (OC)');
    expect(row?.costActual).toBe(1);
    expect(row?.costApprox).toBeCloseTo(4.625, 8);
    expect(row?.costKnown).toBe(false);
    expect(row).toMatchObject({ tokCr: 4, tokCw: 5, tokIn: 2_300_007, tokOut: 3 });
    expect(row?.durationMs).toBe(120_000);
    expect(row?.partial).toBe(true);
    expect(row?.turns).toBe(2);
  });

  test('classifies OpenCode generic titles as technical id fallbacks', () => {
    expect(classifyOpenCodeTitle(null, 'session-abcdef').source).toBe('id');
    expect(classifyOpenCodeTitle('  New   session... ', 'session-abcdef')).toEqual({
      name: 'session-ab',
      source: 'id',
    });
    expect(classifyOpenCodeTitle('New session …', 'session-abcdef')).toEqual({
      name: 'session-ab',
      source: 'id',
    });
    expect(classifyOpenCodeTitle('ACP', 'session-abcdef')).toEqual({ name: 'ACP session', source: 'id' });
    expect(classifyOpenCodeTitle('ACP session', 'session-abcdef')).toEqual({ name: 'ACP session', source: 'id' });
    expect(classifyOpenCodeTitle('Build usage report', 'session-abcdef')).toEqual({
      name: 'Build usage report',
      source: 'ai',
    });
  });

  test('collects OpenCode sessions from stable.db without duplicating live.db sessions', () => {
    const storage = new TestMemoryStorage();

    const liveSession = {
      id: 'live-1',
      title: 'Live session',
      directory: '/work/ai-usage',
      summary_additions: 5,
      summary_deletions: 1,
    };
    const stableSession = {
      id: 'stable-1',
      title: 'Stable session',
      directory: '/work/other',
      summary_additions: 3,
      summary_deletions: 0,
    };

    writeOpenCodeLegacyDatabase(storage, OPENCODE_DB, {
      sessions: [liveSession],
      tools: [{ session_id: 'live-1', message_id: 'live-assistant', n: 1 }],
      turns: [{ session_id: 'live-1', message_id: 'live-user' }],
      messages: [
        assistantRow('live-assistant', 'live-1', {
          completed: '2026-02-01T00:01:00.000Z',
          cost: 0.05,
          created: '2026-02-01T00:00:00.000Z',
          model_id: 'claude-4',
          provider_id: 'anthropic',
          token_cache_read: 5,
          token_cache_write: 1,
          token_input: 50,
          token_output: 10,
        }),
      ],
    });

    writeOpenCodeLegacyDatabase(storage, OPENCODE_STABLE_DB, {
      sessions: [stableSession],
      tools: [{ session_id: 'stable-1', message_id: 'stable-assistant', n: 3 }],
      turns: [{ session_id: 'stable-1', message_id: 'stable-user' }],
      messages: [
        assistantRow('stable-assistant', 'stable-1', {
          completed: '2026-01-01T00:02:00.000Z',
          cost: 0,
          created: '2026-01-01T00:00:00.000Z',
          model_id: 'gpt-5',
          provider_id: 'openai',
          token_input: 200,
          token_output: 40,
          token_reasoning: 10,
        }),
      ],
    });

    const rows = runWithStorage(collectOpenCode, storage);

    expect(rows).toHaveLength(2);
    const liveRow = rows.find((r) => r.name === 'Live session');
    const stableRow = rows.find((r) => r.name === 'Stable session');
    expect(liveRow).toBeDefined();
    expect(stableRow).toBeDefined();
    expect(liveRow?.provider).toBe('Anthropic API');
    expect(stableRow?.provider).toBe('Codex sub (OC)');
  });

  test('collects session_v2 usage OpenCode owns and retires sessions the Claude collector counts', () => {
    const storage = new TestMemoryStorage();
    const claudeAgentTurn = {
      cost: 0,
      model_id: 'opus',
      provider_id: 'claude-agent',
      token_cache_read: 30,
      token_cache_write: 4,
      token_input: 100,
      token_output: 20,
      token_reasoning: 5,
      variant: 'implementation',
    };
    writeOpenCodeV2Database(storage, OPENCODE_DB, {
      sessions: [
        {
          id: 'v2-session',
          parent_id: 'v2-parent',
          title: 'Migrate the collector',
          directory: '/work/ai-usage',
          summary_additions: 8,
          summary_deletions: 2,
        },
        {
          id: 'claude-agent-session',
          title: 'Claude Agent SDK through OpenCode',
          directory: '/work/ai-usage',
          summary_additions: 3,
          summary_deletions: 0,
        },
      ],
      // The Claude Agent SDK turn's tool calls are in the Claude transcript too.
      tools: [
        { session_id: 'v2-session', message_id: 'v2-assistant-1', n: 3 },
        { session_id: 'v2-session', message_id: 'v2-assistant-2', n: 1 },
        { session_id: 'claude-agent-session', message_id: 'ca-assistant-1', n: 2 },
      ],
      turns: [
        { session_id: 'v2-session', message_id: 'v2-user-1' },
        { session_id: 'v2-session', message_id: 'v2-user-2' },
        { session_id: 'claude-agent-session', message_id: 'ca-user-1' },
      ],
      messages: [
        assistantRow('v2-assistant-1', 'v2-session', {
          ...claudeAgentTurn,
          completed: 1_793_000_060_000,
          created: 1_793_000_000_000,
        }),
        assistantRow('v2-assistant-2', 'v2-session', {
          completed: 1_793_000_130_000,
          cost: 0,
          created: 1_793_000_120_000,
          model_id: 'gpt-6.1-sol',
          provider_id: 'openai',
          token_cache_read: 0,
          token_cache_write: 0,
          token_input: 10,
          token_output: 2,
          token_reasoning: 0,
          variant: 'high',
        }),
        assistantRow('ca-assistant-1', 'claude-agent-session', {
          ...claudeAgentTurn,
          completed: 1_793_100_060_000,
          created: 1_793_100_000_000,
        }),
      ],
    });

    const result = runWithStorage(collectOpenCodeResult, storage);
    const rows = result.rows;

    // The mixed session keeps the usage OpenCode owns and says it is a lower bound.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.harness).toBe('OpenCode');
    expect(rows[0]?.name).toBe('Migrate the collector');
    expect(rows[0]?.origin).toBe('subagent');
    expect(rows[0]?.source?.parentSourceSessionId).toBe('v2-parent');
    expect(rows[0]?.model).toBe('openai/gpt-6.1-sol');
    expect(rows[0]?.models).toEqual(['openai/gpt-6.1-sol']);
    expect(rows[0]?.provider).toBe('Codex sub (OC)');
    expect(rows[0]).toMatchObject({
      calls: 1,
      partial: true,
      tokCr: 0,
      tokCw: 0,
      tokIn: 10,
      tokOut: 2,
      tools: 1,
      turns: 2,
    });
    expect(rows[0]?.durationMs).toBe(10_000);
    expect(rows[0]?.linesAdded).toBe(8);
    expect(rows[0]?.date?.getTime()).toBe(1_793_000_120_000);
    // The session with only Claude Agent SDK turns is observed and retired, not emitted.
    expect(result.retiredSourceSessionIds).toEqual(['claude-agent-session']);
    expect(result.warnings).toEqual([]);
  });

  test('never retires an OpenCode session that another OpenCode database emits as a row', () => {
    const storage = new TestMemoryStorage();
    writeOpenCodeV2Database(storage, OPENCODE_DB, {
      sessions: [{ id: 'both', title: 'Live copy', directory: '/work', summary_additions: 0, summary_deletions: 0 }],
      messages: [
        assistantRow('live-claude', 'both', {
          cost: 0,
          created: 1_793_000_000_000,
          model_id: 'opus',
          provider_id: 'claude-agent',
          token_input: 5,
          token_output: 1,
        }),
      ],
    });
    writeOpenCodeLegacyDatabase(storage, OPENCODE_STABLE_DB, {
      sessions: [{ id: 'both', title: 'Stable copy', directory: '/work', summary_additions: 0, summary_deletions: 0 }],
      messages: [
        assistantRow('stable-openai', 'both', {
          cost: 0,
          created: 1_780_000_000_000,
          model_id: 'gpt-5.5',
          provider_id: 'openai',
          token_input: 9,
          token_output: 2,
        }),
      ],
    });

    const result = runWithStorage(collectOpenCodeResult, storage);

    expect(result.rows.map((row) => row.source?.sourceSessionId)).toEqual(['both']);
    expect(result.rows[0]).toMatchObject({ calls: 1, provider: 'Codex sub (OC)', tokIn: 9 });
    expect(result.retiredSourceSessionIds).toEqual([]);
  });

  test('reads session_v2 and the legacy session table once per session and once per message', () => {
    const storage = new TestMemoryStorage();
    writeOpenCodeSchema(storage, OPENCODE_DB, [...OPENCODE_LEGACY_TABLES, ...OPENCODE_V2_TABLES]);
    const migrated = {
      completed: 1_780_000_010_000,
      cost: 0,
      created: 1_780_000_000_000,
      model_id: 'gpt-5.3-codex',
      provider_id: 'openai',
      token_input: 100,
      token_output: 10,
    };
    writeOpenCodeV2Tables(storage, OPENCODE_DB, {
      sessions: [
        {
          id: 'shared',
          title: 'Shared (v2 title)',
          directory: '/work/shared',
          summary_additions: 5,
          summary_deletions: 5,
        },
        { id: 'v2-only', title: 'Only in v2', directory: '/work/v2', summary_additions: 1, summary_deletions: 0 },
      ],
      tools: [{ session_id: 'shared', message_id: 'shared-migrated', n: 2 }],
      turns: [{ session_id: 'shared', message_id: 'shared-user' }],
      messages: [
        assistantRow('shared-migrated', 'shared', migrated),
        assistantRow('v2-only-assistant', 'v2-only', {
          cost: 0,
          created: 1_790_000_000_000,
          model_id: 'minimax-m3',
          provider_id: 'opencode-go',
          token_input: 7,
          token_output: 3,
        }),
      ],
    });
    writeOpenCodeLegacyTables(storage, OPENCODE_DB, {
      sessions: [
        {
          id: 'shared',
          title: 'Shared (legacy title)',
          directory: '/work/shared',
          summary_additions: 0,
          summary_deletions: 0,
        },
        {
          id: 'legacy-only',
          title: 'Only in legacy',
          directory: '/work/legacy',
          summary_additions: 2,
          summary_deletions: 1,
        },
      ],
      // The migrated message keeps its legacy tool parts and user turn; only the
      // legacy-only message and turn add to the session.
      tools: [
        { session_id: 'shared', message_id: 'shared-migrated', n: 2 },
        { session_id: 'shared', message_id: 'shared-legacy-only', n: 1 },
        { session_id: 'legacy-only', message_id: 'legacy-assistant', n: 4 },
      ],
      turns: [
        { session_id: 'shared', message_id: 'shared-user' },
        { session_id: 'shared', message_id: 'shared-legacy-user' },
        { session_id: 'legacy-only', message_id: 'legacy-user' },
      ],
      messages: [
        assistantRow('shared-migrated', 'shared', migrated),
        assistantRow('shared-legacy-only', 'shared', {
          ...migrated,
          completed: 1_779_000_005_000,
          created: 1_779_000_000_000,
          token_input: 50,
          token_output: 5,
        }),
        assistantRow('legacy-assistant', 'legacy-only', {
          completed: 1_770_000_001_000,
          cost: 0.5,
          created: 1_770_000_000_000,
          model_id: 'claude-sonnet-4-5',
          provider_id: 'anthropic',
          token_input: 20,
          token_output: 4,
        }),
      ],
    });

    const rows = runWithStorage(collectOpenCode, storage);
    const byId = new Map(rows.map((row) => [row.source?.sourceSessionId, row]));

    expect([...byId.keys()].sort()).toEqual(['legacy-only', 'shared', 'v2-only']);
    const shared = byId.get('shared');
    expect(shared?.name).toBe('Shared (v2 title)');
    expect(shared?.linesAdded).toBe(5);
    // The migrated message is counted once; the legacy-only message is added.
    expect(shared).toMatchObject({ calls: 2, tokIn: 150, tokOut: 15, tools: 3, turns: 2 });
    expect(shared?.date?.getTime()).toBe(1_779_000_000_000);
    expect(byId.get('legacy-only')).toMatchObject({
      calls: 1,
      provider: 'Anthropic API',
      tokIn: 20,
      tools: 4,
      turns: 1,
    });
    expect(byId.get('v2-only')).toMatchObject({ calls: 1, provider: 'OpenCode Go', tokIn: 7 });
  });

  test('warns instead of returning no OpenCode sessions when neither known schema is present', () => {
    const storage = new TestMemoryStorage();
    writeOpenCodeSchema(storage, OPENCODE_DB, ['kv', 'project']);

    const result = runWithStorage(collectOpenCodeResult, storage);
    const selected = runWithStorage(
      collectSelectedHarnessResults({ harness: 'opencode', includeCursor: false }),
      storage,
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.harness).toBe('opencode');
    expect(result.warnings[0]?.operation).toBe('opencode.schema');
    expect(result.warnings[0]?.message).toContain('Failed to read OpenCode live database');
    expect(result.warnings[0]?.message).toContain('session_v2');
    expect(result.observationCompleteness.invocation.truncated).toBe(true);
    expect(selected.harnesses.find((harness) => harness.harness === 'opencode')?.status).toBe('warning');
  });

  test('collects Cursor partial Usage rows through SQLite fixture storage', () => {
    const storage = new TestMemoryStorage();
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_COMPOSER_SQL, [
      {
        key: 'composerData:composer-1',
        value: JSON.stringify({
          name: 'Fix UI',
          isAgentic: true,
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
    expect(rows[0]?.titleSource).toBe('ai');
    expect(rows[0]?.origin).toBeUndefined();
    expect(rows[0]?.originProvenance).toBe('origin-unsupported');
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
    expect(rows[0]?.titleSource).toBe('ai');
    expect(rows[0]?.usageUnavailable).toBe(true);
    expect(rows[0]?.tokIn).toBe(0);
    expect(rows[0]?.costActual).toBeNull();
    expect(rows[0]?.costKnown).toBe(false);
    expect(rows[0]?.turns).toBe(2);
    expect(rows[0]?.linesAdded).toBe(9);
    expect(rows[0]?.date?.toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });

  test('ingests Cursor CSV through the Cursor harness before publishing rows', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_COMPOSER_SQL, [
      {
        key: 'composerData:tokenless',
        value: JSON.stringify({
          name: 'Refactor agent loop',
          modelConfig: { modelName: 'gpt-5.3' },
          createdAt: Date.parse('2026-06-03T09:00:00.000Z'),
          totalLinesAdded: 9,
          totalLinesRemoved: 4,
        }),
      },
    ]);
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_TOKEN_SQL, [
      {
        key: 'bubbleId:tokenless:assistant-1',
        value: JSON.stringify({ tokenCount: { inputTokens: 0, outputTokens: 0 } }),
      },
    ]);
    storage.writeDatabaseRows(CURSOR_DB, CURSOR_USER_SQL, [
      { key: 'bubbleId:tokenless:user-1', value: JSON.stringify({ type: 1, text: 'Refactor the agent loop' }) },
    ]);
    storage.writeText(
      'cursor.csv',
      cursorCsv([
        '"2026-06-03T09:00:57.773Z","alex@example.com","","","Included","claude-opus-4-8-thinking-high","No","20","10","100","5","135","1.50"',
        '"2026-06-03T12:00:00.000Z","alex@example.com","","","On-Demand","claude-4.5-sonnet","No","0","7","50","3","60","0.40"',
      ]),
    );

    const result = runWithStorage(
      collectSelectedHarnessResults({
        harness: 'cursor',
        includeCursor: true,
        keepSource: true,
        cursorCsv: { usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'alex@example.com' },
      }),
      storage,
    );
    const rows = result.rows as Array<
      (typeof result.rows)[number] & {
        source?: { artifactPath?: string | null; sourcePath?: string | null; sourceSessionId: string | null };
      }
    >;

    expect(rows).toHaveLength(2);
    const matched = rows.find((row) => row.source?.sourceSessionId === 'tokenless');
    const orphan = rows.find((row) => row.name.startsWith('Cursor export'));

    expect(matched?.usageUnavailable).toBeUndefined();
    expect(matched?.model).toBe('claude-opus-4-8-thinking-high');
    expect(matched?.tokIn).toBe(10);
    expect(matched?.tokCw).toBe(20);
    expect(matched?.tokCr).toBe(100);
    expect(matched?.tokOut).toBe(5);
    expect(matched?.modelSegments).toEqual([
      {
        model: 'claude-opus-4-8-thinking-high',
        tokIn: 10,
        tokOut: 5,
        tokCr: 100,
        tokCw: 20,
        costApprox: 0.000_35,
        costKnown: true,
      },
    ]);
    expect(matched?.costApprox).toBe(0.000_35);
    expect(matched?.costKnown).toBe(true);
    expect(matched?.costQuota).toBe(1.5);
    expect(matched?.linesAdded).toBe(9);
    expect(orphan?.source?.artifactPath).toBe(exportPath);
    expect(orphan?.source?.sourcePath).toBeUndefined();
    expect(orphan?.costActual).toBe(0.4);
    expect(result.harnesses.find((harness) => harness.harness === 'cursor')?.rows).toHaveLength(2);
  });

  test('keeps Cursor CSV import when Cursor database read fails', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeText(CURSOR_DB, '');
    storage.writeText(
      'cursor.csv',
      cursorCsv([
        '"2026-06-03T12:00:00.000Z","alex@example.com","","","On-Demand","claude-4.5-sonnet","No","0","7","50","3","60","0.40"',
      ]),
    );

    const result = runWithStorage(
      collectSelectedHarnessResults({
        harness: 'cursor',
        includeCursor: true,
        keepSource: true,
        cursorCsv: { usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'alex@example.com' },
      }),
      storage,
    );
    const cursor = result.harnesses.find((harness) => harness.harness === 'cursor');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.harness).toBe('Cursor');
    expect(result.rows[0]?.costActual).toBe(0.4);
    expect(cursor?.status).toBe('warning');
    expect(cursor?.warnings[0]?.message).toContain('Failed to read Cursor database');
  });
});
