import { describe, expect, test } from 'bun:test';
import { resolveUsageRuntimePaths } from './runtime-paths';

const databasePathForHome = (homeDirectory: string): string => `${homeDirectory}/store.sqlite`;

describe('usage runtime paths', () => {
  test('resolves one shared target for engine, web, and CLI adapters', () => {
    expect(
      resolveUsageRuntimePaths({
        cwd: '/workspace',
        databasePathForHome,
        env: { AI_USAGE_HOME: '/isolated/home' },
        systemTemporaryRoot: '/isolated/tmp',
      }),
    ).toEqual({
      configCwd: '/workspace',
      databasePath: '/isolated/home/store.sqlite',
      homeDirectory: '/isolated/home',
      inboxDirectory: '/isolated/home/.config/ai-usage/engine/inbox',
      operatorCwd: '/workspace',
      rendezvousPath: '/isolated/home/.config/ai-usage/engine/rendezvous.json',
      stateDirectory: '/isolated/home/.config/ai-usage/engine',
      temporaryRoot: '/isolated/tmp',
    });
  });

  test('rejects relative overrides before a surface can target a different runtime', () => {
    expect(() =>
      resolveUsageRuntimePaths({
        databasePathForHome,
        env: { AI_USAGE_DATABASE_PATH: 'relative.sqlite', AI_USAGE_HOME: '/isolated/home' },
      }),
    ).toThrow('Usage database path must be an absolute path.');
  });
});
