import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { resolveUsageEngineProcessPaths } from './process-paths';

describe('usage engine process paths', () => {
  test('derives every runtime path from one explicit isolated home', () => {
    expect(
      resolveUsageEngineProcessPaths({
        cwd: '/workspace',
        env: { AI_USAGE_HOME: '/isolated/home' },
        systemTemporaryRoot: '/isolated/tmp',
      }),
    ).toEqual({
      configCwd: '/workspace',
      databasePath: '/isolated/home/.config/ai-usage/usage-store.sqlite',
      homeDirectory: '/isolated/home',
      inboxDirectory: '/isolated/home/.config/ai-usage/engine/inbox',
      operatorCwd: '/workspace',
      stateDirectory: '/isolated/home/.config/ai-usage/engine',
      temporaryRoot: '/isolated/tmp',
    });
  });

  test('honors absolute path overrides and rejects relative ones', () => {
    const root = '/isolated/runtime';
    expect(
      resolveUsageEngineProcessPaths({
        cwd: '/workspace',
        env: {
          AI_USAGE_DATABASE_PATH: path.join(root, 'store.sqlite'),
          AI_USAGE_ENGINE_STATE_DIR: path.join(root, 'state'),
          AI_USAGE_HOME: path.join(root, 'home'),
          AI_USAGE_LOG_DIR: path.join(root, 'logs'),
          AI_USAGE_ROOT_DIR: path.join(root, 'repo'),
          AI_USAGE_TEMP_ROOT: path.join(root, 'tmp'),
        },
        systemTemporaryRoot: '/system/tmp',
      }),
    ).toMatchObject({
      configCwd: path.join(root, 'repo'),
      databasePath: path.join(root, 'store.sqlite'),
      inboxDirectory: path.join(root, 'state', 'inbox'),
      stateDirectory: path.join(root, 'state'),
      temporaryRoot: path.join(root, 'tmp'),
    });

    expect(() =>
      resolveUsageEngineProcessPaths({
        cwd: '/workspace',
        env: { AI_USAGE_ENGINE_STATE_DIR: 'relative/state', AI_USAGE_HOME: '/isolated/home' },
        systemTemporaryRoot: '/system/tmp',
      }),
    ).toThrow('absolute');
  });
});
