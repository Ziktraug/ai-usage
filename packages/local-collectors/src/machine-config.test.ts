import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { aiUsageConfigPath, readAiUsageConfig } from './machine-config';

describe('machine config', () => {
  test('reads valid project groups from user config', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          projectGroups: [
            {
              id: 'group-1',
              name: 'exalibur',
              sources: [{ machineId: 'machine-a', sourcePath: '/work/exalibur' }],
            },
          ],
        }),
      );

      const config = await Effect.runPromise(
        readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(config.projectGroups?.[0]?.name).toBe('exalibur');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects invalid project groups', async () => {
    const home = await mkdtemp('ai-usage-machine-config-');
    try {
      const storage = createLocalHistoryStorage(home);
      mkdirSync(path.dirname(aiUsageConfigPath(storage)), { recursive: true });
      writeFileSync(
        aiUsageConfigPath(storage),
        JSON.stringify({
          projectGroups: [{ id: 'group-1', name: 'exalibur', sources: [{}] }],
        }),
      );

      await expect(
        Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
      ).rejects.toThrow('Invalid ai-usage config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const mkdtemp = async (prefix: string) => {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(tmpdir(), prefix));
};
