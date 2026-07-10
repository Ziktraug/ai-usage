import { describe, expect, test } from 'bun:test';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  dateBoundsForRange,
  dateFromIndex,
  dateIndexFrom,
  normalizeDateIndexRange,
  parseLocalDate,
  rowMatchesDateBounds,
} from './date-range';

const rowAt = (activeDate: string): SerializedRow => ({
  date: activeDate,
  endDate: activeDate,
  activeDate,
  harness: 'Codex',
  provider: 'Codex API',
  name: activeDate,
  sessionLabel: activeDate,
  model: 'gpt-5.5',
  project: 'ai-usage',
  tokIn: 1,
  tokOut: 0,
  tokCr: 0,
  tokCw: 0,
  tokenTotal: 1,
  freshTokens: 1,
  costActual: null,
  costApprox: 0,
  costKnown: false,
  calls: 1,
  durationMs: null,
  turns: 0,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  lineDelta: null,
});

describe('date range filters', () => {
  test('uses rolling days for 7d and 30d to match CLI --since semantics', () => {
    const generatedAt = new Date('2026-06-11T23:19:24.682Z');
    const bounds = dateBoundsForRange('30d', generatedAt, '', '');

    expect(bounds.from?.toISOString()).toBe('2026-05-12T23:19:24.682Z');
    expect(bounds.to).toBeNull();
    expect(rowMatchesDateBounds(rowAt('2026-05-12T23:19:24.681Z'), bounds)).toBe(false);
    expect(rowMatchesDateBounds(rowAt('2026-05-12T23:19:24.682Z'), bounds)).toBe(true);
  });

  test('normalizes date indexes for timeline controls', () => {
    const minDay = new Date(2026, 5, 1);

    expect(dateIndexFrom(new Date(2026, 5, 4), minDay)).toBe(3);
    expect(dateFromIndex(minDay, 3)).toEqual(new Date(2026, 5, 4));
    expect(normalizeDateIndexRange([8.4, -2], 10)).toEqual([0, 8]);
  });

  test('rejects impossible local calendar dates instead of normalizing them', () => {
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2026-02-31')).toBeNull();
    expect(parseLocalDate('2024-02-29')).toEqual(new Date(2024, 1, 29));
  });
});
