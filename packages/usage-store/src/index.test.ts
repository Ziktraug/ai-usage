import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageMergeBundle, toSerializedMergeRow, type UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  exportLocalMergeBundle,
  importLocalRows,
  importPeerMergeBundle,
  queryReportRows,
  usageStorePath,
  UsageStoreError,
  type ImportResult,
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

describe('usage-store public boundary', () => {
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

    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'local-1' })] }));
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

    await Effect.runPromise(importLocalRows({ dbPath, machine: machineA, rows: [makeRow({ sourceSessionId: 'local-1' })] }));
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
    if (result._tag === 'Left') expect(result.left.reason).toBe('self-import');
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
});
