import { Database } from 'bun:sqlite';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type HarnessFixtureKey = 'claude' | 'codex' | 'cursor' | 'opencode';

export const HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL = 'PRIVATE_DETAIL_PROMPT_SENTINEL_025';

export interface SeededHarnessHome {
  ids: {
    claude: string;
    codexChild: string;
    codexRoot: string;
    cursor: string;
    opencode: string;
  };
  paths: {
    codexRootRollout: string;
    cursorDatabase: string;
    opencodeDatabase: string;
  };
  seededHarnesses: readonly HarnessFixtureKey[];
}

export interface SeedHarnessHomeOptions {
  codexSessionCount?: number;
  harnesses?: readonly HarnessFixtureKey[];
}

const FIXTURE_IDS = {
  claude: 'claude-fixture-025',
  codexChild: 'codex-child-025',
  codexRoot: 'codex-root-025',
  cursor: 'cursor-fixture-025',
  opencode: 'opencode-fixture-025',
} as const;

const jsonLines = (...events: readonly unknown[]): string =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const ensureParent = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

const writeClaudeFixture = async (home: string): Promise<void> => {
  const filePath = join(home, '.claude', 'projects', '-work-fixture', `${FIXTURE_IDS.claude}.jsonl`);
  await ensureParent(filePath);
  await writeFile(
    filePath,
    jsonLines(
      {
        type: 'user',
        timestamp: '2026-07-01T08:00:00.000Z',
        message: { role: 'user', content: 'Build the fixture report' },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-01T08:01:00.000Z',
        cwd: '/work/fixture',
        requestId: 'claude-request-1',
        message: {
          id: 'claude-message-1',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', name: 'Read' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
      },
      {
        type: 'user',
        timestamp: '2026-07-01T08:02:00.000Z',
        message: { role: 'user', content: 'Add the golden assertions' },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-01T08:04:00.000Z',
        cwd: '/work/fixture',
        requestId: 'claude-request-2',
        message: {
          id: 'claude-message-2',
          model: 'claude-opus-4-1',
          content: [{ type: 'text', text: 'Done' }],
          usage: {
            input_tokens: 40,
            output_tokens: 15,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
        },
      },
    ),
  );
};

const codexUsage = (input: number, cached: number, output: number) => ({
  total_tokens: input + output,
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
});

const codexSessionEvents = (
  id: string,
  start: string,
  options: { abortSecond?: boolean; child?: boolean; prompt: string },
): readonly unknown[] => {
  const startMs = Date.parse(start);
  const turnOneStart = new Date(startMs + 10_000).toISOString();
  const turnOneEnd = new Date(startMs + 70_000).toISOString();
  const turnTwoStart = new Date(startMs + 120_000).toISOString();
  const turnTwoEnd = new Date(startMs + 180_000).toISOString();
  return [
    {
      timestamp: start,
      type: 'session_meta',
      payload: {
        id,
        cwd: '/work/fixture',
        ...(options.child
          ? { source: { subagent: { thread_spawn: { parent_thread_id: FIXTURE_IDS.codexRoot } } } }
          : {}),
      },
    },
    { timestamp: turnOneStart, payload: { type: 'task_started', turn_id: `${id}-turn-1` } },
    {
      timestamp: new Date(startMs + 10_010).toISOString(),
      type: 'turn_context',
      payload: { model: options.child ? 'gpt-5.6-terra' : 'gpt-5.6-sol', turn_id: `${id}-turn-1` },
    },
    {
      timestamp: new Date(startMs + 10_020).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: options.prompt },
    },
    {
      timestamp: new Date(startMs + 40_000).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: codexUsage(80, 30, 20) } },
    },
    {
      timestamp: new Date(startMs + 50_000).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: '{}',
        internal_chat_message_metadata_passthrough: { turn_id: `${id}-turn-1` },
      },
    },
    {
      timestamp: turnOneEnd,
      payload: { type: 'task_complete', turn_id: `${id}-turn-1`, duration_ms: 60_000 },
    },
    { timestamp: turnTwoStart, payload: { type: 'task_started', turn_id: `${id}-turn-2` } },
    {
      timestamp: new Date(startMs + 120_010).toISOString(),
      type: 'turn_context',
      payload: { model: options.child ? 'gpt-5.6-terra' : 'gpt-5.6-terra', turn_id: `${id}-turn-2` },
    },
    {
      timestamp: new Date(startMs + 120_020).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: options.child ? 'Finish the delegated task' : HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
      },
    },
    {
      timestamp: new Date(startMs + 150_000).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: codexUsage(120, 40, 30) } },
    },
    {
      timestamp: turnTwoEnd,
      payload: {
        ...(options.abortSecond
          ? { completed_at: Math.floor(Date.parse(turnTwoEnd) / 1000), reason: 'interrupted' }
          : {}),
        duration_ms: 60_000,
        type: options.abortSecond ? 'turn_aborted' : 'task_complete',
        turn_id: `${id}-turn-2`,
      },
    },
    ...(options.child
      ? []
      : [
          {
            timestamp: new Date(startMs + 90_000).toISOString(),
            payload: { type: 'task_started', turn_id: `${id}-open-turn` },
          },
          {
            timestamp: new Date(startMs + 90_010).toISOString(),
            type: 'turn_context',
            payload: { model: 'gpt-5.6-terra', turn_id: `${id}-open-turn` },
          },
        ]),
  ];
};

const writeCodexFixture = async (home: string, sessionCount: number): Promise<string> => {
  if (!(Number.isSafeInteger(sessionCount) && sessionCount >= 2)) {
    throw new Error('codexSessionCount must be a safe integer of at least 2');
  }
  const sessionsDirectory = join(home, '.codex', 'sessions', '2026', '07');
  await mkdir(sessionsDirectory, { recursive: true });
  const rootPath = join(sessionsDirectory, `rollout-2026-07-02T09-00-00-${FIXTURE_IDS.codexRoot}.jsonl`);
  const childPath = join(sessionsDirectory, `rollout-2026-07-02T09-10-00-${FIXTURE_IDS.codexChild}.jsonl`);
  await writeFile(
    rootPath,
    jsonLines(
      ...codexSessionEvents(FIXTURE_IDS.codexRoot, '2026-07-02T09:00:00.000Z', {
        abortSecond: true,
        prompt: 'Implement fixture root',
      }),
    ),
  );
  await writeFile(
    childPath,
    jsonLines(
      ...codexSessionEvents(FIXTURE_IDS.codexChild, '2026-07-02T09:10:00.000Z', {
        child: true,
        prompt: 'Implement fixture child',
      }),
    ),
  );
  for (let index = 2; index < sessionCount; index++) {
    const id = `codex-extra-025-${String(index).padStart(3, '0')}`;
    const filePath = join(sessionsDirectory, `${id}.jsonl`);
    await writeFile(
      filePath,
      jsonLines(
        {
          timestamp: `2026-07-03T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
          type: 'session_meta',
          payload: { id, cwd: '/work/fixture-pagination' },
        },
        {
          timestamp: `2026-07-03T10:${String(index % 60).padStart(2, '0')}:01.000Z`,
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: codexUsage(10, 2, 3) } },
        },
      ),
    );
  }
  return rootPath;
};

const writeOpenCodeFixture = async (databasePath: string): Promise<void> => {
  await ensureParent(databasePath);
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, summary_additions INTEGER, summary_deletions INTEGER, time_created INTEGER, time_updated INTEGER)',
    );
    database.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
    database.exec(
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)',
    );
    const insertSession = database.prepare(
      'INSERT INTO session (id, parent_id, title, directory, summary_additions, summary_deletions, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertSession.run(
      FIXTURE_IDS.opencode,
      'opencode-human-parent-025',
      'OpenCode fixture',
      '/work/fixture',
      12,
      3,
      Date.parse('2026-07-04T10:00:00.000Z'),
      Date.parse('2026-07-04T10:02:00.000Z'),
    );
    insertSession.run(
      'opencode-human-parent-025',
      null,
      'Human parent',
      '/work/fixture',
      0,
      0,
      Date.parse('2026-07-04T09:59:00.000Z'),
      Date.parse('2026-07-04T09:59:00.000Z'),
    );
    const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    insertMessage.run(
      'opencode-user-1',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:00.000Z'),
      JSON.stringify({ role: 'user', time: { created: '2026-07-04T10:00:00.000Z' } }),
    );
    insertMessage.run(
      'opencode-assistant-1',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:10.000Z'),
      JSON.stringify({
        role: 'assistant',
        parentID: 'opencode-user-1',
        providerID: 'openai',
        modelID: 'gpt-5',
        cost: 0.25,
        tokens: { input: 50, output: 10, reasoning: 5, cache: { read: 20, write: 4 } },
        time: { created: '2026-07-04T10:00:10.000Z', completed: '2026-07-04T10:01:10.000Z' },
      }),
    );
    insertMessage.run(
      'opencode-assistant-without-tokens',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:15.000Z'),
      JSON.stringify({
        role: 'assistant',
        parentID: 'opencode-user-1',
        providerID: 'openai',
        modelID: 'gpt-5',
        time: { created: '2026-07-04T10:00:15.000Z', completed: '2026-07-04T10:00:16.000Z' },
      }),
    );
    insertMessage.run(
      'opencode-assistant-with-null-tokens',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:16.000Z'),
      JSON.stringify({
        role: 'assistant',
        parentID: 'opencode-user-1',
        providerID: 'openai',
        modelID: 'gpt-5',
        tokens: null,
        time: { created: '2026-07-04T10:00:16.000Z', completed: '2026-07-04T10:00:17.000Z' },
      }),
    );
    insertMessage.run(
      'opencode-user-internal',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:35.000Z'),
      JSON.stringify({ role: 'user', time: { created: '2026-07-04T10:00:35.000Z' } }),
    );
    insertMessage.run(
      'opencode-assistant-2',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:40.000Z'),
      JSON.stringify({
        role: 'assistant',
        parentID: 'opencode-user-internal',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-6',
        cost: 0.5,
        tokens: { input: 30, output: 8, reasoning: 2, cache: { read: 6, write: 1 } },
        time: { created: '2026-07-04T10:00:40.000Z', completed: '2026-07-04T10:01:40.000Z' },
      }),
    );
    insertMessage.run(
      'opencode-assistant-open',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:02:00.000Z'),
      JSON.stringify({
        role: 'assistant',
        parentID: 'opencode-user-missing',
        providerID: 'openai',
        modelID: 'gpt-5',
        cost: 0.1,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
      }),
    );
    const insertPart = database.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
    );
    insertPart.run(
      'opencode-user-part',
      'opencode-user-1',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:00.000Z'),
      JSON.stringify({ type: 'text', text: 'Run the OpenCode fixture' }),
    );
    insertPart.run(
      'opencode-tool-part',
      'opencode-assistant-1',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:30.000Z'),
      JSON.stringify({ type: 'tool', tool: 'bash' }, null, 2),
    );
    insertPart.run(
      'opencode-internal-user-part',
      'opencode-user-internal',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:35.000Z'),
      JSON.stringify({ synthetic: true, text: 'Internal compaction context', type: 'text' }),
    );
    insertPart.run(
      'opencode-internal-part',
      'opencode-assistant-2',
      FIXTURE_IDS.opencode,
      Date.parse('2026-07-04T10:00:50.000Z'),
      JSON.stringify({ type: 'subtask', sessionID: 'opencode-internal-parent-025' }),
    );
  } finally {
    database.close();
  }
};

const writeCursorFixture = async (databasePath: string): Promise<void> => {
  await ensureParent(databasePath);
  const database = new Database(databasePath, { create: true });
  try {
    database.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = database.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
    insert.run(
      `composerData:${FIXTURE_IDS.cursor}`,
      JSON.stringify({
        name: 'Cursor fixture',
        modelConfig: { modelName: 'gpt-5.3' },
        createdAt: Date.parse('2026-07-05T11:00:00.000Z'),
        totalLinesAdded: 9,
        totalLinesRemoved: 2,
      }),
    );
    insert.run(`bubbleId:${FIXTURE_IDS.cursor}:user-1`, JSON.stringify({ type: 1, text: 'Run the Cursor fixture' }));
    insert.run(
      `bubbleId:${FIXTURE_IDS.cursor}:assistant-1`,
      JSON.stringify({ tokenCount: { inputTokens: 25, outputTokens: 7, cacheReadTokens: 5 } }),
    );
  } finally {
    database.close();
  }
};

export const seedHarnessHome = async (
  home: string,
  options: SeedHarnessHomeOptions = {},
): Promise<SeededHarnessHome> => {
  const seededHarnesses = [...(options.harnesses ?? ['claude', 'codex', 'opencode', 'cursor'])];
  if (new Set(seededHarnesses).size !== seededHarnesses.length) {
    throw new Error('harnesses must not contain duplicates');
  }
  const knownHarnesses = new Set<HarnessFixtureKey>(['claude', 'codex', 'cursor', 'opencode']);
  if (!seededHarnesses.every((harness) => knownHarnesses.has(harness))) {
    throw new Error('harnesses contains an unsupported fixture key');
  }
  const paths = {
    codexRootRollout: join(
      home,
      '.codex',
      'sessions',
      '2026',
      '07',
      `rollout-2026-07-02T09-00-00-${FIXTURE_IDS.codexRoot}.jsonl`,
    ),
    cursorDatabase: join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    opencodeDatabase: join(home, '.local', 'share', 'opencode', 'opencode.db'),
  };
  if (seededHarnesses.includes('claude')) {
    await writeClaudeFixture(home);
  }
  if (seededHarnesses.includes('codex')) {
    await writeCodexFixture(home, options.codexSessionCount ?? 2);
  }
  if (seededHarnesses.includes('opencode')) {
    await writeOpenCodeFixture(paths.opencodeDatabase);
  }
  if (seededHarnesses.includes('cursor')) {
    await writeCursorFixture(paths.cursorDatabase);
  }
  return { ids: { ...FIXTURE_IDS }, paths, seededHarnesses };
};

export const appendCodexRootUsage = async (fixture: SeededHarnessHome): Promise<void> => {
  if (!fixture.seededHarnesses.includes('codex')) {
    throw new Error('Cannot append Codex usage: the codex harness was not seeded');
  }
  await appendFile(
    fixture.paths.codexRootRollout,
    jsonLines({
      timestamp: '2026-07-02T09:04:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: codexUsage(150, 50, 40) } },
    }),
  );
};
