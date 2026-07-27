import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CursorCommitAttributionDatasetItem } from '@ai-usage/report-core/datasets';
import {
  createUsageMergeBundle,
  toSerializedMergeRow,
  type UsageMergeBundle,
  usageContentHash,
} from '@ai-usage/report-core/merge-bundle';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  confirmPeerMergeBundle,
  exportLocalMergeBundle,
  type ImportResult,
  importLocalRows,
  importNormalizedDatasetItems,
  importPeerMergeBundle,
  importProviderQuotaBatch,
  type PreviewPeerMergeBundleResult,
  previewPeerMergeBundle,
  queryEnrichableUsageRows,
  queryNormalizedDatasetItems,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryReportRows,
  queryUsageMachineFleet,
  queryUsageStoreGeneration,
  UsageStoreError,
  upsertRtkSavingsContributions,
  usageStorePath,
} from './index';

const machineA: UsageMachine = { id: 'machine-a', label: 'Machine A' };
const machineB: UsageMachine = { id: 'machine-b', label: 'Machine B' };
const CONFIRMATION_TOKEN_PATTERN = /^v1\.[0-9a-f]{64}$/;

const makeRow = (input: {
  sourceSessionId: string;
  project?: string;
  tokOut?: number;
}): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-06-01T10:00:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-06-01T10:01:00.000Z'),
    harness: 'Codex',
    model: 'gpt-5',
    name: 'Session',
    project: input.project ?? 'ai-usage',
    provider: 'OpenAI',
    tokens: { in: 10, out: input.tokOut ?? 20, cr: 0, cw: 5 },
  }),
  source: {
    harnessKey: 'codex',
    sourceSessionId: input.sourceSessionId,
  },
});

const makeBundle = (machine: UsageMachine, rows: UsageRowWithOptionalSource[]): UsageMergeBundle =>
  createUsageMergeBundle({
    generatedAt: new Date('2026-06-19T12:00:00.000Z'),
    machine,
    rows,
  });

interface BarrierChild {
  complete: () => Promise<string>;
  release: () => void;
}

type ConcurrentConfirmOutcome = { kind: 'preview-stale' } | { kind: 'success'; result: unknown };

const USAGE_STORE_MODULE_URL = new URL('./index.ts', import.meta.url).href;
const CONFIRM_SUCCESS_PREFIX = 'result:success:';

const startBarrierChild = async (program: string): Promise<BarrierChild> => {
  const child = spawn(process.execPath, ['-e', program]);
  let errorOutput = '';
  let output = '';
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('ready')) {
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('ready')) {
        reject(new Error(`Child exited before the barrier with code ${code}: ${errorOutput}`));
      }
    });
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Child exited with code ${code}: ${errorOutput}`));
      }
    });
  });
  return {
    complete: async () => {
      await completion;
      return output;
    },
    release: () => child.stdin.end('continue\\n'),
  };
};

const startCompetingImport = async (dbPath: string, bundle: UsageMergeBundle): Promise<() => Promise<void>> => {
  const child = await startBarrierChild(`
    const { Effect } = await import('effect');
    const { importPeerMergeBundle } = await import(${JSON.stringify(USAGE_STORE_MODULE_URL)});
    process.stdout.write('ready\\n');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    await Effect.runPromise(importPeerMergeBundle({
      bundle: ${JSON.stringify(bundle)},
      dbPath: ${JSON.stringify(dbPath)},
      localMachineId: ${JSON.stringify(machineA.id)},
    }));
  `);
  return async () => {
    child.release();
    await child.complete();
  };
};

const parseConcurrentConfirmOutcome = (output: string): ConcurrentConfirmOutcome => {
  const resultLine = output.split('\n').find((line) => line.startsWith('result:'));
  if (resultLine === 'result:preview-stale') {
    return { kind: 'preview-stale' };
  }
  if (resultLine?.startsWith(CONFIRM_SUCCESS_PREFIX)) {
    return { kind: 'success', result: JSON.parse(resultLine.slice(CONFIRM_SUCCESS_PREFIX.length)) as unknown };
  }
  throw new Error(`Confirmation child returned no result: ${output}`);
};

const runConcurrentConfirms = async (
  dbPath: string,
  bundle: UsageMergeBundle,
  confirmationToken: string,
): Promise<ConcurrentConfirmOutcome[]> => {
  const program = `
    const { Database } = await import('bun:sqlite');
    const fs = await import('node:fs');
    const originalExec = Database.prototype.exec;
    let confirmationBarrierReached = false;
    Database.prototype.exec = function (sql, ...params) {
      if (!confirmationBarrierReached && sql.trim() === 'BEGIN IMMEDIATE') {
        confirmationBarrierReached = true;
        fs.writeSync(1, 'ready\\n');
        fs.readFileSync(0, 'utf8');
      }
      return originalExec.call(this, sql, ...params);
    };
    const { Effect } = await import('effect');
    const { confirmPeerMergeBundle } = await import(${JSON.stringify(USAGE_STORE_MODULE_URL)});
    const outcome = await Effect.runPromise(Effect.either(confirmPeerMergeBundle({
      bundle: ${JSON.stringify(bundle)},
      confirmationToken: ${JSON.stringify(confirmationToken)},
      dbPath: ${JSON.stringify(dbPath)},
      localMachineId: ${JSON.stringify(machineA.id)},
    })));
    if (outcome._tag === 'Right') {
      process.stdout.write('result:success:' + JSON.stringify(outcome.right) + '\\n');
    } else if (outcome.left.reason === 'preview-stale') {
      process.stdout.write('result:preview-stale\\n');
    } else {
      throw outcome.left;
    }
  `;
  const children = await Promise.all([startBarrierChild(program), startBarrierChild(program)]);
  for (const child of children) {
    child.release();
  }
  return (await Promise.all(children.map(({ complete }) => complete()))).map(parseConcurrentConfirmOutcome);
};

const previewAcrossNoGenerationMutation = async (
  dbPath: string,
  bundle: UsageMergeBundle,
  mutate: () => Promise<void>,
): Promise<PreviewPeerMergeBundleResult> => {
  const child = await startBarrierChild(`
    const { Database } = await import('bun:sqlite');
    const fs = await import('node:fs');
    const originalQuery = Database.prototype.query;
    let previewSnapshotReady = false;
    Database.prototype.query = function (sql, ...params) {
      const statement = originalQuery.call(this, sql, ...params);
      if (previewSnapshotReady || !sql.includes("WHERE key = 'generation'")) {
        return statement;
      }
      return {
        get(...getParams) {
          const result = statement.get(...getParams);
          previewSnapshotReady = true;
          fs.writeSync(1, 'ready\\n');
          fs.readFileSync(0, 'utf8');
          return result;
        },
      };
    };
    const { Effect } = await import('effect');
    const { previewPeerMergeBundle } = await import(${JSON.stringify(USAGE_STORE_MODULE_URL)});
    const preview = await Effect.runPromise(previewPeerMergeBundle({
      bundle: ${JSON.stringify(bundle)},
      dbPath: ${JSON.stringify(dbPath)},
      localMachineId: ${JSON.stringify(machineA.id)},
    }));
    process.stdout.write('result:preview:' + JSON.stringify(preview) + '\\n');
  `);
  try {
    await mutate();
  } finally {
    child.release();
  }
  const output = await child.complete();
  const prefix = 'result:preview:';
  const resultLine = output.split('\n').find((line) => line.startsWith(prefix));
  if (!resultLine) {
    throw new Error(`Preview child returned no result: ${output}`);
  }
  return JSON.parse(resultLine.slice(prefix.length)) as PreviewPeerMergeBundleResult;
};

const makeDatasetItem = (itemKey: string, linesAdded = 3): CursorCommitAttributionDatasetItem => ({
  datasetKey: 'cursor.commit-attribution',
  itemKey,
  machineId: machineA.id,
  payload: {
    blankLinesAdded: 0,
    blankLinesDeleted: 0,
    branchName: 'main',
    commitDate: null,
    commitHash: `commit-${itemKey}`,
    commitMessage: null,
    composerLinesAdded: 1,
    composerLinesDeleted: 0,
    humanLinesAdded: 2,
    humanLinesDeleted: 0,
    linesAdded,
    linesDeleted: 0,
    scoredAt: '2026-07-16T10:00:00.000Z',
    tabLinesAdded: 0,
    tabLinesDeleted: 0,
    v1AiPercentage: 33,
    v2AiPercentage: 34,
  },
  schemaVersion: 1,
  sourceId: 'cursor.commit-attribution',
});

describe('usage-store public boundary', () => {
  test('keeps RTK-owned enrichment across base re-imports, no-ops, and store reopen', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-rtk-contribution-'));
    const dbPath = usageStorePath(home);
    const base = makeRow({ sourceSessionId: 'rtk-owned' });
    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [base] }));
    const enrichable = await Effect.runPromise(
      queryEnrichableUsageRows({
        dbPath,
        originMachineIds: [machineA.id],
        sourceAuthorities: ['local-observed'],
      }),
    );
    const rowKey = enrichable.rows[0]?.rowKey;
    if (!rowKey) {
      throw new Error('Expected an enrichable stable row key');
    }
    const contribution = {
      rtkCommandCount: 1,
      rtkInputTokens: 20,
      rtkOutputTokens: 5,
      rtkSavedTokens: 15,
    };
    expect(
      await Effect.runPromise(upsertRtkSavingsContributions({ contributions: [{ contribution, rowKey }], dbPath })),
    ).toEqual({ inserted: 1, unchanged: 0, updated: 0 });
    const enrichedGeneration = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [base] }));
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine: machineA,
        rows: [makeRow({ sourceSessionId: 'rtk-owned', tokOut: 99 })],
      }),
    );
    await Effect.runPromise(upsertRtkSavingsContributions({ contributions: [], dbPath }));

    const reopened = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(reopened.rows[0]).toMatchObject({ rtkSavedTokens: 15, tokOut: 99 });
    expect((await Effect.runPromise(queryEnrichableUsageRows({ dbPath }))).rows[0]?.row.rtkSavedTokens).toBeUndefined();
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(enrichedGeneration + 1);
  });

  test('preserves portable RTK contributions across preview, confirm, and later base imports', async () => {
    const machineAHome = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-rtk-portable-a-'));
    const machineBHome = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-rtk-portable-b-'));
    const machineADbPath = usageStorePath(machineAHome);
    const machineBDbPath = usageStorePath(machineBHome);
    const base = makeRow({ sourceSessionId: 'portable-rtk' });
    await Effect.runPromise(importLocalRows({ dbPath: machineADbPath, machine: machineA, rows: [base] }));
    const enrichable = await Effect.runPromise(queryEnrichableUsageRows({ dbPath: machineADbPath }));
    const rowKey = enrichable.rows[0]?.rowKey;
    if (!rowKey) {
      throw new Error('Expected a stable row key for the portable RTK test');
    }
    const contribution = {
      rtkCommandCount: 3,
      rtkInputTokens: 40,
      rtkOutputTokens: 11,
      rtkSavedTokens: 29,
    };
    await Effect.runPromise(
      upsertRtkSavingsContributions({
        contributions: [{ contribution, rowKey }],
        dbPath: machineADbPath,
      }),
    );
    const bundle = await Effect.runPromise(exportLocalMergeBundle({ dbPath: machineADbPath, machine: machineA }));

    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath: machineBDbPath }))).toBe(0);
    const preview = await Effect.runPromise(
      previewPeerMergeBundle({ bundle, dbPath: machineBDbPath, localMachineId: machineB.id }),
    );
    const confirmed = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle,
        dbPath: machineBDbPath,
        confirmationToken: preview.confirmationToken,
        localMachineId: machineB.id,
      }),
    );
    expect(confirmed).toEqual({
      deleted: preview.deleted,
      inserted: preview.inserted,
      superseded: preview.superseded,
      unchanged: preview.unchanged,
      updated: preview.updated,
      warnings: preview.warnings,
    });
    expect((await Effect.runPromise(queryReportRows({ dbPath: machineBDbPath }))).rows[0]).toMatchObject(contribution);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath: machineBDbPath }))).toBe(1);

    expect(
      await Effect.runPromise(importPeerMergeBundle({ bundle, dbPath: machineBDbPath, localMachineId: machineB.id })),
    ).toMatchObject({ inserted: 0, unchanged: 1, updated: 0 });
    const baseOnlyBundle = makeBundle(machineA, [base]);
    expect(
      await Effect.runPromise(
        importPeerMergeBundle({ bundle: baseOnlyBundle, dbPath: machineBDbPath, localMachineId: machineB.id }),
      ),
    ).toMatchObject({ inserted: 0, unchanged: 1, updated: 0 });
    expect((await Effect.runPromise(queryReportRows({ dbPath: machineBDbPath }))).rows[0]).toMatchObject(contribution);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath: machineBDbPath }))).toBe(1);

    const changedContribution = { ...contribution, rtkCommandCount: 4, rtkSavedTokens: 35 };
    const changedBundle = makeBundle(machineA, [{ ...base, ...changedContribution }]);
    const changedPreview = await Effect.runPromise(
      previewPeerMergeBundle({ bundle: changedBundle, dbPath: machineBDbPath, localMachineId: machineB.id }),
    );
    expect(changedPreview).toMatchObject({ inserted: 0, unchanged: 1, updated: 0 });
    const changed = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle: changedBundle,
        dbPath: machineBDbPath,
        confirmationToken: changedPreview.confirmationToken,
        localMachineId: machineB.id,
      }),
    );
    expect(changed).toMatchObject({ inserted: 0, unchanged: 1, updated: 0 });
    expect((await Effect.runPromise(queryReportRows({ dbPath: machineBDbPath }))).rows[0]).toMatchObject(
      changedContribution,
    );
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath: machineBDbPath }))).toBe(2);
  });

  test('migrates legacy embedded RTK fields additively without advancing semantic generation', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-rtk-migration-'));
    const dbPath = usageStorePath(home);
    const legacy = {
      ...makeRow({ sourceSessionId: 'legacy-rtk' }),
      rtkCommandCount: 2,
      rtkInputTokens: 30,
      rtkOutputTokens: 10,
      rtkSavedTokens: 20,
    };
    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [legacy] }));
    const serializedLegacy = toSerializedMergeRow(legacy, machineA);
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.query('UPDATE usage_rows SET content_hash = ?, row_json = ? WHERE row_key = ?').run(
      serializedLegacy.contentHash,
      JSON.stringify(serializedLegacy),
      serializedLegacy.rowKey,
    );
    db.query('DELETE FROM usage_row_enrichments WHERE row_key = ?').run(serializedLegacy.rowKey);
    db.query("UPDATE usage_store_metadata SET value = 0 WHERE key = 'migration.rtk-contributions-v1'").run();
    db.close();
    const generationBeforeMigration = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    const first = await Effect.runPromise(queryReportRows({ dbPath }));
    const second = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(first.rows[0]).toMatchObject({ rtkCommandCount: 2, rtkSavedTokens: 20 });
    expect(second.rows[0]).toMatchObject({ rtkCommandCount: 2, rtkSavedTokens: 20 });
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generationBeforeMigration);
  });

  test('upserts normalized datasets semantically without deleting absent items', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-datasets-'));
    const dbPath = usageStorePath(home);
    const first = makeDatasetItem('first');

    expect(await Effect.runPromise(importNormalizedDatasetItems({ dbPath, items: [] }))).toEqual({
      inserted: 0,
      unchanged: 0,
      updated: 0,
    });
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(0);

    expect(
      await Effect.runPromise(
        importNormalizedDatasetItems({
          dbPath,
          importedAt: new Date('2026-07-16T10:00:00.000Z'),
          items: [first, makeDatasetItem('first', 4)],
        }),
      ),
    ).toEqual({ inserted: 1, unchanged: 0, updated: 1 });
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(1);

    expect(
      await Effect.runPromise(
        importNormalizedDatasetItems({
          dbPath,
          importedAt: new Date('2026-07-16T10:01:00.000Z'),
          items: [makeDatasetItem('first', 4)],
        }),
      ),
    ).toEqual({ inserted: 0, unchanged: 1, updated: 0 });
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(1);

    await Effect.runPromise(importNormalizedDatasetItems({ dbPath, items: [] }));
    const queried = await Effect.runPromise(queryNormalizedDatasetItems({ dbPath }));
    expect(queried).toMatchObject({ skipped: 0, truncated: false });
    expect(queried.items).toHaveLength(1);
    expect(queried.items[0]?.payload.linesAdded).toBe(4);
  });

  test('rejects an invalid dataset batch atomically', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-dataset-invalid-'));
    const dbPath = usageStorePath(home);
    const invalid = {
      ...makeDatasetItem('invalid'),
      payload: { ...makeDatasetItem('invalid').payload, linesAdded: -1 },
    } as CursorCommitAttributionDatasetItem;

    await expect(
      Effect.runPromise(importNormalizedDatasetItems({ dbPath, items: [makeDatasetItem('valid'), invalid] })),
    ).rejects.toThrow('failed strict validation');
    expect((await Effect.runPromise(queryNormalizedDatasetItems({ dbPath }))).items).toHaveLength(0);
  });

  test('isolates corrupt stored dataset items and bounds reads', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-dataset-corrupt-'));
    const dbPath = usageStorePath(home);
    await Effect.runPromise(
      importNormalizedDatasetItems({
        dbPath,
        items: [makeDatasetItem('one'), makeDatasetItem('two')],
      }),
    );
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.query(`
      UPDATE collected_dataset_items
      SET payload_json = ?
      WHERE item_key = ?
    `).run('{"private":"corrupt"}', 'one');
    db.close();

    const queried = await Effect.runPromise(
      queryNormalizedDatasetItems({
        datasetKey: 'cursor.commit-attribution',
        dbPath,
        machineId: machineA.id,
        maximumItems: 10,
      }),
    );
    expect(queried).toMatchObject({ skipped: 1, truncated: false });
    expect(queried.items.map(({ itemKey }) => itemKey)).toEqual(['two']);

    const bounded = await Effect.runPromise(queryNormalizedDatasetItems({ dbPath, maximumItems: 1 }));
    expect(bounded.truncated).toBe(true);
    expect(bounded.items.length + bounded.skipped).toBe(1);
  });

  test('serializes concurrent dataset writers without losing items', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-dataset-concurrent-'));
    const dbPath = usageStorePath(home);
    await Promise.all([
      Effect.runPromise(importNormalizedDatasetItems({ dbPath, items: [makeDatasetItem('left')] })),
      Effect.runPromise(importNormalizedDatasetItems({ dbPath, items: [makeDatasetItem('right')] })),
    ]);

    const queried = await Effect.runPromise(queryNormalizedDatasetItems({ dbPath }));
    expect(queried.items.map(({ itemKey }) => itemKey).sort()).toEqual(['left', 'right']);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(2);
  });

  test('initializes an absent store and confirms against one opaque token', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-preview-'));
    const dbPath = usageStorePath(home);
    const bundle = createUsageMergeBundle({
      machine: machineB,
      rows: [makeRow({ sourceSessionId: 'peer-preview' })],
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    await expect(Bun.file(dbPath).exists()).resolves.toBe(true);
    expect(preview.inserted).toBe(1);
    expect(preview.confirmationToken.length).toBeGreaterThan(0);

    const confirmed = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle,
        dbPath,
        localMachineId: machineA.id,
        confirmationToken: preview.confirmationToken,
      }),
    );
    expect(confirmed.inserted).toBe(1);
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(1);
  });

  test('keeps opaque tokens stable for unchanged state and binds them to the canonical bundle', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-token-binding-'));
    const dbPath = usageStorePath(home);
    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'token-seed' })] }),
    );
    const bundle = makeBundle(machineB, [makeRow({ sourceSessionId: 'token-peer' })]);
    const first = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    const repeated = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    const differentBundle = makeBundle(machineB, [makeRow({ sourceSessionId: 'token-other' })]);
    const different = await Effect.runPromise(
      previewPeerMergeBundle({ bundle: differentBundle, dbPath, localMachineId: machineA.id }),
    );

    expect(first.confirmationToken).toMatch(CONFIRMATION_TOKEN_PATTERN);
    expect(repeated.confirmationToken).toBe(first.confirmationToken);
    expect(different.confirmationToken).not.toBe(first.confirmationToken);
    const generationBeforeStale = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
    const error = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle: differentBundle,
        confirmationToken: first.confirmationToken,
        dbPath,
        localMachineId: machineA.id,
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe('preview-stale');
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generationBeforeStale);
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(1);
  });

  test('does not recreate a store removed after preview', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-removed-'));
    const dbPath = usageStorePath(home);
    const movedDbPath = `${dbPath}.previewed`;
    const bundle = makeBundle(machineB, [makeRow({ sourceSessionId: 'removed-peer' })]);
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    renameSync(dbPath, movedDbPath);

    const error = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle,
        confirmationToken: preview.confirmationToken,
        dbPath,
        localMachineId: machineA.id,
      }).pipe(Effect.flip),
    );

    expect(error.reason).toBe('preview-stale');
    await expect(Bun.file(dbPath).exists()).resolves.toBe(false);
    await expect(Bun.file(movedDbPath).exists()).resolves.toBe(true);
  });

  test('rejects stale schema metadata without migrating or writing the bundle', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-schema-stale-'));
    const dbPath = usageStorePath(home);
    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'schema-seed' })] }),
    );
    const peerRow = makeRow({ sourceSessionId: 'schema-peer' });
    const bundle = makeBundle(machineB, [peerRow]);
    const peerRowKey = toSerializedMergeRow(peerRow, machineB).rowKey;
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    const generationBefore = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
    const { Database } = await import('bun:sqlite');
    const drift = new Database(dbPath);
    drift.query("UPDATE usage_store_metadata SET value = 0 WHERE key LIKE 'migration.%'").run();
    drift.close();

    const error = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle,
        confirmationToken: preview.confirmationToken,
        dbPath,
        localMachineId: machineA.id,
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe('preview-stale');

    const inspection = new Database(dbPath, { readonly: true });
    const migrationValues = inspection
      .query("SELECT value FROM usage_store_metadata WHERE key LIKE 'migration.%' ORDER BY key")
      .all() as Array<{ value: number }>;
    const generation = inspection.query("SELECT value FROM usage_store_metadata WHERE key = 'generation'").get() as {
      value: number;
    };
    const peerCount = inspection
      .query('SELECT COUNT(*) AS count FROM usage_rows WHERE row_key = ?')
      .get(peerRowKey) as {
      count: number;
    };
    inspection.close();
    expect(migrationValues.map(({ value }) => value)).toEqual([0, 0]);
    expect(generation.value).toBe(generationBefore);
    expect(peerCount.count).toBe(0);
  });

  test('rejects owner-only permission drift without repairing or mutating the store', async () => {
    if (process.platform === 'win32') {
      return;
    }

    for (const drift of [
      { label: 'database file access', mode: 0o644, target: 'database' },
      { label: 'store directory access', mode: 0o755, target: 'directory' },
    ]) {
      const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-private-drift-'));
      const dbPath = usageStorePath(home);
      const peerRow = {
        ...makeRow({ sourceSessionId: `private-drift-${drift.label}` }),
        rtkCommandCount: 2,
        rtkInputTokens: 30,
        rtkOutputTokens: 10,
        rtkSavedTokens: 20,
      };
      const bundle = makeBundle(machineB, [peerRow]);
      const peerRowKey = toSerializedMergeRow(peerRow, machineB).rowKey;
      const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
      const driftPath = drift.target === 'database' ? dbPath : path.dirname(dbPath);
      const statBeforeDrift = lstatSync(driftPath);
      if (typeof process.getuid === 'function') {
        expect(statBeforeDrift.uid).toBe(process.getuid());
      }
      chmodSync(driftPath, drift.mode);

      const error = await Effect.runPromise(
        confirmPeerMergeBundle({
          bundle,
          confirmationToken: preview.confirmationToken,
          dbPath,
          localMachineId: machineA.id,
        }).pipe(Effect.flip),
      );

      expect(error.reason).toBe('preview-stale');
      expect(lstatSync(driftPath).mode % 0o1_0000).toBe(drift.mode);
      const { Database } = await import('bun:sqlite');
      const inspection = new Database(dbPath, { readonly: true });
      const migrationValues = inspection
        .query("SELECT value FROM usage_store_metadata WHERE key LIKE 'migration.%' ORDER BY key")
        .all() as Array<{ value: number }>;
      const generation = inspection.query("SELECT value FROM usage_store_metadata WHERE key = 'generation'").get() as {
        value: number;
      };
      const peerCount = inspection
        .query('SELECT COUNT(*) AS count FROM usage_rows WHERE row_key = ?')
        .get(peerRowKey) as { count: number };
      const enrichmentCount = inspection
        .query('SELECT COUNT(*) AS count FROM usage_row_enrichments WHERE row_key = ?')
        .get(peerRowKey) as { count: number };
      inspection.close();
      expect(migrationValues.map(({ value }) => value)).toEqual([1, 1]);
      expect(generation.value).toBe(0);
      expect(peerCount.count).toBe(0);
      expect(enrichmentCount.count).toBe(0);
    }
  });

  test('rejects database identity replacement during confirmation before writing', async () => {
    if (process.platform === 'win32') {
      return;
    }

    for (const replacementPhase of [
      { label: 'open', sql: 'PRAGMA foreign_keys = ON' },
      { label: 'begin', sql: 'BEGIN IMMEDIATE' },
    ]) {
      const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-identity-drift-'));
      const dbPath = usageStorePath(home);
      const movedDbPath = `${dbPath}.${replacementPhase.label}.original`;
      const peerRow = {
        ...makeRow({ sourceSessionId: `identity-drift-${replacementPhase.label}` }),
        rtkCommandCount: 2,
        rtkInputTokens: 30,
        rtkOutputTokens: 10,
        rtkSavedTokens: 20,
      };
      const bundle = makeBundle(machineB, [peerRow]);
      const peerRowKey = toSerializedMergeRow(peerRow, machineB).rowKey;
      const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
      const { Database } = await import('bun:sqlite');
      const originalExec = Database.prototype.exec;
      let replacementOccurred = false;
      Database.prototype.exec = function (sql, ...bindings) {
        const result = originalExec.call(this, sql, ...bindings);
        if (!(replacementOccurred || sql.trim() !== replacementPhase.sql)) {
          replacementOccurred = true;
          renameSync(dbPath, movedDbPath);
          copyFileSync(movedDbPath, dbPath);
          chmodSync(dbPath, 0o600);
        }
        return result;
      };
      const error = await (async () => {
        try {
          return await Effect.runPromise(
            confirmPeerMergeBundle({
              bundle,
              confirmationToken: preview.confirmationToken,
              dbPath,
              localMachineId: machineA.id,
            }).pipe(Effect.flip),
          );
        } finally {
          Database.prototype.exec = originalExec;
        }
      })();

      expect(replacementOccurred).toBe(true);
      expect(error.reason).toBe('preview-stale');
      for (const inspectedPath of [dbPath, movedDbPath]) {
        const inspection = new Database(inspectedPath, { readonly: true });
        const generation = inspection
          .query("SELECT value FROM usage_store_metadata WHERE key = 'generation'")
          .get() as { value: number };
        const peerCount = inspection
          .query('SELECT COUNT(*) AS count FROM usage_rows WHERE row_key = ?')
          .get(peerRowKey) as { count: number };
        const enrichmentCount = inspection
          .query('SELECT COUNT(*) AS count FROM usage_row_enrichments WHERE row_key = ?')
          .get(peerRowKey) as { count: number };
        inspection.close();
        expect(generation.value).toBe(0);
        expect(peerCount.count).toBe(0);
        expect(enrichmentCount.count).toBe(0);
      }
    }
  });

  test('binds preview counts and token to one snapshot across a no-generation write', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-preview-snapshot-'));
    const dbPath = usageStorePath(home);
    const row = makeRow({ sourceSessionId: 'snapshot-race-peer' });
    const deletedBundle = {
      ...makeBundle(machineB, []),
      rows: [toSerializedMergeRow(row, machineB, 'deleted')],
    };
    const supersededBundle = {
      ...makeBundle(machineB, []),
      rows: [toSerializedMergeRow(row, machineB, 'superseded')],
    };
    await Effect.runPromise(importPeerMergeBundle({ bundle: deletedBundle, dbPath, localMachineId: machineA.id }));
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(0);

    const preview = await previewAcrossNoGenerationMutation(dbPath, deletedBundle, async () => {
      const mutation = await Effect.runPromise(
        importPeerMergeBundle({ bundle: supersededBundle, dbPath, localMachineId: machineA.id }),
      );
      expect(mutation).toMatchObject({ superseded: 1 });
    });

    expect(preview).toMatchObject({ deleted: 0, unchanged: 1 });
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(0);
    const error = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle: deletedBundle,
        confirmationToken: preview.confirmationToken,
        dbPath,
        localMachineId: machineA.id,
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe('preview-stale');
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(0);
    expect((await Effect.runPromise(queryReportRows({ dbPath, statuses: ['deleted'] }))).rows).toHaveLength(0);
    expect((await Effect.runPromise(queryReportRows({ dbPath, statuses: ['superseded'] }))).rows).toHaveLength(1);
  });

  test('serializes two concurrent confirms from one preview with exact result parity', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-concurrent-'));
    const dbPath = usageStorePath(home);
    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'confirm-seed' })] }),
    );
    const bundle = makeBundle(machineB, [
      {
        ...makeRow({ sourceSessionId: 'confirm-peer' }),
        rtkCommandCount: 2,
        rtkInputTokens: 30,
        rtkOutputTokens: 10,
        rtkSavedTokens: 20,
      },
    ]);
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    const outcomes = await runConcurrentConfirms(dbPath, bundle, preview.confirmationToken);
    const successes = outcomes.filter((outcome) => outcome.kind === 'success');
    const { confirmationToken: _confirmationToken, ...expectedResult } = preview;

    expect(successes).toHaveLength(1);
    expect(successes[0]?.result).toEqual(expectedResult);
    expect(outcomes.filter((outcome) => outcome.kind === 'preview-stale')).toHaveLength(1);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(2);
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.find((row) => row.source.sourceSessionId === 'confirm-peer')).toMatchObject({
      rtkSavedTokens: 20,
    });
  });

  test('stales behind a competing import without writing previewed rows, RTK, or generation', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-race-'));
    const dbPath = usageStorePath(home);
    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'race-seed' })] }),
    );
    const bundle = makeBundle(machineB, [
      {
        ...makeRow({ sourceSessionId: 'race-peer' }),
        rtkCommandCount: 2,
        rtkInputTokens: 30,
        rtkOutputTokens: 10,
        rtkSavedTokens: 20,
      },
    ]);
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    const releaseCompetingImport = await startCompetingImport(
      dbPath,
      makeBundle(machineB, [makeRow({ sourceSessionId: 'race-competitor' })]),
    );
    await releaseCompetingImport();
    const error = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle,
        confirmationToken: preview.confirmationToken,
        dbPath,
        localMachineId: machineA.id,
      }).pipe(Effect.flip),
    );

    expect(error.reason).toBe('preview-stale');
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(2);
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(stored.rows.map((row) => row.source.sourceSessionId).sort()).toEqual(['race-competitor', 'race-seed']);
    expect(stored.rows.every((row) => row.rtkSavedTokens === undefined)).toBe(true);
  });

  test('serializes two concurrent confirms after preview initializes an absent store', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-absent-concurrent-'));
    const dbPath = usageStorePath(home);
    const bundle = makeBundle(machineB, [
      {
        ...makeRow({ sourceSessionId: 'absent-confirm-peer' }),
        rtkCommandCount: 2,
        rtkInputTokens: 30,
        rtkOutputTokens: 10,
        rtkSavedTokens: 20,
      },
    ]);
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(0);
    const outcomes = await runConcurrentConfirms(dbPath, bundle, preview.confirmationToken);
    const successes = outcomes.filter((outcome) => outcome.kind === 'success');
    const { confirmationToken: _confirmationToken, ...expectedResult } = preview;

    expect(successes).toHaveLength(1);
    expect(successes[0]?.result).toEqual(expectedResult);
    expect(outcomes.filter((outcome) => outcome.kind === 'preview-stale')).toHaveLength(1);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(1);
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ rtkSavedTokens: 20 });
  });

  test('stales the same race after preview initializes an absent store', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-confirm-absent-race-'));
    const dbPath = usageStorePath(home);
    const bundle = makeBundle(machineB, [
      {
        ...makeRow({ sourceSessionId: 'absent-race-peer' }),
        rtkCommandCount: 2,
        rtkInputTokens: 30,
        rtkOutputTokens: 10,
        rtkSavedTokens: 20,
      },
    ]);
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(0);
    const releaseCompetingImport = await startCompetingImport(
      dbPath,
      makeBundle(machineB, [makeRow({ sourceSessionId: 'absent-race-competitor' })]),
    );
    await releaseCompetingImport();
    const error = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle,
        confirmationToken: preview.confirmationToken,
        dbPath,
        localMachineId: machineA.id,
      }).pipe(Effect.flip),
    );

    expect(error.reason).toBe('preview-stale');
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(1);

    const stored = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(stored.rows.map((row) => row.source.sourceSessionId)).toEqual(['absent-race-competitor']);
    expect(stored.rows[0]?.rtkSavedTokens).toBeUndefined();
  });

  test('keeps portable authority opaque, blocks local collisions, and permits a genuine local upgrade', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-authority-'));
    const dbPath = usageStorePath(home);
    const sourceRow = makeRow({ sourceSessionId: 'authority-row' });
    const portableBundle = createUsageMergeBundle({ machine: machineA, rows: [sourceRow] });

    expect(
      (await Effect.runPromise(importPeerMergeBundle({ bundle: portableBundle, dbPath, localMachineId: machineB.id })))
        .inserted,
    ).toBe(1);
    const opaque = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(opaque.sourceAuthorities).toEqual(['portable-opaque']);
    expect((await Effect.runPromise(exportLocalMergeBundle({ dbPath, machine: machineA }))).rows).toHaveLength(0);

    const upgraded = await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [sourceRow] }));
    expect(upgraded.updated).toBe(1);
    const local = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(local.sourceAuthorities).toEqual(['local-observed']);
    expect((await Effect.runPromise(exportLocalMergeBundle({ dbPath, machine: machineA }))).rows).toHaveLength(1);

    await expect(
      Effect.runPromise(previewPeerMergeBundle({ bundle: portableBundle, dbPath, localMachineId: machineB.id })),
    ).rejects.toThrow('collides with locally observed usage');
  });

  test('keeps import results count based for UI state', () => {
    const result: ImportResult = {
      deleted: 0,
      inserted: 1,
      superseded: 0,
      unchanged: 2,
      updated: 3,
      warnings: 0,
    };

    expect(result.inserted + result.updated + result.unchanged).toBe(6);
  });

  test('uses a typed public error', () => {
    const error = new UsageStoreError({
      message: 'Cannot import this machine as a peer',
      operation: 'importPeerMergeBundle',
      reason: 'self-import',
    });

    expect(error._tag).toBe('UsageStoreError');
  });

  test('imports local rows idempotently and queries active report rows', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-'));
    const dbPath = usageStorePath(home);
    const machine = { id: 'machine-a', label: 'Machine A' };
    const row = normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: new Date('2026-06-01T10:00:00.000Z'),
      durationMs: 1000,
      endDate: new Date('2026-06-01T10:01:00.000Z'),
      harness: 'Codex',
      model: 'gpt-5',
      name: 'Session',
      project: 'ai-usage',
      provider: 'OpenAI',
      tokens: { in: 10, out: 20, cr: 0, cw: 5 },
    });

    const inserted = await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [{ ...row, source: { harnessKey: 'codex', sourceSessionId: 'session-1' } }],
      }),
    );
    const repeated = await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [{ ...row, source: { harnessKey: 'codex', sourceSessionId: 'session-1' } }],
      }),
    );
    const queried = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machine.id] }));

    expect(inserted.inserted).toBe(1);
    expect(repeated.unchanged).toBe(1);
    expect(queried.rows).toHaveLength(1);
    expect(queried.rows[0]?.source.machineId).toBe('machine-a');
  });

  test('round-trips declared origin and preserves legacy stored absence', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-origin-'));
    const dbPath = usageStorePath(home);
    const classifierParentId = '11111111-2222-4333-8444-555555555555';
    const classifier = {
      ...makeRow({ sourceSessionId: 'classifier' }),
      origin: 'classifier' as const,
      source: {
        harnessKey: 'codex',
        rootSourceSessionId: classifierParentId,
        sourceSessionId: 'classifier',
      },
    };
    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [classifier] }));

    const currentLegacy = toSerializedMergeRow(makeRow({ sourceSessionId: 'legacy' }), machineB);
    const { contentHash: _contentHash, origin: _origin, ...legacyContent } = currentLegacy;
    const legacyRow = { ...legacyContent, contentHash: usageContentHash(legacyContent) };
    const legacyBundle: UsageMergeBundle = { ...makeBundle(machineB, []), rows: [legacyRow] };
    await Effect.runPromise(importPeerMergeBundle({ bundle: legacyBundle, dbPath, localMachineId: machineA.id }));

    const queried = await Effect.runPromise(queryReportRows({ dbPath }));
    const rowsById = new Map(queried.rows.map((row) => [row.source.sourceSessionId, row]));

    expect(rowsById.get('classifier')?.origin).toBe('classifier');
    expect(rowsById.get('classifier')?.source.rootSourceSessionId).toBe(classifierParentId);
    expect(rowsById.get('legacy')?.origin).toBeUndefined();
  });

  test('projects active rows into per-machine fleet freshness', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-fleet-'));
    const dbPath = usageStorePath(home);
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: new Date('2026-06-12T12:00:00.000Z'),
        machine: machineA,
        rows: [makeRow({ sourceSessionId: 'fleet-local' })],
      }),
    );
    const latestPeerRow = {
      ...makeRow({ sourceSessionId: 'fleet-peer-latest' }),
      date: new Date('2026-06-11T10:00:00.000Z'),
      endDate: new Date('2026-06-11T10:01:00.000Z'),
    };
    await Effect.runPromise(
      importPeerMergeBundle({
        bundle: makeBundle(machineB, [makeRow({ sourceSessionId: 'fleet-peer-oldest' }), latestPeerRow]),
        dbPath,
        importedAt: new Date('2026-06-15T12:00:00.000Z'),
        localMachineId: machineA.id,
      }),
    );

    const fleet = await Effect.runPromise(queryUsageMachineFleet({ dbPath }));

    expect(fleet).toEqual({
      machines: [
        {
          id: machineB.id,
          label: machineB.label,
          hasLocalObservedRows: false,
          hasPortableRows: true,
          lastSeenAt: '2026-06-15T12:00:00.000Z',
          newestSessionAt: '2026-06-11T10:01:00.000Z',
          sessionCount: 2,
        },
        {
          id: machineA.id,
          label: machineA.label,
          hasLocalObservedRows: true,
          hasPortableRows: false,
          lastSeenAt: '2026-06-12T12:00:00.000Z',
          newestSessionAt: '2026-06-01T10:01:00.000Z',
          sessionCount: 1,
        },
      ],
      skipped: 0,
    });
  });

  test('advances generation only when the active report projection changes', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-generation-'));
    const dbPath = usageStorePath(home);

    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(0);
    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'generation-row' })] }),
    );
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(1);
    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'generation-row' })] }),
    );
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(1);
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine: machineA,
        rows: [makeRow({ sourceSessionId: 'generation-row', tokOut: 21 })],
      }),
    );
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(2);
    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [] }));
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(2);
  });

  test('round-trips VCS in source JSON and treats its change as semantic without changing the row key', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-vcs-'));
    const dbPath = usageStorePath(home);
    const base = makeRow({ sourceSessionId: 'vcs-row' });
    const vcs = {
      branches: [],
      headCommit: null,
      partial: false,
      pullRequests: [],
      repository: {
        host: 'github.com',
        ownerPath: 'example/project',
        provenance: 'local-derived' as const,
        webUrl: 'https://github.com/example/project',
      },
    };

    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [base] }));
    const updated = await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine: machineA,
        rows: [
          {
            ...base,
            source: { harnessKey: 'codex', sourceSessionId: 'vcs-row', vcs },
          },
        ],
      }),
    );
    const after = await Effect.runPromise(queryReportRows({ dbPath }));

    expect(updated.updated).toBe(1);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.source.vcs).toEqual(vcs);
  });

  test('migrates stored pre-VCS row fingerprints and republishes them exactly once', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-pre-vcs-'));
    const dbPath = usageStorePath(home);
    const row = makeRow({ sourceSessionId: 'pre-vcs-row', project: 'Exalibur' });
    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [row] }));

    const current = toSerializedMergeRow(row, machineA);
    const legacySourceFingerprint = usageContentHash({
      activeDate: current.activeDate,
      date: current.date,
      endDate: current.endDate,
      harness: current.harness,
      model: current.model,
      models: current.models ?? [],
      name: current.name,
      project: current.project,
      provider: current.provider,
      sourcePath: current.source.sourcePath ?? current.source.artifactPath ?? null,
      tokenTotal: current.tokenTotal,
    });
    const {
      contentHash: _currentContentHash,
      sourceFingerprint: _currentSourceFingerprint,
      ...legacyContent
    } = current;
    const legacy = {
      ...legacyContent,
      sourceFingerprint: legacySourceFingerprint,
    };
    const legacyContentHash = usageContentHash(legacy);
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.query('UPDATE usage_rows SET source_fingerprint = ?, content_hash = ?, row_json = ? WHERE row_key = ?').run(
      legacySourceFingerprint,
      legacyContentHash,
      JSON.stringify({ ...legacy, contentHash: legacyContentHash }),
      current.rowKey,
    );
    db.query("UPDATE usage_store_metadata SET value = 0 WHERE key = 'migration.merge-row-v3-vcs'").run();
    db.close();

    const first = await Effect.runPromise(queryReportRows({ dbPath }));
    const generationAfterMigration = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));
    const second = await Effect.runPromise(queryReportRows({ dbPath }));

    expect(first).toMatchObject({ rows: [{ project: 'Exalibur' }], skipped: 0 });
    expect(second).toMatchObject({ rows: [{ project: 'Exalibur' }], skipped: 0 });
    expect(generationAfterMigration).toBe(2);
    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generationAfterMigration);

    const migratedDb = new Database(dbPath, { readonly: true });
    const migrated = migratedDb
      .query('SELECT source_fingerprint, content_hash, row_json FROM usage_rows WHERE row_key = ?')
      .get(current.rowKey) as { content_hash: string; row_json: string; source_fingerprint: string };
    migratedDb.close();
    expect(migrated.source_fingerprint).toBe(current.sourceFingerprint);
    expect(migrated.content_hash).toBe(current.contentHash);
    expect(JSON.parse(migrated.row_json)).toEqual(current);
  });

  test('skips invalid stored rows instead of failing the whole query', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-corrupt-'));
    const dbPath = usageStorePath(home);

    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine: machineA,
        rows: [makeRow({ sourceSessionId: 'good' }), makeRow({ sourceSessionId: 'corrupt' })],
      }),
    );

    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    const record = db.query("SELECT row_json FROM usage_rows WHERE source_session_id = 'corrupt'").get() as {
      row_json: string;
    };
    const tampered = JSON.parse(record.row_json) as Record<string, unknown>;
    tampered.durationMs = -1;
    db.query("UPDATE usage_rows SET row_json = ? WHERE source_session_id = 'corrupt'").run(JSON.stringify(tampered));
    db.close();

    const queried = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machineA.id] }));

    expect(queried.rows).toHaveLength(1);
    expect(queried.skipped).toBe(1);
    expect(queried.rows[0]?.source.sourceSessionId).toBe('good');
  });

  test('updates rather than duplicates rows without a source session id', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-nosession-'));
    const dbPath = usageStorePath(home);
    const row = (tokOut: number): UsageRowWithOptionalSource => ({
      ...normalizeUsageRow({
        calls: 1,
        cost: actualCost(null),
        date: new Date('2026-06-01T10:00:00.000Z'),
        durationMs: 1000,
        endDate: new Date('2026-06-01T10:01:00.000Z'),
        harness: 'Cursor',
        model: 'gpt-5',
        name: 'Daily',
        project: 'ai-usage',
        provider: 'OpenAI',
        tokens: { in: 10, out: tokOut, cr: 0, cw: 5 },
      }),
      source: { harnessKey: 'cursor', sourceSessionId: null },
    });

    const first = await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [row(20)] }));
    const second = await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [row(120)] }));
    const queried = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machineA.id] }));

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(queried.rows).toHaveLength(1);
  });

  test('waits for a short concurrent SQLite writer before importing rows', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-busy-'));
    const dbPath = usageStorePath(home);

    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'seed' })] }),
    );

    const blocker = spawn(process.execPath, [
      '-e',
      `
        const { Database } = await import('bun:sqlite');
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('BEGIN IMMEDIATE');
        process.stdout.write('locked\\n');
        await new Promise((resolve) => setTimeout(resolve, 100));
        db.exec('COMMIT');
        db.close();
      `,
    ]);

    await new Promise<void>((resolve, reject) => {
      let output = '';
      blocker.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes('locked')) {
          resolve();
        }
      });
      blocker.on('error', reject);
      blocker.on('exit', (code) => {
        if (!output.includes('locked')) {
          reject(new Error(`SQLite blocker exited before locking with code ${code}`));
        }
      });
    });

    try {
      const imported = await Effect.runPromise(
        importLocalRows({
          dbPath,
          machine: machineA,
          rows: [makeRow({ sourceSessionId: 'after-lock' })],
        }),
      );

      expect(imported.inserted).toBe(1);
    } finally {
      blocker.kill();
    }
  });

  test('updates a changed row with the same stable key', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-update-'));
    const dbPath = usageStorePath(home);
    const machine = { id: 'machine-a', label: 'Machine A' };
    const base = normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: new Date('2026-06-01T10:00:00.000Z'),
      durationMs: 1000,
      endDate: new Date('2026-06-01T10:01:00.000Z'),
      harness: 'Codex',
      model: 'gpt-5',
      name: 'Session',
      project: 'ai-usage',
      provider: 'OpenAI',
      tokens: { in: 10, out: 20, cr: 0, cw: 5 },
    });

    await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [{ ...base, source: { harnessKey: 'codex', sourceSessionId: 'session-1' } }],
      }),
    );
    const updated = await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine,
        rows: [{ ...base, tokOut: 25, source: { harnessKey: 'codex', sourceSessionId: 'session-1' } }],
      }),
    );
    const queried = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machine.id] }));

    expect(updated.updated).toBe(1);
    expect(queried.rows[0]?.tokOut).toBe(25);
  });

  test('exports this machine rows as a merge bundle', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-export-'));
    const dbPath = usageStorePath(home);

    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'local-1' })] }),
    );
    const bundle = await Effect.runPromise(
      exportLocalMergeBundle({
        dbPath,
        machine: machineA,
        generatedAt: new Date('2026-06-19T12:00:00.000Z'),
      }),
    );

    expect(bundle.machine).toEqual(machineA);
    expect(bundle.generatedAt).toBe('2026-06-19T12:00:00.000Z');
    expect(bundle.rows).toHaveLength(1);
    expect(bundle.rows[0]?.source.machineId).toBe(machineA.id);
  });

  test('imports peer rows alongside local rows and keeps repeated imports idempotent', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-peer-'));
    const dbPath = usageStorePath(home);

    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'local-1' })] }),
    );
    const inserted = await Effect.runPromise(
      importPeerMergeBundle({
        dbPath,
        localMachineId: machineA.id,
        bundle: makeBundle(machineB, [makeRow({ sourceSessionId: 'peer-1', project: 'peer-project' })]),
      }),
    );
    const repeated = await Effect.runPromise(
      importPeerMergeBundle({
        dbPath,
        localMachineId: machineA.id,
        bundle: makeBundle(machineB, [makeRow({ sourceSessionId: 'peer-1', project: 'peer-project' })]),
      }),
    );
    const queried = await Effect.runPromise(queryReportRows({ dbPath }));

    expect(inserted.inserted).toBe(1);
    expect(repeated.unchanged).toBe(1);
    expect(queried.rows.map((row) => row.source.machineId).sort()).toEqual([machineA.id, machineB.id]);
  });

  test('rejects importing a peer bundle from the local machine', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-self-'));
    const dbPath = usageStorePath(home);

    const result = await Effect.runPromise(
      Effect.either(
        importPeerMergeBundle({
          dbPath,
          localMachineId: machineA.id,
          bundle: makeBundle(machineA, [makeRow({ sourceSessionId: 'local-1' })]),
        }),
      ),
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left.reason).toBe('self-import');
    }
  });

  test('rejects a peer row forged into another machine namespace before storage', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-forged-peer-'));
    const dbPath = usageStorePath(home);
    const forgedBundle: UsageMergeBundle = {
      ...makeBundle(machineB, []),
      rows: [toSerializedMergeRow(makeRow({ sourceSessionId: 'forged' }), machineA)],
    };

    const result = await Effect.runPromise(
      Effect.either(
        importPeerMergeBundle({
          dbPath,
          localMachineId: 'local-machine',
          bundle: forgedBundle,
        }),
      ),
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left.reason).toBe('invalid-input');
    }
  });

  test('updates peer rows with changed content and keeps missing rows from later bundles', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-peer-update-'));
    const dbPath = usageStorePath(home);

    await Effect.runPromise(
      importPeerMergeBundle({
        dbPath,
        localMachineId: machineA.id,
        bundle: makeBundle(machineB, [
          makeRow({ sourceSessionId: 'peer-1', tokOut: 20 }),
          makeRow({ sourceSessionId: 'peer-2', tokOut: 30 }),
        ]),
      }),
    );
    const updated = await Effect.runPromise(
      importPeerMergeBundle({
        dbPath,
        localMachineId: machineA.id,
        bundle: makeBundle(machineB, [makeRow({ sourceSessionId: 'peer-1', tokOut: 25 })]),
      }),
    );
    const queried = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machineB.id] }));

    expect(updated.updated).toBe(1);
    expect(queried.rows).toHaveLength(2);
    expect(queried.rows.find((row) => row.source.sourceSessionId === 'peer-1')?.tokOut).toBe(25);
    expect(queried.rows.find((row) => row.source.sourceSessionId === 'peer-2')?.tokOut).toBe(30);
  });

  test('applies explicit deleted peer rows while leaving them out of active report queries', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-peer-delete-'));
    const dbPath = usageStorePath(home);
    const activeRow = makeRow({ sourceSessionId: 'peer-1' });
    const deletedRow = toSerializedMergeRow(activeRow, machineB, 'deleted');

    await Effect.runPromise(
      importPeerMergeBundle({
        dbPath,
        localMachineId: machineA.id,
        bundle: makeBundle(machineB, [activeRow]),
      }),
    );
    const deleted = await Effect.runPromise(
      importPeerMergeBundle({
        dbPath,
        localMachineId: machineA.id,
        bundle: {
          ...makeBundle(machineB, []),
          rows: [deletedRow],
        },
      }),
    );
    const active = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [machineB.id] }));
    const tombstones = await Effect.runPromise(
      queryReportRows({ dbPath, originMachineIds: [machineB.id], statuses: ['deleted'] }),
    );

    expect(deleted.deleted).toBe(1);
    expect(active.rows).toHaveLength(0);
    expect(tombstones.rows).toHaveLength(1);
    expect(tombstones.rows[0]?.source.sourceSessionId).toBe('peer-1');
  });

  test('preserves mixed counters and states across more than two lookup batches', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-batches-'));
    const dbPath = usageStorePath(home);
    const rowCount = 1205;
    const rows = Array.from({ length: rowCount }, (_, index) =>
      makeRow({ sourceSessionId: `peer-batch-${index}`, tokOut: 20 }),
    );
    await Effect.runPromise(
      importPeerMergeBundle({
        bundle: makeBundle(machineB, rows),
        dbPath,
        localMachineId: machineA.id,
      }),
    );
    const serializedRows = rows.map((row, index) => {
      if (index % 4 === 0) {
        return toSerializedMergeRow(row, machineB, 'deleted');
      }
      if (index % 4 === 1) {
        return toSerializedMergeRow(row, machineB, 'superseded');
      }
      if (index % 4 === 2) {
        return toSerializedMergeRow({ ...row, tokOut: 99 }, machineB);
      }
      return toSerializedMergeRow(row, machineB);
    });

    const result = await Effect.runPromise(
      importPeerMergeBundle({
        bundle: { ...makeBundle(machineB, []), rows: serializedRows },
        dbPath,
        localMachineId: machineA.id,
      }),
    );
    const stored = await Effect.runPromise(queryReportRows({ dbPath, statuses: ['active', 'deleted', 'superseded'] }));

    expect(result).toEqual({
      deleted: serializedRows.filter((row) => row.status === 'deleted').length,
      inserted: 0,
      superseded: serializedRows.filter((row) => row.status === 'superseded').length,
      unchanged: serializedRows.filter((row, index) => row.status === 'active' && index % 4 === 3).length,
      updated: serializedRows.filter((row, index) => row.status === 'active' && index % 4 === 2).length,
      warnings: 0,
    });
    expect(stored.rows).toHaveLength(rowCount);
  });

  test('keeps duplicate row keys sequential within one input batch', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-duplicate-batch-'));
    const dbPath = usageStorePath(home);

    const result = await Effect.runPromise(
      importLocalRows({
        dbPath,
        machine: machineA,
        rows: [
          makeRow({ sourceSessionId: 'duplicate-key', tokOut: 20 }),
          makeRow({ sourceSessionId: 'duplicate-key', tokOut: 25 }),
          makeRow({ sourceSessionId: 'duplicate-key', tokOut: 25 }),
        ],
      }),
    );
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));

    expect(result).toMatchObject({ inserted: 1, unchanged: 1, updated: 1 });
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.tokOut).toBe(25);
  });

  test('keeps duplicate row keys sequential across lookup batch boundaries', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-duplicate-batches-'));
    const dbPath = usageStorePath(home);
    const rows = [makeRow({ sourceSessionId: 'cross-batch-duplicate', tokOut: 20 })];
    rows.push(
      ...Array.from({ length: 1000 }, (_, index) => makeRow({ sourceSessionId: `cross-batch-filler-${index}` })),
    );
    rows.push(makeRow({ sourceSessionId: 'cross-batch-duplicate', tokOut: 30 }));

    const result = await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows }));
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));

    expect(result).toMatchObject({ inserted: 1001, updated: 1 });
    expect(stored.rows).toHaveLength(1001);
    expect(stored.rows.find((row) => row.source.sourceSessionId === 'cross-batch-duplicate')?.tokOut).toBe(30);
  });

  test('rolls back every batch after a late write failure', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-batch-rollback-'));
    const dbPath = usageStorePath(home);
    await Effect.runPromise(
      importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'seed' })] }),
    );
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TRIGGER reject_late_import
      BEFORE INSERT ON usage_rows
      WHEN NEW.source_session_id = 'late-failure'
      BEGIN
        SELECT RAISE(ABORT, 'late import failure');
      END;
    `);
    db.close();
    const rows = Array.from({ length: 1002 }, (_, index) =>
      makeRow({ sourceSessionId: index === 1001 ? 'late-failure' : `rollback-${index}` }),
    );
    const generationBeforeFailure = await Effect.runPromise(queryUsageStoreGeneration({ dbPath }));

    await expect(Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows }))).rejects.toThrow(
      'late import failure',
    );
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));

    expect(await Effect.runPromise(queryUsageStoreGeneration({ dbPath }))).toBe(generationBeforeFailure);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.source.sourceSessionId).toBe('seed');
  });
});

const quotaObservation = (observedAt: string, usedPercent = 25): ProviderQuotaObservation => ({
  accountScope: 'account-digest',
  machineId: machineA.id,
  machineLabel: machineA.label,
  observedAt,
  plan: 'plus',
  providerGeneratedAt: null,
  providerKey: 'codex',
  providerLabel: 'Codex',
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'codex:primary',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 100 - usedPercent,
      resetsAt: '2026-07-15T15:00:00.000Z',
      scope: 'provider',
      usedPercent,
    },
  ],
});

describe('provider quota storage', () => {
  test('coalesces adjacent content, retains heartbeats, and commits checkpoints atomically', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-quota-'));
    const dbPath = usageStorePath(home);

    const first = await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [{ observation: quotaObservation('2026-07-15T10:00:00.000Z'), sourceEventKey: 'live-1' }],
      }),
    );
    const adjacent = await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [{ observation: quotaObservation('2026-07-15T10:05:00.000Z'), sourceEventKey: 'live-2' }],
      }),
    );
    const repeatedEvent = await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [],
        dbPath,
        items: [{ observation: quotaObservation('2026-07-15T10:05:00.000Z'), sourceEventKey: 'live-2' }],
      }),
    );
    const heartbeat = await Effect.runPromise(
      importProviderQuotaBatch({
        checkpointUpdates: [
          {
            cursor: { offset: 42 },
            cursorKey: 'rollout.jsonl',
            machineId: machineA.id,
            providerKey: 'codex',
            sourceKey: 'codex-rollout',
          },
        ],
        dbPath,
        items: [{ observation: quotaObservation('2026-07-15T10:31:00.000Z'), sourceEventKey: 'live-3' }],
      }),
    );

    const queried = await Effect.runPromise(
      queryProviderQuotaObservations({
        dbPath,
        from: '2026-07-15T10:10:00.000Z',
        machineId: machineA.id,
        providerKey: 'codex',
        to: '2026-07-15T11:00:00.000Z',
      }),
    );
    const checkpoint = await Effect.runPromise(
      queryProviderQuotaSourceState({
        cursorKey: 'rollout.jsonl',
        dbPath,
        machineId: machineA.id,
        providerKey: 'codex',
        sourceKey: 'codex-rollout',
      }),
    );

    expect(first).toMatchObject({ coalesced: 0, inserted: 1, unchanged: 0 });
    expect(adjacent).toMatchObject({ coalesced: 1, inserted: 0, unchanged: 0 });
    expect(repeatedEvent).toMatchObject({ coalesced: 0, inserted: 0, unchanged: 1 });
    expect(heartbeat).toMatchObject({ coalesced: 0, inserted: 1, unchanged: 0 });
    expect(queried.observations).toHaveLength(2);
    expect(queried.observations[0]?.firstObservedAt).toBe('2026-07-15T10:00:00.000Z');
    expect(queried.observations[0]?.lastObservedAt).toBe('2026-07-15T10:05:00.000Z');
    expect(queried.observations[1]?.firstObservedAt).toBe('2026-07-15T10:31:00.000Z');
    expect(checkpoint?.cursor).toEqual({ offset: 42 });
  });
});
