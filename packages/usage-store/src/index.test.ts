import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CursorCommitAttributionDatasetItem } from '@ai-usage/report-core/datasets';
import {
  createUsageMergeBundle,
  toSerializedMergeRow,
  type UsageMergeBundle,
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
  previewPeerMergeBundle,
  queryEnrichableUsageRows,
  queryNormalizedDatasetItems,
  queryProviderQuotaObservations,
  queryProviderQuotaSourceState,
  queryReportRows,
  queryUsageStoreGeneration,
  UsageStoreError,
  upsertRtkSavingsContributions,
  usageStorePath,
} from './index';

const machineA: UsageMachine = { id: 'machine-a', label: 'Machine A' };
const machineB: UsageMachine = { id: 'machine-b', label: 'Machine B' };

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
        expectedGeneration: preview.generation,
        expectedStoreStateToken: preview.storeStateToken,
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
        expectedGeneration: changedPreview.generation,
        expectedStoreStateToken: changedPreview.storeStateToken,
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

  test('previews an absent store without creating it and confirms against the same state token', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-preview-'));
    const dbPath = usageStorePath(home);
    const bundle = createUsageMergeBundle({
      machine: machineB,
      rows: [makeRow({ sourceSessionId: 'peer-preview' })],
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const preview = await Effect.runPromise(previewPeerMergeBundle({ bundle, dbPath, localMachineId: machineA.id }));
    await expect(Bun.file(dbPath).exists()).resolves.toBe(false);
    expect(preview.inserted).toBe(1);
    expect(preview.generation).toBe(0);

    const confirmed = await Effect.runPromise(
      confirmPeerMergeBundle({
        bundle,
        dbPath,
        localMachineId: machineA.id,
        expectedGeneration: preview.generation,
        expectedStoreStateToken: preview.storeStateToken,
      }),
    );
    expect(confirmed.inserted).toBe(1);
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(1);
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
