import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { collectCursorResult } from './collectors/cursor';
import { collectOpenCodeResult } from './collectors/opencode';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { seedHarnessHome } from './test-fixtures/harness-home';

const temporaryHomes: string[] = [];

const makeHome = async (): Promise<string> => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-db-integration-'));
  temporaryHomes.push(home);
  return home;
};

afterEach(async () => {
  for (const home of temporaryHomes.splice(0)) {
    await fs.rm(home, { force: true, recursive: true });
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

  test('ignores an isolated invalid OpenCode JSON row without losing valid neighbors', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['opencode'] });
    const database = new Database(fixture.paths.opencodeDatabase);
    database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run('invalid-json', fixture.ids.opencode, Date.parse('2026-07-04T10:00:20.000Z'), '{invalid');
    database.close();

    const result = await runAtHome(home, collectOpenCodeResult);
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === fixture.ids.opencode);

    expect(row).toMatchObject({ calls: 3, tokIn: 90, tokOut: 28 });
  });

  test('collects partial Cursor composer tokens through a real state database', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['cursor'] });

    const result = await runAtHome(home, collectCursorResult());
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === fixture.ids.cursor);

    expect(result.warnings).toEqual([]);
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
    const csvPath = path.join(home, 'cursor-usage.csv');
    await fs.writeFile(
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
});
