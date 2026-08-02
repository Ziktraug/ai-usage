import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  queryLocalMergeBundle,
  queryUsageLocalMachine,
  queryUsageStoreGenerations,
  queryUsageSyncFleet,
  UsageStoreError,
  usageStorePath,
} from './reader';
import { setLocalProjectionReadFaultInjectorForTesting } from './testing';
import { importLocalRows, importPeerMergeBundle, initializeUsageStore, updateUsageMachineLabel } from './writer';

const localMachine: UsageMachine = { id: 'machine-local', label: 'Local machine' };
const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

const temporaryHome = (prefix: string): string => {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryHomes.push(home);
  return home;
};

const usageRow = (sourceSessionId: string): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-07-30T10:00:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-07-30T10:01:00.000Z'),
    harness: 'Codex',
    model: 'gpt-5',
    name: 'Session',
    project: 'ai-usage',
    provider: 'OpenAI',
    tokens: { cr: 0, cw: 0, in: 10, out: 20 },
  }),
  source: { harnessKey: 'codex', sourceSessionId },
});

test('publishes the engine-owned local machine projection before query-only Sync reads', async () => {
  const home = temporaryHome('ai-usage-local-machine-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(initializeUsageStore({ dbPath }));

  const unavailable = await Effect.runPromise(Effect.flip(queryUsageLocalMachine({ dbPath })));
  expect(unavailable).toBeInstanceOf(UsageStoreError);
  expect(unavailable.reason).toBe('machine-unavailable');

  expect(
    await Effect.runPromise(
      updateUsageMachineLabel({
        dbPath,
        machine: localMachine,
        updatedAt: new Date('2026-07-30T11:00:00.000Z'),
      }),
    ),
  ).toEqual({ changed: true, skippedRows: 0, updatedRows: 0 });
  expect(await Effect.runPromise(queryUsageLocalMachine({ dbPath }))).toEqual(localMachine);
  expect(await Effect.runPromise(queryUsageSyncFleet({ dbPath }))).toEqual({
    currentMachine: localMachine,
    machines: [],
    omittedMachines: 0,
    skipped: 0,
  });
  expect(
    await Effect.runPromise(queryLocalMergeBundle({ dbPath, generatedAt: new Date('2026-07-30T12:00:00.000Z') })),
  ).toEqual({
    generatedAt: '2026-07-30T12:00:00.000Z',
    machine: localMachine,
    rows: [],
    version: 3,
    warnings: [],
  });
});

test('exports only active locally observed rows for the projected machine', async () => {
  const home = temporaryHome('ai-usage-local-export-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(
    updateUsageMachineLabel({
      dbPath,
      machine: localMachine,
      updatedAt: new Date('2026-07-30T11:00:00.000Z'),
    }),
  );
  await Effect.runPromise(importLocalRows({ dbPath, machine: localMachine, rows: [usageRow('local-row')] }));
  const peerMachine: UsageMachine = { id: 'machine-peer', label: 'Peer machine' };
  await Effect.runPromise(
    importPeerMergeBundle({
      bundle: createUsageMergeBundle({ machine: peerMachine, rows: [usageRow('portable-row')] }),
      dbPath,
      localMachineId: localMachine.id,
    }),
  );

  const bundle = await Effect.runPromise(
    queryLocalMergeBundle({ dbPath, generatedAt: new Date('2026-07-30T12:00:00.000Z') }),
  );
  expect(bundle.machine).toEqual(localMachine);
  expect(bundle.rows).toHaveLength(1);
  expect(bundle.rows[0]?.source).toMatchObject({ machineId: localMachine.id, sourceSessionId: 'local-row' });
});

test('rejects 50,001 local rows before loading or parsing row JSON', async () => {
  const home = temporaryHome('ai-usage-local-export-overflow-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(
    updateUsageMachineLabel({
      dbPath,
      machine: localMachine,
      updatedAt: new Date('2026-07-30T11:00:00.000Z'),
    }),
  );
  const { Database } = await import('bun:sqlite');
  const database = new Database(dbPath);
  try {
    database.exec('DROP TRIGGER usage_rows_invalidate_fleet_metadata_after_insert');
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 50001
      )
      INSERT INTO usage_rows (
        origin_machine_id, harness_key, source_session_id, source_fingerprint, source_authority,
        row_key, content_hash, row_json, machine_label, fleet_metadata_valid, status, active_date,
        project, model, token_total, first_seen_at, last_seen_at, updated_at, superseded_by
      )
      SELECT
        'machine-local', 'codex', 'overflow-' || value, 'fingerprint', 'local-observed',
        'overflow-' || value, 'hash', 'not-json', '', 0, 'active', NULL,
        'ai-usage', 'gpt-5', 0, '2026-07-30T11:00:00.000Z', '2026-07-30T11:00:00.000Z',
        '2026-07-30T11:00:00.000Z', NULL
      FROM sequence
    `);
  } finally {
    database.close();
  }

  const error = await Effect.runPromise(Effect.flip(queryLocalMergeBundle({ dbPath })));
  expect(error).toBeInstanceOf(UsageStoreError);
  expect(error).toMatchObject({ reason: 'invalid-input' });
  expect(error.message).toContain('contains 50001 rows; maximum is 50000');
});

test('reports a current-version store with a missing machine table as corrupt without repairing it', async () => {
  const home = temporaryHome('ai-usage-local-machine-corrupt-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const { Database } = await import('bun:sqlite');
  const database = new Database(dbPath);
  database.exec('DROP TABLE usage_local_machine');
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close();
  const before = readFileSync(dbPath);

  const error = await Effect.runPromise(Effect.flip(queryUsageLocalMachine({ dbPath })));

  expect(error).toMatchObject({ reason: 'corrupt' });
  expect(readFileSync(dbPath)).toEqual(before);
  const inspection = new Database(dbPath, { create: false, readonly: true });
  try {
    expect(
      inspection.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'usage_local_machine'").get(),
    ).toBeNull();
  } finally {
    inspection.close();
  }
});

test('rejects non-text local machine projection values as corrupt', async () => {
  const home = temporaryHome('ai-usage-local-machine-types-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: localMachine }));
  const { Database } = await import('bun:sqlite');
  const database = new Database(dbPath);
  database.query("UPDATE usage_local_machine SET machine_id = X'6d616368696e652d626c6f62'").run();
  database.close();

  const errors = await Promise.all([
    Effect.runPromise(Effect.flip(queryUsageLocalMachine({ dbPath }))),
    Effect.runPromise(Effect.flip(queryUsageSyncFleet({ dbPath }))),
    Effect.runPromise(Effect.flip(queryLocalMergeBundle({ dbPath }))),
  ]);

  expect(errors.map((error) => error.reason)).toEqual(['corrupt', 'corrupt', 'corrupt']);
});

test('keeps historical empty labels canonical and does not advance generations for an identical relabel', async () => {
  const home = temporaryHome('ai-usage-local-empty-label-');
  const dbPath = usageStorePath(home);
  const emptyLabelMachine = { id: localMachine.id, label: '' };
  await Effect.runPromise(importLocalRows({ dbPath, machine: emptyLabelMachine, rows: [usageRow('empty-label')] }));
  expect(
    await Effect.runPromise(
      updateUsageMachineLabel({
        dbPath,
        machine: emptyLabelMachine,
        updatedAt: new Date('2026-07-30T11:00:00.000Z'),
      }),
    ),
  ).toEqual({ changed: true, skippedRows: 0, updatedRows: 1 });
  const generations = await Effect.runPromise(queryUsageStoreGenerations({ dbPath }));

  expect(
    await Effect.runPromise(
      updateUsageMachineLabel({
        dbPath,
        machine: emptyLabelMachine,
        updatedAt: new Date('2026-07-30T12:00:00.000Z'),
      }),
    ),
  ).toEqual({ changed: false, skippedRows: 0, updatedRows: 0 });
  expect(await Effect.runPromise(queryUsageStoreGenerations({ dbPath }))).toEqual(generations);
  expect(await Effect.runPromise(queryUsageLocalMachine({ dbPath }))).toEqual(emptyLabelMachine);
  expect((await Effect.runPromise(queryLocalMergeBundle({ dbPath }))).machine).toEqual(emptyLabelMachine);
});

test('keeps Sync fleet identity and rows on one WAL snapshot during a concurrent relabel', async () => {
  const home = temporaryHome('ai-usage-sync-snapshot-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: localMachine }));
  await Effect.runPromise(importLocalRows({ dbPath, machine: localMachine, rows: [usageRow('snapshot-fleet')] }));
  const renamedMachine = { ...localMachine, label: 'Renamed machine' };
  const clear = setLocalProjectionReadFaultInjectorForTesting(async (phase) => {
    if (phase === 'sync-fleet-after-machine') {
      await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: renamedMachine }));
    }
  });
  try {
    const snapshot = await Effect.runPromise(queryUsageSyncFleet({ dbPath }));
    expect(snapshot.currentMachine).toEqual(localMachine);
    expect(snapshot.machines).toEqual([expect.objectContaining({ id: localMachine.id, label: localMachine.label })]);
  } finally {
    clear();
  }
  expect((await Effect.runPromise(queryUsageSyncFleet({ dbPath }))).currentMachine).toEqual(renamedMachine);
});

test('keeps merge export identity and row provenance on one WAL snapshot during a concurrent relabel', async () => {
  const home = temporaryHome('ai-usage-export-snapshot-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: localMachine }));
  await Effect.runPromise(importLocalRows({ dbPath, machine: localMachine, rows: [usageRow('snapshot-export')] }));
  const renamedMachine = { ...localMachine, label: 'Renamed machine' };
  const clear = setLocalProjectionReadFaultInjectorForTesting(async (phase) => {
    if (phase === 'local-bundle-after-machine') {
      await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: renamedMachine }));
    }
  });
  try {
    const snapshot = await Effect.runPromise(queryLocalMergeBundle({ dbPath }));
    expect(snapshot.machine).toEqual(localMachine);
    expect(snapshot.rows[0]?.source.machineLabel).toBe(localMachine.label);
  } finally {
    clear();
  }
  expect((await Effect.runPromise(queryLocalMergeBundle({ dbPath }))).machine).toEqual(renamedMachine);
});

test('skips malformed local row JSON without blocking a bounded export', async () => {
  const home = temporaryHome('ai-usage-local-corrupt-row-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine: localMachine }));
  await Effect.runPromise(importLocalRows({ dbPath, machine: localMachine, rows: [usageRow('valid-row')] }));
  const { Database } = await import('bun:sqlite');
  const database = new Database(dbPath);
  database.query("UPDATE usage_rows SET row_json = 'not-json' WHERE row_key LIKE '%valid-row'").run();
  database.close();

  const bundle = await Effect.runPromise(queryLocalMergeBundle({ dbPath }));
  expect(bundle.machine).toEqual(localMachine);
  expect(bundle.rows).toEqual([]);
});

test('returns machine-unavailable from both composite readers', async () => {
  const home = temporaryHome('ai-usage-local-composite-unavailable-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(initializeUsageStore({ dbPath }));

  expect((await Effect.runPromise(Effect.flip(queryUsageSyncFleet({ dbPath })))).reason).toBe('machine-unavailable');
  expect((await Effect.runPromise(Effect.flip(queryLocalMergeBundle({ dbPath })))).reason).toBe('machine-unavailable');
});

test('rejects a same-column machine table that omits singleton constraints', async () => {
  const home = temporaryHome('ai-usage-local-machine-schema-');
  const dbPath = usageStorePath(home);
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const { Database } = await import('bun:sqlite');
  const database = new Database(dbPath);
  database.exec(`
    DROP TABLE usage_local_machine;
    CREATE TABLE usage_local_machine (
      singleton INTEGER PRIMARY KEY,
      machine_id TEXT NOT NULL,
      machine_label TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
  database.close();

  const error = await Effect.runPromise(Effect.flip(queryUsageLocalMachine({ dbPath })));
  expect(error.reason).toBe('corrupt');
});
