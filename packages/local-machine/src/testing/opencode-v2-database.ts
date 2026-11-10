import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Synthetic OpenCode databases in the storage shape that followed OpenCode's
 * `session_v2` migration: sessions in `session_v2`, messages in
 * `session_message` with the role in `type` and the former parts embedded in
 * `data.content`; `session_part` exists but stays empty. With `legacy`, the
 * pre-migration `session`/`message`/`part` tables are created alongside, as a
 * migrated database keeps them.
 *
 * Every value here is invented; nothing is copied from a real history.
 */

export const OPENCODE_DATABASE_RELATIVE_PATH = join('.local', 'share', 'opencode', 'opencode.db');
export const OPENCODE_V2_FIXTURE_SKILL_DIR = '/work/fixture/.agents/skills/fixture-skill';

export interface OpenCodeV2Scenario {
  databasePath: string;
  ids: {
    /** `session_v2` only; every assistant message is the `claude-agent` provider's, so no usage row (ADR 0090). */
    claudeAgentOnly: string;
    /** Never migrated: legacy tables only, no user message. */
    legacyOnly: string;
    /** `session_v2` only; one `claude-agent` turn and one `openai` turn, so a partial usage row. */
    mixed: string;
    /** In both session tables; one message migrated (present in both message tables), one legacy-only. */
    shared: string;
    /** `session_v2` only, with embedded tool content, a malformed assistant row and non-object content items. */
    v2Content: string;
    /** `session_v2` only, created after the migration, no tool content. */
    v2Only: string;
  };
  times: {
    sharedStartMs: number;
    v2ContentStartMs: number;
  };
}

const openCodeDatabasePath = async (home: string): Promise<string> => {
  const databasePath = join(home, OPENCODE_DATABASE_RELATIVE_PATH);
  await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
  return databasePath;
};

export const createOpenCodeV2Database = async (home: string, options: { legacy: boolean }): Promise<Database> => {
  const database = new Database(await openCodeDatabasePath(home), { create: true });
  database.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
      title TEXT, version TEXT NOT NULL, summary_additions INTEGER, summary_deletions INTEGER, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE session_part (
      message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, type TEXT NOT NULL,
      call_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (message_id, ordinal)
    );
  `);
  if (options.legacy) {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, summary_additions INTEGER,
        summary_deletions INTEGER, time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
  }
  return database;
};

/** A database OpenCode could own but with neither known session schema. */
export const createOpenCodeUnknownSchemaDatabase = async (home: string): Promise<string> => {
  const databasePath = await openCodeDatabasePath(home);
  const database = new Database(databasePath, { create: true });
  try {
    database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  } finally {
    database.close();
  }
  return databasePath;
};

export interface OpenCodeV2SessionFixture {
  directory: string;
  id: string;
  model?: object;
  parentId?: string | null;
  summary?: { additions: number; deletions: number };
  title: string | null;
}

export const insertV2Session = (database: Database, session: OpenCodeV2SessionFixture, at: number): void => {
  database
    .prepare(
      'INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, summary_additions, summary_deletions, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      session.id,
      'project-fixture',
      session.parentId ?? null,
      `slug-${session.id}`,
      session.directory,
      session.title,
      '1.0.0',
      session.summary?.additions ?? null,
      session.summary?.deletions ?? null,
      session.model ? JSON.stringify(session.model) : null,
      at,
      at + 60_000,
    );
};

export interface OpenCodeV2MessageFixture {
  data: string;
  id: string;
  seq: number;
  sessionId: string;
  type: string;
}

export const insertV2Message = (database: Database, message: OpenCodeV2MessageFixture, at: number): void => {
  database
    .prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(message.id, message.sessionId, message.type, message.seq, at, at, message.data);
};

export const v2AssistantData = (
  model: { id: string; providerID: string; variant?: string },
  tokens: { cache?: { read: number; write: number }; input: number; output: number; reasoning?: number },
  time: { completed?: number; created: number },
  content: unknown,
): string => JSON.stringify({ agent: 'build', content, cost: 0, finish: 'stop', model, time, tokens });

const v2UserData = (text: string, createdMs: number): string => JSON.stringify({ text, time: { created: createdMs } });

const legacyAssistantData = (message: {
  cost?: number;
  createdMs: number;
  modelID: string;
  parentID: string | null;
  providerID: string;
  tokens: { input: number; output: number };
}): string =>
  JSON.stringify({
    cost: message.cost ?? 0,
    modelID: message.modelID,
    parentID: message.parentID,
    providerID: message.providerID,
    role: 'assistant',
    time: { completed: message.createdMs + 5000, created: message.createdMs },
    tokens: message.tokens,
  });

/**
 * One migrated OpenCode database with six sessions, written so that the report
 * collector and the on-demand session analysis can be checked against each
 * other. The expected figures per session are documented at the call sites.
 */
export const seedOpenCodeV2Scenario = async (home: string): Promise<OpenCodeV2Scenario> => {
  const database = await createOpenCodeV2Database(home, { legacy: true });
  const v2ContentStartMs = Date.parse('2026-11-01T09:00:00.000Z');
  const sharedStartMs = Date.parse('2026-08-01T08:00:00.000Z');
  const ids = {
    claudeAgentOnly: 'claude-agent-only',
    legacyOnly: 'legacy-only',
    mixed: 'mixed-providers',
    shared: 'shared',
    v2Content: 'v2-real',
    v2Only: 'v2-only',
  };
  try {
    const t0 = v2ContentStartMs;
    const sol = { id: 'gpt-6.1-sol', providerID: 'openai' };
    const solHigh = { ...sol, variant: 'high' };
    insertV2Session(
      database,
      {
        directory: '/work/fixture',
        id: ids.v2Content,
        model: solHigh,
        summary: { additions: 4, deletions: 1 },
        title: 'Real session_v2 fixture',
      },
      t0,
    );
    const v2Content = (message: Omit<OpenCodeV2MessageFixture, 'sessionId'>, at: number) =>
      insertV2Message(database, { ...message, sessionId: ids.v2Content }, at);
    v2Content({ data: v2UserData('Run the v2 fixture', t0), id: 'v2-user-1', seq: 1, type: 'user' }, t0);
    v2Content(
      {
        data: v2AssistantData(
          solHigh,
          { cache: { read: 20, write: 4 }, input: 50, output: 10, reasoning: 5 },
          { completed: t0 + 70_000, created: t0 + 10_000 },
          [
            { text: 'thinking', type: 'reasoning' },
            {
              id: 'call_read',
              name: 'read',
              state: { status: 'completed' },
              time: { created: t0 + 11_000 },
              type: 'tool',
            },
            {
              id: 'call_skill',
              name: 'skill',
              state: {
                input: { name: 'fixture-skill' },
                metadata: { dir: OPENCODE_V2_FIXTURE_SKILL_DIR, name: 'fixture-skill' },
                status: 'completed',
              },
              time: { completed: t0 + 13_000, created: t0 + 12_000 },
              type: 'tool',
            },
            { text: 'done', type: 'text' },
          ],
        ),
        id: 'v2-assistant-1',
        seq: 2,
        type: 'assistant',
      },
      t0 + 10_000,
    );
    // Malformed JSON in an assistant row must not break the embedded-content reads.
    v2Content({ data: '{invalid', id: 'v2-assistant-malformed', seq: 3, type: 'assistant' }, t0 + 80_000);
    // Valid metrics without a content array: counted as a call, no tools.
    v2Content(
      {
        data: v2AssistantData(sol, { input: 5, output: 1 }, { completed: t0 + 100_000, created: t0 + 90_000 }, null),
        id: 'v2-assistant-2',
        seq: 4,
        type: 'assistant',
      },
      t0 + 90_000,
    );
    // Non-prompt rows: the migration gives synthetic and compaction inputs their own type.
    v2Content(
      {
        data: JSON.stringify({ outcome: 'succeeded', time: { created: t0 + 101_000 } }),
        id: 'v2-idle',
        seq: 5,
        type: 'idle',
      },
      t0 + 101_000,
    );
    v2Content(
      {
        data: JSON.stringify({ metadata: { source: 'shell' }, text: 'shell output', time: { created: t0 + 102_000 } }),
        id: 'v2-synthetic',
        seq: 6,
        type: 'synthetic',
      },
      t0 + 102_000,
    );
    v2Content(
      {
        data: JSON.stringify({ status: 'done', summary: 'compacted', time: { created: t0 + 103_000 } }),
        id: 'v2-compaction',
        seq: 7,
        type: 'compaction',
      },
      t0 + 103_000,
    );
    // Non-object content items must be skipped, not fail the statement.
    v2Content(
      {
        data: v2AssistantData(solHigh, { input: 1, output: 1 }, { completed: t0 + 111_000, created: t0 + 110_000 }, [
          'bad',
          42,
          null,
          { id: 'call_bash', name: 'bash', state: { status: 'completed' }, type: 'tool' },
          { text: 'ok', type: 'text' },
        ]),
        id: 'v2-assistant-3',
        seq: 8,
        type: 'assistant',
      },
      t0 + 110_000,
    );

    const insertLegacySession = database.prepare(
      'INSERT INTO session (id, parent_id, title, directory, summary_additions, summary_deletions, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertLegacyMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    const insertLegacyPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
    const toolPart = (id: string, messageId: string, sessionId: string, at: number, tool: string, callID: string) =>
      insertLegacyPart.run(id, messageId, sessionId, at, JSON.stringify({ callID, tool, type: 'tool' }));

    // "shared": one message migrated (kept in message/part too), one legacy-only exchange.
    const a = sharedStartMs;
    const dayMs = 86_400_000;
    insertLegacySession.run(ids.shared, null, 'Shared (legacy title)', '/work/shared', 0, 0, a, a);
    insertV2Session(
      database,
      {
        directory: '/work/shared',
        id: ids.shared,
        summary: { additions: 5, deletions: 5 },
        title: 'Shared (v2 title)',
      },
      a,
    );
    insertLegacyMessage.run('shared-user', ids.shared, a, JSON.stringify({ role: 'user', time: { created: a } }));
    insertLegacyPart.run(
      'shared-user-part',
      'shared-user',
      ids.shared,
      a,
      JSON.stringify({ text: 'go', type: 'text' }),
    );
    insertV2Message(
      database,
      { data: v2UserData('go', a), id: 'shared-user', seq: 1, sessionId: ids.shared, type: 'user' },
      a,
    );
    const codex = { id: 'gpt-5.3-codex', providerID: 'openai' };
    insertLegacyMessage.run(
      'shared-migrated',
      ids.shared,
      a + 1000,
      legacyAssistantData({
        createdMs: a + 1000,
        modelID: codex.id,
        parentID: 'shared-user',
        providerID: codex.providerID,
        tokens: { input: 100, output: 10 },
      }),
    );
    toolPart('shared-migrated-tool-1', 'shared-migrated', ids.shared, a + 1000, 'read', 'call_a');
    toolPart('shared-migrated-tool-2', 'shared-migrated', ids.shared, a + 1000, 'bash', 'call_b');
    // The migration copy keeps the tokens and `created` but stamps `completed`
    // with the migration instant; readers must take the legacy record.
    const migrationStampMs = a + 30 * dayMs;
    insertV2Message(
      database,
      {
        data: v2AssistantData(codex, { input: 100, output: 10 }, { completed: migrationStampMs, created: a + 1000 }, [
          { id: 'call_a', name: 'read', state: { status: 'completed' }, type: 'tool' },
          { id: 'call_b', name: 'bash', state: { status: 'completed' }, type: 'tool' },
        ]),
        id: 'shared-migrated',
        seq: 2,
        sessionId: ids.shared,
        type: 'assistant',
      },
      a + 1000,
    );
    insertLegacyMessage.run(
      'shared-legacy-user',
      ids.shared,
      a + 10_000,
      JSON.stringify({ role: 'user', time: { created: a + 10_000 } }),
    );
    insertLegacyPart.run(
      'shared-legacy-user-part',
      'shared-legacy-user',
      ids.shared,
      a + 10_000,
      JSON.stringify({ text: 'more', type: 'text' }),
    );
    insertLegacyMessage.run(
      'shared-legacy-only',
      ids.shared,
      a + 11_000,
      legacyAssistantData({
        createdMs: a + 11_000,
        modelID: codex.id,
        parentID: 'shared-legacy-user',
        providerID: codex.providerID,
        tokens: { input: 50, output: 5 },
      }),
    );
    toolPart('shared-legacy-only-tool', 'shared-legacy-only', ids.shared, a + 11_000, 'edit', 'call_c');

    // "legacy-only": never migrated, no user message.
    insertLegacySession.run(ids.legacyOnly, null, 'Only in legacy', '/work/legacy', 2, 1, a - dayMs, a - dayMs);
    insertLegacyMessage.run(
      'legacy-assistant',
      ids.legacyOnly,
      a - dayMs,
      legacyAssistantData({
        cost: 0.5,
        createdMs: a - dayMs,
        modelID: 'claude-sonnet-4-5',
        parentID: null,
        providerID: 'anthropic',
        tokens: { input: 20, output: 4 },
      }),
    );

    // "v2-only": created after the migration.
    insertV2Session(
      database,
      { directory: '/work/v2', id: ids.v2Only, summary: { additions: 1, deletions: 0 }, title: 'Only in v2' },
      a + dayMs,
    );
    insertV2Message(
      database,
      {
        data: v2AssistantData(
          { id: 'minimax-m3', providerID: 'opencode-go' },
          { input: 7, output: 3 },
          { completed: a + dayMs + 1000, created: a + dayMs },
          [],
        ),
        id: 'v2-only-assistant',
        seq: 1,
        sessionId: ids.v2Only,
        type: 'assistant',
      },
      a + dayMs,
    );

    // "claude-agent-only": every usage-bearing message belongs to the Claude
    // Agent SDK provider, which the Claude collector already counts (ADR 0090).
    const opus = { id: 'opus', providerID: 'claude-agent' };
    const c0 = t0 + dayMs;
    insertV2Session(
      database,
      {
        directory: '/work/fixture',
        id: ids.claudeAgentOnly,
        model: opus,
        summary: { additions: 9, deletions: 3 },
        title: 'Claude Agent SDK through OpenCode',
      },
      c0,
    );
    const claudeAgentOnly = (message: Omit<OpenCodeV2MessageFixture, 'sessionId'>, at: number) =>
      insertV2Message(database, { ...message, sessionId: ids.claudeAgentOnly }, at);
    claudeAgentOnly({ data: v2UserData('Review the diff', c0), id: 'ca-user-1', seq: 1, type: 'user' }, c0);
    claudeAgentOnly(
      {
        data: v2AssistantData(
          opus,
          { cache: { read: 300, write: 40 }, input: 20, output: 30, reasoning: 10 },
          { completed: c0 + 20_000, created: c0 + 1000 },
          [{ id: 'call_ca_read', name: 'read', state: { status: 'completed' }, type: 'tool' }],
        ),
        id: 'ca-assistant-1',
        seq: 2,
        type: 'assistant',
      },
      c0 + 1000,
    );
    claudeAgentOnly(
      {
        data: v2AssistantData(opus, { input: 2, output: 8 }, { completed: c0 + 40_000, created: c0 + 30_000 }, []),
        id: 'ca-assistant-2',
        seq: 3,
        type: 'assistant',
      },
      c0 + 30_000,
    );

    // "mixed-providers": one Claude Agent SDK turn and one OpenCode-owned turn.
    // Only the second is OpenCode usage; the row stays a lower bound.
    const m0 = c0 + 3_600_000;
    const gpt55 = { id: 'gpt-5.5', providerID: 'openai' };
    insertV2Session(
      database,
      {
        directory: '/work/fixture',
        id: ids.mixed,
        model: gpt55,
        summary: { additions: 2, deletions: 2 },
        title: 'Mixed providers',
      },
      m0,
    );
    const mixed = (message: Omit<OpenCodeV2MessageFixture, 'sessionId'>, at: number) =>
      insertV2Message(database, { ...message, sessionId: ids.mixed }, at);
    mixed({ data: v2UserData('Start with Claude', m0), id: 'mixed-user-1', seq: 1, type: 'user' }, m0);
    mixed(
      {
        data: v2AssistantData(
          opus,
          { cache: { read: 8, write: 2 }, input: 40, output: 9 },
          { completed: m0 + 5000, created: m0 + 1000 },
          [
            { id: 'call_mixed_read', name: 'read', state: { status: 'completed' }, type: 'tool' },
            { id: 'call_mixed_bash', name: 'bash', state: { status: 'completed' }, type: 'tool' },
          ],
        ),
        id: 'mixed-assistant-claude',
        seq: 2,
        type: 'assistant',
      },
      m0 + 1000,
    );
    mixed({ data: v2UserData('Now with GPT', m0 + 10_000), id: 'mixed-user-2', seq: 3, type: 'user' }, m0 + 10_000);
    mixed(
      {
        data: v2AssistantData(gpt55, { input: 12, output: 3 }, { completed: m0 + 14_000, created: m0 + 11_000 }, [
          { id: 'call_mixed_edit', name: 'edit', state: { status: 'completed' }, type: 'tool' },
        ]),
        id: 'mixed-assistant-gpt',
        seq: 4,
        type: 'assistant',
      },
      m0 + 11_000,
    );
  } finally {
    database.close();
  }
  return { databasePath: join(home, OPENCODE_DATABASE_RELATIVE_PATH), ids, times: { sharedStartMs, v2ContentStartMs } };
};
