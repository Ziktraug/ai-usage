import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { importLocalRows, queryReportRows, usageStorePath, UsageStoreError, type ImportResult } from './index';

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
});
