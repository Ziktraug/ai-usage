import { describe, expect, test } from 'bun:test';
import type { Row } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { LocalHistoryStorage } from './local-history';
import {
  type CollectorRow,
  enrichCollectorRowsWithRtkSavings,
  RTK_COMMANDS_SQL,
  withProjectPath,
} from './rtk-enrichment';
import { TestMemoryStorage } from './test-memory-storage';

const RTK_DB = '.local/share/rtk/history.db';

const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runSync(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

const row = (name: string, start: string, end: string, projectPath = '/work/ai-usage'): CollectorRow =>
  withProjectPath(
    {
      date: new Date(start),
      endDate: new Date(end),
      harness: 'Claude',
      provider: 'Claude sub',
      name,
      model: 'claude-sonnet-4.5',
      project: 'ai-usage',
      tokIn: 10,
      tokOut: 5,
      tokCr: 0,
      tokCw: 0,
      costActual: 0,
      costApprox: 0,
      costKnown: true,
      calls: 1,
      durationMs: new Date(end).getTime() - new Date(start).getTime(),
      turns: 1,
      tools: 1,
      linesAdded: null,
      linesDeleted: null,
    } satisfies Row,
    projectPath,
  );

describe('RTK enrichment', () => {
  test('matches saved tokens by project path and session window', () => {
    const storage = new TestMemoryStorage();
    storage.writeDatabaseRows(RTK_DB, RTK_COMMANDS_SQL, [
      {
        timestamp: '2026-01-01T00:03:00.000Z',
        project_path: '/work/ai-usage',
        input_tokens: 100,
        output_tokens: 40,
        saved_tokens: 10,
      },
      {
        timestamp: '2026-01-01T00:08:00.000Z',
        project_path: '/work/ai-usage/apps/web',
        input_tokens: 50,
        output_tokens: 20,
        saved_tokens: 5,
      },
      {
        timestamp: '2026-01-01T00:03:00.000Z',
        project_path: '/work/other',
        input_tokens: 990,
        output_tokens: 10,
        saved_tokens: 99,
      },
    ]);

    const enriched = runWithStorage(
      enrichCollectorRowsWithRtkSavings([
        row('wide', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z'),
        row('narrow', '2026-01-01T00:02:00.000Z', '2026-01-01T00:04:00.000Z'),
      ]),
      storage,
    );

    expect(enriched[0]?.rtkSavedTokens).toBe(5);
    expect(enriched[0]?.rtkInputTokens).toBe(50);
    expect(enriched[0]?.rtkOutputTokens).toBe(20);
    expect(enriched[0]?.rtkCommandCount).toBe(1);
    expect(enriched[1]?.rtkSavedTokens).toBe(10);
    expect(enriched[1]?.rtkInputTokens).toBe(100);
    expect(enriched[1]?.rtkOutputTokens).toBe(40);
    expect(enriched[1]?.rtkCommandCount).toBe(1);
  });

  test('leaves rows unchanged when RTK history is unavailable', () => {
    const storage = new TestMemoryStorage();
    const rows = [row('session', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z')];

    const enriched = runWithStorage(enrichCollectorRowsWithRtkSavings(rows), storage);

    expect(enriched).toEqual(rows);
  });
});
