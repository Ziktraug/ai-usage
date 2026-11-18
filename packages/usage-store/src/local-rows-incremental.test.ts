import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  importLocalRows,
  queryEnrichableUsageRowChanges,
  queryEnrichableUsageRows,
  queryLocalRowsWatermark,
  retireLocalRows,
  updateUsageMachineLabel,
  usageStorePath,
} from './index';

const machine = { id: 'machine-a', label: 'Machine A' };

const makeRow = (sourceSessionId: string, tokOut = 20, harnessKey = 'codex'): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-06-01T10:00:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-06-01T10:01:00.000Z'),
    harness: harnessKey === 'codex' ? 'Codex' : 'Claude',
    model: 'gpt-5',
    name: 'Session',
    project: 'ai-usage',
    provider: 'OpenAI',
    tokens: { in: 10, out: tokOut, cr: 0, cw: 5 },
  }),
  source: { harnessKey, sourceSessionId },
});

describe('incremental reads of locally observed rows', () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ai-usage-store-incremental-'));
    dbPath = usageStorePath(home);
  });

  afterEach(() => {
    rmSync(home, { force: true, recursive: true });
  });

  const importAt = (at: string, rows: UsageRowWithOptionalSource[]) =>
    Effect.runPromise(importLocalRows({ dbPath, importedAt: new Date(at), machine, rows }));
  const changes = (known: ReadonlyMap<string, string>) =>
    Effect.runPromise(
      queryEnrichableUsageRowChanges({
        dbPath,
        knownContentHashes: known,
        originMachineIds: [machine.id],
        sourceAuthorities: ['local-observed'],
      }),
    );
  const hashes = (entries: readonly { contentHash: string; rowKey: string }[]) =>
    new Map(entries.map((entry) => [entry.rowKey, entry.contentHash]));

  test('returns the rows of the full read in the same order, and reads only those not already known', async () => {
    await importAt('2026-06-02T00:00:00.000Z', [makeRow('one'), makeRow('two'), makeRow('three')]);
    const full = await Effect.runPromise(
      queryEnrichableUsageRows({ dbPath, originMachineIds: [machine.id], sourceAuthorities: ['local-observed'] }),
    );

    const cold = await changes(new Map());
    expect(cold.entries.map((entry) => entry.state)).toEqual(['read', 'read', 'read']);
    expect(cold.entries.map((entry) => entry.rowKey)).toEqual(full.rows.map((row) => row.rowKey));
    expect(cold.entries.map((entry) => (entry.state === 'read' ? entry.row : null))).toEqual(
      full.rows.map((row) => row.row),
    );

    const warm = await changes(hashes(cold.entries));
    expect(warm.entries.map((entry) => entry.state)).toEqual(['known', 'known', 'known']);
    expect(hashes(warm.entries)).toEqual(hashes(cold.entries));

    // One row is rewritten, one is retired, one is new: only the rewritten and the new one are read.
    await importAt('2026-06-02T00:01:00.000Z', [makeRow('two', 99), makeRow('four')]);
    await Effect.runPromise(retireLocalRows({ dbPath, harnessKey: 'codex', machine, sourceSessionIds: ['three'] }));
    const after = await changes(hashes(cold.entries));
    const fullAfter = await Effect.runPromise(
      queryEnrichableUsageRows({ dbPath, originMachineIds: [machine.id], sourceAuthorities: ['local-observed'] }),
    );

    expect(after.entries.map((entry) => entry.rowKey)).toEqual(fullAfter.rows.map((row) => row.rowKey));
    expect(after.entries.map((entry) => entry.state).sort()).toEqual(['known', 'read', 'read']);
    const reread = after.entries.flatMap((entry) => (entry.state === 'read' ? [entry.row.tokOut] : []));
    expect(reread.sort()).toEqual([20, 99]);
  });

  test('reports a stored row that no longer validates as invalid, where the full read skips it', async () => {
    await importAt('2026-06-02T00:00:00.000Z', [makeRow('one'), makeRow('two')]);
    const cold = await changes(new Map());
    const broken = cold.entries[0];
    if (!broken) {
      throw new Error('Expected a stored row');
    }
    const db = new Database(dbPath);
    db.query("UPDATE usage_rows SET row_json = '{\"broken\":true}', content_hash = 'rewritten' WHERE row_key = ?").run(
      broken.rowKey,
    );
    db.close();

    const after = await changes(hashes(cold.entries));
    const full = await Effect.runPromise(queryEnrichableUsageRows({ dbPath }));

    expect(after.entries.find((entry) => entry.rowKey === broken.rowKey)).toEqual({
      contentHash: 'rewritten',
      rowKey: broken.rowKey,
      state: 'invalid',
    });
    expect(full).toMatchObject({ skipped: 1 });
    expect(full.rows.map((row) => row.rowKey)).toEqual(
      after.entries.filter((entry) => entry.state !== 'invalid').map((entry) => entry.rowKey),
    );
  });

  test('moves the watermark of a harness when its rows are written, and only then', async () => {
    const watermark = (harnessKey: string) =>
      Effect.runPromise(queryLocalRowsWatermark({ dbPath, harnessKey, machineId: machine.id }));
    await importAt('2026-06-02T00:00:00.000Z', [makeRow('one'), makeRow('two'), makeRow('other', 20, 'claude')]);
    const initial = await watermark('codex');
    expect(initial).toEqual({ lastUpdatedAt: '2026-06-02T00:00:00.000Z', rows: 2 });
    expect(await watermark('claude')).toEqual({ lastUpdatedAt: '2026-06-02T00:00:00.000Z', rows: 1 });
    expect(await watermark('cursor')).toEqual({ lastUpdatedAt: null, rows: 0 });

    // An unchanged re-import, a freshness heartbeat and another harness's rows leave it where it was.
    await importAt('2026-06-02T00:10:00.000Z', [makeRow('one'), makeRow('two')]);
    await importAt('2026-06-02T03:00:00.000Z', [makeRow('one'), makeRow('two')]);
    await importAt('2026-06-02T03:01:00.000Z', [makeRow('other', 21, 'claude')]);
    expect(await watermark('codex')).toEqual(initial);

    await importAt('2026-06-02T03:02:00.000Z', [makeRow('two', 99)]);
    expect(await watermark('codex')).toEqual({ lastUpdatedAt: '2026-06-02T03:02:00.000Z', rows: 2 });
    await importAt('2026-06-02T03:03:00.000Z', [makeRow('three')]);
    expect(await watermark('codex')).toEqual({ lastUpdatedAt: '2026-06-02T03:03:00.000Z', rows: 3 });
    await Effect.runPromise(
      retireLocalRows({
        dbPath,
        harnessKey: 'codex',
        machine,
        retiredAt: new Date('2026-06-02T03:04:00.000Z'),
        sourceSessionIds: ['one'],
      }),
    );
    expect(await watermark('codex')).toEqual({ lastUpdatedAt: '2026-06-02T03:04:00.000Z', rows: 3 });
    await Effect.runPromise(
      updateUsageMachineLabel({
        dbPath,
        machine: { id: machine.id, label: 'Renamed' },
        updatedAt: new Date('2026-06-02T03:05:00.000Z'),
      }),
    );
    expect(await watermark('codex')).toEqual({ lastUpdatedAt: '2026-06-02T03:05:00.000Z', rows: 3 });
  });
});
