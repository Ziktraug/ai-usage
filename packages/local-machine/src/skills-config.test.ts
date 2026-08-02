import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { readAiUsageConfig, updateAiUsageConfig, writeAiUsageConfig } from './machine-config';
import { createSkillsConfigStore } from './skills-config';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-skills-config-'));
  roots.push(root);
  const homePath = path.join(root, 'home');
  const storage = createLocalHistoryStorage(homePath);
  const runWithStorage = <A, E>(effect: Effect.Effect<A, E, typeof LocalHistoryStorage.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  return {
    homePath,
    runWithStorage,
    store: createSkillsConfigStore({ configCwd: root, homePath }),
  };
};

describe('Skills config store', () => {
  test('updates only the Skills field', async () => {
    const fixture = await createFixture();
    await fixture.runWithStorage(
      writeAiUsageConfig({
        cursor: { user: 'kept-user' },
        sourcePolicies: { 'claude.sessions': { enabled: false } },
      }),
    );

    await fixture.store.updateSkills({ sourceRepoPath: '/portable/skills' });

    expect(await fixture.store.read()).toEqual({
      skills: { sourceRepoPath: '/portable/skills' },
    });

    expect(await fixture.runWithStorage(readAiUsageConfig)).toEqual({
      cursor: { user: 'kept-user' },
      skills: { sourceRepoPath: '/portable/skills' },
      sourcePolicies: { 'claude.sessions': { enabled: false } },
    });
  });

  test('shares the config transaction with usage-domain updates', async () => {
    const fixture = await createFixture();
    await fixture.runWithStorage(writeAiUsageConfig({}));

    await Promise.all([
      fixture.store.updateSkills({ sourceRepoPath: '/portable/skills' }),
      fixture.runWithStorage(
        updateAiUsageConfig((config) => ({
          ...config,
          sourcePolicies: { 'codex.sessions': { enabled: false } },
        })),
      ),
    ]);

    expect(await fixture.runWithStorage(readAiUsageConfig)).toEqual({
      skills: { sourceRepoPath: '/portable/skills' },
      sourcePolicies: { 'codex.sessions': { enabled: false } },
    });
  });
});
