import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL } from './claude-desktop-sessions-fixture';
import { seedHarnessHome } from './harness-home';

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'claude-desktop-fixture-'));
  temporaryHomes.push(home);
  return home;
};

const registryFiles = async (registry: string): Promise<{ name: string; path: string }[]> => {
  const files: { name: string; path: string }[] = [];
  for (const account of await readdir(registry)) {
    for (const organization of await readdir(join(registry, account))) {
      const directory = join(registry, account, organization);
      for (const name of await readdir(directory)) {
        if ((await stat(join(directory, name))).isFile()) {
          files.push({ name, path: join(directory, name) });
        }
      }
    }
  }
  return files;
};

describe('seedHarnessHome claudeDesktopSessions', () => {
  test('is opt-in and leaves the existing fixture untouched by default', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['claude'] });
    expect(fixture.claudeDesktop).toBeNull();
    await expect(stat(join(home, '.config', 'Claude'))).rejects.toThrow();
  });

  test('writes the minimal registry in the attested shape under the fixture home', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { claudeDesktopSessions: 'minimal', harnesses: ['claude'] });
    if (fixture.claudeDesktop === null) {
      throw new Error('expected a seeded Desktop registry');
    }
    expect(fixture.claudeDesktop.variant).toBe('minimal');
    expect(fixture.claudeDesktop.rootCount).toBe(3);
    expect(fixture.claudeDesktop.childCount).toBe(2);
    expect(fixture.claudeDesktop.cliSessionIds.blockedRoot).toBe(fixture.ids.claude);
    const files = await registryFiles(fixture.claudeDesktop.registryDirectory);
    expect(
      files
        .filter(({ name }) => name.startsWith('local_'))
        .map(({ name }) => name)
        .sort(),
    ).toEqual([
      'local_fixture-blocked-child-1.json',
      'local_fixture-blocked-child-2.json',
      'local_fixture-blocked-root.json',
      'local_fixture-completed-root.json',
      'local_fixture-unsupported.json',
    ]);
    const blocked = JSON.parse(
      await readFile(files.find(({ name }) => name === 'local_fixture-blocked-root.json')?.path ?? '', 'utf8'),
    ) as Record<string, unknown>;
    expect(blocked.sessionId).toBe(fixture.claudeDesktop.ids.blockedRoot);
    expect(blocked.cliSessionId).toBe(fixture.ids.claude);
    expect(typeof blocked.createdAt).toBe('number');
    expect(typeof blocked.lastActivityAt).toBe('number');
    expect(blocked.postTurnSummary).toMatchObject({ status_category: 'blocked' });
    expect((blocked.postTurnSummary as { needs_action: string }).needs_action.length).toBeGreaterThan(0);
    expect(String(blocked.cwd).startsWith(home)).toBe(true);
    const child = JSON.parse(
      await readFile(files.find(({ name }) => name === 'local_fixture-blocked-child-1.json')?.path ?? '', 'utf8'),
    ) as { spawnedFrom: { sessionId: string } };
    expect(child.spawnedFrom.sessionId).toBe(fixture.claudeDesktop.ids.blockedRoot);
    const completed = JSON.parse(
      await readFile(files.find(({ name }) => name === 'local_fixture-completed-root.json')?.path ?? '', 'utf8'),
    ) as { prs: { state: string }[]; writtenBranches: string[] };
    expect(completed.prs.map(({ state }) => state)).toEqual(['OPEN']);
    expect(completed.writtenBranches.length).toBeGreaterThan(0);
    // File mtimes are pinned so a re-import of an unchanged registry is `unchanged`.
    const modified = await stat(files.find(({ name }) => name === 'local_fixture-blocked-root.json')?.path ?? '');
    expect(modified.mtime.toISOString()).toBe(new Date(Number(blocked.lastActivityAt) + 60_000).toISOString());
  });

  test('writes a representative registry with every scenario the read model interprets', async () => {
    const home = await makeHome();
    const epoch = new Date('2026-10-21T00:00:00.000Z');
    const fixture = await seedHarnessHome(home, {
      claudeDesktopEpoch: epoch,
      claudeDesktopSessions: 'representative',
      harnesses: ['claude'],
    });
    if (fixture.claudeDesktop === null) {
      throw new Error('expected a seeded Desktop registry');
    }
    const { claudeDesktop } = fixture;
    expect(claudeDesktop.epoch).toBe(epoch.toISOString());
    expect(claudeDesktop.rootCount).toBeGreaterThanOrEqual(20);
    expect(claudeDesktop.childCount).toBeGreaterThanOrEqual(15);
    for (const [role, value] of Object.entries(claudeDesktop.ids)) {
      expect(value, role).not.toBeNull();
    }
    const files = await registryFiles(claudeDesktop.registryDirectory);
    const accounts = await readdir(claudeDesktop.registryDirectory);
    expect(accounts).toHaveLength(2);
    expect(files.filter(({ name }) => name === 'archived-sessions.idx')).toHaveLength(2);
    expect(files.some(({ name }) => name === 'scheduled-tasks.json')).toBe(true);
    expect(files.some(({ name }) => name.startsWith('deleted_'))).toBe(true);
    const sessions = await Promise.all(
      files
        .filter(({ name }) => name.startsWith('local_'))
        .map(async ({ path }) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>),
    );
    expect(sessions.length).toBe(claudeDesktop.rootCount + claudeDesktop.childCount);
    const ages = sessions.map((session) => (epoch.getTime() - Number(session.lastActivityAt)) / 3_600_000);
    expect(Math.min(...ages)).toBeLessThanOrEqual(1);
    expect(Math.max(...ages)).toBeGreaterThanOrEqual(40 * 24);
    const statuses = new Set(
      sessions.map((session) => (session.postTurnSummary as { status_category: string }).status_category),
    );
    expect([...statuses].sort()).toEqual(['blocked', 'completed', 'review_ready', 'waiting_for_person']);
    const resolutions = new Set(
      sessions.flatMap((session) => Object.values(session.resolvedBackgroundTaskSuggestions ?? {})),
    );
    expect([...resolutions].sort()).toEqual(['dismissed', 'started_notified']);
    const pullRequestStates = new Set(
      sessions.flatMap((session) => ((session.prs as { state: string }[] | undefined) ?? []).map(({ state }) => state)),
    );
    expect([...pullRequestStates].sort()).toEqual(['MERGED', 'OPEN']);
    expect(sessions.some((session) => typeof session.worktreePath === 'string')).toBe(true);
    expect(sessions.filter((session) => session.isArchived === true)).toHaveLength(1);
    expect(sessions.filter((session) => session.title === 'Enquête').length).toBeGreaterThanOrEqual(2);
    // Every path the registry names stays under the fixture home.
    for (const session of sessions) {
      for (const key of ['cwd', 'originCwd', 'worktreePath'] as const) {
        if (typeof session[key] === 'string') {
          expect(String(session[key]).startsWith(home)).toBe(true);
        }
      }
    }
    // The prompt sentinel is in the files, so a downstream absence assertion means something.
    const raw = await Promise.all(files.map(({ path }) => readFile(path, 'utf8')));
    expect(raw.some((text) => text.includes(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL))).toBe(true);
  });
});
