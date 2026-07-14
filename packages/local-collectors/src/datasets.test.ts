import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { collectHarnessDatasets } from './datasets';
import { LocalHistoryError } from './errors';
import { HISTORY_SCAN_MAX_BYTES } from './history-budgets';
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

class OverBudgetCodexStorage extends TestMemoryStorage {
  override exists() {
    return Effect.succeed(true);
  }

  override readDir() {
    return Effect.succeed([
      {
        isDirectory: false,
        isRegularFile: true,
        name: 'oversized.jsonl',
        size: HISTORY_SCAN_MAX_BYTES + 1,
      },
    ]);
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

  test('turns a Codex completeness-budget failure into a safe provider status', () => {
    const storage = new OverBudgetCodexStorage();

    const datasets = Effect.runSync(
      collectHarnessDatasets({ includeCursor: false, includeProviderStatus: true }).pipe(
        Effect.provideService(LocalHistoryStorage, storage),
      ),
    );

    expect(datasets.providerStatus?.providers[0]).toMatchObject({
      key: 'codex',
      state: 'error',
      warnings: ['Codex provider status could not be collected from local history.'],
    });
  });
});
