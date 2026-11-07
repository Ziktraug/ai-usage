import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { Effect } from 'effect';
import { collectCursorResult } from './collectors/cursor';
import { collectOpenCodeResult } from './collectors/opencode';

const OPENCODE_DB_RELATIVE = join('.local', 'share', 'opencode', 'opencode.db');

/**
 * The OpenCode storage after its `session_v2` migration, as a synthetic
 * subset of the real columns: sessions in `session_v2`, messages in
 * `session_message` with the role in `type` and the tool calls embedded in
 * `data.content`; `session_part` exists but is empty. With `legacy`, the
 * pre-migration `session`/`message`/`part` tables are created alongside.
 */
const createOpenCodeV2Database = async (home: string, options: { legacy: boolean }): Promise<Database> => {
  const databasePath = join(home, OPENCODE_DB_RELATIVE);
  await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
  const database = new Database(databasePath, { create: true });
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

const insertV2Session = (
  database: Database,
  session: { directory: string; id: string; model?: object; parentId?: string | null; title: string | null },
  at: number,
) =>
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
      4,
      1,
      session.model ? JSON.stringify(session.model) : null,
      at,
      at + 60_000,
    );

const insertV2Message = (
  database: Database,
  message: { data: string; id: string; seq: number; sessionId: string; type: string },
  at: number,
) =>
  database
    .prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(message.id, message.sessionId, message.type, message.seq, at, at, message.data);

const v2AssistantData = (
  model: { id: string; providerID: string; variant?: string },
  tokens: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } },
  time: { completed?: number; created: number },
  content: unknown,
) => JSON.stringify({ agent: 'build', model, content, finish: 'stop', cost: 0, tokens, time });

const FIXTURE_SKILL_DIR = '/work/fixture/.agents/skills/fixture-skill';

const temporaryHomes: string[] = [];
const CACHE_VERSION_PATTERN = /"version":(\d+)/;

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'ai-usage-db-integration-'));
  temporaryHomes.push(home);
  return home;
};

afterEach(async () => {
  for (const home of temporaryHomes.splice(0)) {
    await rm(home, { force: true, recursive: true });
  }
});

const runAtHome = <A, E>(home: string, effect: Effect.Effect<A, E, LocalHistoryStorage>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))));

describe('real SQLite harness collectors', () => {
  test('collects a nominal multi-model OpenCode session', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['opencode'] });

    const result = await runAtHome(home, collectOpenCodeResult);
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === fixture.ids.opencode);

    expect(result.warnings).toEqual([]);
    expect(row?.models).toEqual(['openai/gpt-5', 'anthropic/claude-sonnet-4-6']);
    expect(row?.modelSegments?.map((segment) => segment.model)).toEqual([
      'openai/gpt-5',
      'anthropic/claude-sonnet-4-6',
    ]);
    expect(row?.endDate?.toISOString()).toBe('2026-07-04T10:02:00.000Z');
    expect(row?.source?.vcs).toEqual({
      branches: [],
      headCommit: null,
      partial: false,
      pullRequests: [],
      repository: {
        host: 'github.com',
        ownerPath: 'fixture/ai-usage',
        provenance: 'local-derived',
        webUrl: 'https://github.com/fixture/ai-usage',
      },
    });
    expect(row?.source?.vcs?.branches).toEqual([]);
    expect(row?.source?.vcs?.headCommit).toBeNull();
    expect(row).toMatchObject({
      calls: 3,
      durationMs: 90_000,
      partial: true,
      tokCr: 29,
      tokCw: 5,
      tokIn: 90,
      tokOut: 28,
      tools: 1,
      turns: 1,
    });
  });

  test('invalidates an OpenCode row cache written at an older version', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['opencode'] });
    await runAtHome(home, collectOpenCodeResult);
    const cachePath = join(home, '.config', 'ai-usage', 'opencode-db-cache.json');
    const currentCache = await readFile(cachePath, 'utf8');
    // Derived from the cache the collector just wrote rather than pinned to a
    // literal: every bump of the cache version is a deliberate invalidation,
    // and this test asserts the invalidation, not the number.
    const currentVersion = Number(CACHE_VERSION_PATTERN.exec(currentCache)?.[1]);
    expect(Number.isSafeInteger(currentVersion)).toBe(true);
    const staleCache = currentCache
      .replace('"name":"OpenCode fixture"', '"name":"stale-cache"')
      .replace('"origin":"subagent"', '"origin":"unknown"')
      .replace(`"version":${currentVersion}`, `"version":${currentVersion - 1}`);
    expect(staleCache).toContain('"name":"stale-cache"');
    expect(staleCache).toContain('"origin":"unknown"');
    expect(staleCache).toContain(`"version":${currentVersion - 1}`);
    await writeFile(cachePath, staleCache);

    const result = await runAtHome(home, collectOpenCodeResult);
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === fixture.ids.opencode);

    expect(row?.name).toBe('OpenCode fixture');
    expect(row?.origin).toBe('subagent');
    expect(row?.originProvenance).toBeUndefined();
    expect(row?.source?.vcs?.repository?.ownerPath).toBe('fixture/ai-usage');
    expect(await readFile(cachePath, 'utf8')).toContain(`"version":${currentVersion}`);
  });

  test('keeps valid OpenCode sessions when joined message and part JSON are malformed', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['opencode'] });
    const database = new Database(fixture.paths.opencodeDatabase);
    database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run('invalid-json', fixture.ids.opencode, Date.parse('2026-07-04T10:00:20.000Z'), '{invalid');
    database
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
      .run(
        'valid-part-for-invalid-message',
        'invalid-json',
        fixture.ids.opencode,
        Date.parse('2026-07-04T10:00:20.000Z'),
        JSON.stringify({ text: 'ignored invalid message', type: 'text' }),
      );
    database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run(
        'valid-user-with-invalid-part',
        fixture.ids.opencode,
        Date.parse('2026-07-04T10:00:21.000Z'),
        JSON.stringify({ role: 'user' }),
      );
    database
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
      .run(
        'invalid-part-json',
        'valid-user-with-invalid-part',
        fixture.ids.opencode,
        Date.parse('2026-07-04T10:00:21.000Z'),
        '{invalid',
      );
    database.close();

    const result = await runAtHome(home, collectOpenCodeResult);
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === fixture.ids.opencode);

    expect(row).toMatchObject({ calls: 3, tokIn: 90, tokOut: 28, turns: 1 });
  });

  test('collects a session_v2 OpenCode session with embedded tool content through a real database', async () => {
    const home = await makeHome();
    const database = await createOpenCodeV2Database(home, { legacy: false });
    const startedAt = Date.parse('2026-11-01T09:00:00.000Z');
    insertV2Session(
      database,
      {
        directory: '/work/fixture',
        id: 'v2-real',
        model: { id: 'opus', providerID: 'claude-agent', variant: 'high' },
        title: 'Real session_v2 fixture',
      },
      startedAt,
    );
    insertV2Message(
      database,
      {
        data: JSON.stringify({ text: 'Run the v2 fixture', time: { created: startedAt } }),
        id: 'v2-user-1',
        seq: 1,
        sessionId: 'v2-real',
        type: 'user',
      },
      startedAt,
    );
    insertV2Message(
      database,
      {
        data: v2AssistantData(
          { id: 'opus', providerID: 'claude-agent', variant: 'high' },
          { cache: { read: 20, write: 4 }, input: 50, output: 10, reasoning: 5 },
          { completed: startedAt + 70_000, created: startedAt + 10_000 },
          [
            { type: 'reasoning', text: 'thinking' },
            {
              id: 'call_read',
              name: 'read',
              state: { status: 'completed' },
              time: { created: startedAt + 11_000 },
              type: 'tool',
            },
            {
              id: 'call_skill',
              name: 'skill',
              state: {
                input: { name: 'fixture-skill' },
                metadata: { dir: FIXTURE_SKILL_DIR, name: 'fixture-skill' },
                status: 'completed',
              },
              time: { completed: startedAt + 13_000, created: startedAt + 12_000 },
              type: 'tool',
            },
            { type: 'text', text: 'done' },
          ],
        ),
        id: 'v2-assistant-1',
        seq: 2,
        sessionId: 'v2-real',
        type: 'assistant',
      },
      startedAt + 10_000,
    );
    // Malformed JSON in an assistant row must not break the embedded-content reads.
    insertV2Message(
      database,
      { data: '{invalid', id: 'v2-assistant-malformed', seq: 3, sessionId: 'v2-real', type: 'assistant' },
      startedAt + 80_000,
    );
    // Valid metrics without a content array: counted as a call, no tools.
    insertV2Message(
      database,
      {
        data: v2AssistantData(
          { id: 'opus', providerID: 'claude-agent' },
          { input: 5, output: 1 },
          { completed: startedAt + 100_000, created: startedAt + 90_000 },
          null,
        ),
        id: 'v2-assistant-2',
        seq: 4,
        sessionId: 'v2-real',
        type: 'assistant',
      },
      startedAt + 90_000,
    );
    insertV2Message(
      database,
      {
        data: JSON.stringify({ outcome: 'succeeded', time: { created: startedAt + 101_000 } }),
        id: 'v2-idle',
        seq: 5,
        sessionId: 'v2-real',
        type: 'idle',
      },
      startedAt + 101_000,
    );
    database.close();

    const result = await runAtHome(home, collectOpenCodeResult);
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === 'v2-real');

    expect(result.warnings.map((warning) => warning.operation)).toEqual(['metricValidation']);
    expect(result.warnings[0]?.rejectedRecords).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(row?.name).toBe('Real session_v2 fixture');
    expect(row?.provider).toBe('Claude sub (OC)');
    expect(row?.models).toEqual(['claude-agent/opus']);
    expect(row).toMatchObject({
      calls: 2,
      durationMs: 70_000,
      partial: false,
      tokCr: 20,
      tokCw: 4,
      tokIn: 55,
      tokOut: 16,
      tools: 2,
      turns: 1,
    });
    expect(row?.date?.toISOString()).toBe('2026-11-01T09:00:10.000Z');
    expect(row?.endDate?.toISOString()).toBe('2026-11-01T09:01:40.000Z');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      harnessKey: 'opencode',
      observationKey: 'call_skill',
      projectPath: '/work/fixture',
      resolvedPath: FIXTURE_SKILL_DIR,
      sessionId: 'v2-real',
      skillName: 'fixture-skill',
      success: true,
      tier: 'declared',
    });
    expect(result.observations[0]?.observedAt).toBe('2026-11-01T09:00:12.000Z');
  });

  test('reads a partially migrated OpenCode database once per session and once per message', async () => {
    const home = await makeHome();
    const database = await createOpenCodeV2Database(home, { legacy: true });
    const at = Date.parse('2026-08-01T08:00:00.000Z');
    const legacyAssistant = (tokens: { input: number; output: number }, created: number) =>
      JSON.stringify({
        cost: 0,
        modelID: 'gpt-5.3-codex',
        providerID: 'openai',
        role: 'assistant',
        time: { completed: created + 5000, created },
        tokens,
      });
    const insertLegacySession = database.prepare(
      'INSERT INTO session (id, parent_id, title, directory, summary_additions, summary_deletions, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertLegacyMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    const insertLegacyPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');

    // "shared": in both session tables; one message migrated to session_message
    // (still present in message/part), one message and one user turn legacy-only.
    insertLegacySession.run('shared', null, 'Shared (legacy title)', '/work/shared', 0, 0, at, at);
    insertV2Session(database, { directory: '/work/shared', id: 'shared', title: 'Shared (v2 title)' }, at);
    insertLegacyMessage.run('shared-user', 'shared', at, JSON.stringify({ role: 'user', time: { created: at } }));
    insertLegacyPart.run('shared-user-part', 'shared-user', 'shared', at, JSON.stringify({ type: 'text', text: 'go' }));
    insertV2Message(
      database,
      {
        data: JSON.stringify({ text: 'go', time: { created: at } }),
        id: 'shared-user',
        seq: 1,
        sessionId: 'shared',
        type: 'user',
      },
      at,
    );
    insertLegacyMessage.run(
      'shared-migrated',
      'shared',
      at + 1000,
      legacyAssistant({ input: 100, output: 10 }, at + 1000),
    );
    insertLegacyPart.run(
      'shared-migrated-tool-1',
      'shared-migrated',
      'shared',
      at + 1000,
      JSON.stringify({ type: 'tool', tool: 'read', callID: 'call_a' }),
    );
    insertLegacyPart.run(
      'shared-migrated-tool-2',
      'shared-migrated',
      'shared',
      at + 1000,
      JSON.stringify({ type: 'tool', tool: 'bash', callID: 'call_b' }),
    );
    insertV2Message(
      database,
      {
        data: v2AssistantData(
          { id: 'gpt-5.3-codex', providerID: 'openai' },
          { input: 100, output: 10 },
          { completed: at + 6000, created: at + 1000 },
          [
            { id: 'call_a', name: 'read', state: { status: 'completed' }, type: 'tool' },
            { id: 'call_b', name: 'bash', state: { status: 'completed' }, type: 'tool' },
          ],
        ),
        id: 'shared-migrated',
        seq: 2,
        sessionId: 'shared',
        type: 'assistant',
      },
      at + 1000,
    );
    insertLegacyMessage.run(
      'shared-legacy-user',
      'shared',
      at + 10_000,
      JSON.stringify({ role: 'user', time: { created: at + 10_000 } }),
    );
    insertLegacyPart.run(
      'shared-legacy-user-part',
      'shared-legacy-user',
      'shared',
      at + 10_000,
      JSON.stringify({ type: 'text', text: 'more' }),
    );
    insertLegacyMessage.run(
      'shared-legacy-only',
      'shared',
      at + 11_000,
      legacyAssistant({ input: 50, output: 5 }, at + 11_000),
    );
    insertLegacyPart.run(
      'shared-legacy-only-tool',
      'shared-legacy-only',
      'shared',
      at + 11_000,
      JSON.stringify({ type: 'tool', tool: 'edit', callID: 'call_c' }),
    );

    // "legacy-only": never migrated.
    insertLegacySession.run(
      'legacy-only',
      null,
      'Only in legacy',
      '/work/legacy',
      2,
      1,
      at - 86_400_000,
      at - 86_400_000,
    );
    insertLegacyMessage.run(
      'legacy-assistant',
      'legacy-only',
      at - 86_400_000,
      legacyAssistant({ input: 20, output: 4 }, at - 86_400_000),
    );

    // "v2-only": created after the migration.
    insertV2Session(database, { directory: '/work/v2', id: 'v2-only', title: 'Only in v2' }, at + 86_400_000);
    insertV2Message(
      database,
      {
        data: v2AssistantData(
          { id: 'minimax-m3', providerID: 'opencode-go' },
          { input: 7, output: 3 },
          { completed: at + 86_401_000, created: at + 86_400_000 },
          [],
        ),
        id: 'v2-only-assistant',
        seq: 1,
        sessionId: 'v2-only',
        type: 'assistant',
      },
      at + 86_400_000,
    );
    database.close();

    const result = await runAtHome(home, collectOpenCodeResult);
    const byId = new Map(result.rows.map((row) => [row.source?.sourceSessionId, row]));

    expect(result.warnings).toEqual([]);
    expect([...byId.keys()].sort()).toEqual(['legacy-only', 'shared', 'v2-only']);
    expect(byId.get('shared')).toMatchObject({
      calls: 2,
      name: 'Shared (v2 title)',
      provider: 'Codex sub (OC)',
      tokIn: 150,
      tokOut: 15,
      tools: 3,
      turns: 2,
    });
    expect(byId.get('legacy-only')).toMatchObject({ calls: 1, name: 'Only in legacy', tokIn: 20, turns: 0 });
    expect(byId.get('v2-only')).toMatchObject({ calls: 1, name: 'Only in v2', provider: 'OpenCode Go', tokIn: 7 });
  });

  test('reports an OpenCode database without a known session schema instead of returning no rows', async () => {
    const home = await makeHome();
    const databasePath = join(home, OPENCODE_DB_RELATIVE);
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
    const database = new Database(databasePath, { create: true });
    database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.close();

    const result = await runAtHome(home, collectOpenCodeResult);

    expect(result.rows).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ harness: 'opencode', operation: 'opencode.schema', path: databasePath });
    expect(result.warnings[0]?.message).toContain('session_v2');
    expect(result.warnings[0]?.message).toContain('kv');
  });

  test('collects partial Cursor composer tokens through a real state database', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['cursor'] });

    const result = await runAtHome(home, collectCursorResult());
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === fixture.ids.cursor);

    expect(result.warnings).toEqual([]);
    expect(row?.source?.vcs).toBeUndefined();
    expect(row).toMatchObject({
      calls: 1,
      model: 'gpt-5.3',
      partial: true,
      tokCr: 5,
      tokCw: 0,
      tokIn: 25,
      tokOut: 7,
      turns: 1,
    });
  });

  test('reconciles Cursor DB and CSV without double counting the DB usage', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['cursor'] });
    const csvPath = join(home, 'cursor-usage.csv');
    await writeFile(
      csvPath,
      [
        'Date,User,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
        '"2026-07-05T11:00:30.000Z","fixture@example.com","","","Included","gpt-5.3","No","0","25","5","7","37","0.20"',
        '"2026-07-05T11:01:30.000Z","fixture@example.com","","","Included","claude-sonnet-4-6","No","2","10","3","4","19","0.10"',
      ].join('\n'),
    );

    const result = await runAtHome(
      home,
      collectCursorResult({
        clusterGapMs: 5 * 60_000,
        reconcileWindowMs: 3 * 60_000,
        usageExportPaths: [csvPath],
        user: 'fixture@example.com',
      }),
    );
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === fixture.ids.cursor);

    expect(result.warnings).toEqual([]);
    expect(row).toMatchObject({ tokCr: 8, tokCw: 2, tokIn: 35, tokOut: 11 });
    expect((row?.tokCr ?? 0) + (row?.tokCw ?? 0) + (row?.tokIn ?? 0) + (row?.tokOut ?? 0)).toBe(56);
    expect(row?.models).toEqual(['gpt-5.3', 'claude-sonnet-4-6']);
  });

  test('rejects Cursor database main and WAL symlink redirection', async () => {
    const mainHome = await makeHome();
    const mainFixture = await seedHarnessHome(mainHome, { harnesses: ['cursor'] });
    const redirectedMainPath = `${mainFixture.paths.cursorDatabase}.redirected`;
    await rename(mainFixture.paths.cursorDatabase, redirectedMainPath);
    await symlink(redirectedMainPath, mainFixture.paths.cursorDatabase);

    const mainResult = await runAtHome(mainHome, collectCursorResult());

    expect(mainResult.rows).toEqual([]);
    expect(mainResult.warnings).toHaveLength(1);
    expect(mainResult.warnings[0]).toMatchObject({
      harness: 'cursor',
      operation: 'sqlite.identity',
      path: mainFixture.paths.cursorDatabase,
    });
    expect(mainResult.warnings[0]?.message).toContain('Failed to read Cursor database');
    expect(mainResult.warnings[0]?.message).not.toContain(mainFixture.ids.cursor);

    const walHome = await makeHome();
    const walFixture = await seedHarnessHome(walHome, { harnesses: ['cursor'] });
    const walPath = `${walFixture.paths.cursorDatabase}-wal`;
    const redirectedWalPath = `${walPath}.redirected`;
    await writeFile(redirectedWalPath, `redirected ${walFixture.ids.cursor}`);
    await symlink(redirectedWalPath, walPath);

    const walResult = await runAtHome(walHome, collectCursorResult());

    expect(walResult.rows).toEqual([]);
    expect(walResult.warnings).toHaveLength(1);
    expect(walResult.warnings[0]).toMatchObject({
      harness: 'cursor',
      operation: 'sqlite.identity',
      path: walPath,
    });
    expect(walResult.warnings[0]?.message).toContain('Failed to read Cursor database');
    expect(walResult.warnings[0]?.message).not.toContain(walFixture.ids.cursor);
  });

  test('rejects OpenCode database main and WAL symlink redirection', async () => {
    const mainHome = await makeHome();
    const mainFixture = await seedHarnessHome(mainHome, { harnesses: ['opencode'] });
    const redirectedMainPath = `${mainFixture.paths.opencodeDatabase}.redirected`;
    await rename(mainFixture.paths.opencodeDatabase, redirectedMainPath);
    await symlink(redirectedMainPath, mainFixture.paths.opencodeDatabase);

    const mainResult = await runAtHome(mainHome, collectOpenCodeResult);

    expect(mainResult.rows).toEqual([]);
    expect(mainResult.observationCompleteness.invocation.truncated).toBe(true);
    expect(mainResult.warnings).toHaveLength(1);
    expect(mainResult.warnings[0]).toMatchObject({
      harness: 'opencode',
      operation: 'sqlite.identity',
      path: mainFixture.paths.opencodeDatabase,
    });
    expect(mainResult.warnings[0]?.message).toContain('Failed to read OpenCode live database');
    expect(mainResult.warnings[0]?.message).not.toContain(mainFixture.ids.opencode);

    const walHome = await makeHome();
    const walFixture = await seedHarnessHome(walHome, { harnesses: ['opencode'] });
    const walPath = `${walFixture.paths.opencodeDatabase}-wal`;
    const redirectedWalPath = `${walPath}.redirected`;
    await writeFile(redirectedWalPath, `redirected ${walFixture.ids.opencode}`);
    await symlink(redirectedWalPath, walPath);

    const walResult = await runAtHome(walHome, collectOpenCodeResult);

    expect(walResult.rows).toEqual([]);
    expect(walResult.observationCompleteness.invocation.truncated).toBe(true);
    expect(walResult.warnings).toHaveLength(1);
    expect(walResult.warnings[0]).toMatchObject({
      harness: 'opencode',
      operation: 'sqlite.identity',
      path: walPath,
    });
    expect(walResult.warnings[0]?.message).toContain('Failed to read OpenCode live database');
    expect(walResult.warnings[0]?.message).not.toContain(walFixture.ids.opencode);
  });
});
