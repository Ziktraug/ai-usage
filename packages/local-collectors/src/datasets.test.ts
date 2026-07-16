import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
  collectHarnessDatasets,
  collectHarnessDatasetsResult,
  cursorCommitAttributionItemKey,
  normalizeCursorCommitAttributionItems,
} from './datasets';
import { LocalHistoryError } from './errors';
import { CURSOR_COMMIT_ATTRIBUTION_SQL } from './facets';
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
  test('derives stable unambiguous Cursor attribution item identities', () => {
    const base = {
      branchName: 'main',
      commitHash: 'abc123',
    };
    expect(cursorCommitAttributionItemKey(base)).toBe(cursorCommitAttributionItemKey({ ...base }));
    expect(cursorCommitAttributionItemKey(base)).not.toBe(
      cursorCommitAttributionItemKey({ branchName: 'main-abc123', commitHash: '' }),
    );
    const payload = {
      ...base,
      blankLinesAdded: 0,
      blankLinesDeleted: 0,
      commitDate: null,
      commitMessage: null,
      composerLinesAdded: 1,
      composerLinesDeleted: 0,
      humanLinesAdded: 2,
      humanLinesDeleted: 0,
      linesAdded: 3,
      linesDeleted: 0,
      scoredAt: '2026-03-10T00:00:00.000Z',
      tabLinesAdded: 0,
      tabLinesDeleted: 0,
      v1AiPercentage: 33,
      v2AiPercentage: 34,
    };
    expect(normalizeCursorCommitAttributionItems('machine-a', [payload])).toEqual([
      {
        datasetKey: 'cursor.commit-attribution',
        itemKey: cursorCommitAttributionItemKey(base),
        machineId: 'machine-a',
        payload,
        schemaVersion: 1,
        sourceId: 'cursor.commit-attribution',
      },
    ]);
  });

  test('keeps valid Cursor attribution and emits one redacted warning for invalid metrics', () => {
    const storage = new TestMemoryStorage();
    storage.writeDatabaseRows('.cursor/ai-tracking/ai-code-tracking.db', CURSOR_COMMIT_ATTRIBUTION_SQL, [
      {
        commitHash: 'valid',
        branchName: 'main',
        scoredAt: Date.parse('2026-03-10T00:00:00.000Z'),
        linesAdded: 10,
        linesDeleted: 2,
        tabLinesAdded: 1,
        tabLinesDeleted: 0,
        composerLinesAdded: 3,
        composerLinesDeleted: 1,
        humanLinesAdded: 4,
        humanLinesDeleted: 1,
        blankLinesAdded: 2,
        blankLinesDeleted: 0,
        commitMessage: null,
        commitDate: null,
        v1AiPercentage: '33.33',
        v2AiPercentage: '41.67',
      },
      {
        commitHash: 'private-invalid-value-must-not-leak',
        branchName: 'main',
        scoredAt: Date.parse('2026-03-10T00:00:00.000Z'),
        linesAdded: -1,
      },
    ]);

    const result = Effect.runSync(
      collectHarnessDatasetsResult({ includeCursor: true }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );

    expect(result.datasets.cursorCommitAttribution).toHaveLength(1);
    expect(result.datasets.cursorCommitAttribution?.[0]?.commitHash).toBe('valid');
    expect(result.warnings).toEqual([
      {
        harness: 'cursor',
        operation: 'metricValidation',
        message: 'Rejected 1 malformed cursor metric record(s).',
      },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain('private-invalid-value');
  });

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
