import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import {
  createOpenCodeUnknownSchemaDatabase,
  OPENCODE_V2_FIXTURE_SKILL_DIR,
  seedOpenCodeV2Scenario,
} from '@ai-usage/local-machine/testing/opencode-v2-database';
import { Effect } from 'effect';
import { collectCursorResult } from './collectors/cursor';
import { collectOpenCodeResult } from './collectors/opencode';

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
    const scenario = await seedOpenCodeV2Scenario(home);
    const t0 = scenario.times.v2ContentStartMs;

    const result = await runAtHome(home, collectOpenCodeResult);
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === scenario.ids.v2Content);

    // The malformed assistant row is the only rejected record; non-object
    // content items, idle, synthetic and compaction rows are not metrics.
    expect(result.warnings.map((warning) => warning.operation)).toEqual(['metricValidation']);
    expect(result.warnings[0]?.rejectedRecords).toBe(1);
    expect(row?.name).toBe('Real session_v2 fixture');
    expect(row?.provider).toBe('Codex sub (OC)');
    expect(row?.models).toEqual(['openai/gpt-6.1-sol']);
    expect(row).toMatchObject({
      calls: 3,
      durationMs: 71_000,
      linesAdded: 4,
      partial: false,
      tokCr: 20,
      tokCw: 4,
      tokIn: 56,
      tokOut: 17,
      tools: 3,
      turns: 1,
    });
    expect(row?.date?.toISOString()).toBe(new Date(t0 + 10_000).toISOString());
    expect(row?.endDate?.toISOString()).toBe(new Date(t0 + 111_000).toISOString());
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      harnessKey: 'opencode',
      observationKey: 'call_skill',
      observedAt: new Date(t0 + 12_000).toISOString(),
      projectPath: '/work/fixture',
      resolvedPath: OPENCODE_V2_FIXTURE_SKILL_DIR,
      sessionId: scenario.ids.v2Content,
      skillName: 'fixture-skill',
      success: true,
      tier: 'declared',
    });
  });

  test('reads a partially migrated OpenCode database once per session and once per message', async () => {
    const home = await makeHome();
    const scenario = await seedOpenCodeV2Scenario(home);

    const result = await runAtHome(home, collectOpenCodeResult);
    const byId = new Map(result.rows.map((row) => [row.source?.sourceSessionId, row]));

    const { claudeAgentOnly, ...usageSessionIds } = scenario.ids;
    expect([...byId.keys()].sort()).toEqual(Object.values(usageSessionIds).sort());
    // Observed in the database, owned by the Claude collector (ADR 0090).
    expect(result.retiredSourceSessionIds).toEqual([claudeAgentOnly]);
    expect(byId.get(scenario.ids.mixed)).toMatchObject({
      calls: 1,
      models: ['openai/gpt-5.5'],
      name: 'Mixed providers',
      partial: true,
      provider: 'Codex sub (OC)',
      tokCr: 0,
      tokCw: 0,
      tokIn: 12,
      tokOut: 3,
      tools: 1,
      turns: 2,
    });
    expect(byId.get(scenario.ids.shared)).toMatchObject({
      calls: 2,
      durationMs: 10_000,
      linesAdded: 5,
      name: 'Shared (v2 title)',
      provider: 'Codex sub (OC)',
      tokIn: 150,
      tokOut: 15,
      tools: 3,
      turns: 2,
    });
    expect(byId.get(scenario.ids.legacyOnly)).toMatchObject({ calls: 1, name: 'Only in legacy', tokIn: 20, turns: 0 });
    expect(byId.get(scenario.ids.v2Only)).toMatchObject({
      calls: 1,
      name: 'Only in v2',
      provider: 'OpenCode Go',
      tokIn: 7,
    });
  });

  test('reports an OpenCode database without a known session schema instead of returning no rows', async () => {
    const home = await makeHome();
    const databasePath = await createOpenCodeUnknownSchemaDatabase(home);

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
