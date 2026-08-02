import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

describe('usage web runtime paths', () => {
  test('matches the engine database, state, inbox, and rendezvous defaults', () => {
    expect(
      resolveUsageWebRuntimePaths({
        cwd: '/workspace',
        env: { AI_USAGE_HOME: '/isolated/home' },
        systemHome: '/unused/home',
      }),
    ).toEqual({
      configCwd: '/workspace',
      databasePath: '/isolated/home/.config/ai-usage/usage-store.sqlite',
      inboxDirectory: '/isolated/home/.config/ai-usage/engine/inbox',
      rendezvousPath: '/isolated/home/.config/ai-usage/engine/rendezvous.json',
      stateDirectory: '/isolated/home/.config/ai-usage/engine',
    });
  });

  test('uses explicit absolute database and state paths and rejects relative paths', () => {
    const root = '/isolated/runtime';
    expect(
      resolveUsageWebRuntimePaths({
        env: {
          AI_USAGE_DATABASE_PATH: path.join(root, 'usage.sqlite'),
          AI_USAGE_ENGINE_STATE_DIR: path.join(root, 'engine'),
          AI_USAGE_HOME: '/isolated/home',
          AI_USAGE_ROOT_DIR: path.join(root, 'config'),
        },
      }),
    ).toMatchObject({
      configCwd: '/isolated/runtime/config',
      databasePath: '/isolated/runtime/usage.sqlite',
      rendezvousPath: '/isolated/runtime/engine/rendezvous.json',
    });
    expect(() =>
      resolveUsageWebRuntimePaths({
        env: { AI_USAGE_DATABASE_PATH: 'relative.sqlite', AI_USAGE_HOME: '/isolated/home' },
      }),
    ).toThrow('Usage database path must be an absolute path.');
    expect(() =>
      resolveUsageWebRuntimePaths({
        env: { AI_USAGE_HOME: '/isolated/home', AI_USAGE_ROOT_DIR: 'relative-config' },
      }),
    ).toThrow('Usage config root must be an absolute path.');
  });
});
