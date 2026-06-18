import { describe, expect, test } from 'bun:test';
import { harnessLabel } from '@ai-usage/core/harness-metadata';
import { actualCost, normalizeUsageRow } from '@ai-usage/core/usage-row';
import { Effect } from 'effect';
import { collectCursorCsvTurns } from './collectors/cursor-csv';
import { reconcileCursorRows } from './collectors/cursor-reconcile';
import { LocalHistoryStorage } from './local-history';
import { withSource } from './rtk-enrichment';
import { TestMemoryStorage } from './test-memory-storage';

const csv = (rows: string[]) =>
  [
    'Date,User,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    ...rows,
  ].join('\n');

const localCursorRow = (date: string, turns = 1) =>
  withSource(
    normalizeUsageRow({
      date: new Date(date),
      endDate: null,
      harness: harnessLabel('cursor'),
      provider: 'Cursor sub',
      name: `local ${date}`,
      model: 'usage unavailable',
      project: '',
      tokens: { in: 0, out: 0, cr: 0, cw: 0 },
      cost: actualCost(null),
      calls: 0,
      turns,
      tools: 0,
      linesAdded: null,
      linesDeleted: null,
      usageUnavailable: true,
    }),
    { harnessKey: 'cursor', sourceSessionId: date },
  );

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

describe('Cursor CSV reconciliation', () => {
  test('assigns usage events to local Composer windows and keeps Cursor cost perspectives separate', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeText(
      'cursor.csv',
      csv([
        '"2026-06-03T09:00:57.773Z","nathan@example.com","","","Included","claude-opus-4-8-thinking-high","No","20","10","100","5","135","1.50"',
        '"2026-06-03T09:02:00.000Z","nathan@example.com","","","On-Demand","claude-4.5-sonnet","No","0","7","50","3","60","0.40"',
      ]),
    );

    const turns = runWithStorage(
      collectCursorCsvTurns({ usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'nathan@example.com' }),
      storage,
    );
    const [row] = reconcileCursorRows([localCursorRow('2026-06-03T09:00:00.000Z', 2)], turns, {
      clusterGapMs: 5 * 60_000,
      maxSessionSpanMs: 60 * 60_000,
      reconcileWindowMs: 3 * 60_000,
    });

    expect(row?.usageUnavailable).toBeUndefined();
    expect(row?.model).toBe('claude-opus-4-8-thinking-high');
    expect(row?.models).toEqual(['claude-opus-4-8-thinking-high', 'claude-4.5-sonnet']);
    expect(row?.tokIn).toBe(17);
    expect(row?.tokCw).toBe(20);
    expect(row?.tokCr).toBe(150);
    expect(row?.tokOut).toBe(8);
    expect(row?.costQuota).toBe(1.5);
    expect(row?.costActual).toBe(0.4);
    expect(row?.calls).toBe(2);
  });

  test('marks ambiguous matches when local Composer windows overlap', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeText(
      'cursor.csv',
      csv([
        '"2026-06-03T09:00:30.000Z","nathan@example.com","","","Included","composer-2.5-fast","No","0","10","20","3","33","0.10"',
      ]),
    );

    const turns = runWithStorage(
      collectCursorCsvTurns({ usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'nathan@example.com' }),
      storage,
    );
    const rows = reconcileCursorRows(
      [localCursorRow('2026-06-03T09:00:00.000Z'), localCursorRow('2026-06-03T09:00:20.000Z')],
      turns,
      { clusterGapMs: 5 * 60_000, maxSessionSpanMs: 60 * 60_000, reconcileWindowMs: 3 * 60_000 },
    );

    expect(rows.some((row) => row.ambiguous)).toBe(true);
  });

  test('keeps far later export events as standalone rows', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeText(
      'cursor.csv',
      csv([
        '"2026-06-03T12:00:00.000Z","nathan@example.com","","","Included","composer-2.5-fast","No","0","10","20","3","33","0.10"',
      ]),
    );

    const turns = runWithStorage(
      collectCursorCsvTurns({ usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'nathan@example.com' }),
      storage,
    );
    const rows = reconcileCursorRows([localCursorRow('2026-06-03T09:00:00.000Z')], turns, {
      clusterGapMs: 5 * 60_000,
      maxSessionSpanMs: 60 * 60_000,
      reconcileWindowMs: 3 * 60_000,
    });

    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.name.startsWith('Cursor export'))).toBe(true);
  });
});
