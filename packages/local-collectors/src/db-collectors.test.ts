import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { collectSelectedHarnessResults, collectSelectedHarnessRows } from './collectors';
import { collectClaude, collectClaudeRetentionWarnings } from './collectors/claude';
import { collectCursor } from './collectors/cursor';
import { classifyOpenCodeTitle, collectOpenCode } from './collectors/opencode';
import { CURSOR_COMMIT_ATTRIBUTION_SQL, collectCursorCommitAttribution } from './facets';
import { LocalHistoryStorage } from './local-history';
import { TestMemoryStorage } from './test-memory-storage';

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

const OPENCODE_DB = '.local/share/opencode/opencode.db';
const OPENCODE_STABLE_DB = '.local/share/opencode/opencode-stable.db';
const OPENCODE_SESSION_SQL =
  'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session';
const OPENCODE_TOOL_SQL = `SELECT session_id, count(*) n FROM part WHERE data LIKE '%"type":"tool"%' GROUP BY session_id`;
const OPENCODE_MESSAGE_SQL = 'SELECT session_id, data FROM message';

const CURSOR_DB = '.config/Cursor/User/globalStorage/state.vscdb';
const CURSOR_AI_TRACKING_DB = '.cursor/ai-tracking/ai-code-tracking.db';
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
    openCodeStorage.writeDatabaseRows(OPENCODE_DB, OPENCODE_SESSION_SQL, [
      { id: 'open-session', title: 'Open session', directory: '/work', summary_additions: 0, summary_deletions: 0 },
    ]);
    openCodeStorage.writeDatabaseRows(OPENCODE_DB, OPENCODE_TOOL_SQL, []);
    openCodeStorage.writeDatabaseRows(OPENCODE_DB, OPENCODE_MESSAGE_SQL, [
      {
        session_id: 'open-session',
        data: JSON.stringify({ role: 'assistant', tokens: { input: 'private-invalid-value' } }),
      },
      {
        session_id: 'open-session',
        data: JSON.stringify({ role: 'assistant', tokens: { input: 10, output: 5 } }),
      },
    ]);
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

  test('reports one failing harness while keeping successful harness rows', () => {
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
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_SESSION_SQL, [
      {
        id: 'broken-opencode',
        title: 'Broken OpenCode DB',
        directory: '/work/opencode',
        summary_additions: 0,
        summary_deletions: 0,
      },
    ]);

    const selection = { harness: null, includeCursor: false, keepSource: true } as const;
    const result = runWithStorage(collectSelectedHarnessResults(selection), storage);
    const flatRows = runWithStorage(collectSelectedHarnessRows(selection), storage);
    const opencode = result.harnesses.find((harness) => harness.harness === 'opencode');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.harness).toBe('Codex');
    expect(flatRows).toHaveLength(1);
    expect(opencode?.status).toBe('warning');
    expect(opencode?.warnings[0]?.message).toContain('Failed to read OpenCode live database');
    expect(result.warnings.some((warning) => warning.harness === 'opencode')).toBe(true);
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
    expect(unavailable?.name).toBe('fait moi un plan pour traiter tous ces findings');
    expect(unavailable?.project).toBe('ai-usage');
    expect(unavailable?.tokIn).toBe(0);
    expect(unavailable?.costActual).toBeNull();
    expect(unavailable?.costKnown).toBe(false);
    expect(unavailable?.turns).toBe(2);
    expect(unavailable?.date?.toISOString()).toBe('2026-04-24T07:17:43.816Z');
    expect(unavailable?.endDate?.toISOString()).toBe('2026-04-24T08:33:07.361Z');
  });

  test('collects Claude title provenance and agent parent lineage from transcript files', () => {
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

    const rows = runWithStorage(collectClaude, storage);
    const parent = rows.find((row) => row.source?.sourceSessionId === 'parent-session');
    const child = rows.find((row) => row.source?.sourceSessionId === 'agent-child');

    expect(parent?.name).toBe('Refresh dashboard UX');
    expect(parent?.titleSource).toBe('ai');
    expect(child?.source?.parentSourceSessionId).toBe('parent-session');
    expect(child?.titleSource).toBe('agent-role');
    expect(child?.subagent).toBe(true);
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
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_SESSION_SQL, [
      {
        id: 'session-1',
        parent_id: 'parent-session',
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
    expect(rows[0]?.titleSource).toBe('ai');
    expect(rows[0]?.source?.parentSourceSessionId).toBe('parent-session');
    expect(rows[0]?.tokOut).toBe(25);
    expect(rows[0]?.costActual).toBe(0.12);
    expect(rows[0]?.turns).toBe(1);
    expect(rows[0]?.tools).toBe(2);
    expect(rows[0]?.linesAdded).toBe(12);
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

    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_SESSION_SQL, [liveSession]);
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_TOOL_SQL, [{ session_id: 'live-1', n: 1 }]);
    storage.writeDatabaseRows(OPENCODE_DB, OPENCODE_MESSAGE_SQL, [
      { session_id: 'live-1', data: JSON.stringify({ role: 'user' }) },
      {
        session_id: 'live-1',
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-4',
          cost: 0.05,
          tokens: { input: 50, output: 10, cache: { read: 5, write: 1 } },
          time: { created: '2026-02-01T00:00:00.000Z', completed: '2026-02-01T00:01:00.000Z' },
        }),
      },
    ]);

    storage.writeDatabaseRows(OPENCODE_STABLE_DB, OPENCODE_SESSION_SQL, [stableSession]);
    storage.writeDatabaseRows(OPENCODE_STABLE_DB, OPENCODE_TOOL_SQL, [{ session_id: 'stable-1', n: 3 }]);
    storage.writeDatabaseRows(OPENCODE_STABLE_DB, OPENCODE_MESSAGE_SQL, [
      { session_id: 'stable-1', data: JSON.stringify({ role: 'user' }) },
      {
        session_id: 'stable-1',
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-5',
          cost: 0,
          tokens: { input: 200, output: 40, reasoning: 10 },
          time: { created: '2026-01-01T00:00:00.000Z', completed: '2026-01-01T00:02:00.000Z' },
        }),
      },
    ]);

    const rows = runWithStorage(collectOpenCode, storage);

    expect(rows).toHaveLength(2);
    const liveRow = rows.find((r) => r.name === 'Live session');
    const stableRow = rows.find((r) => r.name === 'Stable session');
    expect(liveRow).toBeDefined();
    expect(stableRow).toBeDefined();
    expect(liveRow?.provider).toBe('Anthropic API');
    expect(stableRow?.provider).toBe('Codex sub (OC)');
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
    expect(rows[0]?.titleSource).toBe('ai');
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

  test('collects Cursor commit attribution as a separate facet', () => {
    const storage = new TestMemoryStorage();
    storage.writeDatabaseRows(CURSOR_AI_TRACKING_DB, CURSOR_COMMIT_ATTRIBUTION_SQL, [
      {
        commitHash: 'abc123',
        branchName: 'main',
        scoredAt: Date.parse('2026-03-10T00:00:00.000Z'),
        linesAdded: 10,
        linesDeleted: 2,
        tabLinesAdded: 1,
        tabLinesDeleted: 0,
        composerLinesAdded: 3,
        composerLinesDeleted: 1,
        humanLinesAdded: 4,
        humanLinesDeleted: 1,
        blankLinesAdded: 2,
        blankLinesDeleted: 0,
        commitMessage: 'add cursor facet',
        commitDate: 'Tue Mar 10 01:00:00 2026 +0100',
        v1AiPercentage: '33.33',
        v2AiPercentage: '41.67',
      },
    ]);

    const rows = runWithStorage(collectCursorCommitAttribution, storage);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitHash).toBe('abc123');
    expect(rows[0]?.composerLinesAdded).toBe(3);
    expect(rows[0]?.v2AiPercentage).toBe(41.67);
    expect(rows[0]?.scoredAt).toBe('2026-03-10T00:00:00.000Z');
  });
});
