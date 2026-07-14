import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { collectHarnessDatasets } from './datasets';
import { LocalHistoryError } from './errors';
import { LocalHistoryStorage } from './local-history';
import { TestMemoryStorage } from './test-memory-storage';

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
        includeCursor: false,
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
