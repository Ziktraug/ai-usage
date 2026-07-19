import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { readCodexUsageSessions } from '../codex-history';
import { createLocalHistoryStorage, LocalHistoryStorage } from '../local-history';
import { appendCodexRootUsage, seedHarnessHome } from './harness-home';

const temporaryHomes: string[] = [];

const makeHome = async (): Promise<string> => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-harness-home-'));
  temporaryHomes.push(home);
  return home;
};

afterEach(async () => {
  for (const home of temporaryHomes.splice(0)) {
    await fs.rm(home, { recursive: true, force: true });
  }
});

const integrityCheck = (databasePath: string): string => {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check ?? '';
  } finally {
    database.close();
  }
};

describe('seedHarnessHome', () => {
  test('seeds stable real files for every harness', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home);

    expect(fixture.ids).toEqual({
      claude: 'claude-fixture-025',
      codexChild: 'codex-child-025',
      codexRoot: 'codex-root-025',
      cursor: 'cursor-fixture-025',
      opencode: 'opencode-fixture-025',
    });
    expect(fixture.seededHarnesses).toEqual(['claude', 'codex', 'opencode', 'cursor']);
    expect(await fs.stat(fixture.paths.codexRootRollout)).toBeDefined();
    expect(integrityCheck(fixture.paths.opencodeDatabase)).toBe('ok');
    expect(integrityCheck(fixture.paths.cursorDatabase)).toBe('ok');
  });

  test('honors a Codex-only subset without creating other artifacts', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['codex'] });

    expect(fixture.seededHarnesses).toEqual(['codex']);
    expect(await fs.exists(path.join(home, '.claude'))).toBe(false);
    expect(await fs.exists(fixture.paths.opencodeDatabase)).toBe(false);
    expect(await fs.exists(fixture.paths.cursorDatabase)).toBe(false);
  });

  test('seeds 205 Codex sessions without changing the root scenario', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { codexSessionCount: 205, harnesses: ['codex'] });
    const sessions = await Effect.runPromise(
      readCodexUsageSessions.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
    );

    expect(sessions).toHaveLength(205);
    const root = sessions.find((session) => session.source.sourceSessionId === fixture.ids.codexRoot);
    expect(root).toMatchObject({ durationMs: 120_010, partial: true, turns: 3 });
    expect(root?.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  test('rejects appends when Codex was not seeded', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['claude'] });

    expect(appendCodexRootUsage(fixture)).rejects.toThrow('the codex harness was not seeded');
  });
});
