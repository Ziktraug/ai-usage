import { describe, expect, test } from 'bun:test';
import { LocalHistoryError } from '@ai-usage/local-machine/errors';
import { LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { TestMemoryStorage } from '@ai-usage/local-machine/testing/memory-storage';
import { Effect } from 'effect';
import { collectHarnessDatasets } from './datasets';

class FailingCodexStorage extends TestMemoryStorage {
  override exists() {
    return Effect.succeed(true);
  }

  override readDir(dirPath: string) {
    return Effect.fail(
      new LocalHistoryError({
        operation: 'readDir',
        path: dirPath,
        cause: new Error('Bearer sk-sensitive-token'),
      }),
    );
  }
}

describe('harness datasets', () => {
  test('turns Codex collection failures into a safe machine-scoped provider status', () => {
    const storage = new FailingCodexStorage();

    const datasets = Effect.runSync(
      collectHarnessDatasets({
        includeProviderStatus: true,
        machineId: 'machine-1',
        machineLabel: 'Test Machine',
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );

    expect(datasets.providerStatus?.providers).toEqual([
      {
        generatedAt: expect.any(String),
        key: 'codex',
        label: 'Codex',
        machineId: 'machine-1',
        machineLabel: 'Test Machine',
        source: 'local-history',
        state: 'error',
        warnings: ['Codex provider status could not be collected from local history.'],
        windows: [],
      },
    ]);
  });
});
