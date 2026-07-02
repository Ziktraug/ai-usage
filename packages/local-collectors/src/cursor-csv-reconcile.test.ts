import { describe, expect, test } from 'bun:test';
import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import type { CollectedSession } from './collected-session';
import { collectCursorCsvTurns } from './collectors/cursor-csv';
import { reconcileCursorSessions } from './collectors/cursor-reconcile';
import { LocalHistoryStorage } from './local-history';
import { TestMemoryStorage } from './test-memory-storage';

const csv = (rows: string[]) =>
  [
    'Date,User,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    ...rows,
  ].join('\n');

const localCursorSession = (date: string, turns = 1): CollectedSession => ({
  source: { harnessKey: 'cursor', sourceSessionId: date },
  projectPath: '/work/project',
  date: new Date(date),
  endDate: null,
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
});

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

describe('Cursor CSV reconciliation', () => {
  test('assigns usage events to local Composer windows and keeps Cursor cost perspectives separate', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeText(
      'cursor.csv',
      csv([
        '"2026-06-03T09:00:57.773Z","alex@example.com","","","Included","claude-opus-4-8-thinking-high","No","20","10","100","5","135","1.50"',
        '"2026-06-03T09:02:00.000Z","alex@example.com","","","On-Demand","claude-4.5-sonnet","No","0","7","50","3","60","0.40"',
      ]),
    );

    const turns = runWithStorage(
      collectCursorCsvTurns({ usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'alex@example.com' }),
      storage,
    );
    const [session] = reconcileCursorSessions([localCursorSession('2026-06-03T09:00:00.000Z', 2)], turns, {
      clusterGapMs: 5 * 60_000,
      maxSessionSpanMs: 60 * 60_000,
      reconcileWindowMs: 3 * 60_000,
    });

    expect(session?.source.sourceSessionId).toBe('2026-06-03T09:00:00.000Z');
    expect(session?.projectPath).toBe('/work/project');
    expect(session?.usageUnavailable).toBeUndefined();
    expect(session?.model).toBe('claude-opus-4-8-thinking-high');
    expect(session?.models).toEqual(['claude-opus-4-8-thinking-high', 'claude-4.5-sonnet']);
    expect(session?.tokens.in).toBe(17);
    expect(session?.tokens.cw).toBe(20);
    expect(session?.tokens.cr).toBe(150);
    expect(session?.tokens.out).toBe(8);
    expect(session?.costQuota).toBe(1.5);
    expect(session?.cost._tag).toBe('ActualCost');
    expect(session?.cost._tag === 'ActualCost' ? session.cost.amount : null).toBe(0.4);
    expect(session?.calls).toBe(2);
  });

  test('marks ambiguous matches when local Composer windows overlap', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeText(
      'cursor.csv',
      csv([
        '"2026-06-03T09:00:30.000Z","alex@example.com","","","Included","composer-2.5-fast","No","0","10","20","3","33","0.10"',
      ]),
    );

    const turns = runWithStorage(
      collectCursorCsvTurns({ usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'alex@example.com' }),
      storage,
    );
    const sessions = reconcileCursorSessions(
      [localCursorSession('2026-06-03T09:00:00.000Z'), localCursorSession('2026-06-03T09:00:20.000Z')],
      turns,
      { clusterGapMs: 5 * 60_000, maxSessionSpanMs: 60 * 60_000, reconcileWindowMs: 3 * 60_000 },
    );

    expect(sessions.some((session) => session.ambiguous)).toBe(true);
  });

  test('keeps far later export events as standalone rows', () => {
    const storage = new TestMemoryStorage();
    const exportPath = `${storage.home}/cursor.csv`;
    storage.writeText(
      'cursor.csv',
      csv([
        '"2026-06-03T12:00:00.000Z","alex@example.com","","","Included","composer-2.5-fast","No","0","10","20","3","33","0.10"',
      ]),
    );

    const turns = runWithStorage(
      collectCursorCsvTurns({ usageExportPaths: [exportPath], clusterGapMs: 5 * 60_000, user: 'alex@example.com' }),
      storage,
    );
    const sessions = reconcileCursorSessions([localCursorSession('2026-06-03T09:00:00.000Z')], turns, {
      clusterGapMs: 5 * 60_000,
      maxSessionSpanMs: 60 * 60_000,
      reconcileWindowMs: 3 * 60_000,
    });

    expect(sessions).toHaveLength(2);
    expect(sessions.some((session) => session.name.startsWith('Cursor export'))).toBe(true);
    const orphan = sessions.find((session) => session.name.startsWith('Cursor export'));
    expect(orphan?.project).toBe('Cursor CSV import');
    expect(orphan?.source.sourcePath).toBeUndefined();
  });
});
